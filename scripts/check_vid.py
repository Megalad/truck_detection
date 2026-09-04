import cv2
import sys

def check_video(filepath):
    cap = cv2.VideoCapture(filepath)
    if not cap.isOpened():
        print(f"Cannot open {filepath}")
        return
    
    w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration = total_frames / fps if fps > 0 else 0
    
    print(f"File: {filepath}")
    print(f"Resolution: {int(w)}x{int(h)}")
    print(f"FPS: {fps}")
    print(f"Duration: {duration:.2f} seconds")
    print("-" * 20)
    cap.release()

check_video('public/recorded_videos/r1.mp4')
check_video('public/recorded_videos/r2.mp4')
