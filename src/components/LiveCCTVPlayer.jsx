import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

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

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const svgRef = useRef(null);

  // Add custom event listener for external ROI toggle from kebab menu
  useEffect(() => {
    const handler = () => setIsEditingRoi(prev => !prev);
    const handleCalibrate = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "TRIGGER_CALIBRATION", stream_url: streamUrl }));
      }
    };
    const handleManualCalibrate = () => {
      setIsManualCalibrating(true);
      setManualCalibPoints([]);
    };
    window.addEventListener(`toggle-roi-${cameraId}`, handler);
    window.addEventListener(`trigger-calibrate-${cameraId}`, handleCalibrate);
    window.addEventListener(`trigger-manual-calibrate-${cameraId}`, handleManualCalibrate);
    return () => {
      window.removeEventListener(`toggle-roi-${cameraId}`, handler);
      window.removeEventListener(`trigger-calibrate-${cameraId}`, handleCalibrate);
      window.removeEventListener(`trigger-manual-calibrate-${cameraId}`, handleManualCalibrate);
    };
  }, [cameraId, streamUrl]);

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
  
  const [isManualCalibrating, setIsManualCalibrating] = useState(false);
  const [manualCalibPoints, setManualCalibPoints] = useState([]);
  const [manualWidth, setManualWidth] = useState("3.5");
  const [manualLength, setManualLength] = useState("27.0");
  
  const [normalizedPointsState, setNormalizedPointsState] = useState([]);
  const [calibrationStatus, setCalibrationStatus] = useState(null); // 'started', 'done', 'failed'
  const [calibrationImageUrl, setCalibrationImageUrl] = useState(null);
  const [calibImageAttempt, setCalibImageAttempt] = useState(0); // bumped to force a retry fetch
  const [calibImageFailed, setCalibImageFailed] = useState(false);
  const CALIB_IMAGE_MAX_RETRIES = 3;

  useEffect(() => {
    let hls;
    const video = videoRef.current;

    // 1. Initialize HLS Video Stream
    if (video && streamUrl) {
      if (Hls.isSupported()) {
        const optimizedHlsConfig = {
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 10,
          maxMaxBufferLength: 15,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 5,
        };

        hls = new Hls(optimizedHlsConfig);
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // hls.levels.length - 1 ဆိုတာ အမြင့်ဆုံး Quality (ဥပမာ 1080p) ကို ဆိုလိုပါတယ်
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
        video.src = streamUrl;
      }
    }

    // 2. Initialize WebSocket for AI Bounding Boxes
    let isConnected = false;
    const connectWebSocket = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = window.location.hostname === 'localhost' ? 'localhost:8000' : window.location.host;
      const wsUrl = `${wsProtocol}//${wsHost}/ws/${cameraId}`;
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

        // Resend ROI on connect/reconnect
        const saved = localStorage.getItem(`roi_${cameraId}`);
        if (saved) {
           try {
               const normalizedPoints = JSON.parse(saved);
               ws.send(JSON.stringify({
                   type: "SET_LANE_ROI",
                   points: normalizedPoints
               }));
           } catch(e) {}
        }

        sendNextFrame();
      };

      // 🟢 1. ws.onmessage အပိုင်းကို ပြင်ပါ
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'VIOLATION_ALERT') {
            if (onViolationAlert) {
              const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              onViolationAlert(`🔴 ${data.message} on ${data.camera} at ${timeStr}`);
            }
            return;
          }

          if (data.type === 'CALIBRATION_STATUS') {
            setCalibrationStatus(data.status);
            if (data.image_url) {
              // Cache-bust once here, not on every render (see the <img> below —
              // computing `?t=${Date.now()}` inline in JSX gives the <img> a new
              // src on every unrelated re-render, restarting its fetch each time).
              setCalibrationImageUrl(`${data.image_url}?t=${Date.now()}`);
              setCalibImageAttempt(0);
              setCalibImageFailed(false);
            } else if (data.status === 'manual_done') {
              setCalibrationImageUrl(null); // No image to show for manual
            }
            if (data.status === 'done' || data.status === 'failed' || data.status === 'manual_done') {
               // Auto-hide after 5 seconds if not explicitly closed? No, let the user close it if there's an image.
               if (data.status === 'failed' || data.status === 'manual_done') {
                   setTimeout(() => setCalibrationStatus(null), 3000);
               }
            }
            return;
          }

          // Data အမျိုးအစားခွဲခြားခြင်း
          let boxesToDraw = [];

          if (Array.isArray(data)) {
            boxesToDraw = data; // အဟောင်းအတွက်
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
      if (wsRef.current) wsRef.current.close();
    };
  }, [streamUrl, cameraId]);

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

      ctx.strokeStyle = '#22c55e'; // Tailwind Green 500
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      if (box.label) {
        const textWidth = ctx.measureText(box.label).width;
        const ly = Math.max(14, y1);
        ctx.fillStyle = '#22c55e';
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
    localStorage.removeItem(`roi_${cameraId}`);
  };

  const handleFinishDrawing = () => {
  if (polygonPoints.length < 3) { alert("..."); return; }
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) { alert("..."); return; }

  const video = videoRef.current;
  const rect = svgRef.current.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;

  // drawBoxes နဲ့ တူညီတဲ့ cover transform
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (rect.width - dw) / 2, dy = (rect.height - dh) / 2;

  const normalizedPoints = polygonPoints.map(p => ({
    x: (p.x - dx) / dw,      // frame coordinate ပြောင်း
    y: (p.y - dy) / dh
  }));

  setIsDrawingFinished(true);
  localStorage.setItem(`roi_${cameraId}`, JSON.stringify(normalizedPoints));
  setNormalizedPointsState(normalizedPoints);
  wsRef.current.send(JSON.stringify({ type: "SET_LANE_ROI", points: normalizedPoints }));
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
      length_m: manualLength
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

  useEffect(() => {
    const saved = localStorage.getItem(`roi_${cameraId}`);
    if (saved) {
      try {
        const normalizedPoints = JSON.parse(saved);

        // Wait briefly for layout to settle so getBoundingClientRect is accurate
        setTimeout(() => {
          if (svgRef.current) {
            const rect = svgRef.current.getBoundingClientRect();
            // Fallback if width/height is 0 (e.g. display: none)
            const width = rect.width || 480;
            const height = rect.height || 360;
            const absolutePoints = normalizedPoints.map(p => ({
              x: p.x * width,
              y: p.y * height
            }));
            setPolygonPoints(absolutePoints);
            setNormalizedPointsState(normalizedPoints);
            setIsDrawingFinished(true);
          }

          // Re-send to backend
          const sendToBackend = () => {
             if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                 wsRef.current.send(JSON.stringify({
                     type: "SET_LANE_ROI",
                     points: normalizedPoints
                 }));
             } else {
                 setTimeout(sendToBackend, 500);
             }
          };
          sendToBackend();
        }, 100);
      } catch (e) {
        console.error("Error loading ROI", e);
      }
    }
  }, []);

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

      {/* ROI Controls */}
      {/* ROI Controls */}
      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', gap: '8px' }}>
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
          </>
        )}
      </div>

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
        <span className="dot"></span>
        <span style={{ color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>LIVE</span>
      </div>

      {/* Calibration Overlay */}
      {calibrationStatus && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full text-center flex flex-col items-center">
            {calibrationStatus === 'started' && (
              <>
                <div className="w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Auto-Calibrating...</h3>
                <p className="text-gray-500 text-sm">Watching traffic to map the 3D road perspective. This usually takes 10-15 seconds.</p>
              </>
            )}
            {calibrationStatus === 'done' && (
              <>
                <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Calibration Successful!</h3>
                <p className="text-gray-500 text-sm mb-4">The speed detection engine has been hot-reloaded with the new perspective.</p>
                {calibrationImageUrl && !calibImageFailed && (
                  <img
                    // calibImageAttempt in the query string forces a fresh request
                    // (not a cached failure) on each retry below.
                    src={`${calibrationImageUrl}&retry=${calibImageAttempt}`}
                    alt="Calibration Grid"
                    className="w-full rounded-lg border border-gray-200 shadow-sm mb-6"
                    onError={() => {
                      // The file is written before the "done" message is ever sent
                      // (see live_server.py), so a failed load here means a
                      // transient hiccup, not a missing file — retry a few times
                      // with a short backoff before giving up.
                      if (calibImageAttempt < CALIB_IMAGE_MAX_RETRIES) {
                        setTimeout(() => setCalibImageAttempt((n) => n + 1), 500 * (calibImageAttempt + 1));
                      } else {
                        setCalibImageFailed(true);
                      }
                    }}
                  />
                )}
                {calibrationImageUrl && calibImageFailed && (
                  <div className="w-full rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-400 text-sm py-10 mb-6">
                    Calibration grid image could not be loaded. Calibration was still saved and applied.
                  </div>
                )}
                <button onClick={() => setCalibrationStatus(null)} className="px-6 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium">
                  Close & Resume
                </button>
              </>
            )}
            {calibrationStatus === 'manual_done' && (
              <>
                <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Manual Calibration Saved!</h3>
                <p className="text-gray-500 text-sm mb-4">The speed detection engine has been updated with your custom grid.</p>
              </>
            )}
            {calibrationStatus === 'failed' && (
              <>
                <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Calibration Failed</h3>
                <p className="text-gray-500 text-sm mb-4">Could not find enough moving traffic to map the perspective. Please try again when there are more vehicles.</p>
                <button onClick={() => setCalibrationStatus(null)} className="px-6 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium">
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
};

export default LiveCCTVPlayer;
