import asyncio
import cv2
import json
import torch
import ultralytics
import os
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

@app.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    print(f"[{camera_id}] WebSocket connection opened")
    try:
        while True:
            # Receive binary frame from client
            data = await websocket.receive_bytes()
            
            # Decode JPEG
            np_arr = np.frombuffer(data, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            
            if frame is None:
                continue
                
            # Run inference
            results = model.predict(source=frame, conf=0.5, verbose=False)
            result = results[0]
            
            boxes = []
            if result.boxes is not None:
                for i in range(len(result.boxes.cls)):
                    cls_id = int(result.boxes.cls[i].cpu().numpy())
                    class_name = model.names[cls_id]
                    if class_name in ["truck", "heavy_truck"]:
                        coords = result.boxes.xyxyn[i].cpu().numpy()
                        conf = float(result.boxes.conf[i].cpu().numpy())
                        boxes.append({
                            "x1": float(coords[0]),
                            "y1": float(coords[1]),
                            "x2": float(coords[2]),
                            "y2": float(coords[3]),
                            "conf": conf,
                            "label": f"Truck {int(conf * 100)}%"
                        })
            
            # Send directly as JSON array to match the frontend update
            await websocket.send_json(boxes)
    except WebSocketDisconnect:
        print(f"[{camera_id}] WebSocket disconnected")
    except Exception as e:
        print(f"[{camera_id}] Error in WebSocket loop: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
