import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from ultralytics import YOLO


LANE_POLYGON = np.array(
    [
        [152, 242],
        [164, 245],
        [390, 680],
        [142, 680],
    ],
    np.int32,
)


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
    parser.add_argument("--conf", type=float, default=0.40)
    parser.add_argument("--device", default="cpu", help="Use cpu, 0, 1, etc.")
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

    zone = sv.PolygonZone(polygon=LANE_POLYGON)
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
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(str(output_path), fourcc, output_fps, (1280, 720))

    frame_count = 0
    violation_frames = 0
    print("Launching High-Visibility Enforcement Engine...", flush=True)

    try:
        while cap.isOpened():
            success, raw_frame = cap.read()
            if not success:
                break

            frame_count += 1
            frame = cv2.resize(raw_frame, (1280, 720)).copy()

            results = model.track(
                frame,
                conf=args.conf,
                persist=True,
                device=args.device,
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
