"""
speed_estimator.py
------------------
Vehicle speed estimation for the Section 35 enforcement system.

Pipeline (per detection, per track):
  1. Take the BOTTOM-CENTRE of the bounding box (where the tyres meet the road).
     That point sits on the ground plane, so it is stable even as the box grows
     or shrinks near the camera.
  2. Median-smooth that pixel point over the last few frames to kill the
     one-frame jitter the detector adds to the box edges.  (#5)
  3. Map it to real-world metres:
       - with a perspective transform (homography) if the camera is calibrated
         in calibration.json - one fixed mapping for the whole image, so no
         invented motion, and both lanes read correctly;   (#1)
       - otherwise fall back to ONE constant pixels-per-metre for that camera
         (rough, but consistent frame to frame).
  4. Feed the metre point into a small constant-velocity Kalman filter that
     estimates velocity directly and rides through missed detections.
       - Each measurement is gated: a reading that implies an impossible jump
         (ID swap, occlusion) is rejected instead of being absorbed.   (#3)
       - The process / measurement noise are tunable per camera.        (#4)
  5. Cross-check the filter against a plain displacement-over-time estimate
     computed on the raw measurements inside a short window, and clamp the
     filter output to a sane band around it - kills residual spikes without
     adding the lag of a moving average.                               (#7)
  6. Clamp the reported number: max speed, sub-walking-pace -> 0, no output
     until a few samples are in and the filter has converged, and a physical
     limit on how fast the label may change between frames.            (#6)

No new dependencies: only numpy + opencv, both already required.
"""

import json
import os
import collections

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Tunables (safe defaults; override per camera via calibration.json)
# ---------------------------------------------------------------------------
DEFAULT_FALLBACK_PPM = 20.0        # pixels per metre when a camera is NOT calibrated
DEFAULT_MAX_SPEED_KMH = 160.0      # anything above this is treated as a glitch
DEFAULT_MIN_SAMPLES = 2            # accepted updates before a speed is trusted
DEFAULT_STATIONARY_MPS = 0.6      # below this (~2 km/h) we report 0
LONG_GAP_SECONDS = 4.0             # if a track vanishes longer than this, restart it
DEFAULT_CLEANUP_GRACE = 4.0        # keep a briefly-missing track's filter this long

DEFAULT_PROCESS_VAR = 2.0          # how much we let the velocity drift (m/s^2)^2
DEFAULT_MEASUREMENT_VAR = 1.5      # how noisy we think the metre measurement is (m^2)
DEFAULT_GATE_CHI2 = 13.8           # chi-square, 2 dof, ~99.9% - reject beyond this
DEFAULT_MAX_REJECTS = 5            # consecutive rejected readings -> restart the track
DEFAULT_POINT_MEDIAN = 3          # frames of median smoothing on the ground pixel point
DEFAULT_WINDOW_SECONDS = 1.0       # displacement cross-check window
DEFAULT_MAX_ACCEL_MPS2 = 6.0       # cap on how fast the reported speed may change
DEFAULT_CONV_VAR = 100.0           # relaxed to let speed show up much faster


