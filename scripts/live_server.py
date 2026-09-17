import asyncio
import functools
import cv2
import json
from dotenv import load_dotenv
import reid_engine
import speed_estimator
import violation_annotation
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
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path

load_dotenv()  # loads .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DB_PASSWORD, ...) if present

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

# Serve calibration images
public_dir = os.path.join(base_dir, "public", "calibration_results")
os.makedirs(public_dir, exist_ok=True)
app.mount("/calibration_results", StaticFiles(directory=public_dir), name="calibration_results")

model_path = os.environ.get("MODEL_PATH",str(base_dir /"models/model_v4.pt"))
print(f"Loading YOLO model from {model_path}...")
model = ultralytics.YOLO(model_path)
print("Model loaded successfully.")

# Global state for ROIs and alerts
camera_rois = {}
last_alert_times = {}
alerted_track_ids = __import__('collections').defaultdict(set)
COOLDOWN_SECONDS = 15.0

# Frame buffers and recordings
frame_buffers = collections.defaultdict(lambda: collections.deque(maxlen=60))
active_recordings = {}

# Custom BoT-SORT config tuned to keep truck track_ids stable (see the file for
# the reasoning). Stable ids matter because speed_estimator resets a vehicle's
# Kalman filter every time its id changes.
TRACKER_CFG = str(base_dir / "scripts" / "trackers" / "botsort_truck.yaml")

# DB Config
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'database': 'section35_db'
}

import requests

# Bot Token/ Chat ID: set via environment, never hardcoded (this repo is public).
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')

# How bright the rest of the evidence image stays (0 = black, 1 = untouched).
SNAPSHOT_DIM = 0.55
SNAPSHOT_DIM_PAD = 8  # px kept at full brightness around the violating box
SNAPSHOT_BOX_ALPHA = 1.25  # contrast boost applied to the truck itself
SNAPSHOT_BOX_BETA = 30     # brightness boost applied to the truck itself

# --- Violation rule -------------------------------------------------------
# A truck counts as a violation only when BOTH hold:
#   1. the middle of its box's bottom edge (≈ tyre-contact point) stays inside
#      the ROI polygon for this many consecutive frames (debounce vs. detector
#      jitter - one noisy frame no longer fires an alert), and
ROI_DEBOUNCE_FRAMES = 15
#   2. its estimated speed is at least this. Set to 0.0 to flag ANY truck in
#      the ROI regardless of speed (pure lane-restriction enforcement).
SPEED_LIMIT_KMH = 0

def highlight_violation(frame, bbox, dim=SNAPSHOT_DIM, pad=SNAPSHOT_DIM_PAD,
                         box_alpha=SNAPSHOT_BOX_ALPHA, box_beta=SNAPSHOT_BOX_BETA):
    """Return a copy of `frame` with everything outside `bbox` dimmed and the
    violating vehicle itself brightened, so it stands out in the saved
    evidence snapshot. Falls back to the untouched frame if the bbox is
    missing or unusable."""
    if bbox is None:
        return frame
    try:
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in bbox)
        x1 = max(0, min(w, x1 - pad)); x2 = max(0, min(w, x2 + pad))
        y1 = max(0, min(h, y1 - pad)); y2 = max(0, min(h, y2 + pad))
        if x2 <= x1 or y2 <= y1:
            return frame
        out = cv2.convertScaleAbs(frame, alpha=dim, beta=0)  # dim everywhere
        out[y1:y2, x1:x2] = cv2.convertScaleAbs(               # brighten the truck
            frame[y1:y2, x1:x2], alpha=box_alpha, beta=box_beta
        )
        return out
    except Exception as exc:
        print(f"[highlight_violation] skipped ({exc})")
        return frame

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

