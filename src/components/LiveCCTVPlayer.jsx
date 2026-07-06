import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

const LiveCCTVPlayer = ({ streamUrl, cameraId, onViolationAlert }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const svgRef = useRef(null);
  const [polygonPoints, setPolygonPoints] = useState([]);
  const [isDrawingFinished, setIsDrawingFinished] = useState(false);

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
    let pendingDisplayFrame = null;
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
            // 1. Capture the scaled-down frame for the AI
            const aiCanvas = document.createElement('canvas');
            aiCanvas.width = 480;
            aiCanvas.height = Math.round(480 * (video.videoHeight / video.videoWidth)) || 360;
            const aiCtx = aiCanvas.getContext('2d');
            aiCtx.drawImage(video, 0, 0, aiCanvas.width, aiCanvas.height);
            
            // 2. Capture the full-resolution frame for perfectly synced display
            const displayCanvas = document.createElement('canvas');
            displayCanvas.width = video.videoWidth;
            displayCanvas.height = video.videoHeight;
            const displayCtx = displayCanvas.getContext('2d');
            displayCtx.drawImage(video, 0, 0, displayCanvas.width, displayCanvas.height);
            pendingDisplayFrame = displayCanvas;
            
            aiCanvas.toBlob((blob) => {
              if (blob && ws.readyState === WebSocket.OPEN) {
                ws.send(blob);
              }
            }, 'image/jpeg', 0.5); // 50% quality JPEG for speed
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

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (!Array.isArray(data)) {
            if (data.type === 'VIOLATION_ALERT') {
              if (onViolationAlert) {
                const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                onViolationAlert(`🔴 ${data.message} on ${data.camera} at ${timeStr}`);
              }
            }
            return;
          }
          
          // Draw the exactly matched frame and its boxes!
          drawFrameAndBoxes(data, pendingDisplayFrame);
          pendingDisplayFrame = null;
          
          if (isConnected) {
            requestAnimationFrame(sendNextFrame);
          }
        } catch (e) {
          console.error(`[${cameraId}] Error parsing WebSocket message:`, e);
        }
      };

      ws.onclose = () => {
        console.log(`[${cameraId}] AI WebSocket disconnected. Reconnecting in 3s...`);
        isConnected = false;
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

  // Handle resizing canvas and drawing both the synced frame and bounding boxes
  const drawFrameAndBoxes = (boxes, displayFrame) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !displayFrame) return;

    // Match canvas size to the actual displayed video size
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw the perfectly synced video frame first!
    ctx.drawImage(displayFrame, 0, 0, canvas.width, canvas.height);

    if (!boxes || boxes.length === 0) return;

    // Draw each box
    boxes.forEach(box => {
      // Calculate absolute pixel coordinates from relative coordinates
      const x1 = box.x1 * canvas.width;
      const y1 = box.y1 * canvas.height;
      const x2 = box.x2 * canvas.width;
      const y2 = box.y2 * canvas.height;
      const w = x2 - x1;
      const h = y2 - y1;

      // Draw bounding box
      ctx.strokeStyle = '#22c55e'; // Tailwind Green 500
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, w, h);

      // Draw label background
      ctx.fillStyle = '#22c55e';
      const labelText = box.label;
      const textWidth = ctx.measureText(labelText).width;
      ctx.fillRect(x1, y1 - 25, textWidth + 10, 25);

      // Draw label text
      ctx.fillStyle = 'white';
      ctx.font = 'bold 14px Arial';
      ctx.fillText(labelText, x1 + 5, y1 - 7);
    });
  };

  const handleSvgClick = (e) => {
    if (isDrawingFinished) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setPolygonPoints([...polygonPoints, { x, y }]);
  };

  const handleClearLane = () => {
    setPolygonPoints([]);
    setIsDrawingFinished(false);
    localStorage.removeItem(`roi_${cameraId}`);
  };

  const handleFinishDrawing = () => {
    if (polygonPoints.length < 3) {
      alert("Please define at least 3 points for the ROI.");
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      alert("WebSocket not connected.");
      return;
    }
    setIsDrawingFinished(true);
    const rect = svgRef.current.getBoundingClientRect();
    const normalizedPoints = polygonPoints.map(p => ({
      x: p.x / rect.width,
      y: p.y / rect.height
    }));
    
    localStorage.setItem(`roi_${cameraId}`, JSON.stringify(normalizedPoints));
    
    wsRef.current.send(JSON.stringify({
      type: "SET_LANE_ROI",
      points: normalizedPoints
    }));
    alert("ROI Saved!");
  };

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
        style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: 0 }}
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
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: isDrawingFinished ? 'default' : 'crosshair', zIndex: 15 }}
      >
        {isDrawingFinished && polygonPoints.length >= 3 ? (
          <polygon
            points={polygonPoints.map(p => `${p.x},${p.y}`).join(' ')}
            fill="rgba(255, 0, 0, 0.3)"
            stroke="red"
            strokeWidth="3"
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
      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', gap: '8px' }}>
        <button
          onClick={handleClearLane}
          style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer' }}
        >
          Clear Lane
        </button>
        <button
          onClick={handleFinishDrawing}
          style={{ padding: '6px 12px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          Finish Drawing
        </button>
      </div>

      {/* Live Indicator */}
      <div className="live-badge" style={{ position: 'absolute', bottom: '12px', left: '12px', zIndex: 10 }}>
        <span className="dot"></span>
        <span style={{ color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>LIVE</span>
      </div>
    </div>
  );
};

export default LiveCCTVPlayer;
