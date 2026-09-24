"""Do Do Vision - live truck-lane (Section 35) enforcement server.

FastAPI app that runs YOLO truck detection + BoT-SORT tracking on CCTV frames and flags
trucks inside each camera's restricted-lane ROI.

Endpoints
    WS   /ws/{camera_id}          live monitoring: browser sends JPEG frames, server returns
                                  boxes, speeds and VIOLATION_ALERT messages
    WS   /ws-test/{camera_id}     admin-only segmentation shadow view (nothing is filed)
    POST /api/process_recorded    run the same pipeline over a recorded / uploaded video
    POST /api/detect_demo         single-image detection for the Project Report demo
    POST /api/admin/login|logout  shared admin session (required to edit a camera's ROI)

A confirmed violation writes an evidence snapshot, a MySQL row (with a Re-ID fingerprint
for cross-camera matching) and, if configured, a Telegram alert.
"""
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
import secrets
import shutil
import traceback
import mysql.connector
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path

load_dotenv()  # loads .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DB_PASSWORD, ...) if present

# ============================================================================
# Runtime environment
# ============================================================================

# Allow OpenCV's FFmpeg backend to open HLS (http/https/tls) sources.
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "protocol_whitelist;file,http,https,tcp,tls,crypto"

# PyTorch 2.6 defaults torch.load(weights_only=True), which cannot unpickle full
# Ultralytics checkpoints. Our weights are trusted local files, so load them in full.
_original_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _original_load(*args, **kwargs)
torch.load = _safe_load
from ultralytics import YOLO

# ============================================================================
# App, static media and models
# ============================================================================

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
class ProcessRequest(BaseModel):
    """Body of POST /api/process_recorded."""
    video_filename: str
    camera_id: str
    roi_points: list

base_dir = Path(__file__).parent.parent  # the web/ project root

# Calibration result images.
public_dir = os.path.join(base_dir, "public", "calibration_results")
os.makedirs(public_dir, exist_ok=True)
app.mount("/calibration_results", StaticFiles(directory=public_dir), name="calibration_results")

# Evidence snapshots and recordings are served by this backend, which writes them.
# Vite's dev server ignores files created in these folders after it starts (see
# vite.config.js), whereas this reads from disk on every request.
for _subdir in ("evidence_snapshots", "recorded_videos"):
    _dir = os.path.join(base_dir, "public", _subdir)
    os.makedirs(_dir, exist_ok=True)
    app.mount(f"/{_subdir}", StaticFiles(directory=_dir), name=_subdir)

# Production detector (template model; each live connection loads its own copy).
model_path = os.environ.get("MODEL_PATH",str(base_dir /"models/model_v6.pt"))
print(f"Loading YOLO model from {model_path}...")
model = ultralytics.YOLO(model_path)
print("Model loaded successfully.")

# Experimental segmentation model, used only by the box-vs-segmentation comparison
# (/api/detect_demo and /ws-test). Loaded lazily on first use so a missing file never
# affects startup of the production pipeline.
SEG_MODEL_PATH = os.environ.get("SEG_MODEL_PATH", str(base_dir / "models/model_seg_v1.pt"))
_seg_model = None
def _get_seg_model():
    """Return the segmentation model, loading it on first call; None if the file is absent."""
    global _seg_model
    if _seg_model is None:
        if not os.path.exists(SEG_MODEL_PATH):
            return None
        print(f"Loading segmentation YOLO model from {SEG_MODEL_PATH}...")
        _seg_model = ultralytics.YOLO(SEG_MODEL_PATH)
        # The training export named class 0 "Truck-Detection-qOuI"; rename it so plotted
        # labels read "truck". YOLO.names returns a copy, so the rename must go on the
        # underlying module's .model.names to persist.
        if 0 in _seg_model.model.names:
            _seg_model.model.names[0] = "truck"
        print("Segmentation model loaded successfully.")
    return _seg_model

# ============================================================================
# ROI persistence and admin authentication
# ============================================================================
# Each camera has one shared restricted-lane ROI, stored server-side and pushed to every
# viewer on connect (CURRENT_ROI). Only a signed-in admin may change it (SET_LANE_ROI).
# camera_rois is the in-memory working copy; ROI_FILE persists it across restarts.
camera_rois = {}
ROI_FILE = os.path.join(base_dir, "rois.json")


