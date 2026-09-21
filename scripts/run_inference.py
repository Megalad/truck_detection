import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from device_util import pick_device
from ultralytics import YOLO


# Frames are always resized to 1280x720 below before the zone check, so this
# stays valid regardless of the source video's own resolution. It's still
# tuned for one specific camera's lane position though - use --roi to check
# an arbitrary uploaded clip against the lane the caller actually drew.
DEFAULT_LANE_POLYGON = np.array(
    [
        [152, 242],
        [164, 245],
        [390, 680],
        [142, 680],
    ],
    np.int32,
)

OUTPUT_W, OUTPUT_H = 1280, 720


def build_lane_polygon(roi_json):
    """Turns --roi (a JSON list of {x, y} points normalized 0-1, as drawn
    against the video preview in the browser) into a pixel polygon in the
    same OUTPUT_W x OUTPUT_H space every frame gets resized to. Falls back
    to DEFAULT_LANE_POLYGON if --roi is missing or malformed, so this script
    still works when called without one."""
    if not roi_json:
        return DEFAULT_LANE_POLYGON
    try:
        points = json.loads(roi_json)
        if not isinstance(points, list) or len(points) < 3:
            return DEFAULT_LANE_POLYGON
        pixel_points = [
            [round(p["x"] * OUTPUT_W), round(p["y"] * OUTPUT_H)]
            for p in points
        ]
        return np.array(pixel_points, np.int32)
    except (ValueError, KeyError, TypeError):
        return DEFAULT_LANE_POLYGON


def make_color(name):
    if hasattr(sv.Color, name):
        return getattr(sv.Color, name)
    if name == "GREEN":
        return sv.Color(0, 255, 0)
    if name == "RED":
        return sv.Color(255, 0, 0)
    if name == "WHITE":
        return sv.Color(255, 255, 255)
    return sv.Color(59, 130, 246)


def parse_args():
    parser = argparse.ArgumentParser(description="Run Section 35 truck enforcement inference.")
    parser.add_argument("--model", required=True, help="Path to YOLO .pt weights.")
    parser.add_argument("--input", required=True, help="Input MP4 path.")
    parser.add_argument("--output", required=True, help="Output MP4 path.")
    parser.add_argument("--fps", type=float, default=30.0, help="Fallback output FPS.")
    parser.add_argument("--threshold-seconds", type=float, default=5.0)
    parser.add_argument("--conf", type=float, default=0.5)
    parser.add_argument("--device", default="auto", help="auto (cuda > mps > cpu), or cpu, mps, cuda:0, ...")
    parser.add_argument("--roi", default=None, help="JSON list of {x,y} points, normalized 0-1.")
    return parser.parse_args()


def main():
    args = parse_args()
    model_path = Path(args.model)
    input_path = Path(args.input)
    output_path = Path(args.output)

    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")
    if not input_path.exists():
        raise FileNotFoundError(f"Input video not found: {input_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(model_path))

    zone = sv.PolygonZone(polygon=build_lane_polygon(args.roi))
    zone_annotator = sv.PolygonZoneAnnotator(
        zone=zone,
        color=make_color("RED"),
        thickness=4,
    )
    box_annotator = sv.BoxAnnotator(color=make_color("GREEN"), thickness=3)
    label_annotator = sv.LabelAnnotator(
        text_color=make_color("WHITE"),
        text_scale=0.6,
        text_thickness=2,
        text_padding=10,
    )

    lane_dwell_tracker = {}
    fallback_fps = args.fps or 30.0
    max_frames = int(args.threshold_seconds * fallback_fps)

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {input_path}")

    source_fps = cap.get(cv2.CAP_PROP_FPS)
    output_fps = source_fps if source_fps and source_fps > 1 else fallback_fps
    # Browsers can't decode MPEG-4 Part 2 ("mp4v") inside an MP4 - the player
    # shows a black frame at 0:00 - so write H.264 ("avc1"). If this OpenCV
    # build has no avc1 encoder, fall back to mp4v and transcode with ffmpeg
    # once writing is finished (see below).
    out = cv2.VideoWriter(str(output_path), cv2.VideoWriter_fourcc(*"avc1"), output_fps, (OUTPUT_W, OUTPUT_H))
    needs_transcode = False
    if not out.isOpened():
        out = cv2.VideoWriter(str(output_path), cv2.VideoWriter_fourcc(*"mp4v"), output_fps, (OUTPUT_W, OUTPUT_H))
        needs_transcode = True

    frame_count = 0
    violation_frames = 0
    print("Launching High-Visibility Enforcement Engine...", flush=True)

    try:
        while cap.isOpened():
            success, raw_frame = cap.read()
            if not success:
                break

            frame_count += 1
            frame = cv2.resize(raw_frame, (OUTPUT_W, OUTPUT_H)).copy()

            results = model.track(
                frame,
                conf=args.conf,
                persist=True,
                device=pick_device(args.device),
                verbose=False,
            )[0]

            detections = sv.Detections.from_ultralytics(results)
            if results.boxes.id is not None:
                detections.tracker_id = results.boxes.id.cpu().numpy().astype(int)

            is_inside_lane = zone.trigger(detections=detections)
            current_loop_ids = set()
            label_map = {}

            if detections.tracker_id is not None:
                for idx, track_id in enumerate(detections.tracker_id):
                    if is_inside_lane[idx]:
                        current_loop_ids.add(track_id)
                        lane_dwell_tracker[track_id] = lane_dwell_tracker.get(track_id, 0) + 1
                        current_duration = lane_dwell_tracker[track_id] / output_fps

                        if lane_dwell_tracker[track_id] > max_frames:
                            violation_frames += 1
                            label_map[track_id] = f"Heavy Truck {track_id} VIOLATION ({current_duration:.1f}s)"
                        else:
                            label_map[track_id] = f"Heavy Truck {track_id} Passing ({current_duration:.1f}s)"
                    else:
                        lane_dwell_tracker.pop(track_id, None)
                        label_map[track_id] = f"Heavy Truck {track_id} OK"

            for dead_id in list(lane_dwell_tracker.keys()):
                if dead_id not in current_loop_ids:
                    lane_dwell_tracker.pop(dead_id, None)

            final_labels = []
            if detections.tracker_id is not None:
                for track_id in detections.tracker_id:
                    final_labels.append(label_map.get(track_id, f"Heavy Truck {track_id}"))

            annotated_frame = zone_annotator.annotate(scene=frame)
            annotated_frame = box_annotator.annotate(scene=annotated_frame, detections=detections)

            if final_labels:
                annotated_frame = label_annotator.annotate(
                    scene=annotated_frame,
                    detections=detections,
                    labels=final_labels,
                )

            out.write(annotated_frame)
    finally:
        cap.release()
        out.release()

    if needs_transcode:
        import os, shutil, subprocess
        ffmpeg = shutil.which("ffmpeg")
        tmp_path = str(output_path) + ".h264.mp4"
        if ffmpeg:
            result = subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", str(output_path),
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp_path],
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                os.replace(tmp_path, str(output_path))
            else:
                print(f"ffmpeg transcode failed: {result.stderr}", file=sys.stderr, flush=True)
        else:
            print("WARNING: no avc1 encoder and no ffmpeg; output may not play in browsers.", file=sys.stderr, flush=True)

    print(
        f"Inference complete. Frames={frame_count}; violation_frames={violation_frames}; output={output_path}",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Inference error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
