import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { demoClipExists, demoClipUrl, useReplayMode } from '../replay';
import { pushAlert } from '../alerts';
import { setOverlayModel as setOverlayModelFor, useOverlayModel } from '../overlayModel';
import { adminLogout, getAdminToken, useAdminSession, requestAdminLogin } from '../adminAuth';

/**
 * One camera tile: plays the camera's HLS stream (or its replay clip), sends frames to the
 * Python server over a WebSocket, and draws the returned truck boxes and the camera's ROI.
 * Admins can edit the ROI and run speed calibration from here.
 */

const LiveCCTVPlayer = ({ streamUrl, cameraId, onViolationAlert }) => {
  // Live <video> plays at full rate; a transparent canvas on top redraws
  // every animation frame (~60/sec via requestAnimationFrame), easing each
  // box a fraction of the way from its last drawn position toward the latest
  // WebSocket detection - POS_SMOOTHING below. There is no
  // extrapolation/velocity term - the box only ever moves toward a real
  // detection, so it can't drift or ghost off a vehicle. The rAF loop is
  // what fills in smooth motion between detections (which arrive slower than
  // the screen refreshes); without it the box would only move once per
  // WebSocket response.

  // Replay ("Plan B"): play public/demo/<cameraId>.mp4 instead of the CCTV stream - only when
  // the operator switches to Replay (never automatically), and only if that clip exists;
  // otherwise the camera keeps its live stream.
  const forcedReplay = useReplayMode();
  const [clipOk, setClipOk] = useState(null); // null = not checked yet
  useEffect(() => {
    let cancelled = false;
    demoClipExists(cameraId).then((ok) => { if (!cancelled) setClipOk(ok); });
    return () => { cancelled = true; };
  }, [cameraId]);
  const replay = forcedReplay && clipOk === true;

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const svgRef = useRef(null);

  // Add custom event listener for external ROI toggle from kebab menu
  useEffect(() => {
    const handler = () => {
      // Already signed in: requestAdminLogin runs this immediately, no modal shown - see
      // its comment in adminAuth.js for why the modal itself is now a single shared
      // component instead of one copy per camera card.
      requestAdminLogin(() => setIsEditingRoi(prev => !prev), cameraId);
    };
    const handleManualCalibrate = () => {
      setIsManualCalibrating(true);
      setManualCalibPoints([]);
    };
    window.addEventListener(`toggle-roi-${cameraId}`, handler);
    window.addEventListener(`trigger-manual-calibrate-${cameraId}`, handleManualCalibrate);
    return () => {
      window.removeEventListener(`toggle-roi-${cameraId}`, handler);
      window.removeEventListener(`trigger-manual-calibrate-${cameraId}`, handleManualCalibrate);
    };
  }, [cameraId]);

  const aiCanvasRef = useRef(null);       // reused downscaled canvas -> JPEG to server
  const latestBoxesRef = useRef([]);      // last batch of boxes received; the rAF loop eases toward these
  const renderBoxesRef = useRef(new Map()); // id -> last drawn (eased) box, so POS_SMOOTHING has something to ease from
  const rafRef = useRef(0);

  const AI_MAX_WIDTH = 640;          // downscale frames sent to the AI
  const AI_JPEG_QUALITY = 0.6;
  const POS_SMOOTHING = 0.1;         // per-update ease toward the new box (0-1; 1 = old snap-instantly behavior)

  const [polygonPoints, setPolygonPoints] = useState([]);
  const [isDrawingFinished, setIsDrawingFinished] = useState(false);
  const [isEditingRoi, setIsEditingRoi] = useState(false);

  // Admin session gate for actually CHANGING the ROI - see adminAuth.js. Any viewer sees
  // the ROI (pushed by the server below, CURRENT_ROI); only a signed-in admin can move it.
  // The sign-in modal itself is a single shared component (AdminLoginModal, rendered once
  // in App.jsx) - see requestAdminLogin's use above, not local state/JSX here anymore.
  useAdminSession(); // re-render this component when login/logout happens elsewhere
  
  const [isManualCalibrating, setIsManualCalibrating] = useState(false);
  const [manualCalibPoints, setManualCalibPoints] = useState([]);
  const [manualWidth, setManualWidth] = useState("3.5");
  const [manualLength, setManualLength] = useState("27.0");
  
  // Admin-only box-vs-segmentation shadow toggle (see websocket_test_endpoint in
  // live_server.py). "box" connects to the real /ws/{cameraId} (unchanged, always safe).
  // "seg" connects to the separate, isolated /ws-test/{cameraId}?model=seg instead - it
  // never touches the real production Kalman filters / alert dedup / DB / Telegram, so
  // switching this can't affect what anyone else watching this camera sees.
  // Shared per-camera store, so the ⋮ menu, the on-video toggle and the SEG TEST badge agree.
  const overlayModel = useOverlayModel(cameraId);
  const setOverlayModel = (model) => setOverlayModelFor(cameraId, model);
  const [testModelUnavailable, setTestModelUnavailable] = useState(false);
  // drawBoxes runs inside a rAF loop set up once (see the `[]`-deps effect below), so it
  // can't see later re-renders' state directly - same reason latestBoxesRef exists. Mirror
  // overlayModel into a ref so the loop always reads its current value, not the one from
  // whichever render happened to be live when that effect first ran.
  const overlayModelRef = useRef('box');
  useEffect(() => { overlayModelRef.current = overlayModel; }, [overlayModel]);

  const [normalizedPointsState, setNormalizedPointsState] = useState([]);
  const [calibrationStatus, setCalibrationStatus] = useState(null); // 'manual_done' while the confirmation shows

  useEffect(() => {
    let hls;
    const video = videoRef.current;

    // The camera servers are plain HTTP; fetching that directly works fine when this page
    // itself is HTTP, but browsers silently block it as mixed content once the page is
    // reached over HTTPS (e.g. via Cloudflare) - the <video> just never loads, no visible
    // error. Routed through our own server (server.js's /cctv proxy) instead, so the
    // browser only ever talks to this same origin, regardless of which protocol got used.
    const proxiedStreamUrl = streamUrl ? `/cctv/${cameraId}/playlist.m3u8` : streamUrl;

    // 1. Initialize the video source: a local recording (replay) or the HLS stream
    if (video && replay) {
      video.src = demoClipUrl(cameraId);
      video.loop = true;
      video.muted = true;
      video.play().catch(() => {});
    } else if (video && streamUrl) {
      if (Hls.isSupported()) {
        // Tuned for slow ~10s segments: buffer up to ~3 segments so one late segment doesn't
        // freeze playback, and wait longer than hls.js's 10s default for a segment's first
        // byte (the proxy tolerates up to 20s of silence). Plain HLS, so no lowLatencyMode.
        const optimizedHlsConfig = {
          enableWorker: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 6,
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 25000,
              maxLoadTimeMs: 60000,
              timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
            },
          },
        };

        hls = new Hls(optimizedHlsConfig);
        hls.loadSource(proxiedStreamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // The last level is the highest quality (e.g. 1080p)
          hls.currentLevel = hls.levels.length - 1;
          console.log(`[${cameraId}] Forced HLS to maximum resolution.`);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn(`[${cameraId}] Network error. Attempting to recover...`);
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn(`[${cameraId}] Media error. Recovering...`);
                hls.recoverMediaError();
                break;
              default:
                hls.destroy();
                break;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxiedStreamUrl;
      }
    }

    // 2. Initialize WebSocket for AI Bounding Boxes
    let isConnected = false;
    const connectWebSocket = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = window.location.hostname === 'localhost' ? 'localhost:8000' : window.location.host;
      const wsPath = overlayModel === 'seg' ? `/ws-test/${cameraId}?model=seg` : `/ws/${cameraId}`;
      const wsUrl = `${wsProtocol}//${wsHost}${wsPath}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const sendNextFrame = () => {
        if (!isConnected) return;
        const video = videoRef.current;
        if (ws.readyState === WebSocket.OPEN && video && !video.paused && !video.ended && video.videoWidth > 0) {
          try {
            // Downscale the frame before sending: JPEG encode, network and YOLO
            // preprocessing all scale with pixel count; boxes come back
            // normalized so placement is unaffected.
            const aScale = Math.min(1, AI_MAX_WIDTH / video.videoWidth);
            const aw = Math.round(video.videoWidth * aScale);
            const ah = Math.round(video.videoHeight * aScale);
            let aiCanvas = aiCanvasRef.current;
            if (!aiCanvas) {
              aiCanvas = document.createElement('canvas');
              aiCanvasRef.current = aiCanvas;
            }
            if (aiCanvas.width !== aw || aiCanvas.height !== ah) {
              aiCanvas.width = aw;
              aiCanvas.height = ah;
            }
            aiCanvas.getContext('2d').drawImage(video, 0, 0, aw, ah);

            aiCanvas.toBlob((blob) => {
              if (blob && ws.readyState === WebSocket.OPEN) {
                ws.send(blob);
              }
            }, 'image/jpeg', AI_JPEG_QUALITY);
          } catch (e) {
            console.error(`[${cameraId}] Error capturing frame:`, e);
          }
        } else if (isConnected) {
          // If video isn't ready, wait a bit and try again
          setTimeout(() => requestAnimationFrame(sendNextFrame), 100);
        }
      };

      ws.onopen = () => {
        console.log(`[${cameraId}] Connected to AI WebSocket`);
        isConnected = true;
        sendNextFrame();
      };

      // Messages from the detection server
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'VIOLATION_ALERT') {
            pushAlert({ cameraId, message: data.message, snapshot: data.snapshot });
            if (onViolationAlert) {
              const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              onViolationAlert(`🔴 ${data.message} on ${data.camera} at ${timeStr}`);
            }
            return;
          }

          if (data.type === 'CURRENT_ROI') {
            // Pushed by the server on connect, and again after any admin's save - the one
            // shared ROI, the same for every viewer, whether or not they can edit it.
            applyServerRoi(data.points);
            return;
          }

          if (data.type === 'ROI_UNAUTHORIZED') {
            alert('Your admin session has expired or is invalid - please sign in again.');
            setIsEditingRoi(false);
            return;
          }

          if (data.type === 'CALIBRATION_STATUS') {
            // Manual calibration saved: show a brief confirmation.
            if (data.status === 'manual_done') {
              setCalibrationStatus('manual_done');
              setTimeout(() => setCalibrationStatus(null), 3000);
            }
            return;
          }

          if (data.type === 'TEST_MODEL_UNAVAILABLE') {
            setTestModelUnavailable(true);
            setOverlayModel('box'); // fall back so the view doesn't just sit dark
            return;
          }

          if (data.type === 'SHADOW_VIOLATION') {
            // Never a real filed violation (no DB row, no Telegram, no evidence file - see
            // websocket_test_endpoint) - tagged unmistakably so it's never mistaken for one.
            if (onViolationAlert) {
              const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              onViolationAlert(`🧪 [TEST - segmentation, not filed] Would have flagged a violation on ${cameraId} at ${timeStr}`);
            }
            return;
          }

          // Box data: BBOX_DATA messages (or a bare array from older servers)
          let boxesToDraw = [];

          if (Array.isArray(data)) {
            boxesToDraw = data;
          } else if (data.type === 'BBOX_DATA') {
            boxesToDraw = data.boxes;
          } else {
            return;
          }

          // Just record the latest target; the rAF loop eases toward it
          // every animation frame - no extrapolation.
          console.log(cameraId, boxesToDraw.map(b => `${b.track_id}:${b.label}`));

          latestBoxesRef.current = boxesToDraw || [];

          if (isConnected) {
            // Lockstep request/response (no queue buildup) but with NO artificial
            // delay - send the next frame the moment a result lands.
            requestAnimationFrame(sendNextFrame);
          }
        } catch (e) {
          console.error(`[${cameraId}] Error parsing WebSocket message:`, e);
        }
      };

      ws.onclose = () => {
        console.log(`[${cameraId}] AI WebSocket disconnected. Reconnecting in 3s...`);
        isConnected = false;
        // Forget boxes so stale ones don't linger over the live feed.
        latestBoxesRef.current = [];
        renderBoxesRef.current.clear();
        setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (err) => {
        console.error(`[${cameraId}] AI WebSocket error:`, err);
        ws.close();
      };
    };

    connectWebSocket();

    // Cleanup
    return () => {
      isConnected = false;
      if (hls) hls.destroy();
      if (video && replay) { video.removeAttribute('src'); video.load(); }
      if (wsRef.current) wsRef.current.close();
    };
  }, [streamUrl, cameraId, replay, overlayModel]);

  // Draw the given boxes onto the overlay canvas, mapping normalized
  // (full-frame) coords through the same object-fit: cover crop the <video>
  // uses so boxes sit on vehicles. Each box is eased by POS_SMOOTHING from
  // its last drawn position (renderBoxesRef) toward the new one - the only
  // smoothing here, no velocity/time term involved. Called every animation
  // frame by the rAF loop below, always against the latest known boxes
  // (latestBoxesRef) - so a frame with no new WebSocket message yet still
  // eases one more step toward the last target instead of standing still.
  const drawBoxes = (boxes) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const cw = video.clientWidth;
    const ch = video.clientHeight;
    if (cw === 0 || ch === 0) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // work in CSS pixels
    ctx.clearRect(0, 0, cw, ch);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    // object-fit: cover -> scaled by the LARGER ratio, centre-cropped
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx.font = '11px Arial';
    ctx.textBaseline = 'alphabetic';

    const renderBoxes = renderBoxesRef.current;
    const seen = new Set();

    (boxes || []).forEach((box, idx) => {
      const hasId = box.track_id !== undefined && box.track_id !== null && box.track_id !== -1;
      const id = hasId ? `t${box.track_id}` : `i${idx}`;
      seen.add(id);

      const prev = renderBoxes.get(id);
      // First sighting draws exactly at the detection (no ease-in from
      // nowhere); later updates ease from the last drawn box.
      const rx1 = prev ? prev.x1 + (box.x1 - prev.x1) * POS_SMOOTHING : box.x1;
      const ry1 = prev ? prev.y1 + (box.y1 - prev.y1) * POS_SMOOTHING : box.y1;
      const rx2 = prev ? prev.x2 + (box.x2 - prev.x2) * POS_SMOOTHING : box.x2;
      const ry2 = prev ? prev.y2 + (box.y2 - prev.y2) * POS_SMOOTHING : box.y2;
      renderBoxes.set(id, { x1: rx1, y1: ry1, x2: rx2, y2: ry2 });

      const x1 = dx + rx1 * dw;
      const y1 = dy + ry1 * dh;
      const x2 = dx + rx2 * dw;
      const y2 = dy + ry2 * dh;

      // Violation (either pipeline) always reads red; otherwise green for the real
      // production overlay, purple for the experimental segmentation test view - so it's
      // visually obvious which one is on screen, never mistaken for the real feed.
      const boxColor = box.violation ? '#ef4444' : (overlayModelRef.current === 'seg' ? '#a855f7' : '#22c55e');
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      if (box.label) {
        const textWidth = ctx.measureText(box.label).width;
        const ly = Math.max(14, y1);
        ctx.fillStyle = boxColor;
        ctx.fillRect(x1, ly - 14, textWidth + 10, 14);
        ctx.fillStyle = 'white';
        ctx.fillText(box.label, x1 + 5, ly - 3);
      }
    });

    // Drop render state for ids no longer present, immediately (no grace
    // period/TTL) - matches the plain snap version's behavior of a box just
    // disappearing once the backend stops reporting it.
    for (const id of renderBoxes.keys()) {
      if (!seen.has(id)) renderBoxes.delete(id);
    }
  };

  // One rAF loop for the life of the component: redraw every animation frame
  // (~60/sec), easing toward whatever latestBoxesRef currently holds. This is
  // the only thing added back here - everything else (no velocity, no
  // extrapolation, immediate drop of tracks no longer reported) is unchanged.
  useEffect(() => {
    const loop = () => {
      drawBoxes(latestBoxesRef.current);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const handleSvgClick = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isManualCalibrating) {
      if (manualCalibPoints.length < 4) {
        setManualCalibPoints([...manualCalibPoints, { x, y }]);
      }
      return;
    }

    if (!isEditingRoi || isDrawingFinished) return;
    setPolygonPoints([...polygonPoints, { x, y }]);
  };

  const handleClearLane = () => {
    setPolygonPoints([]);
    setIsDrawingFinished(false);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "SET_LANE_ROI", points: [], admin_token: getAdminToken() }));
    }
  };

  const handleFinishDrawing = () => {
  if (polygonPoints.length < 3) { alert("..."); return; }
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) { alert("..."); return; }

  const video = videoRef.current;
  const rect = svgRef.current.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;

  // Same object-fit: cover transform as drawBoxes
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (rect.width - dw) / 2, dy = (rect.height - dh) / 2;

  const normalizedPoints = polygonPoints.map(p => ({
    x: (p.x - dx) / dw,      // screen -> normalised frame coordinates
    y: (p.y - dy) / dh
  }));

  setIsDrawingFinished(true);
  setNormalizedPointsState(normalizedPoints);
  wsRef.current.send(JSON.stringify({ type: "SET_LANE_ROI", points: normalizedPoints, admin_token: getAdminToken() }));
  alert("ROI Saved!");
};
  const handleSaveManualCalibration = () => {
    if (manualCalibPoints.length !== 4) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const video = videoRef.current;
    const rect = svgRef.current.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;

    const scale = Math.max(rect.width / vw, rect.height / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = (rect.width - dw) / 2, dy = (rect.height - dh) / 2;

    const absolutePoints = manualCalibPoints.map(p => {
      return [
        Math.max(0, Math.min(vw, (p.x - dx) / scale)),
        Math.max(0, Math.min(vh, (p.y - dy) / scale))
      ];
    });

    wsRef.current.send(JSON.stringify({ 
      type: "SAVE_MANUAL_CALIBRATION", 
      image_points: absolutePoints,
      width_m: manualWidth,
      length_m: manualLength,
      // Resolution these points were clicked at (the video's native size) - the backend
      // stores this so speed_estimator.py can rescale correctly if it ever runs at a
      // different resolution (e.g. the ~640px inference frame vs. this native video).
      image_width: vw,
      image_height: vh
    }));
    
    setIsManualCalibrating(false);
  };
  // Responsive Canvas Alignment using ResizeObserver
  useEffect(() => {
    if (!svgRef.current) return;
    const resizeObserver = new ResizeObserver(entries => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        const video = videoRef.current;
        if (width > 0 && height > 0 && normalizedPointsState.length > 0 && video && video.videoWidth) {
          // Same object-fit: cover transform as drawBoxes/handleFinishDrawing,
          // recomputed against the CARD'S NEW size - this is what was missing:
          // the polygon was staying at its old pixel coordinates whenever the
          // card resized (e.g. changing how many cameras show in the grid).
          const vw = video.videoWidth, vh = video.videoHeight;
          const scale = Math.max(width / vw, height / vh);
          const dw = vw * scale, dh = vh * scale;
          const dx = (width - dw) / 2, dy = (height - dh) / 2;
          const absolutePoints = normalizedPointsState.map(p => ({
            x: dx + p.x * dw,
            y: dy + p.y * dh
          }));
          setPolygonPoints(absolutePoints);
        }
      }
    });
    resizeObserver.observe(svgRef.current);
    return () => resizeObserver.disconnect();
  }, [normalizedPointsState]);

  // Renders the one shared ROI the server holds for this camera (points is null/[] if
  // none is set). Called from onmessage whenever CURRENT_ROI arrives: once right after
  // connecting, and again whenever any admin (this tab or another) saves or clears it -
  // so every open viewer of this camera stays in sync without needing to refresh.
  const applyServerRoi = (points, attempt = 0) => {
    if (!points || points.length < 3) {
      setPolygonPoints([]);
      setNormalizedPointsState([]);
      setIsDrawingFinished(false);
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if ((!rect || rect.width === 0) && attempt < 10) {
      // Layout not settled yet (e.g. this arrived before the card finished sizing) - retry
      // briefly rather than drawing at a fallback size that would visibly jump once real
      // layout is ready.
      setTimeout(() => applyServerRoi(points, attempt + 1), 100);
      return;
    }
    const width = rect?.width || 480;
    const height = rect?.height || 360;
    setPolygonPoints(points.map(p => ({ x: p.x * width, y: p.y * height })));
    setNormalizedPointsState(points);
    setIsDrawingFinished(true);
  };

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: 'black', borderRadius: '0 0 8px 8px', overflow: 'hidden', position: 'relative' }}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 1 }}
      />
      {/* Overlay Canvas for Bounding Boxes AND Video Frames */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/* SVG Overlay for ROI Drawing */}
      <svg
        ref={svgRef}
        onClick={handleSvgClick}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: (isEditingRoi && !isDrawingFinished) ? 'crosshair' : 'default', zIndex: 15 }}
      >
        {isDrawingFinished && polygonPoints.length >= 3 ? (
          <polygon
            points={polygonPoints.map(p => `${p.x},${p.y}`).join(' ')}
            fill="rgba(255, 0, 0, 0.2)"
            stroke="red"
            strokeWidth="1"
          />
        ) : (
          <polyline
            points={polygonPoints.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="red"
            strokeWidth="3"
          />
        )}
        {polygonPoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="5" fill="red" />
        ))}
      </svg>

      {/* ROI Controls. flexWrap + maxWidth/justifyContent: on a narrow phone-width card this
          wraps onto a second line and never grows past the card's edge, instead of overflowing
          or getting clipped by the parent's overflow:hidden (both real failure modes here,
          since this row can share the card with the model toggle below at the same time). */}
      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px', maxWidth: 'calc(100% - 24px)' }}>
        {isEditingRoi && (
          <>
            <button
              onClick={handleClearLane}
              style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer' }}
            >
              Clear Lane
            </button>
            <button
              onClick={handleFinishDrawing}
              style={{ padding: '6px 12px', backgroundColor: '#358802', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Finish Drawing
            </button>
            <button
              onClick={() => { adminLogout(); setIsEditingRoi(false); }}
              title="Sign out of the admin session"
              style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer' }}
            >
              Log out
            </button>
          </>
        )}
      </div>

      {/* Admin-only box-vs-segmentation quick toggle (also in the camera's ⋮ menu). Bottom-right:
          the one corner free of the camera's own timestamp/ID text (top-left), the ROI edit
          buttons (top-right) and the LIVE badge (bottom-left). Dimmed until hovered. Other
          viewers of this camera always keep the production /ws feed. */}
      {getAdminToken() && (
        <div className="model-quick-toggle" style={{ position: 'absolute', bottom: '12px', right: '12px', zIndex: 20, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', maxWidth: 'calc(100% - 24px)' }}>
          <div style={{ display: 'flex', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: '6px', padding: '2px', gap: '2px' }}>
            {[
              { id: 'box', label: 'Box' },
              { id: 'seg', label: 'Seg' },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => { setTestModelUnavailable(false); setOverlayModel(opt.id); }}
                title={opt.id === 'seg' ? "Experimental - own isolated connection, doesn't affect the real production feed or file real violations" : 'The real production model'}
                style={{
                  padding: '3px 8px', borderRadius: '4px', border: 'none', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  backgroundColor: overlayModel === opt.id ? (opt.id === 'seg' ? '#a855f7' : '#22c55e') : 'transparent',
                  color: overlayModel === opt.id ? '#fff' : '#d1d5db',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {testModelUnavailable && (
            <span style={{ fontSize: '11px', color: '#fca5a5', backgroundColor: 'rgba(0,0,0,0.7)', padding: '3px 8px', borderRadius: '4px' }}>
              Segmentation model not found on the server - see models/model_seg_v1.pt
            </span>
          )}
        </div>
      )}

      {/* Manual Calibration SVG Overlay */}
      <svg
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 15, pointerEvents: 'none' }}
      >
        {manualCalibPoints.map((p, i) => (
          <g key={`mc-${i}`}>
            <circle cx={p.x} cy={p.y} r="6" fill="#3b82f6" />
            <text x={p.x + 10} y={p.y + 10} fill="#3b82f6" fontSize="16" fontWeight="bold" stroke="white" strokeWidth="1px" paintOrder="stroke">{i + 1}</text>
          </g>
        ))}
        {manualCalibPoints.length === 4 && (
          <polygon
            points={manualCalibPoints.map(p => `${p.x},${p.y}`).join(' ')}
            fill="rgba(59, 130, 246, 0.2)"
            stroke="#3b82f6"
            strokeWidth="2"
          />
        )}
      </svg>

      {/* Manual Calibration Controls */}
      {isManualCalibrating && (
        <div className="absolute inset-x-0 bottom-12 z-20 flex justify-center">
          <div className="bg-white/90 backdrop-blur rounded-xl shadow-2xl p-4 flex flex-col items-center border border-gray-200">
            <h4 className="text-gray-900 font-bold mb-2">Manual Calibration</h4>
            {manualCalibPoints.length < 4 ? (
              <p className="text-sm text-gray-600 mb-2">
                Click 4 points forming a rectangle on the road. <br/>
                Order: Far-Left (1), Far-Right (2), Near-Right (3), Near-Left (4)
              </p>
            ) : (
              <div className="flex flex-col gap-3 mb-4 w-full">
                <div className="flex items-center justify-between text-sm">
                  <label className="text-gray-700 font-medium">Width (m):</label>
                  <input type="text" value={manualWidth} onChange={e => setManualWidth(e.target.value)} className="w-20 px-2 py-1 border rounded text-right" />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <label className="text-gray-700 font-medium">Length (m):</label>
                  <input type="text" value={manualLength} onChange={e => setManualLength(e.target.value)} className="w-20 px-2 py-1 border rounded text-right" />
                </div>
              </div>
            )}
            
            <div className="flex gap-2 w-full">
              <button 
                onClick={() => { setManualCalibPoints([]); setIsManualCalibrating(false); }} 
                className="flex-1 py-1.5 px-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button 
                onClick={() => setManualCalibPoints([])} 
                className="py-1.5 px-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
              >
                Clear
              </button>
              <button 
                onClick={handleSaveManualCalibration}
                disabled={manualCalibPoints.length !== 4}
                className={`flex-1 py-1.5 px-3 rounded-lg transition-colors text-sm font-medium text-white ${manualCalibPoints.length === 4 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-400 cursor-not-allowed'}`}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Indicator */}
      <div className="live-badge" style={{ position: 'absolute', bottom: '12px', left: '12px', zIndex: 10 }}>
        <span className="dot" style={replay ? { backgroundColor: '#f59e0b', animation: 'none' } : undefined}></span>
        <span style={{ color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>{replay ? 'REPLAY' : 'LIVE'}</span>
        {/* Non-production mode must always be visible: segmentation view files no violations. */}
        {overlayModel === 'seg' && (
          <span
            title="Experimental segmentation model - test view only, no violations are filed"
            style={{ marginLeft: '4px', padding: '2px 7px', borderRadius: '4px', backgroundColor: '#a855f7', color: 'white', fontSize: '11px', letterSpacing: '0.05em' }}
          >
            SEG TEST
          </span>
        )}
      </div>

      {/* Manual calibration saved - confirmation overlay */}
      {calibrationStatus && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full text-center flex flex-col items-center">
            {calibrationStatus === 'manual_done' && (
              <>
                <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Manual Calibration Saved!</h3>
                <p className="text-gray-500 text-sm mb-4">The speed detection engine has been updated with your custom grid.</p>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
};

export default LiveCCTVPlayer;
