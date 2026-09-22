CREATE DATABASE IF NOT EXISTS section35_db;
USE section35_db;

CREATE TABLE IF NOT EXISTS violations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    violation_id VARCHAR(255) NOT NULL,
    timestamp DATETIME NOT NULL,
    camera_location VARCHAR(255) NOT NULL,
    roi_polygon JSON NOT NULL,
    evidence_snapshot_url VARCHAR(255),
    -- Re-ID (scripts/reid_engine.py): links a truck's fingerprint across cameras on the
    -- same route so repeat sightings share one route_match_id.
    fingerprint TEXT,
    route_match_id VARCHAR(255),
    camera_route VARCHAR(50),
    camera_direction VARCHAR(10),
    camera_km DECIMAL(10,3),
    speed_kmh DECIMAL(10,3)
);
