"""
License Plate Recognition Test on Motorway CCTV Footage
Pipeline: YOLO truck detect → Crop → Upscale → Plate detect → Thai OCR
"""
import cv2
import torch
import numpy as np
import os
import easyocr

# Fix PyTorch loading
_orig = torch.load
torch.load = lambda *a, **kw: _orig(*a, **{**kw, 'weights_only': False})
from ultralytics import YOLO

# === CONFIG ===
MODEL_PATH = "model_v2.pt"
OUTPUT_DIR = "outputs/lpr_test"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Initialize models
print("Loading YOLO truck detector...")
truck_model = YOLO(MODEL_PATH)

print("Loading EasyOCR (Thai + English)... (first run downloads ~100MB)")
ocr_reader = easyocr.Reader(['th', 'en'], gpu=torch.backends.mps.is_available(), model_storage_directory='outputs/easyocr_models', user_network_directory='outputs/easyocr_models')

def upscale_image(img, scale=4):
    """Simple bicubic upscale (fast, no extra model needed)"""
    h, w = img.shape[:2]
    return cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

def enhance_for_plate(img):
    """Enhance contrast and sharpness for plate reading"""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    enhanced = cv2.merge([l, a, b])
    enhanced = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)
    
    # Sharpen
    kernel = np.array([[-1, -1, -1],
                       [-1,  9, -1],
                       [-1, -1, -1]])
    sharpened = cv2.filter2D(enhanced, -1, kernel)
    return sharpened

def try_read_plate(truck_crop, truck_idx, frame_idx):
    """Attempt to find and read license plate from a truck crop"""
    h, w = truck_crop.shape[:2]
    results = []
    
    # Strategy 1: Upscale the whole truck crop 4x and OCR everything
    upscaled = upscale_image(truck_crop, scale=4)
    enhanced = enhance_for_plate(upscaled)
    cv2.imwrite(f"{OUTPUT_DIR}/frame{frame_idx}_truck{truck_idx}_enhanced.jpg", enhanced)
    
    ocr_results = ocr_reader.readtext(enhanced, detail=1)
    for (bbox, text, conf) in ocr_results:
        text = text.strip()
        if len(text) >= 2:
            results.append({'text': text, 'confidence': conf, 'bbox': bbox})
    
    # Strategy 2: Focus on bottom portion (where plates usually are)
    bottom_crop = truck_crop[int(h * 0.5):, :]
    if bottom_crop.shape[0] > 20 and bottom_crop.shape[1] > 20:
        bottom_up = upscale_image(bottom_crop, scale=4)
        bottom_enh = enhance_for_plate(bottom_up)
        cv2.imwrite(f"{OUTPUT_DIR}/frame{frame_idx}_truck{truck_idx}_bottom_enhanced.jpg", bottom_enh)
        
        ocr_bottom = ocr_reader.readtext(bottom_enh, detail=1)
        for (bbox, text, conf) in ocr_bottom:
            text = text.strip()
            if len(text) >= 2:
                results.append({'text': text, 'confidence': conf, 'bbox': bbox, 'region': 'bottom_focus'})
    
    return results

def process_video_frames(video_path, sample_frames=None):
    """Process specific frames from a video"""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  ERROR: Cannot open {video_path}")
        return
    
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"  Video: {w}x{h}, {total} frames")
    
    if sample_frames is None:
        sample_frames = [int(total * i / 6) for i in range(1, 6)]
    
    for frame_idx in sample_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            continue
        
        print(f"\n  --- Frame {frame_idx} ---")
        
        detections = truck_model.predict(frame, conf=0.3, verbose=False)
        boxes = detections[0].boxes
        
        if len(boxes) == 0:
            print(f"  No trucks detected")
            continue
        
        print(f"  Found {len(boxes)} truck(s)")
        
        for i, box in enumerate(boxes):
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            conf = box.conf[0].item()
            truck_crop = frame[y1:y2, x1:x2]
            crop_h, crop_w = truck_crop.shape[:2]
            
            print(f"  Truck {i}: bbox=({x1},{y1})-({x2},{y2}), size={crop_w}x{crop_h}, conf={conf:.2f}")
            cv2.imwrite(f"{OUTPUT_DIR}/frame{frame_idx}_truck{i}_raw.jpg", truck_crop)
            
            plate_results = try_read_plate(truck_crop, i, frame_idx)
            
            if plate_results:
                print(f"  OCR Results for Truck {i}:")
                for r in plate_results:
                    region = r.get('region', 'full_crop')
                    print(f"     Text: '{r['text']}' (conf: {r['confidence']:.2f}, region: {region})")
            else:
                print(f"  No readable text found on Truck {i}")
            
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 3)
            label = f"Truck {conf:.2f}"
            if plate_results:
                best = max(plate_results, key=lambda r: r['confidence'])
                label += f" | {best['text']}"
            cv2.putText(frame, label, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        
        cv2.imwrite(f"{OUTPUT_DIR}/frame{frame_idx}_annotated.jpg", frame)
    
    cap.release()


# === RUN TESTS ===
print("\n" + "=" * 60)
print("TEST 1: re1.mp4 (TV03CL2 M9-0+000-KL)")
print("=" * 60)
process_video_frames("public/recorded_videos/re1.mp4", [100, 300, 500, 800, 1500])

print("\n" + "=" * 60)
print("TEST 2: re2.mp4 (TV76CL2 M9-55+250-ON)")  
print("=" * 60)
process_video_frames("public/recorded_videos/re2.mp4", [100, 400, 700, 1000])

print("\n" + "=" * 60)
print("DONE - Results saved to outputs/lpr_test/")
print("=" * 60)
