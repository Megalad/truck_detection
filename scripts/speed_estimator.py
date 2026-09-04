"""
speed_estimator.py
------------------
Upgraded vehicle speed estimation for the Section 35 enforcement system.

Why this file exists
====================
The old speed code (inline in live_server.py) did this per frame:
  - took the CENTRE of the bounding box,
  - measured how many pixels it moved since the *previous* frame,
  - divided by a hand-guessed "pixels per metre" number that changed
    depending on how high up the screen the truck was,
  - divided by wall-clock time,
  - smoothed the result with an EMA (exponential moving average).

That approach is noisy and biased because:
  1. The box centre jumps around when the box grows/shrinks near the camera.
  2. A "pixels per metre" value that changes every frame invents fake motion.
  3. One-frame gaps are too short: detection jitter dominates the reading.
  4. There was no upper sanity limit, so glitches produced 300+ km/h labels.

This module fixes all four:
  1. It uses the BOTTOM-CENTRE of the box (where the tyres meet the road) as
     the point to track - that point sits on the ground plane and is stable.
  2. If a camera is calibrated (see calibration.json) it maps that point to
     real-world metres with a perspective transform (homography). One fixed
     mapping for the whole image, so no invented motion. If the camera is not
     calibrated it falls back to ONE constant pixels-per-metre for that camera
     (still rough, but at least consistent frame to frame).
  3. It feeds the measurements into a small constant-velocity Kalman filter.
     The filter estimates velocity directly and rides through missed
     detections and jitter, giving a smooth number without the lag of an EMA.
  4. It clamps the output to a maximum speed, ignores sub-walking-pace noise,
     and refuses to report until it has seen a few samples for that track.

No new dependencies: only numpy + opencv, both already required.
"""

import json
import os

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Tunables (safe defaults; override per camera via calibration.json)
# ---------------------------------------------------------------------------
DEFAULT_FALLBACK_PPM = 20.0      # pixels per metre when a camera is NOT calibrated
DEFAULT_MAX_SPEED_KMH = 160.0    # anything above this is treated as a glitch
DEFAULT_MIN_SAMPLES = 2          # need this many updates before trusting a speed
DEFAULT_STATIONARY_MPS = 0.6     # below this (~2 km/h) we report 0
LONG_GAP_SECONDS = 4.0           # if a track vanishes longer than this, restart it
DEFAULT_CLEANUP_GRACE = 3.0      # keep a briefly-missing track's filter this long


