"""
kalman_demo.py  --  standalone demonstration of the speed Kalman filter
======================================================================

Runs one recorded video through YOLO + tracking and, for a single truck,
records TWO speed numbers per frame:

  * "raw"      - instantaneous speed from the frame-to-frame movement of the
                 tyre-contact point, with NO filtering. This is what the speed
                 would look like without the Kalman filter.
  * "filtered" - the number the real system shows, i.e. speed_estimator.update()
                 (bottom-centre ground point -> homography/fallback -> Kalman).

Both numbers use the EXACT same ground-point mapping (SpeedEstimator's own
_ground_point_metres), so the only difference between the two lines is the
Kalman filter itself.

Outputs (into web/public/report/):
  * kalman_demo.csv  - frame, time_s, raw_kmh, filtered_kmh  for the chosen truck
  * kalman_demo.png  - the raw-vs-filtered line chart used on the report page

Nothing in live_server.py or speed_estimator.py is modified. This script only
imports speed_estimator and calls its public/marked-internal helpers read-only.

Usage:
  .venv/bin/python scripts/kalman_demo.py \
      [--video public/recorded_videos/re1.mp4] \
      [--camera demo] [--max-frames 900] [--min-samples 25] [--device mps]
"""

import argparse
import csv
import math
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import speed_estimator  # noqa: E402  (local module, read-only use)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--video", default=os.path.join(WEB, "public", "recorded_videos", "re1.mp4"))
    p.add_argument("--model", default=os.path.join(WEB, "model_v2.pt"))
    p.add_argument("--camera", default="demo")
    p.add_argument("--max-frames", type=int, default=900)
    p.add_argument("--min-samples", type=int, default=25,
                   help="only keep trucks seen at least this many frames")
    p.add_argument("--device", default="mps")
    p.add_argument("--conf", type=float, default=0.7)
    p.add_argument("--outdir", default=os.path.join(WEB, "public", "report"))
    p.add_argument("--replot", action="store_true",
                   help="skip inference; rebuild the PNG from an existing kalman_demo.csv")
    return p.parse_args()


def load_model(model_path, device):
    # Same PyTorch 2.6 weights_only workaround live_server.py uses.
    import torch
    _orig = torch.load

    def _safe_load(*a, **k):
        k["weights_only"] = False
        return _orig(*a, **k)

    torch.load = _safe_load
    from ultralytics import YOLO

    model = YOLO(model_path)
    return model


