# Speed Tracking Upgrade — What Changed and Why

**Date:** 2026-09-02
**Scope:** speed estimation only. Detection, tracking, ROI, violation logic, Telegram, and the database were **not** touched.

---

## 1. Short version

The old speed code guessed how fast a truck was going by watching how many
pixels the **middle of its box** moved between **two frames in a row**, then
dividing by a "pixels-per-metre" number that **changed depending on where the
truck was on the screen**. That produced jumpy, often wrong numbers (sometimes
200–300 km/h from a single glitch).

The new code:

1. Tracks the **bottom-centre of the box** (where the tyres touch the road)
   instead of the middle.
2. Converts that point to **real-world metres** using a fixed per-camera
   perspective map (**homography**) when the camera is calibrated; otherwise it
   uses **one** constant scale for the whole picture.
3. Feeds the measurements into a small **Kalman filter** that estimates speed
   smoothly and copes with missed frames.
4. **Clamps** impossible values, ignores tiny sub-walking-pace jitter, and
   waits for a few frames before showing any number.

Result: steadier, more believable km/h readings, and a clear path to *accurate*
readings once each fixed camera is calibrated once.

---

## 2. Files added

| File | What it is |
| --- | --- |
| `scripts/speed_estimator.py` | New module. All speed maths now lives here: the `SpeedEstimator` class, the Kalman filter, and a `get_estimator(camera_id, w, h)` helper. Uses only `numpy` + `opencv` — **no new dependencies**. |
| `calibration.json` | New per-camera calibration file (with a built-in `_README`). Optional: cameras missing from it just use the fallback scale. |

## 3. Files changed

| File | Change |
| --- | --- |
| `scripts/live_server.py` | Added `import speed_estimator`. Replaced the inline speed block in **both** places (`/api/process_recorded` and the live `/ws/{camera_id}` handler) with a call to the new estimator. Added `estimator.cleanup(...)` after each frame so finished tracks are forgotten. Marked the old `camera_track_histories` / `PIXELS_PER_METER` globals as legacy (left in place, no longer used for speed). |

Nothing else in `live_server.py` changed — the box the frontend receives still
has the same `label` field (`"32.4 km/h"`, `"Tracking..."`, `"VIOLATION ..."`),
so the React side needs no change.

---

## 4. The problems in the old code (in plain English)

The old logic (still visible in git history) did this for every truck, every frame:

```
point   = centre of the bounding box
moved   = distance in pixels from where it was last frame
ppm     = 12, 20, or 35  depending on how high up the screen the box is
metres  = moved / ppm
seconds = now() - last_time     (wall-clock)
speed   = metres / seconds       then smoothed with an EMA
```

Why it was unreliable:

1. **The box centre is not a fixed point on the truck.** As a truck comes
   closer the box gets taller, so its centre drifts upward even if the truck
   only moved forward. That drift gets read as extra speed.

2. **A "pixels-per-metre" that changes every frame invents motion.** When the
   truck crossed from the "mid" zone (20 px/m) to the "near" zone (35 px/m),
   the *same* real position suddenly converted to a different number of metres.
   The code saw that as the truck jumping.

3. **One frame is too short a ruler.** Detection boxes wobble by a few pixels
   frame to frame. Over one frame that wobble is a big fraction of the real
   movement, so the raw speed swung wildly. The EMA hid some of it but added
   lag.

4. **`time.time()` includes the AI's own delay.** If one frame took 250 ms to
   run the model and the next took 40 ms, the "seconds" value jumped around and
   corrupted the speed even when the truck moved steadily.

5. **No upper limit.** Any single bad frame could print "287.4 km/h".

---

## 5. What the new code does

### Step 1 — Track the tyre-contact point
We use the **bottom-centre** of the box: `x = (x1 + x2) / 2`, `y = y2`.
That point sits on the road surface and barely moves when the box grows or
shrinks, so it is a much more honest marker of where the truck actually is.