def _load_rois():
    """Return {camera_id: [points]} from ROI_FILE, or {} if missing/unreadable."""
    try:
        with open(ROI_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_roi(camera_id, points):
    """Persist one camera's ROI (empty/None points removes it)."""
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


# Single shared operator account, configured in .env. There is no default password:
# leaving ADMIN_PASSWORD unset disables admin login entirely.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_SESSION_SECONDS = 12 * 3600  # one working day
admin_sessions = {}  # token -> expiry (unix seconds)


def _valid_admin_token(token):
    """True if `token` is a live admin session; expired tokens are purged."""
    if not token:
        return False
    exp = admin_sessions.get(token)
    if exp is None:
        return False
    if time.time() > exp:
        admin_sessions.pop(token, None)
        return False
    return True


# ============================================================================
# Tracking, storage and notification settings
# ============================================================================

# track_ids already alerted, per camera (or per recorded job): one alert per truck.
alerted_track_ids = __import__('collections').defaultdict(set)

# Tracker config. Stable track ids matter: the ROI timer, alert de-duplication and the
# per-vehicle speed filter are all keyed on them. BoT-SORT is the default;
# TRACKER=bytetrack selects the ByteTrack config (same thresholds) for comparison.
TRACKER_NAME = "bytetrack" if os.environ.get("TRACKER", "").lower() == "bytetrack" else "botsort"
TRACKER_CFG = str(base_dir / "scripts" / "trackers" / f"{TRACKER_NAME}_truck.yaml")
print(f"Tracker: {TRACKER_NAME} ({TRACKER_CFG})")

# MySQL connection (credentials from the environment).
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'database': 'section35_db'
}

import requests

# Telegram alert credentials - environment only, never committed (the repo is public).
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')

# Evidence snapshot styling: brightness of everything outside the truck (0 = black, 1 = unchanged).
SNAPSHOT_DIM = 0.7
SNAPSHOT_DIM_PAD = 5  # px kept at full brightness around the violating box
SNAPSHOT_BOX_ALPHA = 1.0  # contrast boost applied to the truck itself
SNAPSHOT_BOX_BETA = 0     # brightness boost applied to the truck itself

# ============================================================================
# Violation rule and detection settings
# ============================================================================
# A tracked truck is a violation when BOTH hold:
#   1. its ROI test point is inside the camera's ROI for at least the debounce period
#      below - box model: the box's bottom-RIGHT corner (the right-side wheels, next to
#      the restricted rightmost lane); segmentation model: either of the mask's two
#      wheel-contact points - and
#   2. its estimated speed is >= SPEED_LIMIT_KMH (0 = any speed; see below).

# Debounce, in frames at LIVE_FPS_ESTIMATE. 0 = flag on the first frame inside the ROI
# (recorded playback still requires 1 frame; see debounce_frames). Raise it (e.g. 3-15)
# if single-frame detector jitter causes false alerts.
ROI_DEBOUNCE_FRAMES = 0
# Live monitoring analyses ~640px-wide browser frames at roughly this rate; recorded
# playback reproduces the same frame size and debounce duration.
LIVE_FRAME_WIDTH = 640
LIVE_FPS_ESTIMATE = 10.0
# Live debounce is measured in elapsed seconds, not frames, so it means the same thing
# however slowly a loaded server receives frames. Recorded playback uses a frame count,
# since it processes every frame of the file.
ROI_DEBOUNCE_SECONDS = ROI_DEBOUNCE_FRAMES / LIVE_FPS_ESTIMATE
# Detection confidence for the production model (live + recorded). Validated on live
# frames from 5 cameras: detections between 0.35 and 0.5 were all genuine (distant or
# partly occluded) trucks.
DETECTION_CONF = 0.4
# Higher bar for the experimental segmentation model: at 0.4 it produced duplicate boxes
# and glare false positives on night footage (456 -> 110 detections over 400 frames at 0.6,
# with no real trucks lost on visual spot-check).
SEG_DETECTION_CONF = 0.6
# cuda:0 on NVIDIA, mps on Apple silicon, else cpu; override with YOLO_DEVICE.
DEVICE = pick_device()
print(f"Inference device: {DEVICE}")
# Rule 2 threshold. Section 35 is a lane restriction with no speed component, so this is
# fixed at 0 (any truck in the ROI counts) rather than operator-adjustable.
SPEED_LIMIT_KMH = 0

