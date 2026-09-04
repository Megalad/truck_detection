import cv2
from ultralytics import YOLO
import sys

def test_tracker():
    model = YOLO("model_v2.pt")
    cap = cv2.VideoCapture("public/recorded_videos/re1.mp4")
    
    count = 0
    while count < 30:
        ret, frame = cap.read()
        if not ret: break
        
        results = model.track(source=frame, persist=True, verbose=False)
        result = results[0]
        
        if result.boxes is not None and result.boxes.id is not None:
            ids = result.boxes.id.cpu().numpy()
            print(f"Frame {count}: Track IDs -> {ids}")
        else:
            print(f"Frame {count}: No tracks")
            
        count += 1
        
    cap.release()

test_tracker()