### Step 2 — Convert pixels to metres with ONE fixed map per camera
If `calibration.json` has 4+ matched points for the camera, we build a
**homography** (`cv2.findHomography`) once. Every pixel then maps to a
real-world `(X, Y)` in metres on the flat road plane — the same mapping for the
whole image and for every frame, so crossing "zones" no longer invents motion.

Thailand motorway measurements you can use to calibrate:
- lane width = **3.5 m**
- dashed lane line = **3 m paint + 6 m gap** (9 m repeat)

If the camera is **not** calibrated, we fall back to **one** constant
`fallback_ppm` (default 20 px/m). Still approximate, but at least consistent
frame to frame, which removes problem #2 above.

### Step 3 — Smooth with a Kalman filter (not an EMA)
Each track gets a tiny **constant-velocity Kalman filter**
(state = position + velocity, in metres and m/s). For every new measurement we:
- `predict` forward by the real elapsed time `dt`,
- `update` with the measured ground point.

The filter outputs velocity **directly**, rides through a missed detection or
two, and does not lag the way a heavy EMA does. Speed = `hypot(vx, vy) * 3.6`.

### Step 4 — Sanity rules
- **Max speed clamp:** anything above `max_speed_kmh` (default 160) is capped —
  kills the "287 km/h" glitches.
- **Stationary cut-off:** below ~0.6 m/s (~2 km/h) we report `0.0`.
- **Warm-up:** the first `min_samples` (default 3) readings of a track return
  `0.0` — we don't trust a brand-new track.
- **Long gap reset:** if a track vanishes for more than 2 s and comes back, its
  filter restarts instead of reporting a huge jump.

### Step 5 — Better time source for recorded videos
For `/api/process_recorded` we now measure time as **`frame_number / fps`**
instead of `time.time()`. A recorded file has an exact, even frame rate, so this
removes the AI-delay jitter (problem #4) completely for the playback path.
(The live WebSocket path still has to use `time.time()` because browser frames
arrive irregularly — but the Kalman filter absorbs most of that noise.)

---

## 6. How to make it accurate for a real camera

1. Grab one clear frame from the fixed camera.
2. Find 4 points on the flat road that form a shape you can measure
   (e.g. two lane lines × two dashes → a 3.5 m × 9 m rectangle).
3. Read the pixel `(x, y)` of each of those 4 points.
4. Add an entry to `calibration.json` under `cameras`, keyed by the camera id
   (`TV73R`, `camera2`, …):

```json
"cameras": {
  "TV73R": {
    "image_points":   [[512,380],[770,382],[910,700],[300,695]],
    "world_points_m": [[0,0],[3.5,0],[3.5,18],[0,18]]
  }
}
```

5. Restart the Python server. The log prints
   `[speed_estimator] TV73R 1280x720: calibrated (homography)`.

Until a camera is calibrated it prints `fallback 20 px/m` and the numbers are
rough estimates only.

---

## 7. Tuning knobs (all optional, per camera in `calibration.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `fallback_ppm` | 20 | pixels per metre when there is no homography |
| `max_speed_kmh` | 160 | glitch clamp |
| `min_samples` | 3 | frames to wait before showing a speed |
| `stationary_mps` | 0.6 | below this → report 0 |

Filter responsiveness lives in `speed_estimator.py`
(`_ConstantVelocityKalman(process_var, measurement_var)`): raise
`measurement_var` for smoother/slower, raise `process_var` for snappier/noisier.

---

## 8. What was NOT done (possible next steps)

- No calibration points are filled in yet — only an example entry. Real
  accuracy needs step 6 done per camera.
- The live path still uses wall-clock time. A frame-timestamp from the browser
  would improve it further.
- Pre-existing (unrelated) bug noticed while editing: `/api/process_recorded`
  references a variable named `camera_id` in a few spots where it should be
  `req.camera_id`. Left as-is to keep this change speed-only.
