import asyncio
import cv2
import json
import torch
import ultralytics
import os
import time
import collections
import threading
import mysql.connector
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pathlib import Path

# Fix OpenCV HLS protocol whitelist issue
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "protocol_whitelist;file,http,https,tcp,tls,crypto"

# Fix for PyTorch 2.6 Weights_Only=True loading issue with Ultralytics
_original_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _original_load(*args, **kwargs)
torch.load = _safe_load
from ultralytics import YOLO

app = FastAPI()

# Map camera ids to their respective HLS streams
CAMERA_STREAMS = {
    "camera1": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_008_IN.stream/playlist.m3u8",
    "camera2": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_IN.stream/playlist.m3u8",
    "camera3": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_OUT.stream/playlist.m3u8",
}

# Preload model
base_dir = Path(__file__).parent.parent
model_path = base_dir / "model_v2.pt"
model = YOLO(str(model_path))

import threading

import numpy as np

# Load YOLO model once
model_path = str(Path(__file__).parent.parent / "model_v2.pt")
print(f"Loading YOLO model from {model_path}...")
model = ultralytics.YOLO(model_path)
print("Model loaded successfully.")

# Global state for ROIs and alerts
camera_rois = {}
last_alert_times = {}
COOLDOWN_SECONDS = 5.0

# Frame buffers and recordings
frame_buffers = collections.defaultdict(lambda: collections.deque(maxlen=60))
active_recordings = {}

# DB Config
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', '12345678'),
    'database': 'section35_db'
}

def save_video_and_db(camera_id, frames, violation_id, roi_polygon_json):
    evidence_video_url = ""
    
    # 1. Video Writer Block
    try:
        evidence_dir = os.path.join(base_dir, "public", "evidence_videos")
        os.makedirs(evidence_dir, exist_ok=True)
        print(f"[{camera_id}] Resolved video directory: {evidence_dir}")
        
        filename = f"{violation_id}_{camera_id}.mp4"
        filepath = os.path.join(evidence_dir, filename)
        
        if len(frames) > 0:
            h, w = frames[0].shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            out = cv2.VideoWriter(filepath, fourcc, 30.0, (w, h))
            for f in frames:
                out.write(f)
            out.release()
            
        evidence_video_url = f"/evidence_videos/{filename}"
    except Exception as e:
        print(f"ERROR: Video Writer failed: {e}")
        return
        
    # 2. MySQL Insert Block
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        sql = """INSERT INTO violations (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name) 
                 VALUES (%s, %s, %s, %s, %s, %s)"""
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, evidence_video_url, filename)
        print(f"[{camera_id}] Attempting MySQL INSERT for {violation_id}...")
        cursor.execute(sql, val)
        conn.commit()
        print(f"[{camera_id}] MySQL INSERT successful for {violation_id}!")
        cursor.close()
        conn.close()
        print(f"[{camera_id}] Saved evidence for {violation_id}")
    except Exception as e:
        print(f"ERROR: MySQL Insert failed: {e}")

@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    print(f"[{camera_id}] WebSocket connection opened")
    camera_rois[camera_id] = None
    last_alert_times[camera_id] = 0.0
    try:
        while True:
            # Receive message (could be bytes or text)
            message = await websocket.receive()
            
            if "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "SET_LANE_ROI":
                        camera_rois[camera_id] = data.get("points")
                        print(f"[{camera_id}] Updated ROI: {camera_rois[camera_id]}")
                except Exception as e:
                    print(f"[{camera_id}] Error parsing text message: {e}")
                    
            elif "bytes" in message and message["bytes"]:
                data = message["bytes"]
                # Decode JPEG
                np_arr = np.frombuffer(data, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                
                if frame is None:
                    continue
                
                # Keep a rolling buffer of frames
                frame_buffers[camera_id].append(frame)
                
                # Process active recording if any
                if camera_id in active_recordings:
                    rec = active_recordings[camera_id]
                    rec['frames'].append(frame)
                    rec['remaining'] -= 1
                    
                    if rec['remaining'] <= 0:
                        # Done collecting frames, spawn a thread to write video and insert to DB
                        threading.Thread(target=save_video_and_db, args=(camera_id, rec['frames'], rec['violation_id'], rec['roi_polygon'])).start()
                        del active_recordings[camera_id]
                    
                h, w = frame.shape[:2]
                
                # Run inference
                results = model.predict(source=frame, conf=0.5, verbose=False)
                result = results[0]
                
                boxes = []
                violation_detected = False
                
                # Setup polygon for point test if ROI is defined
                roi_poly = None
                if camera_rois.get(camera_id) and len(camera_rois[camera_id]) >= 3:
                    points = []
                    for pt in camera_rois[camera_id]:
                        points.append([int(pt['x'] * w), int(pt['y'] * h)])
                    roi_poly = np.array(points, dtype=np.int32)
                
                if result.boxes is not None:
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = model.names[cls_id]
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            
                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * w)
                            y1_pix = int(coords[1] * h)
                            x2_pix = int(coords[2] * w)
                            y2_pix = int(coords[3] * h)
                            
                            if roi_poly is not None:
                                # bottom corners
                                bottom_left = (int(x1_pix), int(y2_pix))
                                bottom_right = (int(x2_pix), int(y2_pix))
                                
                                # pointPolygonTest
                                # +1 if inside, 0 if on edge, -1 if outside
                                is_inside_left = cv2.pointPolygonTest(roi_poly, bottom_left, False)
                                is_inside_right = cv2.pointPolygonTest(roi_poly, bottom_right, False)
                                
                                if is_inside_left >= 0 or is_inside_right >= 0:
                                    violation_detected = True
                                    cv2.rectangle(frame, (int(x1_pix), int(y1_pix)), (int(x2_pix), int(y2_pix)), (0, 0, 255), 2)
                                    cv2.putText(frame, f"VIOLATION: Truck", (int(x1_pix), int(y1_pix) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                            
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "label": f"Truck {int(conf * 100)}%"
                            })
                
                # Send violation alert if needed
                if violation_detected:
                    current_time = time.time()
                    if current_time - last_alert_times[camera_id] > COOLDOWN_SECONDS:
                        last_alert_times[camera_id] = current_time
                        
                        violation_id = f"V-{int(current_time)}"
                        
                        # Start recording
                        active_recordings[camera_id] = {
                            'frames': list(frame_buffers[camera_id]),
                            'remaining': 30,
                            'violation_id': violation_id,
                            'roi_polygon': json.dumps(camera_rois[camera_id])
                        }
                        
                        alert_msg = {
                            "type": "VIOLATION_ALERT",
                            "camera": camera_id,
                            "message": "Potential Section 35 Violation detected!"
                        }
                        await websocket.send_json(alert_msg)
                
                # Send directly as JSON array to match the frontend update
                await websocket.send_json(boxes)
    except WebSocketDisconnect:
        print(f"[{camera_id}] WebSocket disconnected")
    except Exception as e:
        print(f"[{camera_id}] Error in WebSocket loop: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
