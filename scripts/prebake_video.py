import cv2
import numpy as np
from ultralytics import YOLO
import sys

def main(input_video_path, output_video_path, model_path):
    # 1. Setup
    print(f"Loading model: {model_path}")
    try:
        model = YOLO(model_path)
    except Exception as e:
        print(f"Error loading model: {e}")
        print("Please ensure ultralytics is installed (pip install ultralytics) and the model path is correct.")
        return

    cap = cv2.VideoCapture(input_video_path)
    if not cap.isOpened():
        print(f"Error: Could not open input video {input_video_path}")
        return
        
    fps = int(cap.get(cv2.CAP_PROP_FPS))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_video_path, fourcc, fps, (width, height))
    
    # 2. Define the Region of Interest (ROI)
    # Example 4-point polygon representing a right lane.
    # You may need to adjust these coordinates based on the actual video resolution/perspective.
    roi_pts = np.array([
        [int(width * 0.6), int(height * 0.4)],
        [int(width * 0.9), int(height * 0.4)],
        [width, height],
        [int(width * 0.5), height]
    ], np.int32)
    roi_pts = roi_pts.reshape((-1, 1, 2))
    
    print(f"Processing video ({width}x{height} at {fps} fps)...")
    print("Press 'q' in the video window to quit early.")
    
    # 3. Processing Loop
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
            
        # Draw the ROI polygon on the frame in red (thickness 2)
        cv2.polylines(frame, [roi_pts], isClosed=True, color=(0, 0, 255), thickness=2)
        
        # Run YOLO model on the frame
        results = model(frame, verbose=False)
        
        # Process detections
        for result in results:
            boxes = result.boxes
            for box in boxes:
                # Class ID 7 is 'truck' in COCO dataset
                cls_id = int(box.cls[0])
                if cls_id == 7:
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    
                    # Calculate the bottom-center point of the bounding box
                    bottom_center_x = (x1 + x2) // 2
                    bottom_center_y = y2
                    
                    # Check if the bottom-center point is inside the ROI polygon
                    dist = cv2.pointPolygonTest(roi_pts, (bottom_center_x, bottom_center_y), False)
                    
                    if dist >= 0:
                        # Inside ROI: VIOLATION (Red bounding box)
                        color = (0, 0, 255) # BGR Red
                        label = f"VIOLATION {conf*100:.0f}%"
                    else:
                        # Outside ROI: Normal (Green bounding box)
                        color = (0, 255, 0) # BGR Green
                        label = f"Truck {conf*100:.0f}%"
                        
                    # Draw bounding box
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    
                    # Draw text label above the box
                    cv2.putText(frame, label, (x1, max(y1 - 10, 0)), 
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                                
                    # Optionally draw the bottom-center point for debugging visualization
                    cv2.circle(frame, (bottom_center_x, bottom_center_y), 5, color, -1)
                    
        # 4. Output
        # Write the processed frame to the VideoWriter
        out.write(frame)
        
        # Display the frame on screen
        cv2.imshow("Video Processing", frame)
        
        # Add cv2.waitKey(1) to allow quitting with 'q'
        if cv2.waitKey(1) & 0xFF == ord('q'):
            print("Processing interrupted by user.")
            break
            
    # Release resources when finished
    cap.release()
    out.release()
    cv2.destroyAllWindows()
    print(f"Finished processing. Output saved to: {output_video_path}")

if __name__ == "__main__":
    # Define file paths based on requirements.
    # Note: adjust the path to 'model_v2.pt' if you run the script from a different directory.
    MODEL_FILE = '../model_v2.pt' 
    INPUT_VIDEO = 'r1.mp4'
    OUTPUT_VIDEO = 'r1_processed.mp4'
    
    # Allow overwriting from command line arguments
    if len(sys.argv) > 1:
        INPUT_VIDEO = sys.argv[1]
    if len(sys.argv) > 2:
        OUTPUT_VIDEO = sys.argv[2]
        
    main(INPUT_VIDEO, OUTPUT_VIDEO, MODEL_FILE)