def main():
    args = parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    csv_path = os.path.join(args.outdir, "kalman_demo.csv")
    png_path = os.path.join(args.outdir, "kalman_demo.png")

    if args.replot:
        with open(csv_path, newline="") as f:
            rdr = csv.reader(f)
            next(rdr)
            rows = [(int(r[0]), float(r[1]), float(r[2]), float(r[3])) for r in rdr]
        make_chart(rows, None, png_path)
        return

    if not os.path.exists(args.video):
        sys.exit(f"video not found: {args.video}")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"could not open video: {args.video}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"video {os.path.basename(args.video)}  {w}x{h} @ {src_fps:.2f} fps")

    print("loading model ...")
    model = load_model(args.model, args.device)
    print("model loaded")

    # Fresh estimator (same code path as the live server, "demo" camera ->
    # uncalibrated fallback scale, which is fine for showing the filter effect).
    speed_estimator.reset_estimator(args.camera)
    estimator = speed_estimator.get_estimator(args.camera, w, h)

    # Per-track history:  track_id -> list of (frame_idx, time_s, raw_kmh, filtered_kmh)
    history = {}
    # For the raw (unfiltered) speed we remember each track's previous ground point.
    prev_ground = {}   # track_id -> (wx, wy, time_s)

    frame_idx = 0
    while frame_idx < args.max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        time_s = frame_idx / src_fps

        try:
            results = model.track(source=frame, conf=args.conf, device=args.device,
                                  half=True, verbose=False, persist=True)
        except Exception as exc:
            if args.device != "cpu":
                print(f"[{args.device}] failed ({exc}); retrying on cpu")
                args.device = "cpu"
                results = model.track(source=frame, conf=args.conf, device="cpu",
                                      verbose=False, persist=True)
            else:
                raise

        result = results[0]
        if result.boxes is None:
            continue

        track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
        active = []

        for i in range(len(result.boxes.cls)):
            cls_id = int(result.boxes.cls[i].cpu().numpy())
            class_name = model.names[cls_id]
            if class_name not in ("truck", "heavy_truck"):
                continue

            coords = result.boxes.xyxyn[i].cpu().numpy()
            x1 = int(coords[0] * w)
            y1 = int(coords[1] * h)
            x2 = int(coords[2] * w)
            y2 = int(coords[3] * h)
            track_id = int(track_ids[i]) if i < len(track_ids) else -1
            if track_id == -1:
                continue
            active.append(track_id)

            bbox = (x1, y1, x2, y2)

            # --- filtered speed: the real system output -----------------------
            filtered_kmh = estimator.update(track_id, bbox, time_s)

            # --- raw speed: same ground point, no Kalman ---------------------
            wx, wy = estimator._ground_point_metres(bbox)
            raw_kmh = 0.0
            if track_id in prev_ground:
                pwx, pwy, pt = prev_ground[track_id]
                dt = time_s - pt
                if dt > 1e-6:
                    dist_m = math.hypot(wx - pwx, wy - pwy)
                    raw_kmh = dist_m / dt * 3.6
            prev_ground[track_id] = (wx, wy, time_s)

            history.setdefault(track_id, []).append(
                (frame_idx, round(time_s, 3), round(raw_kmh, 2), round(filtered_kmh, 2))
            )

        estimator.cleanup(active)

        if frame_idx % 100 == 0:
            print(f"  frame {frame_idx}  tracks so far: {len(history)}")

    cap.release()

    # For each truck, find its longest CONTIGUOUS run (no time gap bigger than a
    # few frame times) so the chart is one clean continuous comparison rather
    # than several restarts stitched together.
    max_gap = 4.0 / src_fps

    def longest_run(rows):
        best = cur = [rows[0]]
        for prev, r in zip(rows, rows[1:]):
            if r[1] - prev[1] <= max_gap:
                cur.append(r)
            else:
                if len(cur) > len(best):
                    best = cur
                cur = [r]
        return best if len(best) >= len(cur) else cur

    runs = {tid: longest_run(rows) for tid, rows in history.items()}
    good = {tid: run for tid, run in runs.items() if len(run) >= args.min_samples}
    if not good:
        sys.exit("no truck had a long enough continuous run; try another --video, "
                 "raise --max-frames, or lower --min-samples")

    best_id = max(good, key=lambda t: len(good[t]))
    rows = good[best_id]
    print(f"chosen truck: track_id={best_id}  "
          f"({len(rows)} continuous frames, {rows[-1][1] - rows[0][1]:.1f} s visible)")

    csv_path = os.path.join(args.outdir, "kalman_demo.csv")
    with open(csv_path, "w", newline="") as f:
        wtr = csv.writer(f)
        wtr.writerow(["frame", "time_s", "raw_kmh", "filtered_kmh"])
        wtr.writerows(rows)
    print(f"wrote {csv_path}")

    make_chart(rows, best_id, os.path.join(args.outdir, "kalman_demo.png"))


def make_chart(rows, track_id, png_path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = [r[1] for r in rows]
    raw = [r[2] for r in rows]
    filt = [r[3] for r in rows]
    t0 = t[0]
    t = [x - t0 for x in t]

    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=160)
    ax.plot(t, raw, color="#ef4444", linewidth=1.4, alpha=0.9,
            label="Raw (frame-to-frame, no filter)")
    ax.plot(t, filt, color="#3b82f6", linewidth=2.4,
            label="Kalman-filtered (what the system shows)")

    ax.set_title("Speed of one truck: raw vs Kalman-filtered", fontsize=13, color="#0f172a")
    ax.set_xlabel("Time truck is visible (seconds)", fontsize=11, color="#475569")
    ax.set_ylabel("Speed (km/h)", fontsize=11, color="#475569")
    ax.grid(True, color="#e2e8f0", linewidth=0.8)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color("#cbd5e1")
    ax.tick_params(colors="#64748b")

    raw_max = max(raw) if raw else 0
    if raw_max > 0:
        ax.annotate(f"raw jumps to ≈ {raw_max:.0f} km/h\nfrom one noisy frame",
                    xy=(t[raw.index(raw_max)], raw_max),
                    xytext=(0.30, 0.62), textcoords="axes fraction",
                    fontsize=9, color="#ef4444",
                    arrowprops=dict(arrowstyle="->", color="#ef4444", lw=1))

    steady = filt[len(filt) // 2]
    ax.annotate(f"filtered stays ≈ {steady:.0f} km/h",
                xy=(t[len(t) // 2], steady),
                xytext=(0.60, 0.30), textcoords="axes fraction",
                fontsize=9, color="#2563eb",
                arrowprops=dict(arrowstyle="->", color="#2563eb", lw=1))

    ax.legend(frameon=False, fontsize=10, loc="upper right")
    fig.tight_layout()
    fig.savefig(png_path, facecolor="white")
    print(f"wrote {png_path}")


if __name__ == "__main__":
    main()