class _ConstantVelocityKalman:
    """Tiny 2-D constant-velocity Kalman filter.

    State  = [x, y, vx, vy]   (position in metres, velocity in m/s)
    Sensor = [x, y]           (the measured ground point in metres)

    `dt` is passed in on every predict() because live frames do not arrive
    at a fixed rate.
    """

    def __init__(self, x, y, process_var=2.0, measurement_var=1.5):
        self.state = np.array([x, y, 0.0, 0.0], dtype=float)
        self.P = np.eye(4) * 100.0          # start uncertain
        self.q = float(process_var)          # how much we let velocity change
        self.r = float(measurement_var)      # how noisy we think the sensor is

    def predict(self, dt):
        F = np.array([
            [1.0, 0.0, dt,  0.0],
            [0.0, 1.0, 0.0, dt],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
        # White-noise acceleration model for the process noise Q.
        dt2 = dt * dt
        dt3 = dt2 * dt
        dt4 = dt2 * dt2
        Q = self.q * np.array([
            [dt4 / 4.0, 0.0,       dt3 / 2.0, 0.0],
            [0.0,       dt4 / 4.0, 0.0,       dt3 / 2.0],
            [dt3 / 2.0, 0.0,       dt2,       0.0],
            [0.0,       dt3 / 2.0, 0.0,       dt2],
        ])
        self.state = F @ self.state
        self.P = F @ self.P @ F.T + Q

    def update(self, measurement):
        H = np.array([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
        ])
        R = np.eye(2) * self.r
        innovation = np.asarray(measurement, dtype=float) - H @ self.state
        S = H @ self.P @ H.T + R
        K = self.P @ H.T @ np.linalg.inv(S)
        self.state = self.state + K @ innovation
        self.P = (np.eye(4) - K @ H) @ self.P

    @property
    def speed_mps(self):
        return float(np.hypot(self.state[2], self.state[3]))


class SpeedEstimator:
    """One instance per (camera, frame size). Call update() for every detection."""

    def __init__(self, camera_id, frame_w, frame_h, calibration=None):
        self.camera_id = camera_id
        self.frame_w = frame_w
        self.frame_h = frame_h

        calibration = calibration or {}
        self.fallback_ppm = float(calibration.get("fallback_ppm", DEFAULT_FALLBACK_PPM))
        self.max_speed_kmh = float(calibration.get("max_speed_kmh", DEFAULT_MAX_SPEED_KMH))
        self.min_samples = int(calibration.get("min_samples", DEFAULT_MIN_SAMPLES))
        self.stationary_mps = float(calibration.get("stationary_mps", DEFAULT_STATIONARY_MPS))

        # Build the perspective transform (image pixels -> ground-plane metres)
        # only if the camera provides 4+ matched points.
        self.homography = None
        img_pts = calibration.get("image_points")
        world_pts = calibration.get("world_points_m")
        if img_pts and world_pts and len(img_pts) >= 4 and len(img_pts) == len(world_pts):
            src = np.array(img_pts, dtype=np.float32)
            dst = np.array(world_pts, dtype=np.float32)
            self.homography, _ = cv2.findHomography(src, dst)

        self.calibrated = self.homography is not None
        self._tracks = {}   # track_id -> dict(kf, last_t, samples, last_speed)

    # -- internal helpers ---------------------------------------------------
    def _ground_point_metres(self, bbox_pixels):
        """Map the tyre-contact point (bottom-centre of the box) to metres."""
        x1, y1, x2, y2 = bbox_pixels
        px = (float(x1) + float(x2)) / 2.0
        py = float(y2)                      # bottom edge = where wheels touch road

        if self.homography is not None:
            pt = np.array([[[px, py]]], dtype=np.float32)
            world = cv2.perspectiveTransform(pt, self.homography)[0][0]
            return float(world[0]), float(world[1])

        # Uncalibrated fallback: one constant scale for the whole frame.
        return px / self.fallback_ppm, py / self.fallback_ppm

    # -- public API -------------------------------------------------------
    def update(self, track_id, bbox_pixels, timestamp_seconds):
        """Return the smoothed speed (km/h) for this track. 0.0 until confident."""
        if track_id is None or track_id == -1:
            return 0.0

        wx, wy = self._ground_point_metres(bbox_pixels)
        track = self._tracks.get(track_id)

        # First time we see this track: start a filter, no speed yet.
        if track is None:
            self._tracks[track_id] = {
                "kf": _ConstantVelocityKalman(wx, wy),
                "last_t": timestamp_seconds,
                "samples": 1,
                "last_speed": 0.0,
            }
            return 0.0

        dt = timestamp_seconds - track["last_t"]

        # Same frame / clock did not advance: reuse the previous answer.
        if dt <= 1e-3:
            return track["last_speed"]

        # Track disappeared for a while: restart so we don't get a huge jump.
        if dt > LONG_GAP_SECONDS:
            self._tracks[track_id] = {
                "kf": _ConstantVelocityKalman(wx, wy),
                "last_t": timestamp_seconds,
                "samples": 1,
                "last_speed": 0.0,
            }
            return 0.0

        kf = track["kf"]
        kf.predict(dt)
        kf.update((wx, wy))
        track["last_t"] = timestamp_seconds
        track["samples"] += 1

        speed_mps = kf.speed_mps
        if speed_mps < self.stationary_mps:
            speed_mps = 0.0

        speed_kmh = min(speed_mps * 3.6, self.max_speed_kmh)

        # Do not trust the very first readings of a track.
        if track["samples"] < self.min_samples:
            speed_kmh = 0.0

        track["last_speed"] = speed_kmh
        return speed_kmh

    def cleanup(self, active_track_ids, now=None, grace_seconds=DEFAULT_CLEANUP_GRACE):
        """Drop filters for tracks that are no longer on screen.

        A track that is merely missing for a frame or two (common when the
        detector flickers or the tracker briefly loses an ID) keeps its filter
        for `grace_seconds` so its sample count is not reset to zero, which is
        what makes the label fall back to "Tracking...". Pass `now` (the same
        clock used for update()) to enable the grace window; without it the old
        delete-immediately behaviour is kept.
        """
        active = set(int(t) for t in active_track_ids)
        for tid in list(self._tracks.keys()):
            if tid in active:
                continue
            if now is None or (now - self._tracks[tid]["last_t"]) > grace_seconds:
                del self._tracks[tid]


# ---------------------------------------------------------------------------
# Module-level registry so callers just ask for an estimator by camera id.
# ---------------------------------------------------------------------------
_ESTIMATORS = {}
_CALIBRATION_CACHE = None


def _load_calibration():
    global _CALIBRATION_CACHE
    if _CALIBRATION_CACHE is not None:
        return _CALIBRATION_CACHE
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "calibration.json",
    )
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        _CALIBRATION_CACHE = data.get("cameras", data)
    except Exception as exc:  # missing or malformed file -> use defaults
        print(f"[speed_estimator] No usable calibration.json ({exc}); using fallback scale.")
        _CALIBRATION_CACHE = {}
    return _CALIBRATION_CACHE


def get_estimator(camera_id, frame_w, frame_h):
    """Get (creating if needed) the SpeedEstimator for this camera + frame size."""
    key = (camera_id, int(frame_w), int(frame_h))
    est = _ESTIMATORS.get(key)
    if est is None:
        calib = _load_calibration().get(camera_id)
        est = SpeedEstimator(camera_id, int(frame_w), int(frame_h), calibration=calib)
        _ESTIMATORS[key] = est
        tag = "calibrated (homography)" if est.calibrated else f"fallback {est.fallback_ppm:.0f} px/m"
        print(f"[speed_estimator] {camera_id} {frame_w}x{frame_h}: {tag}")
    return est


def reset_estimator(camera_id):
    """Forget all state for a camera (used when a recorded job restarts)."""
    for key in list(_ESTIMATORS.keys()):
        if key[0] == camera_id:
            del _ESTIMATORS[key]
