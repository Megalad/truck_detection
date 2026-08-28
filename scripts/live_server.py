import asyncio
import cv2
import json
import torch
import numpy as np
import ultralytics
import os
import time
import collections
import threading
import mysql.connector
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ProcessRequest(BaseModel):
    video_filename: str
    camera_id: str
    roi_points: list

# Map camera ids to their respective HLS streams
CAMERA_STREAMS = {
    # "camera1": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_008_IN.stream/playlist.m3u8",
    "camera2": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_IN.stream/playlist.m3u8",
    # "camera3": "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_OUT.stream/playlist.m3u8",
}

# Load YOLO model once
base_dir = Path(__file__).parent.parent
model_path = str(base_dir / "model_v2.pt")
print(f"Loading YOLO model from {model_path}...")
model = ultralytics.YOLO(model_path)
print("Model loaded successfully.")

# Global state for ROIs and alerts
camera_rois = {}
last_alert_times = {}
COOLDOWN_SECONDS = 2.0

# Frame buffers and recordings
frame_buffers = collections.defaultdict(lambda: collections.deque(maxlen=60))
active_recordings = {}
camera_track_histories = collections.defaultdict(dict) # 🟢 Live Speed မှတ်ရန် အသစ်ထည့်ပါ
PIXELS_PER_METER = 20.0

# DB Config
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', '12345678'),
    'database': 'section35_db'
}

import requests

TELEGRAM_BOT_TOKEN = "8633570454:AAEK0wMLoWApzcnzuQAxvubtyyGBfl-FuPQ"  # 🟢 သင့် Bot Token ထည့်ပါ
TELEGRAM_CHAT_ID = "-5394933515"      # 🟢 သင့် Chat ID ထည့်ပါ (အနုတ်လက္ခဏာပါသည်)

def send_telegram_alert(camera_id, speed, snapshot_path):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
        
        # ပို့ချင်သော စာသား (Caption)
        caption = f"🚨 Section 35 Violation Detected!\n📷 Camera: {camera_id}\n⚡ Speed: {speed:.1f} km/h\n⏰ Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        
        with open(snapshot_path, 'rb') as photo:
            files = {'photo': photo}
            data = {'chat_id': TELEGRAM_CHAT_ID, 'caption': caption}
            requests.post(url, data=data, files=files)
            
        print(f"[{camera_id}] Telegram Alert ပို့ပြီးပါပြီ!")
    except Exception as e:
        print(f"Telegram Error: {e}")

def save_video_and_db(camera_id, frames, violation_id, roi_polygon_json, snapshot_url=""):
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
            fourcc = cv2.VideoWriter_fourcc(*'avc1')
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
        sql = """INSERT INTO violations (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url) 
                 VALUES (%s, %s, %s, %s, %s, %s, %s)"""
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, evidence_video_url, filename, snapshot_url)
        print(f"[{camera_id}] Attempting MySQL INSERT for {violation_id}...")
        cursor.execute(sql, val)
        conn.commit()
        print(f"[{camera_id}] MySQL INSERT successful for {violation_id}!")
        cursor.close()
        conn.close()
        print(f"[{camera_id}] Saved evidence for {violation_id}")
    except Exception as e:
        print(f"ERROR: MySQL Insert failed: {e}")