def save_video_and_db(camera_id, frames, violation_id, roi_polygon_json, snapshot_url="", violating_bbox=None, trigger_frame=None, speed_kmh=0.0):
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
        
    # 2. Re-ID and MySQL Insert Block
    try:
        # Extract Fingerprint
        fp_json = None
        route_match_id = None
        cam_route = None
        cam_dir = None
        cam_km = 0.0
        
        if trigger_frame is not None and violating_bbox is not None:
            fp_vector = reid_engine.get_fingerprint_from_frame(trigger_frame, violating_bbox)
            if fp_vector:
                fp_json = json.dumps(fp_vector)
                
                # Check DB for match
                current_time = datetime.now()
                matched = reid_engine.find_matching_route(DB_CONFIG, fp_vector, camera_id, current_time)
                
                if matched:
                    route_match_id = matched
                else:
                    route_match_id = f"ROUTE-{int(current_time.timestamp())}"
        
        # Get metadata
        if camera_id in reid_engine.camera_meta:
            meta = reid_engine.camera_meta[camera_id]
            cam_route = meta['route']
            cam_dir = meta['direction']
            cam_km = meta['km']

        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        sql = """INSERT INTO violations 
                 (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url, fingerprint, route_match_id, camera_route, camera_direction, camera_km, speed_kmh) 
                 VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"""
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, evidence_video_url, filename, snapshot_url, fp_json, route_match_id, cam_route, cam_dir, cam_km, float(speed_kmh) if speed_kmh is not None else None)
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
    
    # Speed: use a fresh estimator for this job. Time comes from the frame
    # index / real fps, which is exact for a recorded file (no clock jitter).
    speed_estimator.reset_estimator(req.camera_id)
    alerted_track_ids.pop(req.camera_id, None)   # fresh de-dup set per job
    roi_streak = collections.defaultdict(int)    # track_id -> consecutive in-ROI frames
    src_fps = fps if fps and fps > 1 else 30.0
    frame_idx = 0
    prev_gray = None
    opt_points = {}

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        msec = cap.get(cv2.CAP_PROP_POS_MSEC)
        if msec > 0:
            video_time_sec = msec / 1000.0
        else:
            video_time_sec = frame_idx / src_fps
            
        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            
        if roi_poly is not None:
            cv2.polylines(frame, [roi_poly.reshape((-1, 1, 2))], isClosed=True, color=(0, 0, 255), thickness=2)

        start_time = time.time()
        # NOTE: do NOT pass half=True (or the made-up `quantize=` kwarg some earlier
        # version of this comment mentioned — Ultralytics has no such argument and
        # passing it raises SyntaxError: 'quantize' is not a valid YOLO argument,
        # which killed inference outright). The real hazard is Model.predict()
        # recreating self.predictor (and therefore its tracker) whenever the kwargs
        # it resolves differ from the previous call. A fresh tracker means every
        # detection gets a brand-new track_id, so speed_estimator.update() never
        # accumulates samples for a track -> the label is stuck on "Tracking...".
        # Passing the exact same kwargs on every call (as below, with no half/
        # quantize toggle at all) keeps the same predictor/tracker across calls so
        # track IDs (and therefore speed) persist frame to frame.
        # iou=0.4 (default is 0.7): the stock NMS threshold is too loose for this
        # single-class model — long trucks regularly produce two overlapping "truck"
        # boxes for the same physical vehicle (cab-only vs cab+trailer), each getting
        # its own track_id, so the same truck shows two overlapping on-screen boxes
        # (one with a converged speed, one stuck on "Tracking..."). A tighter IoU
        # collapses most of these duplicates in NMS before tracking ever sees them.
        # Use conf=0.35 instead of 0.8 to allow the tracker to bridge gaps
        results = model.track(source=frame, conf=0.35, iou=0.2, device="mps", verbose=False, persist=True, tracker=TRACKER_CFG)
        result = results[0]

        boxes = []
        violation_detected = False
        violating_bbox = None
        new_snapshot_url = ""
        if result.boxes is not None:
                    # 🟢 Track ID များကို ယူပါမည်
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = model.names[cls_id]
                        confirmed=False
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1
                            
                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * w)
                            y1_pix = int(coords[1] * h)
                            x2_pix = int(coords[2] * w)
                            y2_pix = int(coords[3] * h)
                            
                            opt_point = None
                            raw_center = ((x1_pix + x2_pix) / 2.0, float(y2_pix))

                            if track_id != -1 and prev_gray is not None and track_id in opt_points:
                                p0 = np.array([[opt_points[track_id]]], dtype=np.float32)
                                p1, st, err = cv2.calcOpticalFlowPyrLK(prev_gray, curr_gray, p0, None, winSize=(15, 15), maxLevel=2, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 10, 0.03))
                                if st[0][0] == 1:
                                    nx, ny = p1[0][0]
                                    # Ensure flow point doesn't drift outside the bounding box
                                    if x1_pix <= nx <= x2_pix and y1_pix <= ny <= y2_pix:
                                        if abs(ny - y2_pix) < (y2_pix - y1_pix) * 0.2:
                                            opt_point = (float(nx), float(ny))
                            
                            if opt_point is None:
                                opt_point = raw_center
                            
                            if track_id != -1:
                                opt_points[track_id] = opt_point
                            
                            # 🟢 Speed: bottom-centre ground point -> homography/fallback
                            #    -> constant-velocity Kalman filter (see speed_estimator.py)
                            estimator = speed_estimator.get_estimator(req.camera_id, w, h)
                            speed_kmh = estimator.update(
                                track_id,
                                (x1_pix, y1_pix, x2_pix, y2_pix),
                                video_time_sec,
                                opt_point=opt_point
                            )

                            # Box ပေါ်တွင်ပေါ်မည့် စာသား
                            box_label = "Truck" if speed_kmh is None else f"Truck({speed_kmh:.1f} km/h)"

                            if roi_poly is not None:
                                # Check multiple points of the bounding box for more robust ROI intersection
                                box_points = [
                                    (int((x1_pix + x2_pix) / 2), int(y2_pix)), # bottom center
                                    (int((x1_pix + x2_pix) / 2), int((y1_pix + y2_pix) / 2)), # center
                                    (int(x1_pix), int(y2_pix)), # bottom left
                                    (int(x2_pix), int(y2_pix)), # bottom right
                                    (int(x1_pix), int(y1_pix)), # top left
                                    (int(x2_pix), int(y1_pix))  # top right
                                ]
                                in_roi = any(cv2.pointPolygonTest(roi_poly, pt, False) >= 0 for pt in box_points)

                                if track_id != -1:
                                    roi_streak[track_id] = roi_streak[track_id] + 1 if in_roi else 0

                                over_limit = SPEED_LIMIT_KMH <= 0 or (speed_kmh is not None and speed_kmh >= SPEED_LIMIT_KMH)
                                confirmed = (
                                    in_roi
                                    and track_id != -1
                                    and roi_streak[track_id] >= ROI_DEBOUNCE_FRAMES
                                    and over_limit
                                )

                                if confirmed:
                                    violation_detected = True
                                    violation_found = True  # flags the final DB insert below to run
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    violating_speed_kmh = speed_kmh
                                    # HUD-style violation marker: outline-only red box + floating
                                    # arrow + "VIOLATION" tag, all anchored above y1 so the truck
                                    # itself stays fully visible in both the live feed and the
                                    # evidence snapshot taken from this same frame below.
                                    violation_annotation.draw_violation_annotation(frame, x1_pix, y1_pix, x2_pix, y2_pix)

                                    current_time_chk = time.time()
                                    if track_id not in alerted_track_ids[req.camera_id] and not new_snapshot_url:
                                        alerted_track_ids[req.camera_id].add(track_id)
                                        snapshot_dir = os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"V-{int(current_time_chk)}_{req.camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)

                                        # Dim everything except the violating truck so the
                                        # evidence image points straight at the offender.
                                        cv2.imwrite(snap_path, highlight_violation(frame, violating_bbox))
                                        new_snapshot_url = f"/evidence_snapshots/{snap_filename}"
                                        snapshot_url = new_snapshot_url  # carried into the final DB insert below

                                        # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                        threading.Thread(target=send_telegram_alert, args=(req.camera_id, speed_kmh, snap_path)).start()
                            
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "label": box_label # 🟢 React ဆီသို့ Speed ပါ ပို့ပေးမည်
                            })

                    # drop Kalman filters for tracks that left the frame (grace window
                    # keeps a briefly-missing track's samples so it doesn't reset to
                    # "Tracking..." every time the detector flickers for a frame)
                    speed_estimator.get_estimator(req.camera_id, w, h).cleanup(track_ids, now=video_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_streak if t not in _live_ids]:
                        del roi_streak[_tid]


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
        prev_gray = curr_gray
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
            sql = """INSERT INTO violations (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url, speed_kmh) 
                     VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"""
            val = (violation_id_str, datetime.now(), req.camera_id, json.dumps(req.roi_points), f"/recorded_videos/{output_filename}", output_filename, snapshot_url, float(violating_speed_kmh) if 'violating_speed_kmh' in locals() else 0.0)
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

    # Bug fix (1 + 2): give every connection its OWN model so the per-model
    # ByteTrack state is not shared between cameras, and run inference in a
    # worker thread so a slow frame never blocks the asyncio event loop /
    # the other connected clients.
    conn_model = YOLO(model_path)
    loop = asyncio.get_running_loop()
    speed_estimator.reset_estimator(camera_id)   # fresh Kalman state per connection
    roi_streak = collections.defaultdict(int)    # track_id -> consecutive in-ROI frames
    prev_gray = None
    opt_points = {}
    print(f"[{camera_id}] Loaded a private model instance for this connection")

    try:
        while True:
            # Receive message (could be bytes or text)
            message = await websocket.receive()

            # Raw receive() returns the ASGI disconnect message itself instead of
            # raising WebSocketDisconnect (that only happens via receive_text() /
            # receive_bytes() / receive_json()). Without this check the loop just
            # looped back around and called receive() again on an already-closed
            # socket, which Starlette then refuses with a RuntimeError on every
            # single normal client disconnect — logged as a misleading "Error in
            # WebSocket loop" instead of the clean disconnect it actually is.
            if message["type"] == "websocket.disconnect":
                print(f"[{camera_id}] WebSocket disconnected")
                break

            if "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "SET_LANE_ROI":
                        camera_rois[camera_id] = data.get("points")
                        print(f"[{camera_id}] Updated ROI: {camera_rois[camera_id]}")
                    elif data.get("type") == "TRIGGER_CALIBRATION":
                        stream_url = data.get("stream_url")
                        print(f"[{camera_id}] TRIGGER_CALIBRATION received! Spawning auto_calibrate_vp.py...")
                        def run_calibration():
                            try:
                                asyncio.run_coroutine_threadsafe(websocket.send_json({"type": "CALIBRATION_STATUS", "status": "started", "camera": camera_id}), loop)
                                import subprocess, sys
                                script_path = os.path.join(base_dir, "scripts", "auto_calibrate_vp.py")
                                subprocess.run([sys.executable, script_path, camera_id, "--stream", stream_url, "--max_frames", "600"], check=True)
                                print(f"[{camera_id}] Auto-calibration finished. Reloading speed_estimator!")
                                speed_estimator.reload_calibration()
                                asyncio.run_coroutine_threadsafe(websocket.send_json({"type": "CALIBRATION_STATUS", "status": "done", "camera": camera_id, "image_url": f"/calibration_results/{camera_id}_vp.jpg"}), loop)
                            except Exception as e:
                                print(f"[{camera_id}] Auto-calibration error: {e}")
                                asyncio.run_coroutine_threadsafe(websocket.send_json({"type": "CALIBRATION_STATUS", "status": "failed", "camera": camera_id}), loop)
                        threading.Thread(target=run_calibration).start()
                    elif data.get("type") == "SAVE_MANUAL_CALIBRATION":
                        pts = data.get("image_points")
                        width = float(data.get("width_m", 3.5))
                        length = float(data.get("length_m", 27.0))
                        
                        if pts and len(pts) == 4:
                            world_pts = [[0.0, length], [width, length], [width, 0.0], [0.0, 0.0]]
                            # NOTE: `json` is already imported at module level (top of file).
                            # A local `import json` here would shadow it for this ENTIRE
                            # function (Python scopes a name as local to a function the
                            # moment it's assigned/imported anywhere in that function body),
                            # breaking every other json.loads/json.dumps call above in this
                            # same websocket_endpoint — including the very first one, for
                            # every message type — with UnboundLocalError.
                            calib_path = os.path.join(base_dir, "calibration.json")
                            cdata = {}
                            if os.path.exists(calib_path):
                                try:
                                    with open(calib_path, "r") as f: cdata = json.load(f)
                                except Exception: pass
                            
                            cams = cdata.setdefault("cameras", {})
                            entry = cams.get(camera_id, {})
                            entry["image_points"] = pts
                            entry["world_points_m"] = world_pts
                            entry["max_speed_kmh"] = 160
                            cams[camera_id] = entry
                            
                            with open(calib_path, "w") as f:
                                json.dump(cdata, f, indent=2)
                                
                            print(f"[{camera_id}] Manual calibration saved. Reloading speed_estimator!")
                            speed_estimator.reload_calibration()
                            asyncio.run_coroutine_threadsafe(websocket.send_json({"type": "CALIBRATION_STATUS", "status": "manual_done", "camera": camera_id}), loop)
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
                        threading.Thread(target=save_video_and_db, args=(camera_id, rec['frames'], rec['violation_id'], rec['roi_polygon'], rec.get('snapshot_url', ''), rec.get('violating_bbox', None), rec.get('trigger_frame', None), rec.get('speed_kmh', 0.0))).start()
                        del active_recordings[camera_id]
                    
                h, w = frame.shape[:2]
                curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                
                # Run inference
                start_time = time.time()
                
                # 🟢 2. Live အတွက် M2 GPU (mps) ကို သုံးပါ
                #    Run on a thread so the event loop stays free for other clients.
                #    NOTE: no half/quantize kwarg here — Ultralytics has no `quantize`
                #    argument (passing it raises SyntaxError and kills inference); see
                #    the matching comment on the recorded-playback model.track() call
                #    above for why toggling half=True between calls silently breaks
                #    tracker persistence instead (new track_id every frame -> speed
                #    never computes -> label stuck on "Tracking...").
                # iou=0.4: see the matching comment on the recorded-playback
                # model.track() call above — tightens NMS so a single long truck
                # doesn't produce two overlapping boxes (and two track_ids).
                # 🟢 iou ကို 0.3 သို့လျှော့ချပြီး agnostic_nms=True ကို ထပ်ထည့်ပါ
                results = await loop.run_in_executor(
                    None,
                    functools.partial(
                        conn_model.track, source=frame, conf=0.35, iou=0.3, agnostic_nms=True, device="mps",
                        verbose=False, persist=True, tracker=TRACKER_CFG,
                    ),
                )
                result = results[0]
                
                boxes = []
                violation_detected = False
                violating_bbox = None
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
                    # Hoisted above the loop so it's always defined for cleanup() below,
                    # even on a frame with zero truck detections.
                    current_time_sec = time.time()

                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = conn_model.names[cls_id]
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1

                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * w)
                            y1_pix = int(coords[1] * h)
                            x2_pix = int(coords[2] * w)
                            y2_pix = int(coords[3] * h)
                            
                            opt_point = None
                            raw_center = ((x1_pix + x2_pix) / 2.0, float(y2_pix))

                            if track_id != -1 and prev_gray is not None and track_id in opt_points:
                                p0 = np.array([[opt_points[track_id]]], dtype=np.float32)
                                p1, st, err = cv2.calcOpticalFlowPyrLK(prev_gray, curr_gray, p0, None, winSize=(15, 15), maxLevel=2, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 10, 0.03))
                                if st[0][0] == 1:
                                    nx, ny = p1[0][0]
                                    # Ensure flow point doesn't drift outside the bounding box
                                    if x1_pix <= nx <= x2_pix and y1_pix <= ny <= y2_pix:
                                        if abs(ny - y2_pix) < (y2_pix - y1_pix) * 0.2:
                                            opt_point = (float(nx), float(ny))
                            
                            if opt_point is None:
                                opt_point = raw_center
                            
                            if track_id != -1:
                                opt_points[track_id] = opt_point

                            # 🟢 Speed: bottom-centre ground point -> homography (if the
                            #    camera is calibrated in calibration.json) or a constant
                            #    fallback scale -> constant-velocity Kalman filter.
                            #    See scripts/speed_estimator.py for the full explanation.
                            estimator = speed_estimator.get_estimator(camera_id, w, h)
                            speed_kmh = estimator.update(
                                track_id,
                                (x1_pix, y1_pix, x2_pix, y2_pix),
                                current_time_sec,
                                opt_point=opt_point
                            )

                            # Box ပေါ်တွင်ပေါ်မည့် စာသား
                            box_label = "Tracking..." if speed_kmh is None else f"{speed_kmh:.1f} km/h"

                            if roi_poly is not None:
                                # Check multiple points of the bounding box for more robust ROI intersection
                                box_points = [
                                    (int((x1_pix + x2_pix) / 2), int(y2_pix)), # bottom center
                                    (int((x1_pix + x2_pix) / 2), int((y1_pix + y2_pix) / 2)), # center
                                    (int(x1_pix), int(y2_pix)), # bottom left
                                    (int(x2_pix), int(y2_pix)), # bottom right
                                    (int(x1_pix), int(y1_pix)), # top left
                                    (int(x2_pix), int(y1_pix))  # top right
                                ]
                                in_roi = any(cv2.pointPolygonTest(roi_poly, pt, False) >= 0 for pt in box_points)

                                if track_id != -1:
                                    roi_streak[track_id] = roi_streak[track_id] + 1 if in_roi else 0

                                over_limit = SPEED_LIMIT_KMH <= 0 or (speed_kmh is not None and speed_kmh >= SPEED_LIMIT_KMH)
                                confirmed = (
                                    in_roi
                                    and track_id != -1
                                    and roi_streak[track_id] >= ROI_DEBOUNCE_FRAMES
                                    and over_limit
                                )

                                if confirmed:
                                    violation_detected = True
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    violating_speed_kmh = speed_kmh
                                    # HUD-style violation marker: outline-only red box + floating
                                    # arrow + "VIOLATION" tag, all anchored above y1 so the truck
                                    # itself stays fully visible in both the live feed and the
                                    # evidence snapshot taken from this same frame below.
                                    violation_annotation.draw_violation_annotation(frame, x1_pix, y1_pix, x2_pix, y2_pix)

                                    current_time_chk = time.time()
                                    if track_id not in alerted_track_ids[camera_id] and not new_snapshot_url:
                                        alerted_track_ids[camera_id].add(track_id)
                                        snapshot_dir = os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"V-{int(current_time_chk)}_{camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)
                                        
                                        # Dim everything except the violating truck so the
                                        # evidence image points straight at the offender.
                                        cv2.imwrite(snap_path, highlight_violation(frame, violating_bbox))
                                        new_snapshot_url = f"/evidence_snapshots/{snap_filename}"
                                        
                                        # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                        threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()
                            
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "track_id": track_id, # 🟢 client keys each box by this so velocity / label stay with the right vehicle
                                "label": box_label # 🟢 React ဆီသို့ Speed ပါ ပို့ပေးမည်
                            })

                    # drop Kalman filters for tracks that left the frame (grace window
                    # keeps a briefly-missing track's samples so it doesn't reset to
                    # "Tracking..." every time the detector flickers for a frame)
                    speed_estimator.get_estimator(camera_id, w, h).cleanup(track_ids, now=current_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_streak if t not in _live_ids]:
                        del roi_streak[_tid]

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
                            'snapshot_url': new_snapshot_url,
                            'violating_bbox': violating_bbox,
                            'trigger_frame': frame.copy(),
                            'speed_kmh': violating_speed_kmh
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
    finally:
        # Free this connection's Kalman filters and its alerted-track set so
        # state does not leak between connections / grow without bound.
        speed_estimator.reset_estimator(camera_id)
        alerted_track_ids.pop(camera_id, None)
        print(f"[{camera_id}] Connection state cleaned up")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