# ============================================================================
# Evidence snapshots, alert de-duplication and notifications
# ============================================================================

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
    """Post the evidence snapshot with a short caption to the configured Telegram chat."""
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"

        # Message caption
        caption = f"Violation Detected!!\nCamera: {camera_id}\nSpeed: {speed:.1f} km/h\nTime: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        
        with open(snapshot_path, 'rb') as photo:
            files = {'photo': photo}
            data = {'chat_id': TELEGRAM_CHAT_ID, 'caption': caption}
            requests.post(url, data=data, files=files)
            
        print(f"[{camera_id}] Telegram Alert ပို့ပြီးပါပြီ!")
    except Exception as e:
        print(f"Telegram Error: {e}")

def save_violation_to_db(camera_id, violation_id, roi_polygon_json, snapshot_url="", violating_bbox=None, trigger_frame=None, speed_kmh=0.0):
    """Insert one violation row into MySQL (runs in a background thread).

    Evidence is image-only: the snapshot is already on disk at `snapshot_url`. When a frame
    and box are given, a Re-ID fingerprint is computed and matched against recent
    violations on other cameras to link the same truck into a route.
    """
    try:
        # Re-ID fingerprint of the violating truck
        fp_json = None
        route_match_id = None
        cam_route = None
        cam_dir = None
        cam_km = 0.0
        
        if trigger_frame is not None and violating_bbox is not None:
            fp_vector = reid_engine.get_fingerprint_from_frame(trigger_frame, violating_bbox)
            if fp_vector:
                fp_json = json.dumps(fp_vector)
                
                # Same truck seen recently on another camera? Reuse its route id.
                current_time = datetime.now()
                matched = reid_engine.find_matching_route(DB_CONFIG, fp_vector, camera_id, current_time)
                
                if matched:
                    route_match_id = matched
                else:
                    route_match_id = f"ROUTE-{int(current_time.timestamp())}"
        
        # Camera location metadata (route, direction, km marker)
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

# ============================================================================
# REST endpoints: admin session and single-image demo
# ============================================================================

class AdminLoginRequest(BaseModel):
    """Body of POST /api/admin/login."""
    username: str
    password: str


@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest):
    """Check the shared admin credentials and issue a session token."""
    if not ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Admin login is not configured (set ADMIN_PASSWORD)")
    # Constant-time comparison, so response timing reveals nothing about the password.
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
    """Body of POST /api/admin/logout."""
    token: str


@app.post("/api/admin/logout")
async def admin_logout(req: AdminLogoutRequest):
    """End an admin session (idempotent)."""
    admin_sessions.pop(req.token, None)
    return {"ok": True}

class DetectDemoRequest(BaseModel):
    """Body of POST /api/detect_demo."""
    image_base64: str
    model: str = "box"  # "box" = production model_v6.pt, "seg" = experimental truck_seg model

