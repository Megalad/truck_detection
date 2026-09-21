import cv2
import numpy as np
import json
import os
from datetime import datetime, timedelta
import mysql.connector

# Vehicle re-ID model: ResNet34 trained on VeRi-776 (ONNX, 512-d embedding).
# Source: https://huggingface.co/dgwon/resnet-34-veri776-onnx (file resnet34_veri776.onnx),
# stored as models/reid_resnet34_veri776.onnx. Replaced an ImageNet-only ResNet18, which
# separated look-alike trucks poorly. Fingerprints from the two models are NOT comparable,
# so clear old `fingerprint` values (and route_match_id) when switching models.
import onnxruntime as ort

REID_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "reid_resnet34_veri776.onnx"
)
REID_INPUT_SIZE = 256
_REID_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_REID_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

print("Initializing Re-ID Engine (ResNet34 / VeRi-776)...")
reid_session = None
try:
    _providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
    reid_session = ort.InferenceSession(REID_MODEL_PATH, providers=_providers)
    _reid_input_name = reid_session.get_inputs()[0].name
except Exception as e:
    print(f"Re-ID model unavailable ({e}); fingerprints and route matching are disabled.")

# Load camera metadata
camera_meta = {}
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cam_json_path = os.path.join(base_dir, 'camera.json')
try:
    with open(cam_json_path, 'r', encoding='utf-8') as f:
        cctv_list = json.load(f).get('data', {}).get('cctv', [])
        for item in cctv_list:
            title = item.get('title', '')
            cam_id = title.split(' ')[0] if ' ' in title else title
            
            # Parse km string "12+345" to float 12.345
            km_str = item.get('km', '0+000')
            km_val = 0.0
            if '+' in km_str:
                parts = km_str.split('+')
                try:
                    km_val = float(parts[0]) + (float(parts[1])/1000.0)
                except:
                    pass
                    
            camera_meta[cam_id] = {
                'route': item.get('route', ''),
                'direction': item.get('direction', ''),
                'km': km_val,
                'lat': item.get('latitude', ''),
                'lon': item.get('longitude', '')
            }
except Exception as e:
    print(f"Failed to load camera.json: {e}")

def get_fingerprint_from_frame(frame, bbox):
    """Extract an L2-normalised 512-d vehicle embedding from a cropped frame.
    Returns None if the re-ID model is unavailable or the crop is empty."""
    if reid_session is None:
        return None
    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None

    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    rgb = cv2.resize(rgb, (REID_INPUT_SIZE, REID_INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
    x = ((rgb.astype(np.float32) / 255.0 - _REID_MEAN) / _REID_STD).transpose(2, 0, 1)[None]
    emb = reid_session.run(None, {_reid_input_name: x})[0][0].astype(np.float64)
    norm = np.linalg.norm(emb)
    if norm == 0:
        return None
    return (emb / norm).tolist()

# Cosine-similarity threshold for the ResNet34/VeRi-776 embedding. Measured on ~1600
# truck crops from two live cameras: 0.89 accepts ~1% of different-truck pairs from the
# same camera and ~62% of same-truck pairs (~85% at 0.84 / 5%). Raise it for fewer false
# matches, lower it for more true ones; re-measure if the model changes.
REID_SIM_THRESHOLD = 0.89
# A truck can't travel between two cameras faster than this; faster => different truck.
REID_MAX_PLAUSIBLE_KMH = 160.0

def find_matching_route(db_config, fp_vector, current_cam_id, current_time):
    """Check DB for a matching fingerprint from a DIFFERENT camera on the same
    route and direction within the last 15 mins. The same camera is excluded: the
    same truck can't be re-identified at the camera it was just seen at (that only
    linked look-alike trucks, or a tracker duplicate, under one route id). A
    candidate is also dropped if reaching this camera from its camera in the time
    between them would need an implausible speed."""
    cam_info = camera_meta.get(current_cam_id)
    if not cam_info or not cam_info['route']:
        return None
        
    conn = mysql.connector.connect(**db_config)
    cursor = conn.cursor(dictionary=True)
    
    # Query last 15 minutes of violations on the same route and direction
    time_limit = current_time - timedelta(minutes=15)
    
    sql = """
        SELECT violation_id, route_match_id, fingerprint, camera_km, timestamp 
        FROM violations 
        WHERE camera_route = %s 
          AND camera_direction = %s 
          AND timestamp >= %s
          AND camera_location <> %s
          AND fingerprint IS NOT NULL
    """
    cursor.execute(sql, (cam_info['route'], cam_info['direction'], time_limit, current_cam_id))
    candidates = cursor.fetchall()
    
    best_match_id = None
    best_sim = 0.0
    
    fp = np.asarray(fp_vector, dtype=np.float64)
    fp = fp / (np.linalg.norm(fp) or 1.0)
    
    for row in candidates:
        try:
            dt_h = (current_time - row['timestamp']).total_seconds() / 3600.0
            dist_km = abs(float(cam_info['km']) - float(row['camera_km'] or 0.0))
            if dt_h <= 0 or dist_km / dt_h > REID_MAX_PLAUSIBLE_KMH:
                continue
            cand_fp = json.loads(row['fingerprint'])
            cand = np.asarray(cand_fp, dtype=np.float64)
            if cand.shape != fp.shape:
                continue  # fingerprint from a different model
            
            sim = float(fp @ cand / (np.linalg.norm(cand) or 1.0))
            if sim > REID_SIM_THRESHOLD and sim > best_sim:
                best_sim = sim
                best_match_id = row['route_match_id'] if row['route_match_id'] else row['violation_id']
        except:
            pass
            
    cursor.close()
    conn.close()
    
    return best_match_id

