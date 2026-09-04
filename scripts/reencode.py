import cv2
import sys
import os

def reencode(filepath):
    print(f"Re-encoding {filepath}...")
    cap = cv2.VideoCapture(filepath)
    if not cap.isOpened():
        print(f"Cannot open {filepath}")
        return

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    tmp_path = filepath + ".tmp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(tmp_path, fourcc, fps, (w, h))

    count = 0
    while True:
        ret, frame = cap.read()
        if not ret: break
        out.write(frame)
        count += 1
        if count % 100 == 0:
            print(f"Processed {count}/{total_frames} frames", end='\r')

    out.release()
    cap.release()
    
    os.replace(tmp_path, filepath)
    print(f"\nDone re-encoding {filepath}")

reencode('public/recorded_videos/r1_processed.mp4')
# We skip r2_processed for now to save time, or we can do it too.
