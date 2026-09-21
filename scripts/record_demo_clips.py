#!/usr/bin/env python3
"""Records Plan-B replay clips: public/demo/<cameraId>.mp4, one per camera, from the live CCTV
streams listed in src/cameras.js. The app's Replay mode (and its automatic fallback when a stream
is down) plays these instead of the stream.

    python3 scripts/record_demo_clips.py                      # all cameras, 3 minutes each
    python3 scripts/record_demo_clips.py TV27CL1 TV03CL2      # just these
    python3 scripts/record_demo_clips.py --seconds 300 TV27CL1

Tips: record in daylight, while trucks are using the restricted (right) lane, so the demo actually
triggers violations. Clips loop, so a few minutes is enough. Needs ffmpeg on PATH."""
import argparse
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "demo"


def load_cameras():
    text = (ROOT / "src" / "cameras.js").read_text()
    return dict(re.findall(r'id:\s*"([^"]+)".*?url:\s*"([^"]+)"', text))


def record(cam_id, url, seconds):
    out = OUT_DIR / f"{cam_id}.mp4"
    tmp = OUT_DIR / f".{cam_id}.recording.mp4"
    cmd = ["ffmpeg", "-v", "error", "-y", "-rw_timeout", "15000000", "-i", url, "-t", str(seconds),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-an",
           "-movflags", "+faststart", str(tmp)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return cam_id, False, (r.stderr or "no output").strip().splitlines()[-1:]
    tmp.replace(out)  # only replaces an existing clip once the new one is complete
    return cam_id, True, f"{out.stat().st_size / 1e6:.1f} MB"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cameras", nargs="*", help="camera ids (default: all in src/cameras.js)")
    ap.add_argument("--seconds", type=int, default=180)
    args = ap.parse_args()

    cams = load_cameras()
    ids = args.cameras or list(cams)
    unknown = [c for c in ids if c not in cams]
    if unknown:
        sys.exit(f"Unknown camera id(s): {', '.join(unknown)}. Known: {', '.join(cams)}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Recording {args.seconds}s from {len(ids)} camera(s) in parallel -> {OUT_DIR}")
    with ThreadPoolExecutor(max_workers=len(ids)) as pool:
        for cam_id, ok, info in pool.map(lambda c: record(c, cams[c], args.seconds), ids):
            print(f"  {cam_id}: {'OK ' + str(info) if ok else 'FAILED ' + str(info)}")


if __name__ == "__main__":
    main()
