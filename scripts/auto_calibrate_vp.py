#!/usr/bin/env python3
"""
auto_calibrate_vp.py
--------------------
Experimental auto-calibration for traffic cameras using Vanishing Points.

This script does NOT require manual clicking. Instead, it:
1. Watches a video stream.
2. Uses Lucas-Kanade Optical Flow to track moving vehicles.
3. Fits lines to the vehicle trajectories.
4. Finds the intersection of these lines to locate the primary Vanishing Point (VP) of the road.

Once the VP is found, we can mathematically determine the camera's tilt (pitch) 
and un-warp the road into a top-down view (assuming zero roll).

Usage:
  python auto_calibrate_vp.py --video path_to_video.mp4
  python auto_calibrate_vp.py --stream "http://.../playlist.m3u8"
"""

import cv2
import numpy as np
import argparse
import sys
import math

import random

def get_vanishing_point(lines, threshold=15, num_iters=1000):
    """
    Given a list of lines (represented as [x1, y1, x2, y2]), find the intersection 
    point (Vanishing Point) using RANSAC to ignore outliers (like cars changing lanes).
    """
    if len(lines) < 2:
        return None
        
    best_vp = None
    max_inliers = -1
    best_inlier_lines = []
    
    # Calculate A, B, C for all lines: Ax + By + C = 0
    line_eqs = []
    for x1, y1, x2, y2 in lines:
        A = y1 - y2
        B = x2 - x1
        C = x1 * y2 - x2 * y1
        norm = math.hypot(A, B)
        if norm > 1e-5:
            line_eqs.append((A/norm, B/norm, C/norm))
            
    if len(line_eqs) < 2:
        return None

    # RANSAC Loop
    for _ in range(num_iters):
        # Pick 2 random lines
        idx1, idx2 = random.sample(range(len(line_eqs)), 2)
        A1, B1, C1 = line_eqs[idx1]
        A2, B2, C2 = line_eqs[idx2]
        
        # Calculate intersection using Cramer's rule
        det = A1 * B2 - A2 * B1
        if abs(det) < 1e-5: # Parallel lines
            continue
            
        x = (B1 * C2 - B2 * C1) / det
        y = (A2 * C1 - A1 * C2) / det
        
        # Count inliers (lines whose distance to the intersection point is < threshold)
        inliers = 0
        inlier_lines = []
        for A, B, C in line_eqs:
            dist = abs(A * x + B * y + C)
            if dist < threshold:
                inliers += 1
                inlier_lines.append((A, B, C))
                
        if inliers > max_inliers:
            max_inliers = inliers
            best_vp = (int(x), int(y))
            best_inlier_lines = inlier_lines
            
    # Refine the best VP using Least Squares ONLY on the inliers!
    if best_vp and len(best_inlier_lines) >= 2:
        A_mat = []
        b_mat = []
        for A, B, C in best_inlier_lines:
            A_mat.append([A, B])
            b_mat.append(-C)
        try:
            res = np.linalg.lstsq(np.array(A_mat), np.array(b_mat), rcond=None)[0]
            return int(res[0]), int(res[1])
        except np.linalg.LinAlgError:
            return best_vp
            
    return best_vp

