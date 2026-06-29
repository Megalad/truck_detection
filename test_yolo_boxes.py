import cv2
import torch
from ultralytics import YOLO

_original_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _original_load(*args, **kwargs)
torch.load = _safe_load

model = YOLO("model_v2.pt")
import urllib.request
urllib.request.urlretrieve("https://ultralytics.com/images/zidane.jpg", "zidane.jpg")
img = cv2.imread("zidane.jpg")

res = model.predict(img, conf=0.1, verbose=False)[0]
print("boxes.xyxyn:", res.boxes.xyxyn)
print("boxes.xywhn:", res.boxes.xywhn)
