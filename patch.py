import re

with open('scripts/live_server.py', 'r') as f:
    content = f.read()

# Add import
if 'import scripts.reid_engine' not in content:
    content = content.replace('import json', 'import json\nimport scripts.reid_engine as reid_engine')

# Change def save_video_and_db
old_def = 'def save_video_and_db(camera_id, frames, violation_id, roi_polygon_json, snapshot_url=""):'
new_def = 'def save_video_and_db(camera_id, frames, violation_id, roi_polygon_json, snapshot_url="", violating_bbox=None, trigger_frame=None):'
content = content.replace(old_def, new_def)

# Modify the call to save_video_and_db
content = re.sub(r'target=save_video_and_db, args=\(cam, rec\[\'frames\'\], rec\[\'violation_id\'\], rec\[\'roi_polygon\'\], rec\[\'snapshot_url\'\]\)', 
                 r'target=save_video_and_db, args=(cam, rec[\'frames\'], rec[\'violation_id\'], rec[\'roi_polygon\'], rec[\'snapshot_url\'], rec.get(\'violating_bbox\'), rec.get(\'trigger_frame\'))', content)

# Inject the re-id and updated SQL logic inside save_video_and_db
old_sql_block = """    # 2. MySQL Insert Block
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        sql = \"\"\"INSERT INTO violations (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url) 
                 VALUES (%s, %s, %s, %s, %s, %s, %s)\"\"\"
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, evidence_video_url, filename, snapshot_url)"""
        
new_sql_block = """    # 2. Re-ID and MySQL Insert Block
    try:
        # Extract Fingerprint
        fp_json = None
        route_match_id = None
        cam_route = None
        cam_dir = None
        cam_km = 0.0
        
        if trigger_frame is not None and violating_bbox is not None:
            fp_vector = reid_engine.get_fingerprint_from_frame(trigger_frame, violating_bbox)
            if fp_vector:
                fp_json = json.dumps(fp_vector)
                
                # Check DB for match
                current_time = datetime.now()
                matched = reid_engine.find_matching_route(DB_CONFIG, fp_vector, camera_id, current_time)
                
                if matched:
                    route_match_id = matched
                else:
                    route_match_id = f"ROUTE-{int(current_time.timestamp())}"
        
        # Get metadata
        if camera_id in reid_engine.camera_meta:
            meta = reid_engine.camera_meta[camera_id]
            cam_route = meta['route']
            cam_dir = meta['direction']
            cam_km = meta['km']

        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        sql = \"\"\"INSERT INTO violations 
                 (violation_id, timestamp, camera_location, roi_polygon, evidence_video_url, video_name, evidence_snapshot_url, fingerprint, route_match_id, camera_route, camera_direction, camera_km) 
                 VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)\"\"\"
        val = (violation_id, datetime.now(), camera_id, roi_polygon_json, evidence_video_url, filename, snapshot_url, fp_json, route_match_id, cam_route, cam_dir, cam_km)"""
content = content.replace(old_sql_block, new_sql_block)

with open('scripts/live_server.py', 'w') as f:
    f.write(content)
print('Patched scripts/live_server.py')