@app.post("/api/detect_demo")
async def detect_demo(req: DetectDemoRequest):
    """Run detection on one uploaded image for the Project Report walkthrough.

    Returns the annotated image, the best truck box, (segmentation only) the mask's two
    wheel-contact points and their midpoint, and a sample of the truck's Re-ID fingerprint.
    """
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

    # .plot() draws boxes for a detection model and masks + boxes for a segmentation model.
    # Each model uses its own confidence threshold (see SEG_DETECTION_CONF).
    demo_conf = SEG_DETECTION_CONF if req.model == "seg" else DETECTION_CONF
    results = active_model.predict(source=frame, conf=demo_conf, iou=0.3, agnostic_nms=True, device=DEVICE, verbose=False)
    res_frame = results[0].plot()

    _, buffer = cv2.imencode('.jpg', res_frame)
    b64_str = base64.b64encode(buffer).decode('utf-8')

    # Highest-confidence truck box (same class filter as live), used by the report's
    # speed-estimation step to anchor its track point on the real detection. Segmentation
    # results populate .boxes too, so this works for either model.
    bbox = None
    best_i = None  # also read below for mask_ground_point, even when nothing was detected
    result_boxes = results[0].boxes
    if result_boxes is not None and len(result_boxes) > 0:
        best_i, best_conf = None, -1.0
        for i in range(len(result_boxes.cls)):
            class_name = active_model.names[int(result_boxes.cls[i])]
            conf = float(result_boxes.conf[i])
            # Production classes are "truck"/"heavy_truck". The segmentation model is
            # truck-only but its export name varies between trainings, so match by substring.
            is_truck = class_name in ["truck", "heavy_truck"] or (req.model == "seg" and "truck" in class_name.lower())
            if is_truck and conf > best_conf:
                best_i, best_conf = i, conf
        if best_i is not None:
            x1, y1, x2, y2 = result_boxes.xyxyn[best_i].tolist()
            bbox = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": best_conf}

    # Segmentation only - the same points the live seg view uses: the two wheel-contact
    # points (leftmost and rightmost points of the mask's lowest ~3% band) for the ROI test,
    # and their midpoint as the speed track point.
    mask_ground_point = None
    mask_wheel_points = None
    result_masks = results[0].masks
    if req.model == "seg" and best_i is not None and result_masks is not None and best_i < len(result_masks.xyn):
        poly = result_masks.xyn[best_i]  # normalized (x, y) polygon points for that instance
        if len(poly) > 0:
            y_bottom = max(pt[1] for pt in poly)
            band = [pt for pt in poly if pt[1] >= y_bottom - 0.03] or [max(poly, key=lambda p: p[1])]
            left_pt = min(band, key=lambda p: p[0])
            right_pt = max(band, key=lambda p: p[0])
            mask_wheel_points = [
                {"x": float(left_pt[0]), "y": float(left_pt[1])},
                {"x": float(right_pt[0]), "y": float(right_pt[1])},
            ]
            mask_ground_point = {
                "x": (mask_wheel_points[0]["x"] + mask_wheel_points[1]["x"]) / 2.0,
                "y": (mask_wheel_points[0]["y"] + mask_wheel_points[1]["y"]) / 2.0,
            }

    # Re-ID fingerprint (report step 7): the same function save_violation_to_db() uses, run
    # on the detected truck. Only the first 24 of the 512 real values are returned for display.
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
        "mask_wheel_points": mask_wheel_points,
        "model_used": req.model,
        "fingerprint": fingerprint,
    }


# ============================================================================
# Recorded / uploaded video processing
# ============================================================================

# Overlay drawn into processed videos to match the live view in LiveCCTVPlayer.jsx:
# green boxes with label chips, translucent red ROI with vertex dots.
LIVE_BOX_BGR = (94, 197, 34)      # #22c55e
LIVE_DISPLAY_WIDTH = 940.0        # width the live overlay's fixed pixel sizes were designed for

def draw_live_overlay(frame, roi_poly, items):
    """Draw the ROI and truck boxes onto `frame` in place.

    items: [(x1, y1, x2, y2, label)] in full-resolution pixels.
    """
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
    """Process a video from public/recorded_videos and return its annotated copy and evidence.

    Nothing is written to the database or sent to Telegram; evidence images are returned.
    """
    input_path = os.path.join(base_dir, "public", "recorded_videos", req.video_filename)
    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="File not found")
    output_filename = req.video_filename.replace('.mp4', '_processed.mp4')
    output_path = os.path.join(base_dir, "public", "recorded_videos", output_filename)
    evidence_name = output_filename.replace('_processed.mp4', '') + "_evidence"
    evidence_dir = os.path.join(base_dir, "public", "recorded_videos", evidence_name)
    shutil.rmtree(evidence_dir, ignore_errors=True)   # drop the previous run's images
    evidence = _process_video(input_path, output_path, req.camera_id, req.roi_points,
                              evidence_dir=evidence_dir, evidence_url_prefix=f"/recorded_videos/{evidence_name}")
    return {"status": "success", "processed_url": f"/recorded_videos/{output_filename}", "evidence": evidence}


