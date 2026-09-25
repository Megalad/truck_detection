#!/usr/bin/env python3
"""Compare BoT-SORT vs ByteTrack on the replay clips (public/demo/*.mp4), offline.

Feeds each clip the way live monitoring does (640px-wide frames at ~LIVE_FPS, same model and
detection settings as live_server.py) through both tracker configs and reports how stable the
truck track ids are - the thing that matters here, since the ROI timer, one-alert-per-truck and
speed estimation are all keyed on track_id.

    .venv/bin/python scripts/compare_trackers.py                       # default clips, 60s each
    .venv/bin/python scripts/compare_trackers.py TV03CL2 TV13CL1 --seconds 120

Metrics (per tracker, summed over clips):
  ids         distinct truck ids created (fewer = less fragmentation, for the same trucks)
  1-frame %   ids seen in only one frame (born and immediately lost - pure noise)
  median life median seconds from an id's first to last sighting (longer = more stable)
  re-spawns   new ids born within 1.5s of, and close to, where another id was just lost -
              most likely the SAME truck getting a new id (an id switch / fragment)
  ms/frame    detection + tracking time per frame on this machine
"""
import argparse
import statistics
import time
from pathlib import Path

import cv2
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "models" / "model_v6.pt"
TRACKERS = {
    "botsort": ROOT / "scripts" / "trackers" / "botsort_truck.yaml",
    "bytetrack": ROOT / "scripts" / "trackers" / "bytetrack_truck.yaml",
}
DEFAULT_CLIPS = ["TV03CL2", "TV27CL1", "TV13CL1", "TV35CL2"]
FRAME_WIDTH = 640      # live_server.LIVE_FRAME_WIDTH
LIVE_FPS = 10.0        # live_server.LIVE_FPS_ESTIMATE
CONF = 0.55            # live_server.DETECTION_CONF
TRUCK_CLASSES = {"truck", "heavy_truck"}
RESPAWN_SECONDS = 1.5


def run(clip, tracker_cfg, seconds):
    model = YOLO(str(MODEL))  # fresh model = fresh tracker state per run
    cap = cv2.VideoCapture(str(ROOT / "public" / "demo" / f"{clip}.mp4"))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, round(src_fps / LIVE_FPS))
    tracks = {}  # id -> {"first": t, "last": t, "n": frames, "last_box": (cx, cy, w)}
    respawns = 0
    frame_idx, processed, busy = 0, 0, 0.0
    while True:
        ok, frame = cap.read()
        if not ok or frame_idx / src_fps >= seconds:
            break
        if frame_idx % step:
            frame_idx += 1
            continue
        t = frame_idx / src_fps
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (FRAME_WIDTH, int(h * FRAME_WIDTH / w)))
        start = time.perf_counter()
        result = model.track(source=small, conf=CONF, iou=0.3, agnostic_nms=True, verbose=False,
                             persist=True, tracker=str(tracker_cfg))[0]
        busy += time.perf_counter() - start
        processed += 1
        if result.boxes.id is not None:
            for box, tid, cls in zip(result.boxes.xyxy.tolist(), result.boxes.id.int().tolist(),
                                     result.boxes.cls.int().tolist()):
                if result.names[cls] not in TRUCK_CLASSES:
                    continue
                cx, cy, bw = (box[0] + box[2]) / 2, box[3], box[2] - box[0]
                if tid not in tracks:
                    # Did another id vanish just before, right around here? Then this is
                    # probably the same truck re-acquired under a new id.
                    if any(0 < t - tr["last"] <= RESPAWN_SECONDS
                           and abs(tr["last_box"][0] - cx) < max(bw, tr["last_box"][2])
                           and abs(tr["last_box"][1] - cy) < max(bw, tr["last_box"][2])
                           for tr in tracks.values()):
                        respawns += 1
                    tracks[tid] = {"first": t, "last": t, "n": 0, "last_box": None}
                tr = tracks[tid]
                tr["last"], tr["n"], tr["last_box"] = t, tr["n"] + 1, (cx, cy, bw)
        frame_idx += 1
    cap.release()
    return tracks, respawns, processed, busy


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="*", default=DEFAULT_CLIPS)
    ap.add_argument("--seconds", type=float, default=60)
    args = ap.parse_args()

    totals = {name: {"lives": [], "single": 0, "respawns": 0, "frames": 0, "busy": 0.0} for name in TRACKERS}
    for clip in args.clips:
        for name, cfg in TRACKERS.items():
            tracks, respawns, frames, busy = run(clip, cfg, args.seconds)
            single = sum(1 for tr in tracks.values() if tr["n"] == 1)
            lives = [tr["last"] - tr["first"] for tr in tracks.values()]
            print(f"{clip:8} {name:9}  ids={len(tracks):4}  1-frame={single:3}  "
                  f"median life={statistics.median(lives) if lives else 0:5.1f}s  re-spawns={respawns:3}  "
                  f"{1000 * busy / max(frames, 1):5.0f} ms/frame", flush=True)
            tot = totals[name]
            tot["lives"] += lives
            tot["single"] += single
            tot["respawns"] += respawns
            tot["frames"] += frames
            tot["busy"] += busy

    print(f"\nTOTAL over {len(args.clips)} clip(s), {args.seconds:.0f}s each")
    print(f"{'tracker':10} {'ids':>5} {'1-frame %':>10} {'median life':>12} {'re-spawns':>10} {'ms/frame':>9}")
    for name, tot in totals.items():
        n = len(tot["lives"])
        print(f"{name:10} {n:5} {100 * tot['single'] / max(n, 1):9.1f}% "
              f"{statistics.median(tot['lives']) if n else 0:11.1f}s {tot['respawns']:10} "
              f"{1000 * tot['busy'] / max(tot['frames'], 1):9.0f}")


if __name__ == "__main__":
    main()
