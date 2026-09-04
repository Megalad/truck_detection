import cv2
import torch
import torchvision.models as models
import torchvision.transforms as transforms
from PIL import Image
import numpy as np
import json
import os
from datetime import datetime, timedelta
import mysql.connector

# Initialize ResNet18
print("Initializing Re-ID Engine (ResNet18)...")
resnet = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
modules = list(resnet.children())[:-1]
reid_model = torch.nn.Sequential(*modules)
reid_model.eval()
if torch.backends.mps.is_available():
    reid_model = reid_model.to("mps")

preprocess = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

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
    """Extract 512-d vector from a cropped frame."""
    x1, y1, x2, y2 = [int(v) for v in bbox]
    # Ensure bounds
    h, w = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None
        
    img = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
    input_tensor = preprocess(img).unsqueeze(0)
    
    if torch.backends.mps.is_available():
        input_tensor = input_tensor.to("mps")
        
    with torch.no_grad():
        features = reid_model(input_tensor)
        
    fp = features.flatten().cpu().numpy().tolist()
    return fp

def find_matching_route(db_config, fp_vector, current_cam_id, current_time):
    """Check DB for matching fingerprints on the same route within last 15 mins."""
    cam_info = camera_meta.get(current_cam_id)
    if not cam_info or not cam_info['route']:
        return None
        
    conn = mysql.connector.connect(**db_config)
    cursor = conn.cursor(dictionary=True)
    
    # Query last 15 minutes of violations on the same route and direction
    time_limit = current_time - timedelta(minutes=15)
    
    sql = """
        SELECT violation_id, route_match_id, fingerprint, camera_km 
        FROM violations 
        WHERE camera_route = %s 
          AND camera_direction = %s 
          AND timestamp >= %s
          AND fingerprint IS NOT NULL
    """
    cursor.execute(sql, (cam_info['route'], cam_info['direction'], time_limit))
    candidates = cursor.fetchall()
    
    best_match_id = None
    best_sim = 0.0
    
    fp_tensor = torch.tensor(fp_vector).unsqueeze(0)
    
    for row in candidates:
        try:
            cand_fp = json.loads(row['fingerprint'])
            cand_tensor = torch.tensor(cand_fp).unsqueeze(0)
            
            sim = torch.nn.functional.cosine_similarity(fp_tensor, cand_tensor).item()
            if sim > 0.82 and sim > best_sim: # 82% threshold
                best_sim = sim
                best_match_id = row['route_match_id'] if row['route_match_id'] else row['violation_id']
        except:
            pass
            
    cursor.close()
    conn.close()
    
    return best_match_id

