import torch
from ultralytics import YOLO
import cv2
import numpy as np

# create dummy image
img = np.zeros((480, 640, 3), dtype=np.uint8)
img[100:200, 200:300] = 255 # draw a white square

model = YOLO('model_v2.pt')
results = model.predict(img, verbose=False)
if len(results) > 0 and len(results[0].boxes) > 0:
    print("xyxyn:", results[0].boxes.xyxyn[0])
    print("xywhn:", results[0].boxes.xywhn[0])
