#!/usr/bin/env python3
"""
calibrate_camera.py
-------------------
Click-to-pick ground-plane calibration for speed_estimator.py.

It grabs one frame from a camera, lets you click 4+ points that lie on the flat
road surface, asks for their real-world position in metres, solves the
image->ground homography, prints the fit error, shows a verification overlay,
and merges the result into web/calibration.json under the camera id.

Do this ONCE per fixed camera. After that speed_estimator uses the perspective
transform instead of the rough single-scale fallback, and both lanes read
correctly.

--------------------------------------------------------------------------------
EXAMPLES

  # Motorway rectangle you can measure: one lane wide (3.5 m) by 3 dashed-line
  # pitches long (3 m paint + 6 m gap = 9 m each -> 27 m). Click the 4 corners
  # in this order:  far-left, far-right, near-right, near-left.
  python calibrate_camera.py TV73R --image frame.jpg --rectangle --width 3.5 --length 27

  # Grab the frame straight from the HLS stream instead of a file:
  python calibrate_camera.py camera2 --stream "https://.../playlist.m3u8" \
         --rectangle --width 3.5 --length 27

  # Pull frame number 900 out of a recorded video:
  python calibrate_camera.py camera2 --video clip.mp4 --frame 900 \
         --rectangle --width 3.5 --length 27

  # General mode: click as many road points as you like, type each one's
  # X Y metres when prompted (X = across road, Y = along road, any origin).
  python calibrate_camera.py camera2 --image frame.jpg

--------------------------------------------------------------------------------
CONTROLS in the click window
  left click   add a point
  u            undo last point
  r            clear all points
  Enter / s    done
  q / Esc      quit without saving
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CALIB_PATH = os.path.join(os.path.dirname(HERE), "calibration.json")


# --------------------------------------------------------------------------- #
# Frame acquisition
# --------------------------------------------------------------------------- #
def grab_frame(args):
    if args.image:
        frame = cv2.imread(args.image)
        if frame is None:
            sys.exit(f"Could not read image: {args.image}")
        return frame

    src = args.video or args.stream
    if not src:
        sys.exit("Give one of --image, --video or --stream.")

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"Could not open: {src}")

    if args.video and args.frame > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, args.frame)

    frame = None
    # Streams often need a few reads before the first decodable frame.
    for _ in range(max(1, args.warmup)):
        ok, f = cap.read()
        if ok and f is not None:
            frame = f
    cap.release()
    if frame is None:
        sys.exit("Read no frame from the source.")
    return frame


def resize_frame(frame, spec):
    """spec is 'WxH' or 'W' (keep aspect). Homography is resolution-specific, so
    this must match the size the live pipeline actually processes."""
    if not spec:
        return frame
    h0, w0 = frame.shape[:2]
    if "x" in spec.lower():
        w, h = (int(v) for v in spec.lower().split("x"))
    else:
        w = int(spec)
        h = int(round(h0 * w / w0))
    if (w, h) != (w0, h0):
        frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
        print(f"Resized {w0}x{h0} -> {w}x{h} to match the processing resolution.")
    return frame


# --------------------------------------------------------------------------- #
# Point picking
# --------------------------------------------------------------------------- #
def pick_points(frame):
    pts = []
    win = "calibrate - click road points, Enter when done"
    disp = frame.copy()

    def redraw():
        nonlocal disp
        disp = frame.copy()
        for i, (x, y) in enumerate(pts):
            cv2.circle(disp, (int(x), int(y)), 5, (0, 255, 255), -1)
            cv2.putText(disp, str(i + 1), (int(x) + 8, int(y) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        if len(pts) >= 2:
            cv2.polylines(disp, [np.int32(pts)], False, (0, 200, 0), 1)
        cv2.imshow(win, disp)

    def on_mouse(event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN:
            pts.append((float(x), float(y)))
            redraw()

    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(win, on_mouse)
    redraw()

    while True:
        key = cv2.waitKey(20) & 0xFF
        if key in (13, ord("s")):           # Enter / s
            break
        if key in (27, ord("q")):           # Esc / q
            cv2.destroyAllWindows()
            sys.exit("Aborted, nothing saved.")
        if key == ord("u") and pts:
            pts.pop()
            redraw()
        if key == ord("r"):
            pts.clear()
            redraw()

    cv2.destroyWindow(win)
    return pts


# --------------------------------------------------------------------------- #
# World coordinates
# --------------------------------------------------------------------------- #
def world_from_rectangle(n, width, length):
    if n != 4:
        sys.exit(f"--rectangle needs exactly 4 clicks (got {n}). "
                 "Order: far-left, far-right, near-right, near-left.")
    # far-left, far-right, near-right, near-left
    return [[0.0, length], [width, length], [width, 0.0], [0.0, 0.0]]


def world_from_prompts(n):
    print("\nEnter each point's real-world position in metres.")
    print("  X = across the road, Y = along the road (any fixed origin).\n")
    world = []
    for i in range(n):
        while True:
            raw = input(f"  point {i + 1}  X Y : ").strip().replace(",", " ")
            try:
                x, y = (float(v) for v in raw.split())
                world.append([x, y])
                break
            except ValueError:
                print("    need two numbers, e.g:  3.5 18")
    return world


# --------------------------------------------------------------------------- #
# Solve + report
# --------------------------------------------------------------------------- #
def solve_and_report(img_pts, world_pts, frame):
    src = np.array(img_pts, dtype=np.float32)
    dst = np.array(world_pts, dtype=np.float32)
    H, mask = cv2.findHomography(src, dst)
    if H is None:
        sys.exit("findHomography failed - points may be collinear. Re-pick.")

    proj = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    err = np.linalg.norm(proj - dst, axis=1)
    print("\nFit (image point -> where the homography puts it, vs. what you said):")
    for i, (p, d, e) in enumerate(zip(proj, dst, err)):
        print(f"  point {i + 1}: got ({p[0]:6.2f}, {p[1]:6.2f}) m   "
              f"want ({d[0]:6.2f}, {d[1]:6.2f}) m   off {e:.2f} m")
    print(f"  mean {err.mean():.2f} m   max {err.max():.2f} m")
    if err.max() > 1.5:
        print("  ! max error > 1.5 m - clicks or measurements are probably off.")

    _verify_overlay(frame, H, world_pts)
    return H.tolist()


def _verify_overlay(frame, H, world_pts):
    """Warp an integer-metre grid back into the image so you can eyeball it."""
    try:
        Hinv = np.linalg.inv(np.array(H))
    except np.linalg.LinAlgError:
        return
    w = np.array(world_pts)
    x0, x1 = float(np.floor(w[:, 0].min())) - 1, float(np.ceil(w[:, 0].max())) + 1
    y0, y1 = float(np.floor(w[:, 1].min())) - 1, float(np.ceil(w[:, 1].max())) + 1
    disp = frame.copy()

    def to_img(X, Y):
        p = cv2.perspectiveTransform(np.array([[[X, Y]]], np.float32), Hinv)[0][0]
        return int(round(p[0])), int(round(p[1]))

    xr = np.arange(np.floor(x0), np.ceil(x1) + 1e-6, 1.0)
    yr = np.arange(np.floor(y0), np.ceil(y1) + 1e-6, 1.0)
    for X in xr:
        cv2.polylines(disp, [np.int32([to_img(X, Y) for Y in yr])], False, (0, 180, 255), 1)
    for Y in yr:
        cv2.polylines(disp, [np.int32([to_img(X, Y) for X in xr])], False, (0, 180, 255), 1)
    cv2.putText(disp, "1 m grid - lines should sit on the road. any key to continue",
                (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 180, 255), 2)
    cv2.namedWindow("verify", cv2.WINDOW_NORMAL)
    cv2.imshow("verify", disp)
    cv2.waitKey(0)
    cv2.destroyAllWindows()


# --------------------------------------------------------------------------- #
# Merge into calibration.json
# --------------------------------------------------------------------------- #
def save(camera_id, img_pts, world_pts):
    data = {}
    if os.path.exists(CALIB_PATH):
        try:
            with open(CALIB_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            print(f"(existing calibration.json unreadable: {exc}; starting fresh)")
            data = {}
    cams = data.setdefault("cameras", {})
    entry = cams.get(camera_id, {})
    entry["image_points"] = [[round(x, 1), round(y, 1)] for x, y in img_pts]
    entry["world_points_m"] = [[round(x, 2), round(y, 2)] for x, y in world_pts]
    entry.setdefault("max_speed_kmh", 160)
    cams[camera_id] = entry

    with open(CALIB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"\nWrote camera '{camera_id}' to {CALIB_PATH}")
    print("Restart live_server (or call speed_estimator.reload_calibration()) to pick it up.")


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("camera_id", help="camera id key to write in calibration.json")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", help="path to a still frame")
    src.add_argument("--video", help="path to a video file")
    src.add_argument("--stream", help="stream URL (HLS/RTSP)")
    ap.add_argument("--frame", type=int, default=0, help="frame index for --video")
    ap.add_argument("--warmup", type=int, default=30,
                    help="frames to read before grabbing (streams need this)")
    ap.add_argument("--resize", default="640",
                    help="resize the frame to 'WxH' or 'W' before picking, so "
                         "points match the pipeline's processing size "
                         "(live_server downscales to 640 wide; default '640')")
    ap.add_argument("--rectangle", action="store_true",
                    help="4 clicks = a known W x L road rectangle "
                         "(order: far-left, far-right, near-right, near-left)")
    ap.add_argument("--width", type=float, help="rectangle width in metres (across road)")
    ap.add_argument("--length", type=float, help="rectangle length in metres (along road)")
    args = ap.parse_args()

    if args.rectangle and (args.width is None or args.length is None):
        ap.error("--rectangle requires --width and --length")

    frame = grab_frame(args)
    frame = resize_frame(frame, args.resize)
    print(f"Frame {frame.shape[1]}x{frame.shape[0]}. Click road-surface points.")
    img_pts = pick_points(frame)
    if len(img_pts) < 4:
        sys.exit(f"Need at least 4 points, got {len(img_pts)}.")

    if args.rectangle:
        world_pts = world_from_rectangle(len(img_pts), args.width, args.length)
    else:
        world_pts = world_from_prompts(len(img_pts))

    solve_and_report(img_pts, world_pts, frame)

    if input("\nSave this to calibration.json? [y/N] ").strip().lower() == "y":
        save(args.camera_id, img_pts, world_pts)
    else:
        print("Not saved.")


if __name__ == "__main__":
    main()