def _process_video(input_path, output_path, camera_id, roi_points, evidence_dir=None, evidence_url_prefix=None):
    """Run a video through the live-monitoring rules and write an annotated copy.

    Uses the same frame size, NMS, ROI test point, debounce, de-duplication and overlay as
    live monitoring. Blocking; FastAPI runs it in a worker thread.

    Without evidence_dir, violations are saved like live ones (snapshot, DB row, Telegram).
    With evidence_dir, nothing goes to the DB or Telegram: snapshots are written there and
    returned as [{url, track_id, speed_kmh, time_sec}].
    """
    found_evidence = []
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise HTTPException(status_code=500, detail="Could not open video")
        
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(output_path, fourcc, fps, (w, h))
    
    # Detection, tracking, speed and the ROI test run on a <=640px-wide copy, like live
    # (so calibration and thresholds mean the same thing); drawing and evidence snapshots
    # use the full-resolution frame.
    lw = min(w, LIVE_FRAME_WIDTH)
    lh = round(h * lw / w)
    alert_key = f"rec:{camera_id}"   # keeps recorded de-dup state apart from the live camera's
    proc_model = YOLO(model_path)        # private tracker state, like each live connection

    roi_poly = None
    if len(roi_points) >= 3:
        pts = [[int(pt['x'] * w), int(pt['y'] * h)] for pt in roi_points]
        roi_poly = np.array(pts, dtype=np.int32)                      # full-res, for drawing
        roi_logic = np.array([[int(pt['x'] * lw), int(pt['y'] * lh)] for pt in roi_points], dtype=np.int32)
        
    
    # Fresh speed estimator per job; time comes from the video position, which is exact
    # for a file (no wall-clock jitter).
    speed_estimator.reset_estimator(camera_id)
    alerted_track_ids.pop(alert_key, None)   # fresh de-dup set per job
    _recent_alert_boxes.pop(alert_key, None)
    roi_streak = collections.defaultdict(int)    # track_id -> consecutive in-ROI frames
    src_fps = fps if fps and fps > 1 else 30.0
    # Live receives ~LIVE_FPS_ESTIMATE frames/s; a file has every frame, so scale the
    # debounce to the same duration.
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
        # Keep these kwargs identical on every call: Ultralytics rebuilds the predictor (and
        # with it the tracker) when they change, which would reset every track id and the
        # per-track speed state.
        # iou=0.3 with agnostic NMS (default 0.7) merges the duplicate cab-only /
        # cab+trailer boxes a long truck often produces, before tracking sees them.
        results = proc_model.track(source=small, conf=DETECTION_CONF, iou=0.3, agnostic_nms=True, device=DEVICE, verbose=False, persist=True, tracker=TRACKER_CFG)
        result = results[0]

        boxes = []
        draw_items = []   # boxes to draw, after all detection logic (so the evidence frame stays clean)
        violating_bbox = None
        new_snapshot_url = ""
        clean_frame = None  # copy of `frame` taken before any annotation is drawn on it
        if result.boxes is not None:
                    # Track ids for this frame (empty until the tracker assigns them)
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    
                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = proc_model.names[cls_id]
                        confirmed=False
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1
                            
                            # Normalised box -> pixels in the inference frame
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
                                    # Accept the flow point only if it stays near the box's bottom edge
                                    if x1_pix <= nx <= x2_pix and y1_pix <= ny <= y2_pix:
                                        if abs(ny - y2_pix) < (y2_pix - y1_pix) * 0.2:
                                            opt_point = (float(nx), float(ny))
                            
                            if opt_point is None:
                                opt_point = raw_center
                            
                            if track_id != -1:
                                opt_points[track_id] = opt_point
                            
                            # Speed: ground point -> homography (or fallback scale) ->
                            # constant-velocity Kalman filter (see speed_estimator.py)
                            estimator = speed_estimator.get_estimator(camera_id, lw, lh)
                            speed_kmh = estimator.update(
                                track_id,
                                (x1_pix, y1_pix, x2_pix, y2_pix),
                                video_time_sec,
                                opt_point=opt_point
                            )

                            # Label shown on the box (same text as live)
                            box_label = "Tracking..." if speed_kmh is None else f"{speed_kmh:.1f} km/h"

                            if roi_poly is not None:
                                # ROI test point: the box's bottom-RIGHT corner (right-side wheels)
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
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    if clean_frame is None:
                                        clean_frame = frame.copy()   # full-res, for the evidence image
                                        clean_small = small.copy()   # what live uses, for re-ID
                                    # Same box in full-resolution pixels, for the evidence snapshot
                                    full_bbox = (int(coords[0] * w), int(coords[1] * h), int(coords[2] * w), int(coords[3] * h))

                                    # De-duplication (as live): one alert per track id, and none for a box
                                    # overlapping one alerted moments ago (a split track of the same truck).
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

                                        # From the unannotated frame, so the image marks only this truck.
                                        try:
                                            write_evidence_snapshot(clean_frame, full_bbox, snap_path)
                                        except Exception:
                                            print(f"[{camera_id}] ERROR writing evidence snapshot:\n{traceback.format_exc()}")
                                        new_snapshot_url = f"{evidence_url_prefix or '/evidence_snapshots'}/{snap_filename}"

                                        if evidence_dir:
                                            # Uploaded clip: return the evidence to the caller only
                                            found_evidence.append({
                                                "url": new_snapshot_url,
                                                "track_id": track_id,
                                                "speed_kmh": None if speed_kmh is None else round(float(speed_kmh), 1),
                                                "time_sec": round(float(video_time_sec), 1),
                                            })
                                        else:
                                            # Record the violation and notify, off the processing thread
                                            threading.Thread(target=save_violation_to_db, args=(camera_id, violation_id, json.dumps(roi_points), new_snapshot_url, violating_bbox, clean_small, speed_kmh)).start()

                                            threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()
                            
                            draw_items.append((int(coords[0] * w), int(coords[1] * h), int(coords[2] * w), int(coords[3] * h), box_label))
                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "label": box_label
                            })

                    # Forget tracks that left the frame (the estimator keeps a short grace
                    # window so a one-frame detector dropout doesn't reset a track's speed)
                    speed_estimator.get_estimator(camera_id, lw, lh).cleanup(track_ids, now=video_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_streak if t not in _live_ids]:
                        del roi_streak[_tid]


        # Drawn last so evidence snapshots taken above stay unannotated.
        draw_live_overlay(frame, roi_poly, draw_items)
        prev_gray = curr_gray
        out.write(frame)
            
    out.release()
    cap.release()
    fps = 0.0
    time_diff = time.time() - start_time
    if time_diff > 0:
        fps = 1.0 / time_diff
    return found_evidence


