CREATE DATABASE IF NOT EXISTS section35_db;
USE section35_db;

CREATE TABLE IF NOT EXISTS violations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    violation_id VARCHAR(255) NOT NULL,
    timestamp DATETIME NOT NULL,
    camera_location VARCHAR(255) NOT NULL,
    roi_polygon JSON NOT NULL,
    evidence_video_url VARCHAR(255) NOT NULL,
    video_name VARCHAR(255) NOT NULL
);
