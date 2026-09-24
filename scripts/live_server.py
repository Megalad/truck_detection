import asyncio
import functools
import cv2
import json
from dotenv import load_dotenv
import reid_engine
from device_util import pick_device
import speed_estimator
import violation_annotation
import torch
import numpy as np
import ultralytics
import os
import time
import collections
import threading
import re
import secrets
import shutil
import traceback
import mysql.connector
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
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

# Serve evidence/recording media directly from the backend that writes it.
# Vite's dev-server public-dir serving does NOT see files created in these
# folders after its process starts (its watcher ignores them - see
# vite.config.js - to stop reload-mid-fetch races, but that also drops them
# from its own static-serving lookup for the rest of that dev session). This
# backend always does a live disk read per request, so it never goes stale.
for _subdir in ("evidence_snapshots", "recorded_videos"):
    _dir = os.path.join(base_dir, "public", _subdir)
    os.makedirs(_dir, exist_ok=True)
    app.mount(f"/{_subdir}", StaticFiles(directory=_dir), name=_subdir)

model_path = os.environ.get("MODEL_PATH",str(base_dir /"models/model_v6.pt"))
print(f"Loading YOLO model from {model_path}...")
model = ultralytics.YOLO(model_path)
print("Model loaded successfully.")

# Experimental segmentation model (Plan B - see truck_seg/) for /api/detect_demo's box-vs-seg
# comparison only. Loaded lazily, the first time someone actually picks "Segmentation" in the
# Project Report demo, so a missing/not-yet-downloaded file can't slow down or crash startup of
# the real live pipeline above. Drop the trained weights at SEG_MODEL_PATH to enable it.
SEG_MODEL_PATH = os.environ.get("SEG_MODEL_PATH", str(base_dir / "models/model_seg_v1.pt"))
_seg_model = None
def _get_seg_model():
    global _seg_model
    if _seg_model is None:
        if not os.path.exists(SEG_MODEL_PATH):
            return None
        print(f"Loading segmentation YOLO model from {SEG_MODEL_PATH}...")
        _seg_model = ultralytics.YOLO(SEG_MODEL_PATH)
        # Whatever this model's training run named class 0 ("Truck-Detection-qOuI" as
        # trained) - it's still just a truck, and .plot() draws the class name straight
        # onto the image verbatim. Renaming it here, once, at load time fixes the label
        # everywhere this model is used (the demo page AND the live Seg toggle) with a
        # single change. NOTE: YOLO.names is a read-only PROPERTY (returns a freshly
        # revalidated copy via check_class_names() on every access, per ultralytics'
        # source) - assigning to _seg_model.names[0] silently mutates a throwaway copy
        # and never sticks. The real, persistent storage is the underlying nn.Module at
        # .model.names; mutating that is what .names actually reads from each time.
        if 0 in _seg_model.model.names:
            _seg_model.model.names[0] = "truck"
        print("Segmentation model loaded successfully.")
    return _seg_model

# --- ROI persistence + admin auth -----------------------------------------
# The ROI used to live only in each browser's own localStorage, resent on connect and
# otherwise invisible to anyone else - a different viewer's browser had nothing to
# render, and the server-side value (used for actual violation detection) was reset to
# None on every single new connection to a camera, admin or not. Now it's saved here,
# on the server, and pushed to every viewer on connect (see CURRENT_ROI below); only a
# signed-in admin session may change it via SET_LANE_ROI. camera_rois is the in-memory
# working copy; ROI_FILE is what actually persists it across restarts.
camera_rois = {}
ROI_FILE = os.path.join(base_dir, "rois.json")


