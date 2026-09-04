import cv2
import sys

cap = cv2.VideoCapture('public/recorded_videos/r1.mp4')
if not cap.isOpened():
    print("Cannot open r1.mp4")
    sys.exit(1)

w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

print(f"Creating test output with avc1...")
fourcc = cv2.VideoWriter_fourcc(*'avc1')
out = cv2.VideoWriter('public/recorded_videos/test_avc1.mp4', fourcc, fps, (w, h))

count = 0
while count < 30:
    ret, frame = cap.read()
    if not ret: break
    out.write(frame)
    count += 1

out.release()
cap.release()
print("Done. Check test_avc1.mp4.")
