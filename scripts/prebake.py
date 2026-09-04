import cv2
import numpy as np
import torch
import sys
from pathlib import Path

# Fix for PyTorch 2.6 Weights_Only=True loading issue with Ultralytics
_original_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _original_load(*args, **kwargs)
torch.load = _safe_load

from ultralytics import YOLO

def main(input_video_path, output_video_path, model_path):
    print(f"Loading model: {model_path}")
    try:
        model = YOLO(model_path)
    except Exception as e:
        print(f"Error loading model: {e}")
        return

    cap = cv2.VideoCapture(input_video_path)
    if not cap.isOpened():
        print(f"Error: Could not open input video {input_video_path}")
        return
        
    fps = int(cap.get(cv2.CAP_PROP_FPS))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    fourcc = cv2.VideoWriter_fourcc(*'avc1') # Changed to H.264 for HTML5 compatibility
    out = cv2.VideoWriter(output_video_path, fourcc, fps, (width, height))
    
    # Generic ROI representing a right lane (adjustable)
    roi_pts = np.array([
        [int(width * 0.6), int(height * 0.4)],
        [int(width * 0.9), int(height * 0.4)],
        [width, height],
        [int(width * 0.5), height]
    ], np.int32).reshape((-1, 1, 2))
    
    print(f"Processing video ({width}x{height} at {fps} fps)...")
    
    frame_count = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
            
        frame_count += 1
        if frame_count % 30 == 0:
            print(f"Processed {frame_count} frames...")
            
        # Draw ROI polygon
        cv2.polylines(frame, [roi_pts], isClosed=True, color=(0, 0, 255), thickness=2)
        
        # Inference
        results = model(frame, verbose=False)
        
        for result in results:
            boxes = result.boxes
            for box in boxes:
                cls_id = int(box.cls[0])
                if cls_id == 7: # truck
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    
                    bottom_center_x = (x1 + x2) // 2
                    bottom_center_y = y2
                    
                    dist = cv2.pointPolygonTest(roi_pts, (bottom_center_x, bottom_center_y), False)
                    
                    if dist >= 0:
                        color = (0, 0, 255) # Red
                        label = f"VIOLATION {conf*100:.0f}%"
                    else:
                        color = (0, 255, 0) # Green
                        label = f"Truck {conf*100:.0f}%"
                        
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, label, (x1, max(y1 - 10, 0)), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                                
        out.write(frame)
        
    cap.release()
    out.release()
    print(f"Finished processing. Output saved to: {output_video_path}")

if __name__ == "__main__":
    MODEL_FILE = str(Path(__file__).parent.parent / 'model_v2.pt')
    INPUT_VIDEO = 'r1.mp4'
    OUTPUT_VIDEO = 'r1_processed.mp4'
    
    if len(sys.argv) > 1:
        INPUT_VIDEO = sys.argv[1]
    if len(sys.argv) > 2:
        OUTPUT_VIDEO = sys.argv[2]
        
    main(INPUT_VIDEO, OUTPUT_VIDEO, MODEL_FILE)
