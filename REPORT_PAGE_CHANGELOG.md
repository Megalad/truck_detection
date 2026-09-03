# Weekly Change History (for the Professor report)

A running log of changes — the **Project Report** page
(`web/src/components/ProjectReport.jsx`) and any supporting code — kept so it can
be reported to the Professor each week. Newest week on top.

---

## Week of 2026-09-04

### Fixed: live server — private model per connection + non-blocking inference

**Where:** `web/scripts/live_server.py`, the `/ws/{camera_id}` handler only.
The recorded-video path was left untouched (that page is being retired).

**Two bugs, one fix:**

1. **Shared tracker across cameras.** There was a single global YOLO `model`, and
   `model.track(..., persist=True)` keeps the ByteTrack state *on that object*.
   With more than one camera, their track IDs collided and swapped.
2. **Inference blocked the event loop.** `model.track()` is synchronous CPU/GPU
   work; called directly inside the `async` handler it froze every other
   connected client while one frame ran.

**What changed:**
- Each WebSocket connection now builds its **own** `conn_model = YOLO(model_path)`,
  so its tracker state is private.
- The inference call now runs via `await loop.run_in_executor(...)`, i.e. on a
  worker thread, so the event loop stays free for other clients.
- On connect and on disconnect the handler calls
  `speed_estimator.reset_estimator(camera_id)` and clears that camera's
  `alerted_track_ids`, so Kalman state and the alert set don't leak between
  connections or grow without bound.

**Cost:** each open live connection loads its own copy of the weights
(~0.3–0.5 GB). Fine for the 1–3 cameras we run on the M2.

**Not done (bigger rewrite):** per-connection worker thread with a 1-frame queue
that drops stale frames; moving `camera_rois` / `last_alert_times` out of module
globals into per-connection locals.

**Files changed:** `web/scripts/live_server.py` (compiles clean).

### Added: "Measuring Truck Speed" section (old vs new)

**Where:** `web/src/components/ProjectReport.jsx` — new *Part 3*, added after the
existing "Real-Time Alerts" (Telegram) section. Nothing else in the file or the
project was changed.

**What the new section shows, in order (kept deliberately short):**

1. **Old Method / New Method cards** — 3 plain bullets each + a one-line result.
2. **Real-footage chart** (`kalman_demo.png`) — red jumpy line vs blue steady line.
3. **"Why red is so jumpy — and what we changed"** — 3 one-line problem → fix pairs:

   | Old problem | What we did |
   | --- | --- |
   | Followed the middle of the truck box, which slides around as the truck nears | Follows the wheels on the road, which stay in place |
   | Measured distance with a ruler that changed across the screen | Uses one fixed ruler for the whole camera view |
   | Compared only two frames, so small wobbles looked like big speed jumps | A Kalman filter blends many frames into one steady number |

4. **"Still to do"** — each fixed camera needs a one-time calibration (4 measured
   road points) before the numbers are exact; until then they are consistent but
   still estimates.

**Simplification note (2026-09-04):** first draft had a 5-row detailed table with
~25 sub-bullets and words like "homography" and "wall-clock time". Feedback was
that it made the section *harder* to follow, so it was cut to the 3 plain rows
above, the chart was moved up to lead the section, and the wording was matched
across all three blocks. Deeper technical detail still lives in
`web/SPEED_TRACKING_UPGRADE.md`.

### Added: real-data chart demonstrating the Kalman filter

**Why:** to show the filter working on real footage, not just describe it.

**New script:** `web/scripts/kalman_demo.py` — standalone, does **not** modify
`live_server.py` or `speed_estimator.py`. It runs one recorded video
(`public/recorded_videos/re1.mp4`) through YOLO + tracking and, for a single
truck, records two speed numbers per frame:

- **raw** — instantaneous speed from frame-to-frame movement, no filter;
- **filtered** — the real system output (`speed_estimator.update()`), i.e. the
  Kalman filter.

Both use the *same* ground-point mapping, so the only difference is the filter.

**Outputs (in `web/public/report/`):**
- `kalman_demo.csv` — frame, time, raw km/h, filtered km/h (one tracked truck).
- `kalman_demo.png` — the chart embedded in the report page.

**What the chart shows:** raw speed sawtooths between ~7 and ~145 km/h every
frame while the truck is really doing ~60; the Kalman line is smooth, settles
near 60, and eases down as the truck slows. The camera is uncalibrated, so the
absolute km/h is approximate — the point is red (noisy) vs blue (steady).

**Report page:** new "Real example: one truck, every frame" card added to the
Speed Estimation section, between the comparison table and the analogy.

**To regenerate:** `.venv/bin/python scripts/kalman_demo.py` (full run, ~1 min),
or `--replot` to rebuild only the PNG from the existing CSV.

**Underlying code reference:** the speed logic itself lives in
`web/scripts/speed_estimator.py` and `web/calibration.json`; full technical
write-up is in `web/SPEED_TRACKING_UPGRADE.md` (dated 2026-09-02). This page
section is the presentation-friendly summary of that work — no code was touched
to add it.

**Files changed this week:**
- `web/src/components/ProjectReport.jsx` — added Part 3 + the Kalman chart card (additive only).
- `web/scripts/kalman_demo.py` — new standalone demo script.
- `web/public/report/kalman_demo.png`, `web/public/report/kalman_demo.csv` — new generated outputs.
- `web/scripts/live_server.py` — live-server bug fix (private model + non-blocking inference).
- `web/REPORT_PAGE_CHANGELOG.md` — this file (new).

**Git:** committed as `33b9e16` and pushed to `origin/main`
(`github.com/Megalad/truck_detection`) on 2026-09-04. The commit also carries
teammates' previously-uncommitted edits to `src/App.jsx`,
`src/components/LiveCCTVPlayer.jsx`, and `setup.sql`. Large videos, model files,
and the `public/evidence_*` folders were deliberately left out of git.

**Open item:** the Telegram bot token and DB password are still hardcoded in
`live_server.py` (and were already in git history before this commit) — rotate
the token and move both to environment variables.

---

## Template for next week

```
## Week of YYYY-MM-DD

### Added / Changed: <short title>

**Where:** <file(s)>

**What it explains / does:**
- ...

**Result:**
- ...

**Files changed this week:**
- ...
```