class _IMMKalmanFilter:
    """Tiny 2-model Interacting Multiple Model (IMM) Filter.

    Model 0: Constant Velocity (low process noise, for cruising)
    Model 1: Maneuvering (high process noise, for braking/accelerating)
    """

    def __init__(self, x, y, process_var=DEFAULT_PROCESS_VAR,
                 measurement_var=DEFAULT_MEASUREMENT_VAR):
        # We define two process noises: one low (cruising), one high (maneuvering)
        self.q = [float(process_var) * 0.1, float(process_var) * 10.0]
        self.r = float(measurement_var)
        
        # Initial mode probabilities (90% cruising, 10% maneuvering)
        self.mu = np.array([0.9, 0.1], dtype=float)
        
        # Transition matrix: high probability of staying in same mode
        self.T = np.array([
            [0.95, 0.05],
            [0.10, 0.90]
        ], dtype=float)
        
        self.x = [np.array([x, y, 0.0, 0.0], dtype=float) for _ in range(2)]
        self.P = [np.eye(4) * 100.0 for _ in range(2)]
        
        self.state = np.copy(self.x[0])
        self.P_mix = np.copy(self.P[0])

    def predict(self, dt):
        # 1. Mixing probabilities
        c_bar = self.T.T @ self.mu # [2,]
        
        mu_mix = np.zeros((2, 2))
        for i in range(2):
            for j in range(2):
                if c_bar[j] > 0:
                    mu_mix[i, j] = self.T[i, j] * self.mu[i] / c_bar[j]
                
        # 2. Mix states and covariances
        x_mix = []
        P_mix = []
        for j in range(2):
            xj = np.zeros(4)
            for i in range(2):
                xj += self.x[i] * mu_mix[i, j]
            x_mix.append(xj)
            
            Pj = np.zeros((4, 4))
            for i in range(2):
                diff = (self.x[i] - xj).reshape(4, 1)
                Pj += mu_mix[i, j] * (self.P[i] + diff @ diff.T)
            P_mix.append(Pj)
            
        # 3. Predict for each model
        F = np.array([
            [1.0, 0.0, dt,  0.0],
            [0.0, 1.0, 0.0, dt],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
        dt2 = dt * dt
        dt3 = dt2 * dt
        dt4 = dt2 * dt2
        
        Q_base = np.array([
            [dt4 / 4.0, 0.0,       dt3 / 2.0, 0.0],
            [0.0,       dt4 / 4.0, 0.0,       dt3 / 2.0],
            [dt3 / 2.0, 0.0,       dt2,       0.0],
            [0.0,       dt3 / 2.0, 0.0,       dt2],
        ])
        
        for j in range(2):
            self.x[j] = F @ x_mix[j]
            self.P[j] = F @ P_mix[j] @ F.T + self.q[j] * Q_base
            
        self.mu = c_bar
        self._combine_state()

    def update(self, measurement, gate_chi2=None):
        H = np.array([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
        ])
        R = np.eye(2) * self.r
        z = np.asarray(measurement, dtype=float)

        # Gate on the combined (mixture) prediction BEFORE touching any
        # per-model state. This is the actual chi-square test; a reading
        # that fails it never mutates self.x / self.P, so it is truly
        # rejected rather than absorbed.
        if gate_chi2 is not None:
            inn0 = z - H @ self.state
            S0 = H @ self.P_mix @ H.T + R
            try:
                S0_inv = np.linalg.inv(S0)
            except np.linalg.LinAlgError:
                S0_inv = np.linalg.pinv(S0)
            d2_0 = float(inn0 @ S0_inv @ inn0)
            if d2_0 > gate_chi2:
                return False

        likelihoods = np.zeros(2)
        x_new = [None, None]
        P_new = [None, None]

        for j in range(2):
            inn = z - H @ self.x[j]
            S = H @ self.P[j] @ H.T + R
            try:
                S_inv = np.linalg.inv(S)
            except np.linalg.LinAlgError:
                S_inv = np.linalg.pinv(S)

            K = self.P[j] @ H.T @ S_inv
            x_new[j] = self.x[j] + K @ inn
            P_new[j] = (np.eye(4) - K @ H) @ self.P[j]

            # Likelihood
            det_S = np.linalg.det(S)
            if det_S <= 0: det_S = 1e-9

            d2 = float(inn @ S_inv @ inn)

            likelihoods[j] = (1.0 / np.sqrt((2 * np.pi)**2 * det_S)) * np.exp(-0.5 * d2)

        mu_new = self.mu * likelihoods
        sum_mu = np.sum(mu_new)
        if sum_mu < 1e-15:
            return False

        # Only commit once both gates pass - a rejected reading leaves
        # self.x / self.P / self.mu completely untouched.
        self.x = x_new
        self.P = P_new
        self.mu = mu_new / sum_mu
        self._combine_state()
        return True

    def _combine_state(self):
        self.state = np.zeros(4)
        for j in range(2):
            self.state += self.mu[j] * self.x[j]
            
        self.P_mix = np.zeros((4, 4))
        for j in range(2):
            diff = (self.x[j] - self.state).reshape(4, 1)
            self.P_mix += self.mu[j] * (self.P[j] + diff @ diff.T)

    @property
    def speed_mps(self):
        return float(np.hypot(self.state[2], self.state[3]))

    @property
    def velocity_mps(self):
        return float(self.state[2]), float(self.state[3])

    @property
    def velocity_var(self):
        return float(self.P_mix[2, 2] + self.P_mix[3, 3])


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

        # Kalman / gating / smoothing knobs (all optional per camera).
        self.process_var = float(calibration.get("process_var", DEFAULT_PROCESS_VAR))
        self.measurement_var = float(calibration.get("measurement_var", DEFAULT_MEASUREMENT_VAR))
        self.gate_chi2 = float(calibration.get("gate_chi2", DEFAULT_GATE_CHI2))
        self.max_rejects = int(calibration.get("max_rejects", DEFAULT_MAX_REJECTS))
        self.point_median = max(1, int(calibration.get("point_median", DEFAULT_POINT_MEDIAN)))
        self.window_seconds = float(calibration.get("window_seconds", DEFAULT_WINDOW_SECONDS))
        self.max_accel_mps2 = float(calibration.get("max_accel_mps2", DEFAULT_MAX_ACCEL_MPS2))
        self.conv_var = float(calibration.get("conv_var", DEFAULT_CONV_VAR))

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
        self._tracks = {}   # track_id -> dict(kf, last_t, samples, last_speed, ...)

    # -- internal helpers ---------------------------------------------------
    def _raw_ground_pixel(self, bbox_pixels):
        """Tyre-contact point in pixels: bottom edge, horizontal centre."""
        x1, y1, x2, y2 = bbox_pixels
        return (float(x1) + float(x2)) / 2.0, float(y2)

    def _pixel_to_metres(self, px, py):
        if self.homography is not None:
            pt = np.array([[[px, py]]], dtype=np.float32)
            world = cv2.perspectiveTransform(pt, self.homography)[0][0]
            return float(world[0]), float(world[1])
        # Uncalibrated fallback: one constant scale for the whole frame.
        return px / self.fallback_ppm, py / self.fallback_ppm

    def _ground_point_metres(self, bbox_pixels):
        """Bottom-centre of the box in ground-plane metres, no smoothing.

        Kept for callers (e.g. kalman_demo.py) that want the raw mapping.
        """
        px, py = self._raw_ground_pixel(bbox_pixels)
        return self._pixel_to_metres(px, py)

    def _new_track(self, wx, wy, timestamp_seconds):
        return {
            "kf": _IMMKalmanFilter(wx, wy, self.process_var, self.measurement_var),
            "last_t": timestamp_seconds,
            "samples": 1,
            "last_speed": 0.0,
            "rejects": 0,
            "pts": collections.deque(maxlen=self.point_median),   # raw pixel points
            "hist": collections.deque(),                          # (t, wx, wy) measurements
        }

    def _window_speed_mps(self, hist):
        """Plain displacement / elapsed-time over the measurement window.

        Independent of the Kalman filter, so it makes a good spike clamp.
        Returns None until the window holds enough spread to be meaningful.
        """
        if len(hist) < 3:
            return None
        t0, x0, y0 = hist[0]
        t1, x1, y1 = hist[-1]
        span = t1 - t0
        if span < 0.5 * self.window_seconds or span <= 1e-3:
            return None
        return float(np.hypot(x1 - x0, y1 - y0) / span)

    # -- public API -------------------------------------------------------
    def update(self, track_id, bbox_pixels, timestamp_seconds, opt_point=None):
        """Return the smoothed speed (km/h) for this track. 0.0 until confident."""
        if track_id is None or track_id == -1:
            return 0.0

        if opt_point is not None:
            raw_px, raw_py = opt_point
        else:
            raw_px, raw_py = self._raw_ground_pixel(bbox_pixels)
        track = self._tracks.get(track_id)

        # First time we see this track: start a filter, no speed yet.
        if track is None:
            wx, wy = self._pixel_to_metres(raw_px, raw_py)
            track = self._new_track(wx, wy, timestamp_seconds)
            track["pts"].append((raw_px, raw_py))
            track["hist"].append((timestamp_seconds, wx, wy))
            self._tracks[track_id] = track
            return None

        dt = timestamp_seconds - track["last_t"]

        # Same frame / clock did not advance: reuse the previous answer.
        if dt <= 1e-3:
            return track["last_speed"]

        # Track disappeared for a while: restart so we don't get a huge jump.
        if dt > LONG_GAP_SECONDS:
            wx, wy = self._pixel_to_metres(raw_px, raw_py)
            self._tracks[track_id] = self._new_track(wx, wy, timestamp_seconds)
            self._tracks[track_id]["pts"].append((raw_px, raw_py))
            self._tracks[track_id]["hist"].append((timestamp_seconds, wx, wy))
            return None

        # #5 - median-smooth the pixel point before projecting it.
        track["pts"].append((raw_px, raw_py))
        pxs = np.array(track["pts"], dtype=float)
        sm_px, sm_py = float(np.median(pxs[:, 0])), float(np.median(pxs[:, 1]))
        wx, wy = self._pixel_to_metres(sm_px, sm_py)

        kf = track["kf"]
        kf.predict(dt)
        accepted = kf.update((wx, wy), gate_chi2=self.gate_chi2)

        if not accepted:
            # #3 - outlier. Drop it from the pixel-smoothing window too, so a
            # single bad detection can't linger and skew the next few frames'
            # median. Don't advance samples; if it keeps happening the track
            # is broken (ID swap), so rebuild it from the current point.
            if track["pts"]:
                track["pts"].pop()
            track["rejects"] += 1
            track["last_t"] = timestamp_seconds
            if track["rejects"] >= self.max_rejects:
                self._tracks[track_id] = self._new_track(wx, wy, timestamp_seconds)
                self._tracks[track_id]["pts"].append((raw_px, raw_py))
                self._tracks[track_id]["hist"].append((timestamp_seconds, wx, wy))
                return None
            return track["last_speed"]

        track["rejects"] = 0
        track["last_t"] = timestamp_seconds
        track["samples"] += 1

        # #7 - keep a short window of raw measurements for the cross-check.
        hist = track["hist"]
        hist.append((timestamp_seconds, wx, wy))
        while hist and (timestamp_seconds - hist[0][0]) > self.window_seconds:
            hist.popleft()

        speed_mps = kf.speed_mps
        win_mps = self._window_speed_mps(hist)
        if win_mps is not None:
            # Clamp the filter output to a sane band around the model-free
            # estimate. Wide enough not to fight real acceleration, tight
            # enough to swallow spikes.
            lo = max(0.0, 0.5 * win_mps - 3.0)
            hi = 1.5 * win_mps + 3.0
            speed_mps = min(max(speed_mps, lo), hi)

        if speed_mps < self.stationary_mps:
            speed_mps = 0.0

        speed_kmh = min(speed_mps * 3.6, self.max_speed_kmh)

        # #6 - do not trust the first readings, or an unconverged filter.
        if track["samples"] < self.min_samples or kf.velocity_var > self.conv_var:
            track["last_speed"] = 0.0
            return None

        # #6 - limit how fast the label may change between frames.
        max_step = self.max_accel_mps2 * 3.6 * dt
        prev = track["last_speed"]
        if prev > 0.0:
            speed_kmh = min(max(speed_kmh, prev - max_step), prev + max_step)

        track["last_speed"] = speed_kmh
        return speed_kmh

    def velocity(self, track_id):
        """(vx, vy) in m/s for a live track, or None. Sign gives direction."""
        track = self._tracks.get(track_id)
        if track is None or track["samples"] < self.min_samples:
            return None
        return track["kf"].velocity_mps

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


def reload_calibration():
    """Forget the cached calibration.json (call after editing it)."""
    global _CALIBRATION_CACHE
    _CALIBRATION_CACHE = None
    _ESTIMATORS.clear()


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