def _load_rois():
    try:
        with open(ROI_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_roi(camera_id, points):
    data = _load_rois()
    if points:
        data[camera_id] = points
    else:
        data.pop(camera_id, None)
    try:
        with open(ROI_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except OSError as e:
        print(f"WARNING: could not persist rois.json: {e}")


# Single shared admin account (this site has exactly one operator role, not
# per-person accounts) - set in .env, never hardcoded. No default password: an
# unset ADMIN_PASSWORD disables login entirely rather than silently accepting
# a guessable one.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_SESSION_SECONDS = 12 * 3600  # a work day; avoids re-login mid-demo without staying open forever
admin_sessions = {}  # token -> expiry (unix seconds)


def _valid_admin_token(token):
    if not token:
        return False
    exp = admin_sessions.get(token)
    if exp is None:
        return False
    if time.time() > exp:
        admin_sessions.pop(token, None)
        return False
    return True


last_alert_times = {}
alerted_track_ids = __import__('collections').defaultdict(set)
COOLDOWN_SECONDS = 15.0

# Frame buffers and recordings

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
SNAPSHOT_DIM = 0.7
SNAPSHOT_DIM_PAD = 5  # px kept at full brightness around the violating box
SNAPSHOT_BOX_ALPHA = 1.0  # contrast boost applied to the truck itself
SNAPSHOT_BOX_BETA = 0     # brightness boost applied to the truck itself

# --- Violation rule -------------------------------------------------------
# A truck counts as a violation only when BOTH hold:
#   1. the middle of its box's bottom edge (≈ tyre-contact point) stays inside
#      the ROI polygon for this many consecutive frames (debounce vs. detector
#      jitter - one noisy frame no longer fires an alert), and
ROI_DEBOUNCE_FRAMES = 15
# Live monitoring analyses the ~640px-wide frames the browser sends, at roughly this many
# per second. Recorded playback reproduces that: same frame size, and a debounce of the
# same duration (see process_recorded). Tune LIVE_FPS_ESTIMATE if live runs faster/slower.
LIVE_FRAME_WIDTH = 640
LIVE_FPS_ESTIMATE = 10.0
# Live's own debounce is measured in real elapsed seconds rather than a frame count: a slow
# server (CPU-only inference, several cameras open, etc.) delivers frames far slower than the
# video plays, so a frame-count debounce can span many real seconds - long enough for a fast
# truck to cross the ROI and leave before enough frames ever accumulate, silently missing it.
# Time-based debounce stays ~1.5s (15 frames @ LIVE_FPS_ESTIMATE) no matter how fast frames
# actually arrive. Recorded playback keeps the frame-count version (debounce_frames below) -
# it processes every video frame regardless of wall-clock speed, so that timing is already
# exact and isn't subject to this problem.
ROI_DEBOUNCE_SECONDS = ROI_DEBOUNCE_FRAMES / LIVE_FPS_ESTIMATE
# Detection confidence used by every pipeline (live + recorded). Lower values
# keep tracks alive through dips (distance/night); higher values cut false boxes.
# 0.5 was silently dropping real trucks that were just a bit distant or partly occluded
# (e.g. one truck behind another) - checked against live frames from 5 cameras: every
# detection in the 0.35-0.5 band was a genuine truck, none were cars/background, so there
# was no accuracy cost to lowering it. Revisit if false-positive boxes start showing up.
DETECTION_CONF = 0.4
# The experimental seg_v1 model needs a separate, higher bar: measured on 400 real frames
# of night footage (TV27CL1.mp4), conf=0.4 produced frequent low-confidence duplicate/
# fragmented boxes (avg conf 0.58, up to 2 simultaneous boxes on what was actually one
# truck, spurious hits on light glare on wet road) - raising to 0.6 cut detections from
# 456 to 110 across those frames and dropped simultaneous-box count to 1, i.e. genuinely
# removed the noise rather than also losing real trucks (spot-checked visually). Does not
# touch DETECTION_CONF above, which stays exactly as tuned for the real production model.
SEG_DETECTION_CONF = 0.6
# cuda:0 on an NVIDIA box, mps on Apple silicon, else cpu; override with YOLO_DEVICE.
DEVICE = pick_device()
print(f"Inference device: {DEVICE}")
#   2. its estimated speed is at least this. 0.0 flags ANY truck in the ROI
#      regardless of speed - pure lane-restriction enforcement, which is what
#      Section 35 actually is (no speed threshold involved), so this is fixed
#      rather than operator-adjustable (the old UI control and /api/speed_limit
#      endpoint were removed - there was never a real reason to raise it above 0).
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

SNAPSHOT_TARGET_WIDTH = 1920   # evidence images are rendered 1920x1080; the marker is drawn at this size
SNAPSHOT_JPEG_QUALITY = 95

def write_evidence_snapshot(clean_frame, bbox, snap_path):
    """Writes the evidence image: the pre-annotation frame, upscaled to
    SNAPSHOT_TARGET_WIDTH, with the violation marker drawn at the upscaled
    size (so it is sharp rather than a tiny icon the viewer later stretches).
    Detail can't exceed the source: inference frames are 640px wide."""
    evidence_frame = highlight_violation(clean_frame, bbox, pad=round(SNAPSHOT_DIM_PAD * clean_frame.shape[1] / 640))
    k = SNAPSHOT_TARGET_WIDTH / evidence_frame.shape[1]
    if k > 1:
        evidence_frame = cv2.resize(evidence_frame, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
    else:
        k = 1.0
    x1, y1, x2, y2 = bbox
    # marker size is relative to the 640px frame it was designed for, whatever the source width was
    violation_annotation.draw_violation_annotation(evidence_frame, x1 * k, y1 * k, x2 * k, y2 * k,
                                                   scale=evidence_frame.shape[1] / 640)
    cv2.imwrite(snap_path, evidence_frame, [cv2.IMWRITE_JPEG_QUALITY, SNAPSHOT_JPEG_QUALITY])

DUP_ALERT_WINDOW_SECONDS = 5.0   # a box overlapping one alerted within this window is the same truck
DUP_ALERT_OVERLAP = 0.5          # intersection / smaller box area
_recent_alert_boxes = collections.defaultdict(list)   # camera_id -> [(time, bbox)]

def _claim_alert(camera_id, bbox, now):
    """True if a violation alert may be raised for `bbox`; records it. False if
    an alert for an overlapping box was raised on this camera a moment ago."""
    recent = [(t, b) for t, b in _recent_alert_boxes[camera_id] if now - t <= DUP_ALERT_WINDOW_SECONDS]
    _recent_alert_boxes[camera_id] = recent
    x1, y1, x2, y2 = bbox
    area = max(1, (x2 - x1) * (y2 - y1))
    for _, (a1, b1, a2, b2) in recent:
        iw = min(x2, a2) - max(x1, a1)
        ih = min(y2, b2) - max(y1, b1)
        if iw > 0 and ih > 0 and iw * ih / min(area, max(1, (a2 - a1) * (b2 - b1))) >= DUP_ALERT_OVERLAP:
            return False
    recent.append((now, bbox))
    return True

def send_telegram_alert(camera_id, speed, snapshot_path):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
        
        # ပို့ချင်သော စာသား (Caption)
        caption = f"Violation Detected!!\nCamera: {camera_id}\nSpeed: {speed:.1f} km/h\nTime: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        
        with open(snapshot_path, 'rb') as photo:
            files = {'photo': photo}
            data = {'chat_id': TELEGRAM_CHAT_ID, 'caption': caption}
            requests.post(url, data=data, files=files)
            
        print(f"[{camera_id}] Telegram Alert ပို့ပြီးပါပြီ!")
    except Exception as e:
        print(f"Telegram Error: {e}")

def save_violation_to_db(camera_id, violation_id, roi_polygon_json, snapshot_url="", violating_bbox=None, trigger_frame=None, speed_kmh=0.0):
    # Image-only evidence: the snapshot is already on disk; no video is recorded.
    # Re-ID and MySQL insert
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
                 (violation_id, timestamp, camera_location, roi_polygon, evidence_snapshot_url, fingerprint, route_match_id, camera_route, camera_direction, camera_km, speed_kmh) 
                 VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"""
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, snapshot_url, fp_json, route_match_id, cam_route, cam_dir, cam_km, float(speed_kmh) if speed_kmh is not None else None)
        print(f"[{camera_id}] Attempting MySQL INSERT for {violation_id}...")
        cursor.execute(sql, val)
        conn.commit()
        print(f"[{camera_id}] MySQL INSERT successful for {violation_id}!")
        cursor.close()
        conn.close()
        print(f"[{camera_id}] Saved evidence for {violation_id}")
    except Exception as e:
        print(f"ERROR: MySQL Insert failed: {e}")

class AdminLoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest):
    if not ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin login is not configured (set ADMIN_PASSWORD)")
    # Constant-time compare: a plain == leaks timing info character-by-character, which
    # matters for a password check even on a small demo site.
    import hmac
    ok_user = hmac.compare_digest(req.username, ADMIN_USERNAME)
    ok_pass = hmac.compare_digest(req.password, ADMIN_PASSWORD)
    if not (ok_user and ok_pass):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + ADMIN_SESSION_SECONDS
    admin_sessions[token] = expires_at
    return {"token": token, "expires_at": expires_at}


class AdminLogoutRequest(BaseModel):
    token: str


@app.post("/api/admin/logout")
async def admin_logout(req: AdminLogoutRequest):
    admin_sessions.pop(req.token, None)
    return {"ok": True}

class DetectDemoRequest(BaseModel):
    image_base64: str
    model: str = "box"  # "box" = production model_v6.pt, "seg" = experimental truck_seg model

@app.post("/api/detect_demo")
async def detect_demo(req: DetectDemoRequest):
    import base64
    import numpy as np
    import cv2

    header, encoded = req.image_base64.split(",", 1) if "," in req.image_base64 else ("", req.image_base64)
    img_data = base64.b64decode(encoded)
    np_arr = np.frombuffer(img_data, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    if frame is None:
        raise HTTPException(status_code=400, detail="Invalid image")

    active_model = model
    if req.model == "seg":
        active_model = _get_seg_model()
        if active_model is None:
            raise HTTPException(
                status_code=503,
                detail=f"Segmentation model not found at {SEG_MODEL_PATH}. Drop the trained "
                       f"weights there (or set SEG_MODEL_PATH) and try again.",
            )

    # .plot() draws boxes for a detection model and filled masks + boxes for a segmentation
    # one, automatically - same call either way, no branching needed here. Confidence bar
    # differs per model - see SEG_DETECTION_CONF's definition.
    demo_conf = SEG_DETECTION_CONF if req.model == "seg" else DETECTION_CONF
    results = active_model.predict(source=frame, conf=demo_conf, iou=0.3, agnostic_nms=True, device=DEVICE, verbose=False)
    res_frame = results[0].plot()

    _, buffer = cv2.imencode('.jpg', res_frame)
    b64_str = base64.b64encode(buffer).decode('utf-8')

    # Pick the highest-confidence truck box (same class filter as the live pipeline) so
    # the Project Report's "Estimate speed" step can anchor its track-point marker on the
    # actual detected truck instead of a fixed, made-up screen position - same photo, real
    # box, not a second illustration that happens to look similar. A segmentation model's
    # .boxes are still populated the same way (segmentation is a superset, not a
    # replacement), so this works unchanged for either model.
    bbox = None
    best_i = None  # referenced below (mask_ground_point) even when nothing was detected at all
    result_boxes = results[0].boxes
    if result_boxes is not None and len(result_boxes) > 0:
        best_i, best_conf = None, -1.0
        for i in range(len(result_boxes.cls)):
            class_name = active_model.names[int(result_boxes.cls[i])]
            conf = float(result_boxes.conf[i])
            # The production model's classes are exactly "truck"/"heavy_truck". The
            # experimental seg model (Plan B, trained via a merged Roboflow workspace) came
            # back with an odd class 0 name ("Truck-Detection-qOuI") instead - it's still a
            # truck-only model, so match loosely by substring for it rather than hardcoding
            # that exact string (which could change on a re-train) or silently finding none.
            is_truck = class_name in ["truck", "heavy_truck"] or (req.model == "seg" and "truck" in class_name.lower())
            if is_truck and conf > best_conf:
                best_i, best_conf = i, conf
        if best_i is not None:
            x1, y1, x2, y2 = result_boxes.xyxyn[best_i].tolist()
            bbox = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": best_conf}

    # Real body-vs-box ROI point: for a segmentation result, the truck's actual lowest mask
    # pixel (not the bounding box's guessed bottom-center) - this is the whole point of
    # comparing the two models, so the frontend can show it, not just describe it.
    mask_ground_point = None
    result_masks = results[0].masks
    if req.model == "seg" and best_i is not None and result_masks is not None and best_i < len(result_masks.xyn):
        poly = result_masks.xyn[best_i]  # normalized (x, y) polygon points for that instance
        if len(poly) > 0:
            lowest = max(poly, key=lambda pt: pt[1])
            mask_ground_point = {"x": float(lowest[0]), "y": float(lowest[1])}

    # Real re-ID fingerprint (Project Report step 7) - the exact same function
    # save_violation_to_db() calls on a real violation (see reid_engine.get_fingerprint_from_frame),
    # run here on the demo's own detected truck crop. Returns a genuine 512-d embedding; only a
    # slice of it is sent back (a bar chart of all 512 values would be unreadable), but every
    # value in that slice is real model output, not fabricated for display.
    fingerprint = None
    if best_i is not None and reid_engine.reid_session is not None:
        x1p, y1p, x2p, y2p = result_boxes.xyxy[best_i].tolist()
        fp_vector = reid_engine.get_fingerprint_from_frame(frame, (x1p, y1p, x2p, y2p))
        if fp_vector:
            fingerprint = {"dims": len(fp_vector), "sample": [round(v, 4) for v in fp_vector[:24]]}

    return {
        "result_image": f"data:image/jpeg;base64,{b64_str}",
        "bbox": bbox,
        "mask_ground_point": mask_ground_point,
        "model_used": req.model,
        "fingerprint": fingerprint,
    }


# Live-style overlay (mirrors LiveCCTVPlayer.jsx: green box + green label chip, translucent
# red ROI with red vertex dots), drawn into the processed video so playback looks like live.
LIVE_BOX_BGR = (94, 197, 34)      # #22c55e
LIVE_DISPLAY_WIDTH = 940.0        # width the live overlay's fixed pixel sizes were designed for

def draw_live_overlay(frame, roi_poly, items):
    """items: [(x1, y1, x2, y2, label)] in full-res pixels."""
    h, w = frame.shape[:2]
    u = w / LIVE_DISPLAY_WIDTH    # one live "css pixel" in this frame
    if roi_poly is not None:
        layer = frame.copy()
        cv2.fillPoly(layer, [roi_poly.reshape((-1, 1, 2))], (0, 0, 255))
        cv2.addWeighted(layer, 0.2, frame, 0.8, 0, frame)
        cv2.polylines(frame, [roi_poly.reshape((-1, 1, 2))], True, (0, 0, 255), max(1, round(u)), cv2.LINE_AA)
        for px, py in roi_poly:
            cv2.circle(frame, (int(px), int(py)), max(2, round(5 * u)), (0, 0, 255), -1, cv2.LINE_AA)
    font, fscale, fthick = cv2.FONT_HERSHEY_SIMPLEX, 0.42 * u, max(1, round(u))
    for x1, y1, x2, y2, label in items:
        cv2.rectangle(frame, (x1, y1), (x2, y2), LIVE_BOX_BGR, max(1, round(2 * u)))
        if label:
            (tw, _), _ = cv2.getTextSize(label, font, fscale, fthick)
            ch = round(14 * u)
            ly = max(ch, y1)
            cv2.rectangle(frame, (x1, ly - ch), (x1 + tw + round(10 * u), ly), LIVE_BOX_BGR, -1)
            cv2.putText(frame, label, (x1 + round(5 * u), ly - round(3 * u)), font, fscale, (255, 255, 255), fthick, cv2.LINE_AA)


@app.post("/api/process_recorded")
def process_recorded(req: ProcessRequest):
    input_path = os.path.join(base_dir, "public", "recorded_videos", req.video_filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="File not found")
    output_filename = req.video_filename.replace('.mp4', '_processed.mp4')
    output_path = os.path.join(base_dir, "public", "recorded_videos", output_filename)
    # Like uploads: nothing goes to the DB / Telegram; the evidence images come back in the response.
    evidence_name = output_filename.replace('_processed.mp4', '') + "_evidence"
    evidence_dir = os.path.join(base_dir, "public", "recorded_videos", evidence_name)
    shutil.rmtree(evidence_dir, ignore_errors=True)   # drop the previous run's images
    evidence = _process_video(input_path, output_path, req.camera_id, req.roi_points,
                              evidence_dir=evidence_dir, evidence_url_prefix=f"/recorded_videos/{evidence_name}")
    return {"status": "success", "processed_url": f"/recorded_videos/{output_filename}", "evidence": evidence}


def _process_video(input_path, output_path, camera_id, roi_points, evidence_dir=None, evidence_url_prefix=None):
    """Runs a video through the SAME rules as live monitoring and writes the annotated copy to
    output_path: same frame size, NMS, ROI test point, debounce, de-duplication, evidence
    snapshot / DB row / Telegram, and the same on-screen look (draw_live_overlay).
    Blocking (runs in a worker thread), so it doesn't stall live monitoring.

    By default a violating truck is saved as evidence exactly like live (snapshot in
    public/evidence_snapshots, DB row, Telegram). With evidence_dir set (uploaded clips) nothing
    goes to the DB or Telegram: the snapshots are written to evidence_dir and returned as a list
    of {url, track_id, speed_kmh, time_sec} for the caller to show."""
    found_evidence = []
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise HTTPException(status_code=500, detail="Could not open video")
        
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
    
    # Recorded playback follows the live-monitoring rules: detection, tracking, speed
    # and the ROI test all run on the same <=640px-wide frame the browser sends live
    # (so calibration and thresholds mean the same thing); only drawing and the
    # evidence snapshot use the full-resolution frame.
    lw = min(w, LIVE_FRAME_WIDTH)
    lh = round(h * lw / w)
    sx = w / lw
    alert_key = f"rec:{camera_id}"   # keeps recorded de-dup state apart from the live camera's
    proc_model = YOLO(model_path)        # private tracker state, like each live connection

    roi_poly = None
    if len(roi_points) >= 3:
        pts = [[int(pt['x'] * w), int(pt['y'] * h)] for pt in roi_points]
        roi_poly = np.array(pts, dtype=np.int32)                      # full-res, for drawing
        roi_logic = np.array([[int(pt['x'] * lw), int(pt['y'] * lh)] for pt in roi_points], dtype=np.int32)
        
    violation_found = False
    snapshot_url = ""
    violation_id_str = f"V-{int(time.time())}"
    
    # Speed: use a fresh estimator for this job. Time comes from the frame
    # index / real fps, which is exact for a recorded file (no clock jitter).
    speed_estimator.reset_estimator(camera_id)
    alerted_track_ids.pop(alert_key, None)   # fresh de-dup set per job
    _recent_alert_boxes.pop(alert_key, None)
    roi_streak = collections.defaultdict(int)    # track_id -> consecutive in-ROI frames
    src_fps = fps if fps and fps > 1 else 30.0
    # Live counts the frames the browser sends (~LIVE_FPS_ESTIMATE per second); a video has
    # every frame, so scale the debounce to the same length of time.
    debounce_frames = max(1, round(ROI_DEBOUNCE_FRAMES * src_fps / LIVE_FPS_ESTIMATE))
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
            
        small = frame if lw == w else cv2.resize(frame, (lw, lh), interpolation=cv2.INTER_AREA)
        curr_gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            
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
        # conf=DETECTION_CONF (see its definition) - lower values let the tracker bridge gaps
        results = proc_model.track(source=small, conf=DETECTION_CONF, iou=0.3, agnostic_nms=True, device=DEVICE, verbose=False, persist=True, tracker=TRACKER_CFG)
        result = results[0]

        boxes = []
        draw_items = []   # boxes to draw, after all detection logic (so the evidence frame stays clean)
        violation_detected = False
        violating_bbox = None
        new_snapshot_url = ""
        clean_frame = None  # snapshot of `frame` before any triangle is drawn on it this pass
        if result.boxes is not None:
                    # 🟢 Track ID များကို ယူပါမည်
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = proc_model.names[cls_id]
                        confirmed=False
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1
                            
                            # calculate actual pixel coords
                            x1_pix = int(coords[0] * lw)
                            y1_pix = int(coords[1] * lh)
                            x2_pix = int(coords[2] * lw)
                            y2_pix = int(coords[3] * lh)
                            
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
                            estimator = speed_estimator.get_estimator(camera_id, lw, lh)
                            speed_kmh = estimator.update(
                                track_id,
                                (x1_pix, y1_pix, x2_pix, y2_pix),
                                video_time_sec,
                                opt_point=opt_point
                            )

                            # Box ပေါ်တွင်ပေါ်မည့် စာသား
                            box_label = "Tracking..." if speed_kmh is None else f"{speed_kmh:.1f} km/h"   # same text as live

                            if roi_poly is not None:
                                # Same point as live monitoring: the box's bottom-right corner
                                # (the truck's right-side wheel; the restricted lane is on its right)
                                wheel_point = (int(x2_pix), int(y2_pix))
                                in_roi = cv2.pointPolygonTest(roi_logic, wheel_point, False) >= 0

                                if track_id != -1:
                                    roi_streak[track_id] = roi_streak[track_id] + 1 if in_roi else 0

                                over_limit = SPEED_LIMIT_KMH <= 0 or (speed_kmh is not None and speed_kmh >= SPEED_LIMIT_KMH)
                                confirmed = (
                                    in_roi
                                    and track_id != -1
                                    and roi_streak[track_id] >= debounce_frames
                                    and over_limit
                                )

                                if confirmed:
                                    violation_detected = True
                                    violation_found = True  # flags the final DB insert below to run
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    violating_speed_kmh = speed_kmh
                                    if clean_frame is None:
                                        clean_frame = frame.copy()   # full-res, for the evidence image
                                        clean_small = small.copy()   # what live uses, for re-ID
                                    # same box in full-resolution pixels, for drawing and the snapshot
                                    full_bbox = (int(coords[0] * w), int(coords[1] * h), int(coords[2] * w), int(coords[3] * h))
                                    # (the red marker is only drawn on the evidence image, as in live)

                                    # Same de-duplication as live: one alert per track id, and none for a
                                    # box sitting on one just alerted (the tracker can split one truck in two).
                                    _first_sight = track_id not in alerted_track_ids[alert_key]
                                    if _first_sight:
                                        alerted_track_ids[alert_key].add(track_id)
                                    if _first_sight and not new_snapshot_url and _claim_alert(alert_key, violating_bbox, video_time_sec):
                                        current_time_chk = time.time()
                                        violation_id = f"V-{int(current_time_chk)}-{track_id}"
                                        snapshot_dir = evidence_dir or os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"{violation_id}_{camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)

                                        # Built from clean_frame (pre-annotation) so this evidence
                                        # shot only marks THIS truck, even if other trucks elsewhere
                                        # in frame are also confirmed violators right now.
                                        try:
                                            write_evidence_snapshot(clean_frame, full_bbox, snap_path)
                                        except Exception:
                                            print(f"[{camera_id}] ERROR writing evidence snapshot:\n{traceback.format_exc()}")
                                        new_snapshot_url = f"{evidence_url_prefix or '/evidence_snapshots'}/{snap_filename}"
                                        snapshot_url = new_snapshot_url  # carried into the final DB insert below

                                        if evidence_dir:
                                            # uploaded clip: hand the evidence back to the caller only
                                            found_evidence.append({
                                                "url": new_snapshot_url,
                                                "track_id": track_id,
                                                "speed_kmh": None if speed_kmh is None else round(float(speed_kmh), 1),
                                                "time_sec": round(float(video_time_sec), 1),
                                            })
                                        else:
                                            # Insert into DB immediately for each unique violating truck
                                            threading.Thread(target=save_violation_to_db, args=(camera_id, violation_id, json.dumps(roi_points), new_snapshot_url, violating_bbox, clean_small, speed_kmh)).start()

                                            # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                            threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()
                            
                            draw_items.append((int(coords[0] * w), int(coords[1] * h), int(coords[2] * w), int(coords[3] * h), box_label))
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
                    speed_estimator.get_estimator(camera_id, lw, lh).cleanup(track_ids, now=video_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_streak if t not in _live_ids]:
                        del roi_streak[_tid]


        # Live-style on-screen look: green boxes with "Tracking..." / "NN.N km/h" chips, translucent
        # red ROI with vertex dots. Drawn last so the evidence snapshot's clean frame has none of it.
        draw_live_overlay(frame, roi_poly, draw_items)
        prev_gray = curr_gray
        out.write(frame)
            
    out.release()
    cap.release()
    fps = 0.0
    time_diff = time.time() - start_time
    if time_diff > 0:
        fps = 1.0 / time_diff
    # DB insertions are now handled immediately per-truck during processing
    return found_evidence


@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    print(f"[{camera_id}] WebSocket connection opened")
    # Reload from disk (not just the in-memory cache) so a change saved by another
    # worker/restart is picked up, then push it straight to this viewer - everyone
    # who opens this camera sees the same ROI, whether or not they can edit it.
    camera_rois[camera_id] = _load_rois().get(camera_id)
    await websocket.send_json({"type": "CURRENT_ROI", "points": camera_rois[camera_id]})
    last_alert_times[camera_id] = 0.0

    # Bug fix (1 + 2): give every connection its OWN model so the per-model
    # ByteTrack state is not shared between cameras, and run inference in a
    # worker thread so a slow frame never blocks the asyncio event loop /
    # the other connected clients.
    conn_model = YOLO(model_path)
    loop = asyncio.get_running_loop()
    speed_estimator.reset_estimator(camera_id)   # fresh Kalman state per connection
    roi_enter_time = {}    # track_id -> wall-clock time it first entered the ROI (this streak)
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
                        if not _valid_admin_token(data.get("admin_token")):
                            print(f"[{camera_id}] Rejected SET_LANE_ROI: no/expired admin session")
                            await websocket.send_json({"type": "ROI_UNAUTHORIZED"})
                        else:
                            points = data.get("points") or []
                            camera_rois[camera_id] = points if points else None
                            _save_roi(camera_id, points if points else None)
                            print(f"[{camera_id}] Updated ROI: {camera_rois[camera_id]}")
                            # Reflect the confirmed save back to whoever changed it - the admin's
                            # own UI already updated optimistically, but this keeps it consistent
                            # if the save is ever rejected/altered server-side in the future, and
                            # gives every OTHER open tab on this same camera a way to pick it up
                            # too, next time they reconnect.
                            await websocket.send_json({"type": "CURRENT_ROI", "points": camera_rois[camera_id]})
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
                            # Resolution these points were clicked at (browser's native video
                            # size) - speed_estimator.py rescales to whatever it actually runs
                            # at, so this calibration stays correct even if that changes.
                            image_w = data.get("image_width")
                            image_h = data.get("image_height")
                            if image_w and image_h:
                                entry["image_width"] = image_w
                                entry["image_height"] = image_h
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
                
                h, w = frame.shape[:2]
                curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                
                # Run inference
                start_time = time.time()
                
                # 🟢 2. Live inference device: see DEVICE (auto-detected)
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
                        conn_model.track, source=frame, conf=DETECTION_CONF, iou=0.3, agnostic_nms=True, device=DEVICE,
                        verbose=False, persist=True, tracker=TRACKER_CFG,
                    ),
                )
                result = results[0]
                
                boxes = []
                violation_detected = False
                violating_bbox = None
                new_snapshot_url = ""
                clean_frame = None  # snapshot of `frame` before any triangle is drawn on it this pass

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
                            is_violation = False  # per-box, sent to the client so it can draw this one's border red

                            if roi_poly is not None:
                                # Check bottom-center of the truck bounding box
                                wheel_point = (int((x1_pix + x2_pix) / 2), int(y2_pix))
                                in_roi = cv2.pointPolygonTest(roi_poly, wheel_point, False) >= 0

                                if track_id != -1:
                                    if in_roi:
                                        roi_enter_time.setdefault(track_id, current_time_sec)
                                    else:
                                        roi_enter_time.pop(track_id, None)

                                over_limit = SPEED_LIMIT_KMH <= 0 or (speed_kmh is not None and speed_kmh >= SPEED_LIMIT_KMH)
                                confirmed = (
                                    in_roi
                                    and track_id != -1
                                    and track_id in roi_enter_time
                                    and current_time_sec - roi_enter_time[track_id] >= ROI_DEBOUNCE_SECONDS
                                    and over_limit
                                )

                                if confirmed:
                                    is_violation = True
                                    violation_detected = True
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    violating_speed_kmh = speed_kmh
                                    if clean_frame is None:
                                        clean_frame = frame.copy()
                                    # HUD-style violation marker: outline-only red box + floating
                                    # arrow + "VIOLATION" tag, all anchored above y1 so the truck
                                    # itself stays fully visible in the live feed. Drawn on every
                                    # confirmed truck this frame, so the live view can show more
                                    # than one violator at once.
                                    try:
                                        violation_annotation.draw_violation_annotation(frame, x1_pix, y1_pix, x2_pix, y2_pix)
                                    except Exception:
                                        print(f"[{camera_id}] ERROR drawing violation marker:\n{traceback.format_exc()}")
                                        
                                    _first_sight = track_id not in alerted_track_ids[camera_id]
                                    if _first_sight:
                                        alerted_track_ids[camera_id].add(track_id)
                                    # A track id alone isn't enough to de-duplicate: the tracker can give
                                    # one truck two ids (cab/trailer boxes, an id switch), and each would
                                    # raise its own alert. Also skip a box that sits on one just alerted.
                                    if _first_sight and not new_snapshot_url and _claim_alert(camera_id, (x1_pix, y1_pix, x2_pix, y2_pix), time.time()):
                                        current_time_chk = time.time()
                                        violation_id = f"V-{int(current_time_chk)}-{track_id}"
                                        
                                        snapshot_dir = os.path.join(base_dir, "public", "evidence_snapshots")
                                        os.makedirs(snapshot_dir, exist_ok=True)
                                        snap_filename = f"{violation_id}_{camera_id}_snap.jpg"
                                        snap_path = os.path.join(snapshot_dir, snap_filename)
                                        
                                        try:
                                            write_evidence_snapshot(clean_frame, violating_bbox, snap_path)
                                        except Exception:
                                            print(f"[{camera_id}] ERROR writing evidence snapshot:\n{traceback.format_exc()}")
                                        new_snapshot_url = f"/evidence_snapshots/{snap_filename}"
                                        
                                        # 🟢 ဓာတ်ပုံသိမ်းပြီးသည်နှင့် Telegram သို့ လှမ်းပို့မည် (Speed အစစ်ပါသွားမည်)
                                        threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()

                                        # Save the DB row right away (image-only evidence)
                                        threading.Thread(target=save_violation_to_db, args=(camera_id, violation_id, json.dumps(camera_rois[camera_id]), new_snapshot_url, violating_bbox, clean_frame, speed_kmh)).start()

                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "track_id": track_id, # 🟢 client keys each box by this so velocity / label stay with the right vehicle
                                "label": box_label, # 🟢 React ဆီသို့ Speed ပါ ပို့ပေးမည်
                                "violation": is_violation, # confirmed in the ROI - client draws this one's border red
                            })

                    # drop Kalman filters for tracks that left the frame (grace window
                    # keeps a briefly-missing track's samples so it doesn't reset to
                    # "Tracking..." every time the detector flickers for a frame)
                    speed_estimator.get_estimator(camera_id, w, h).cleanup(track_ids, now=current_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_enter_time if t not in _live_ids]:
                        del roi_enter_time[_tid]

                # Send violation alert if needed
                fps = 0.0
                time_diff = time.time() - start_time
                if time_diff > 0:
                    fps = 1.0 / time_diff
                if new_snapshot_url:
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
        print(f"[{camera_id}] Error in WebSocket loop: {e}\n{traceback.format_exc()}")
    finally:
        # Free this connection's Kalman filters and its alerted-track set so
        # state does not leak between connections / grow without bound.
        speed_estimator.reset_estimator(camera_id)
        alerted_track_ids.pop(camera_id, None)
        print(f"[{camera_id}] Connection state cleaned up")

@app.websocket("/ws-test/{camera_id}")
async def websocket_test_endpoint(websocket: WebSocket, camera_id: str):
    """Read-only 'shadow' view for A/B-testing a model against a camera's REAL live feed:
    ?model=box (default, same weights as production) or ?model=seg (experimental truck_seg).

    Deliberately a separate, self-contained endpoint rather than a flag threaded through
    websocket_endpoint above, because that function's per-camera state - _ESTIMATORS (keyed
    by camera_id+frame size, shared across every connection to that camera), alerted_track_ids,
    last_alert_times - is real, and its `finally:` block resets ALL of it on disconnect. A
    shared-state version of this feature could reset a real Kalman filter mid-violation, or
    have a closed test tab wipe the real alert dedup for that camera - both while the actual
    production connection keeps running. This endpoint never touches any of that:
      - its own model instance (own copy, not shared with any other connection)
      - its own SpeedEstimator, constructed directly rather than via speed_estimator.get_estimator()
        (which would hand back - and let this mutate - the real per-camera cached instance)
      - its own local `seen_violations` set instead of the global alerted_track_ids
      - the ROI is read once at connect (view-only; SET_LANE_ROI isn't handled here)
      - NEVER writes to the violations DB, sends Telegram, or writes an evidence snapshot -
        confirmed violations are only reported back over this socket (SHADOW_VIOLATION), so
        this is safe to open at any time, including mid-exhibition, without affecting the real
        production feed anyone else has open on the same camera.
    """
    await websocket.accept()
    model_choice = websocket.query_params.get("model", "box")
    is_seg = model_choice == "seg"

    if is_seg:
        test_model = _get_seg_model()
        if test_model is None:
            await websocket.send_json({
                "type": "TEST_MODEL_UNAVAILABLE",
                "detail": f"Segmentation model not found at {SEG_MODEL_PATH}.",
            })
            await websocket.close()
            return
    else:
        test_model = YOLO(model_path)

    print(f"[{camera_id}] TEST WebSocket opened (model={model_choice})")
    roi_points = camera_rois.get(camera_id) or _load_rois().get(camera_id)
    await websocket.send_json({"type": "CURRENT_ROI", "points": roi_points})

    loop = asyncio.get_running_loop()
    calib = speed_estimator._load_calibration().get(camera_id)
    test_estimator = None  # built once the real frame size is known, just below
    roi_enter_time = {}
    prev_gray = None
    opt_points = {}
    seen_violations = set()  # local-only "first sight" dedup - never touches alerted_track_ids

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                print(f"[{camera_id}] TEST WebSocket disconnected")
                break
            if "bytes" not in message or not message["bytes"]:
                continue  # this view is read-only: no SET_LANE_ROI/calibration handling

            np_arr = np.frombuffer(message["bytes"], np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if frame is None:
                continue

            h, w = frame.shape[:2]
            curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if test_estimator is None:
                test_estimator = speed_estimator.SpeedEstimator(camera_id, w, h, calibration=calib)

            start_time = time.time()
            results = await loop.run_in_executor(
                None,
                functools.partial(
                    test_model.track, source=frame, conf=(SEG_DETECTION_CONF if is_seg else DETECTION_CONF), iou=0.3, agnostic_nms=True, device=DEVICE,
                    verbose=False, persist=True, tracker=TRACKER_CFG,
                ),
            )
            result = results[0]
            boxes = []

            roi_poly = None
            if roi_points and len(roi_points) >= 3:
                pts = [[int(pt['x'] * w), int(pt['y'] * h)] for pt in roi_points]
                roi_poly = np.array(pts, dtype=np.int32)

            if result.boxes is not None:
                track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                current_time_sec = time.time()

                for i in range(len(result.boxes.cls)):
                    class_name = test_model.names[int(result.boxes.cls[i])]
                    # See detect_demo's identical comment: the seg model's real truck class
                    # came back oddly named, so match loosely by substring for it only.
                    if not (class_name in ["truck", "heavy_truck"] or (is_seg and "truck" in class_name.lower())):
                        continue

                    coords = result.boxes.xyxyn[i].cpu().numpy()
                    conf = float(result.boxes.conf[i])
                    track_id = int(track_ids[i]) if i < len(track_ids) else -1
                    x1_pix, y1_pix = int(coords[0] * w), int(coords[1] * h)
                    x2_pix, y2_pix = int(coords[2] * w), int(coords[3] * h)

                    # This is the actual point of testing segmentation, not just swapping
                    # weights: the box model's "ground point" can only ever be the axis-
                    # aligned box's bottom-center - it doesn't know the truck's real shape.
                    # For the seg model, approximate the two near-side WHEEL contact points
                    # instead of one body-center point: take the mask's bottom edge (its
                    # lowest ~3% band) and use that band's leftmost and rightmost points.
                    # A wide/angled truck can have one wheel inside the restricted lane and
                    # the other outside it - checking a single center point (of the box OR
                    # the mask) can miss that; checking both wheel points can't. Kept to two
                    # points rather than the full mask polygon because it's simpler, doesn't
                    # need a new dependency (Shapely) for real polygon-vs-polygon overlap, and
                    # covers the case that actually matters for a lane boundary. Box mode is
                    # untouched here on purpose - it must keep matching real production
                    # exactly, or this stops being a fair baseline to compare seg against.
                    ground_point = ((x1_pix + x2_pix) / 2.0, float(y2_pix))  # box default
                    seg_wheel_points = None  # (left, right) - seg mode only
                    if is_seg and result.masks is not None and i < len(result.masks.xyn):
                        poly = result.masks.xyn[i]  # normalized (x, y) polygon points for this instance
                        if len(poly) > 0:
                            y_bottom = max(pt[1] for pt in poly)
                            band = [pt for pt in poly if pt[1] >= y_bottom - 0.03] or [max(poly, key=lambda p: p[1])]
                            left_pt = min(band, key=lambda p: p[0])
                            right_pt = max(band, key=lambda p: p[0])
                            seg_wheel_points = (
                                (float(left_pt[0]) * w, float(left_pt[1]) * h),
                                (float(right_pt[0]) * w, float(right_pt[1]) * h),
                            )
                            # Speed still tracks one point (adding a second doesn't improve a
                            # velocity estimate, just doubles the optical-flow/Kalman work) -
                            # the midpoint of the two wheel points is that one point.
                            ground_point = (
                                (seg_wheel_points[0][0] + seg_wheel_points[1][0]) / 2.0,
                                (seg_wheel_points[0][1] + seg_wheel_points[1][1]) / 2.0,
                            )

                    opt_point = None
                    raw_center = ground_point
                    if track_id != -1 and prev_gray is not None and track_id in opt_points:
                        p0 = np.array([[opt_points[track_id]]], dtype=np.float32)
                        p1, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, curr_gray, p0, None, winSize=(15, 15), maxLevel=2, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 10, 0.03))
                        if st[0][0] == 1:
                            nx, ny = p1[0][0]
                            if x1_pix <= nx <= x2_pix and y1_pix <= ny <= y2_pix and abs(ny - y2_pix) < (y2_pix - y1_pix) * 0.2:
                                opt_point = (float(nx), float(ny))
                    if opt_point is None:
                        opt_point = raw_center
                    if track_id != -1:
                        opt_points[track_id] = opt_point

                    speed_kmh = test_estimator.update(track_id, (x1_pix, y1_pix, x2_pix, y2_pix), current_time_sec, opt_point=opt_point)
                    box_label = "Tracking..." if speed_kmh is None else f"{speed_kmh:.1f} km/h"

                    is_violation = False
                    if roi_poly is not None:
                        if seg_wheel_points is not None:
                            # Either wheel touching the restricted lane counts - not just
                            # one designated point.
                            in_roi = any(
                                cv2.pointPolygonTest(roi_poly, (int(px), int(py)), False) >= 0
                                for px, py in seg_wheel_points
                            )
                        else:
                            wheel_point = (int(ground_point[0]), int(ground_point[1]))
                            in_roi = cv2.pointPolygonTest(roi_poly, wheel_point, False) >= 0
                        if track_id != -1:
                            if in_roi:
                                roi_enter_time.setdefault(track_id, current_time_sec)
                            else:
                                roi_enter_time.pop(track_id, None)
                        over_limit = SPEED_LIMIT_KMH <= 0 or (speed_kmh is not None and speed_kmh >= SPEED_LIMIT_KMH)
                        confirmed = (
                            in_roi and track_id != -1 and track_id in roi_enter_time
                            and current_time_sec - roi_enter_time[track_id] >= ROI_DEBOUNCE_SECONDS
                            and over_limit
                        )
                        if confirmed:
                            is_violation = True
                            if track_id not in seen_violations:
                                seen_violations.add(track_id)
                                await websocket.send_json({
                                    "type": "SHADOW_VIOLATION",
                                    "camera": camera_id,
                                    "model": model_choice,
                                    "speed_kmh": speed_kmh,
                                })

                    boxes.append({
                        "x1": float(coords[0]), "y1": float(coords[1]),
                        "x2": float(coords[2]), "y2": float(coords[3]),
                        "conf": conf, "track_id": track_id, "label": box_label,
                        "violation": is_violation,
                    })

                test_estimator.cleanup(track_ids, now=current_time_sec)
                live_ids = {int(t) for t in track_ids}
                for tid in [t for t in roi_enter_time if t not in live_ids]:
                    del roi_enter_time[tid]

            prev_gray = curr_gray
            elapsed = time.time() - start_time
            await websocket.send_json({
                "type": "BBOX_DATA",
                "boxes": boxes,
                "fps": (1.0 / elapsed) if elapsed > 0 else 0.0,
                "model": model_choice,
            })
    except WebSocketDisconnect:
        print(f"[{camera_id}] TEST WebSocket disconnected")
    except Exception:
        print(f"[{camera_id}] Error in TEST WebSocket loop:\n{traceback.format_exc()}")
    # No finally-block cleanup needed: nothing shared/global was ever touched above.


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