@app.post("/api/process_recorded")
async def process_recorded(req: ProcessRequest):
    input_path = os.path.join(base_dir, "public", "recorded_videos", req.video_filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    output_filename = req.video_filename.replace('.mp4', '_processed.mp4')
    output_path = os.path.join(base_dir, "public", "recorded_videos", output_filename)
    
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise HTTPException(status_code=500, detail="Could not open video")
        
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
    
    roi_poly = None
    if len(req.roi_points) >= 3:
        pts = [[int(pt['x'] * w), int(pt['y'] * h)] for pt in req.roi_points]
        roi_poly = np.array(pts, dtype=np.int32)
        
    violation_found = False
    snapshot_url = ""
    violation_id_str = f"V-{int(time.time())}"
    
    track_history = {}
    PIXELS_PER_METER = 20.0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        if roi_poly is not None:
            cv2.polylines(frame, [roi_poly.reshape((-1, 1, 2))], isClosed=True, color=(0, 0, 255), thickness=2)

        start_time = time.time() 
        results = model.track(source=frame, conf=0.7, device="mps", half=True, verbose=False,persist=True)
        result = results[0]

        boxes = []
        violation_detected = False
        new_snapshot_url = ""
        if result.boxes is not None:
                    # 🟢 Track ID များကို ယူပါမည်
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = model.names[cls_id]
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1
                            
                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * w)
                            y1_pix = int(coords[1] * h)
                            x2_pix = int(coords[2] * w)
                            y2_pix = int(coords[3] * h)
                            
                            # 🟢 Live Speed တွက်ချက်ခြင်း
                            cx = (x1_pix + x2_pix) / 2.0
                            cy = (y1_pix + y2_pix) / 2.0
                            current_time_sec = time.time()
                            speed_kmh = 0.0
                            
                            if track_id != -1:
                                if track_id in camera_track_histories[camera_id]:
                                    prev_cx, prev_cy, prev_time = camera_track_histories[camera_id][track_id]
                                    time_diff = current_time_sec - prev_time
                                    if time_diff > 0:
                                        dist_pixels = ((cx - prev_cx)**2 + (cy - prev_cy)**2)**0.5
                                        dist_meters = dist_pixels / PIXELS_PER_METER
                                        speed_mps = dist_meters / time_diff
                                        speed_kmh = speed_mps * 3.6
                                
                                # နောက် Frame တွက်ရန် History မှတ်ခြင်း
                                camera_track_histories[camera_id][track_id] = (cx, cy, current_time_sec)
                            
                            # Box ပေါ်တွင်ပေါ်မည့် စာသား
                            box_label = f"({speed_kmh:.1f} km/h)" if speed_kmh > 0 else "VIOLATION!"
                            
                            if roi_poly is not None:
                                # bottom corners
                                bottom_left = (int(x1_pix), int(y2_pix))
                                bottom_right = (int(x2_pix), int(y2_pix))
                                
                                # pointPolygonTest
                                is_inside_left = cv2.pointPolygonTest(roi_poly, bottom_left, False)
                                is_inside_right = cv2.pointPolygonTest(roi_poly, bottom_right, False)
                                
                                if is_inside_left >= 0 or is_inside_right >= 0:
                                    violation_detected = True
                                    box_label = f"VIOLATION {speed_kmh:.1f} km/h" # 🔴 ဖောက်ဖျက်လျှင် ပြမည့်စာသား
                                    cv2.rectangle(frame, (int(x1_pix), int(y1_pix)), (int(x2_pix), int(y2_pix)), (0, 0, 255), 2)
                                    cv2.putText(frame, box_label, (int(x1_pix), int(y1_pix) - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
                                    
                                    current_time_chk = time.time()
                                    if current_time_chk - last_alert_times[camera_id] > COOLDOWN_SECONDS and not new_snapshot_url:
                                        snapshot_dir = os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"V-{int(current_time_chk)}_{camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)
                                        
                                        cv2.imwrite(snap_path, frame)
                                        new_snapshot_url = f"/evidence_snapshots/{snap_filename}"
                                        
                                        # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                        threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()
                            
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "label": box_label # 🟢 React ဆီသို့ Speed ပါ ပို့ပေးမည်
                            })
        
        
        end_time = time.time()
        time_diff = end_time - start_time
        if time_diff > 0:
            fps = 1.0 / time_diff
            fps_text = f"FPS: {fps:.1f}"
            
            # ပုံရဲ့ အကျယ် (Width) နှင့် အမြင့် (Height) ကို ယူပါမည်
            h, w = frame.shape[:2]
            
            # ညာဘက်အပေါ်ထောင့် (Top-Right) တွင် FPS စာသားကို အဝါရောင်ဖြင့် ရေးဆွဲပါမည်
            cv2.putText(frame, fps_text, (w - 250, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 255, 255), 3)

        # 🟢 FPS စာသား ရေးဆွဲပြီးမှသာ frame ကို သိမ်းပါ (သို့) WebSocket မှ ပို့ပါ
        out.write(frame)
            
    out.release()
    cap.release()
    fps = 0.0
    time_diff = time.time() - start_time
    if time_diff > 0:
        fps = 1.0 / time_diff
    # Save one evidence record to DB if any violation occurred
    if violation_found:
        try:
            conn = mysql.connector.connect(**DB_CONFIG)
            cursor = conn.cursor()
            sql = """INSERT INTO violations (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url) 
                     VALUES (%s, %s, %s, %s, %s, %s, %s)"""
            val = (violation_id_str, datetime.now(), req.camera_id, json.dumps(req.roi_points), f"/recorded_videos/{output_filename}", output_filename, snapshot_url)
            cursor.execute(sql, val)
            conn.commit()
            cursor.close()
            conn.close()
        except Exception as e:
            print("DB error", e)

    return {"status": "success", "processed_url": f"/recorded_videos/{output_filename}"}

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
                        threading.Thread(target=save_video_and_db, args=(camera_id, rec['frames'], rec['violation_id'], rec['roi_polygon'], rec.get('snapshot_url', ''))).start()
                        del active_recordings[camera_id]
                    
                h, w = frame.shape[:2]
                
                # Run inference
                start_time = time.time()
                
                # 🟢 2. Live အတွက် M2 GPU (mps) နှင့် half=True ကို ထည့်ပေးပါ
                results = model.track(source=frame, conf=0.5, device="mps", half=True, verbose=False,persist=True)
                result = results[0]
                
                boxes = []
                violation_detected = False
                new_snapshot_url = ""
                
                # Setup polygon for point test if ROI is defined
                roi_poly = None
                if camera_rois.get(camera_id) and len(camera_rois[camera_id]) >= 3:
                    points = []
                    for pt in camera_rois[camera_id]:
                        points.append([int(pt['x'] * w), int(pt['y'] * h)])
                    roi_poly = np.array(points, dtype=np.int32)
                
                if result.boxes is not None:
                    # 🟢 Track ID များကို ယူပါမည်
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = model.names[cls_id]
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1
                            
                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * w)
                            y1_pix = int(coords[1] * h)
                            x2_pix = int(coords[2] * w)
                            y2_pix = int(coords[3] * h)
                            
                            # 🟢 Live Speed တွက်ချက်ခြင်း
                            cx = (x1_pix + x2_pix) / 2.0
                            cy = (y1_pix + y2_pix) / 2.0
                            current_time_sec = time.time()
                            speed_kmh = 0.0
                            
                            if track_id != -1:
                                if track_id in camera_track_histories[camera_id]:
                                    history_data = camera_track_histories[camera_id][track_id]
                                    if len(history_data) == 4:
                                        prev_cx, prev_cy, prev_time, last_speed = history_data
                                    else:
                                        prev_cx, prev_cy, prev_time = history_data
                                        last_speed = 0.0
                                        
                                    time_diff = current_time_sec - prev_time
                                    
                                    # 🟢 1. Dynamic Zones သတ်မှတ်ခြင်း (y2_pix ပေါ် မူတည်၍)
                                    if y2_pix < (h * 0.4):
                                        dynamic_time_buffer = 0.5 
                                        dynamic_ppm = 12.0  
                                    elif y2_pix < (h * 0.75):
                                        dynamic_time_buffer = 0.3
                                        dynamic_ppm = 20.0
                                    else:
                                        dynamic_time_buffer = 0.15
                                        dynamic_ppm = 35.0

                                    # 🟢 2. Dynamic Buffer ဖြင့် စစ်ဆေးမည်
                                    if time_diff >= dynamic_time_buffer:
                                        dist_pixels = ((cx - prev_cx)**2 + (cy - prev_cy)**2)**0.5
                                        
                                        if dist_pixels < 10.0:
                                            speed_kmh = 0.0
                                        else:
                                            # 🟢 3. Dynamic PPM ကို သုံးမည်
                                            dist_meters = dist_pixels / dynamic_ppm
                                            raw_speed_kmh = (dist_meters / time_diff) * 3.6
                                            
                                            # Speed Smoothing (EMA)
                                            alpha = 0.4 
                                            if last_speed > 0:
                                                speed_kmh = (alpha * raw_speed_kmh) + ((1.0 - alpha) * last_speed)
                                            else:
                                                speed_kmh = raw_speed_kmh
                                        
                                        camera_track_histories[camera_id][track_id] = (cx, cy, current_time_sec, speed_kmh)
                                    else:
                                        speed_kmh = last_speed
                                else:
                                    camera_track_histories[camera_id][track_id] = (cx, cy, current_time_sec, 0.0)
                            
                            # Box ပေါ်တွင်ပေါ်မည့် စာသား
                            box_label = f"{speed_kmh:.1f} km/h" if speed_kmh > 0 else "Tracking..."
                            
                            if roi_poly is not None:
                                # bottom corners
                                bottom_left = (int(x1_pix), int(y2_pix))
                                bottom_right = (int(x2_pix), int(y2_pix))
                                
                                # pointPolygonTest
                                is_inside_left = cv2.pointPolygonTest(roi_poly, bottom_left, False)
                                is_inside_right = cv2.pointPolygonTest(roi_poly, bottom_right, False)
                                
                                if is_inside_left >= 0 or is_inside_right >= 0:
                                    violation_detected = True
                                    box_label = f"VIOLATION ({speed_kmh:.1f} km/h)" # 🔴 ဖောက်ဖျက်လျှင် ပြမည့်စာသား
                                    cv2.rectangle(frame, (int(x1_pix), int(y1_pix)), (int(x2_pix), int(y2_pix)), (0, 0, 255), 2)
                                    cv2.putText(frame, box_label, (int(x1_pix), int(y1_pix) - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
                                    
                                    current_time_chk = time.time()
                                    if current_time_chk - last_alert_times[camera_id] > COOLDOWN_SECONDS and not new_snapshot_url:
                                        snapshot_dir = os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"V-{int(current_time_chk)}_{camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)
                                        
                                        cv2.imwrite(snap_path, frame)
                                        new_snapshot_url = f"/evidence_snapshots/{snap_filename}"
                                        
                                        # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                        threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()
                            
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "label": box_label # 🟢 React ဆီသို့ Speed ပါ ပို့ပေးမည်
                            })
                
                # Send violation alert if needed
                fps = 0.0
                time_diff = time.time() - start_time
                if time_diff > 0:
                    fps = 1.0 / time_diff
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
                            'roi_polygon': json.dumps(camera_rois[camera_id]),
                            'snapshot_url': new_snapshot_url
                        }
                        
                        alert_msg = {
                            "type": "VIOLATION_ALERT",
                            "camera": camera_id,
                            "message": "Potential Section 35 Violation detected!"
                        }
                        await websocket.send_json(alert_msg)
                
                # Send directly as JSON array to match the frontend update
                payload = {
                    "type": "BBOX_DATA",
                    "boxes": boxes,
                    "fps": fps
                }
                await websocket.send_json(payload)
                
    except WebSocketDisconnect:
        print(f"[{camera_id}] WebSocket disconnected")
    except Exception as e:
        print(f"[{camera_id}] Error in WebSocket loop: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