def main():
    ap = argparse.ArgumentParser(description="Auto-Calibrate via Vanishing Point")
    ap.add_argument("camera_id", nargs="?", default="AUTO_CALIB_CAM", help="Camera ID to save in calibration.json")
    ap.add_argument("--video", help="Path to video file")
    ap.add_argument("--stream", help="Path to stream URL")
    ap.add_argument("--max_frames", type=int, default=400, help="Number of frames to process")
    args = ap.parse_args()

    src = args.video or args.stream
    if not src:
        sys.exit("Please provide --video or --stream")

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"Could not open source: {src}")

    # Warmup loop for HLS streams (first few frames are often corrupted)
    print("Warming up stream...")
    for _ in range(30):
        cap.read()

    ret, old_frame = cap.read()
    if not ret:
        sys.exit("Could not read frame after warmup.")

    # Use Background Subtraction instead of Optical Flow (works MUCH better at night/with headlights)
    back_sub = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=50, detectShadows=False)
    
    # Tracking state: dictionary of { track_id: [ (x,y), (x,y), ... ] }
    tracks = {}
    next_track_id = 0
    motion_lines = []

    frame_count = 0
    print(f"Tracking vehicles to find vanishing point (Processing {args.max_frames} frames)...")

    while frame_count < args.max_frames:
        ret, frame = cap.read()
        if not ret:
            break
            
        # Apply Background Subtractor
        fg_mask = back_sub.apply(frame)
        
        # Clean up the mask (remove noise)
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_DILATE, np.ones((15, 15), np.uint8))
        
        # Find moving blobs
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        current_centroids = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area > 400: # Filter out tiny noise
                M = cv2.moments(cnt)
                if M["m00"] != 0:
                    cx = int(M["m10"] / M["m00"])
                    cy = int(M["m01"] / M["m00"])
                    current_centroids.append((cx, cy))
                    
        # Match centroids to existing tracks (very simple nearest neighbor)
        new_tracks = {}
        used_centroids = set()
        
        for t_id, t_points in tracks.items():
            last_p = t_points[-1]
            # Find closest centroid
            closest_p = None
            min_dist = float('inf')
            
            for i, p in enumerate(current_centroids):
                if i in used_centroids:
                    continue
                dist = math.hypot(p[0] - last_p[0], p[1] - last_p[1])
                # Max pixel movement per frame (adjust if cars move too fast/slow)
                if dist < 80: 
                    if dist < min_dist:
                        min_dist = dist
                        closest_p = (i, p)
                        
            if closest_p:
                used_centroids.add(closest_p[0])
                t_points.append(closest_p[1])
                new_tracks[t_id] = t_points
                
                # If track is long enough, save it as a finished motion line
                dist_total = math.hypot(t_points[-1][0] - t_points[0][0], t_points[-1][1] - t_points[0][1])
                if dist_total > 150: # Minimum total pixel movement to qualify as a car track
                    motion_lines.append([t_points[0][0], t_points[0][1], t_points[-1][0], t_points[-1][1]])
                    del new_tracks[t_id] # Stop tracking this one to prevent line curving
            
        # Start new tracks for unmatched centroids
        for i, p in enumerate(current_centroids):
            if i not in used_centroids:
                new_tracks[next_track_id] = [p]
                next_track_id += 1
                
        tracks = new_tracks
        frame_count += 1
        
        if frame_count % 50 == 0:
            print(f"Processed {frame_count}/{args.max_frames} frames... Found {len(motion_lines)} motion tracks.")

    cap.release()

    # Find the Vanishing Point
    print("Calculating Vanishing Point...")
    vp = get_vanishing_point(motion_lines)

    # Visualization
    display_frame = old_frame.copy()
    
    # Draw all the tracked motion lines
    for x1, y1, x2, y2 in motion_lines:
        cv2.line(display_frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)

    if vp:
        print(f"Vanishing Point Found at (X: {vp[0]}, Y: {vp[1]})")
        # Draw Vanishing Point
        cv2.circle(display_frame, vp, 10, (0, 0, 255), -1)
        cv2.putText(display_frame, f"Vanishing Point {vp}", (vp[0] + 15, vp[1] - 15), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                    
        # Draw lines from track ends to the vanishing point to show the projection
        for x1, y1, x2, y2 in motion_lines:
             cv2.line(display_frame, (int(x2), int(y2)), vp, (0, 100, 255), 1)
             
        # Generate the calibration data
        print("\n--- Auto-Generating Homography ---")
        h, w = old_frame.shape[:2]
        
        # We need the camera ID to save it
        cam_id = None
        for arg in sys.argv:
            if arg.startswith("TV") or arg.startswith("camera"):
                cam_id = arg
                break
        if not cam_id and "TV73R" in src:
            cam_id = "TV73R"
        elif not cam_id:
            cam_id = "AUTO_CALIB_CAM"
            
        # Pinhole Camera Assumptions
        focal_length = w  # Assume roughly 60-degree FOV
        cam_height = 6.5  # Assume standard highway pole height in meters
        
        # Pick a trapezoid in the lower half of the image
        y_bottom = h - 20
        y_top = vp[1] + int((h - vp[1]) * 0.4) # 40% of the way from horizon to bottom
        
        if y_top <= vp[1]:
            y_top = vp[1] + 10 # Safety fallback
            
        x_left = int(w * 0.2)
        x_right = int(w * 0.8)
        
        img_points = [
            [x_left, y_bottom],
            [x_right, y_bottom],
            [x_right, y_top],
            [x_left, y_top]
        ]
        
        world_points = []
        for x, y in img_points:
            # Pinhole projection mapping (assuming 0 roll)
            # Distance from camera base along the road
            Y_world = (cam_height * focal_length) / (y - vp[1])
            # Distance left/right from the camera centerline
            X_world = (cam_height * (x - vp[0])) / (y - vp[1])
            world_points.append([round(X_world, 2), round(Y_world, 2)])
            
        # Save to JSON
        import json
        import os
        
        calib_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "calibration.json")
        data = {}
        if os.path.exists(calib_path):
            try:
                with open(calib_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                pass
                
        cams = data.setdefault("cameras", {})
        entry = cams.get(cam_id, {})
        entry["image_points"] = img_points
        entry["world_points_m"] = world_points
        entry["max_speed_kmh"] = 160
        # Resolution these points were computed at (old_frame's own size) - speed_estimator.py
        # rescales to whatever it actually runs at, so this calibration stays correct even if
        # that's a different resolution (e.g. a downscaled inference frame).
        entry["image_width"] = w
        entry["image_height"] = h
        cams[cam_id] = entry
        
        with open(calib_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            
        print(f"Successfully calculated real-world grid using VP {vp}.")
        print(f"Assumed Camera Height: {cam_height}m, Focal Length: {focal_length}px")
        print(f"Updated calibration.json for camera: {cam_id}")
        
    else:
        print("Failed to find enough motion lines to calculate a Vanishing Point.")
    # Save output to public directory so frontend can show it
    public_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "calibration_results")
    os.makedirs(public_dir, exist_ok=True)
    output_path = os.path.join(public_dir, f"{cam_id}_vp.jpg")
    cv2.imwrite(output_path, display_frame)
    print(f"Saved visualization to {output_path}")

if __name__ == "__main__":
    main()