# ============================================================================
# Live monitoring WebSocket
# ============================================================================

@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    """Live monitoring for one camera.

    Client -> server:
        binary        JPEG frame (~640px wide) to analyse
        SET_LANE_ROI  save the camera's ROI (requires a valid admin_token)
        SAVE_MANUAL_CALIBRATION   store the admin's 4-point speed calibration
    Server -> client:
        CURRENT_ROI, ROI_UNAUTHORIZED, CALIBRATION_STATUS,
        BBOX_DATA (boxes + labels per frame), VIOLATION_ALERT (with snapshot URL)
    """
    await websocket.accept()
    print(f"[{camera_id}] WebSocket connection opened")
    # Read the ROI from disk (it may have been saved by another process) and send it to
    # this viewer, so everyone watching the camera sees the same ROI.
    camera_rois[camera_id] = _load_rois().get(camera_id)
    await websocket.send_json({"type": "CURRENT_ROI", "points": camera_rois[camera_id]})

    # Each connection gets its own model instance, so tracker state is never shared
    # between cameras. Inference runs in a worker thread to keep the event loop free.
    conn_model = YOLO(model_path)
    loop = asyncio.get_running_loop()
    speed_estimator.reset_estimator(camera_id)   # fresh Kalman state per connection
    roi_enter_time = {}    # track_id -> wall-clock time it first entered the ROI (this streak)
    prev_gray = None
    opt_points = {}
    print(f"[{camera_id}] Loaded a private model instance for this connection")

    try:
        while True:
            # A frame (bytes) or a control message (JSON text)
            message = await websocket.receive()

            # receive() returns the disconnect message rather than raising
            # WebSocketDisconnect, so a normal disconnect must be detected here.
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
                            # Echo the saved ROI back so the admin's view matches what was stored.
                            await websocket.send_json({"type": "CURRENT_ROI", "points": camera_rois[camera_id]})
                    elif data.get("type") == "SAVE_MANUAL_CALIBRATION":
                        pts = data.get("image_points")
                        width = float(data.get("width_m", 3.5))
                        length = float(data.get("length_m", 27.0))
                        
                        if pts and len(pts) == 4:
                            world_pts = [[0.0, length], [width, length], [width, 0.0], [0.0, 0.0]]
                            # Uses the module-level `json`: a local import anywhere in this
                            # function would make `json` local to all of it (UnboundLocalError).
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
                            # Resolution the points were clicked at; speed_estimator rescales
                            # them to whatever resolution it runs at.
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
                # Decode the JPEG frame
                np_arr = np.frombuffer(data, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                
                if frame is None:
                    continue
                
                h, w = frame.shape[:2]
                curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                
                # Detection + tracking, in a worker thread so other clients aren't blocked.
                # Same kwargs as the recorded pipeline (see the comment there): they must
                # not change between calls, or the tracker is rebuilt and ids reset.
                start_time = time.time()
                
                results = await loop.run_in_executor(
                    None,
                    functools.partial(
                        conn_model.track, source=frame, conf=DETECTION_CONF, iou=0.3, agnostic_nms=True, device=DEVICE,
                        verbose=False, persist=True, tracker=TRACKER_CFG,
                    ),
                )
                result = results[0]
                
                boxes = []
                violating_bbox = None
                new_snapshot_url = ""
                clean_frame = None  # copy of `frame` taken before any annotation is drawn on it

                # This camera's ROI polygon in frame pixels (None if not set)
                roi_poly = None
                if camera_rois.get(camera_id) and len(camera_rois[camera_id]) >= 3:
                    points = []
                    for pt in camera_rois[camera_id]:
                        points.append([int(pt['x'] * w), int(pt['y'] * h)])
                    roi_poly = np.array(points, dtype=np.int32)
                
                if result.boxes is not None:
                    # Track ids for this frame (empty until the tracker assigns them)
                    track_ids = result.boxes.id.cpu().numpy() if result.boxes.id is not None else []
                    # Defined before the loop so cleanup() below has it even with no trucks.
                    current_time_sec = time.time()

                    for i in range(len(result.boxes.cls)):
                        cls_id = int(result.boxes.cls[i].cpu().numpy())
                        class_name = conn_model.names[cls_id]
                        if class_name in ["truck", "heavy_truck"]:
                            coords = result.boxes.xyxyn[i].cpu().numpy()
                            conf = float(result.boxes.conf[i].cpu().numpy())
                            track_id = int(track_ids[i]) if i < len(track_ids) else -1

                            # Normalised box -> pixels in the inference frame
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
                                    # Accept the flow point only if it stays near the box's bottom edge
                                    if x1_pix <= nx <= x2_pix and y1_pix <= ny <= y2_pix:
                                        if abs(ny - y2_pix) < (y2_pix - y1_pix) * 0.2:
                                            opt_point = (float(nx), float(ny))
                            
                            if opt_point is None:
                                opt_point = raw_center
                            
                            if track_id != -1:
                                opt_points[track_id] = opt_point

                            # Speed: ground point -> homography (if calibrated in
                            # calibration.json) or a fallback scale -> constant-velocity
                            # Kalman filter (see speed_estimator.py).
                            estimator = speed_estimator.get_estimator(camera_id, w, h)
                            speed_kmh = estimator.update(
                                track_id,
                                (x1_pix, y1_pix, x2_pix, y2_pix),
                                current_time_sec,
                                opt_point=opt_point
                            )

                            # Label shown on the box
                            box_label = "Tracking..." if speed_kmh is None else f"{speed_kmh:.1f} km/h"
                            is_violation = False  # sent per box so the client can highlight violators

                            if roi_poly is not None:
                                # ROI test point: the box's bottom-RIGHT corner (right-side wheels)
                                wheel_point = (int(x2_pix), int(y2_pix))
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
                                    violating_bbox = (x1_pix, y1_pix, x2_pix, y2_pix)
                                    if clean_frame is None:
                                        clean_frame = frame.copy()
                                    # Violation marker (outline, arrow and tag above the truck),
                                    # drawn for every confirmed truck in this frame.
                                    try:
                                        violation_annotation.draw_violation_annotation(frame, x1_pix, y1_pix, x2_pix, y2_pix)
                                    except Exception:
                                        print(f"[{camera_id}] ERROR drawing violation marker:\n{traceback.format_exc()}")
                                        
                                    _first_sight = track_id not in alerted_track_ids[camera_id]
                                    if _first_sight:
                                        alerted_track_ids[camera_id].add(track_id)
                                    # De-duplication: one alert per track id, and none for a box
                                    # overlapping one alerted moments ago (the tracker can give one
                                    # truck two ids, e.g. cab/trailer boxes or an id switch).
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
                                        
                                        # Notify and record the violation in background threads
                                        threading.Thread(target=send_telegram_alert, args=(camera_id, speed_kmh, snap_path)).start()

                                        threading.Thread(target=save_violation_to_db, args=(camera_id, violation_id, json.dumps(camera_rois[camera_id]), new_snapshot_url, violating_bbox, clean_frame, speed_kmh)).start()

                            boxes.append({
                                "x1": float(coords[0]),
                                "y1": float(coords[1]),
                                "x2": float(coords[2]),
                                "y2": float(coords[3]),
                                "conf": conf,
                                "track_id": track_id,  # lets the client keep each label on the right vehicle
                                "label": box_label,
                                "violation": is_violation,
                            })

                    # Forget tracks that left the frame (the estimator keeps a short grace
                    # window so a one-frame detector dropout doesn't reset a track's speed)
                    speed_estimator.get_estimator(camera_id, w, h).cleanup(track_ids, now=current_time_sec)
                    _live_ids = {int(t) for t in track_ids}
                    for _tid in [t for t in roi_enter_time if t not in _live_ids]:
                        del roi_enter_time[_tid]

                # Processing rate for this frame, plus the alert (if a violation was filed)
                fps = 0.0
                time_diff = time.time() - start_time
                if time_diff > 0:
                    fps = 1.0 / time_diff
                if new_snapshot_url:
                    alert_msg = {
                        "type": "VIOLATION_ALERT",
                        "camera": camera_id,
                        "message": "Potential Section 35 Violation detected!",
                        "snapshot": new_snapshot_url,  # evidence image, shown in the web page's alert bell
                    }
                    await websocket.send_json(alert_msg)
                
                # Boxes for the client overlay
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
        # Release this connection's speed filters and alert state.
        speed_estimator.reset_estimator(camera_id)
        alerted_track_ids.pop(camera_id, None)
        print(f"[{camera_id}] Connection state cleaned up")

# ============================================================================
# Model comparison ("shadow") WebSocket
# ============================================================================

@app.websocket("/ws-test/{camera_id}")
async def websocket_test_endpoint(websocket: WebSocket, camera_id: str):
    """Read-only shadow view for comparing models on a camera's live feed.

    ?model=box (default, production weights) or ?model=seg (experimental segmentation).

    Fully isolated from production state, so it is safe to open at any time:
      - its own model instance and its own SpeedEstimator (not the shared per-camera one)
      - a local `seen_violations` set instead of the global alerted_track_ids
      - the ROI is read once at connect; SET_LANE_ROI is not handled
      - never writes to the database, Telegram or evidence snapshots; confirmed
        violations are only reported on this socket as SHADOW_VIOLATION
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
    test_estimator = None  # created once the first frame's size is known
    roi_enter_time = {}
    prev_gray = None
    opt_points = {}
    seen_violations = set()  # local de-duplication; the global alerted_track_ids is untouched

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
                    # Truck classes; the seg model's class name varies, so match it by substring
                    if not (class_name in ["truck", "heavy_truck"] or (is_seg and "truck" in class_name.lower())):
                        continue

                    coords = result.boxes.xyxyn[i].cpu().numpy()
                    conf = float(result.boxes.conf[i])
                    track_id = int(track_ids[i]) if i < len(track_ids) else -1
                    x1_pix, y1_pix = int(coords[0] * w), int(coords[1] * h)
                    x2_pix, y2_pix = int(coords[2] * w), int(coords[3] * h)

                    # ROI test point(s), as in production:
                    #   box mode: the box's bottom-right corner (speed still tracks bottom-centre).
                    #   seg mode: the two wheel-contact points - leftmost and rightmost points of
                    #             the mask's lowest ~3% band - so a truck with only one wheel in
                    #             the restricted lane is still caught.
                    ground_point = ((x1_pix + x2_pix) / 2.0, float(y2_pix))  # speed track point (box)
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
                            # Speed tracks a single point: the midpoint of the two wheels.
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
                            # Either wheel inside the restricted lane counts
                            in_roi = any(
                                cv2.pointPolygonTest(roi_poly, (int(px), int(py)), False) >= 0
                                for px, py in seg_wheel_points
                            )
                        else:
                            wheel_point = (int(x2_pix), int(y2_pix))  # box: bottom-right corner
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
    # No shared state to clean up (see docstring).


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
