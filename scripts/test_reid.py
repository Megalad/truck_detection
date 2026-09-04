import cv2
import torch
import torch.nn.functional as F
import torchvision.models as models
import torchvision.transforms as transforms
from PIL import Image
import numpy as np
import os

# 1. Setup the Feature Extractor (ResNet18)
print("Loading ResNet18 Feature Extractor...")
# We use ResNet18 but remove the final classification layer so it outputs the raw 512-d features
resnet = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
modules = list(resnet.children())[:-1]
model = torch.nn.Sequential(*modules)
model.eval()

# Image transforms (standard for ResNet)
preprocess = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

def get_fingerprint(image_path):
    img = Image.open(image_path).convert('RGB')
    input_tensor = preprocess(img)
    input_batch = input_tensor.unsqueeze(0)
    
    with torch.no_grad():
        features = model(input_batch)
    
    # Flatten the 512x1x1 tensor to a 1D vector of 512 numbers
    fingerprint = features.flatten()
    return fingerprint

# 2. Extract crops for our test using cv2
print("Extracting test images from videos...")
os.makedirs("outputs/reid_test", exist_ok=True)

def extract_crop(video_path, frame_idx, bbox, out_name):
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()
    x1, y1, x2, y2 = bbox
    crop = frame[y1:y2, x1:x2]
    cv2.imwrite(f"outputs/reid_test/{out_name}", crop)
    return f"outputs/reid_test/{out_name}"

# From previous logs: re1.mp4 frame 300 has a truck at (0,863)-(233,1177)
# Let's get it at frame 300 and frame 330 (it will have moved)
path_A1 = extract_crop("public/recorded_videos/re1.mp4", 300, (0, 863, 233, 1177), "truck_A_time1.jpg")
path_A2 = extract_crop("public/recorded_videos/re1.mp4", 310, (50, 880, 280, 1190), "truck_A_time2.jpg") # Approximated movement

# From re2.mp4 frame 400: a completely different truck at (1976,603)-(2490,914)
path_B = extract_crop("public/recorded_videos/re2.mp4", 400, (1976, 603, 2490, 914), "truck_B.jpg")

# 3. Get Fingerprints
print("\nExtracting Fingerprints (512-dimension vectors)...")
fp_A1 = get_fingerprint(path_A1)
fp_A2 = get_fingerprint(path_A2)
fp_B = get_fingerprint(path_B)

# 4. Compare them mathematically!
print("\n=== AI MATCHING RESULTS ===")
sim_same_truck = F.cosine_similarity(fp_A1.unsqueeze(0), fp_A2.unsqueeze(0)).item()
sim_diff_truck = F.cosine_similarity(fp_A1.unsqueeze(0), fp_B.unsqueeze(0)).item()

print(f"Similarity (Same Truck, Different Frames): {sim_same_truck * 100:.2f}%")
print(f"Similarity (Two Completely Different Trucks): {sim_diff_truck * 100:.2f}%")

if sim_same_truck > 0.85 and sim_diff_truck < 0.85:
    print("\n✅ SUCCESS: The AI successfully recognized the same truck and rejected the false one!")
