import React, { useRef, useState, useEffect } from 'react';

const RecordedVideoPlayer = ({ videoFile, cameraId, onViolationAlert }) => {
  const [polygonPoints, setPolygonPoints] = useState([]);
  const [isDrawingFinished, setIsDrawingFinished] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedVideoUrl, setProcessedVideoUrl] = useState(null);
  
  const videoRef = useRef(null);
  const svgRef = useRef(null);
  
  const baseVideoUrl = `/recorded_videos/${videoFile}`;
  const currentVideoSrc = processedVideoUrl || baseVideoUrl;

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
    setProcessedVideoUrl(null);
  };

  const handleProcessVideo = async () => {
    if (polygonPoints.length < 3) {
      alert("Please define at least 3 points for the ROI.");
      return;
    }
    
    setIsDrawingFinished(true);
    setIsProcessing(true);
    
    const rect = svgRef.current.getBoundingClientRect();
    const normalizedPoints = polygonPoints.map(p => ({
      x: p.x / rect.width,
      y: p.y / rect.height
    }));
    
    const apiHost = window.location.hostname === 'localhost' ? 'http://localhost:8000' : '';
    const apiUrl = `${apiHost}/api/process_recorded`;
    
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          video_filename: videoFile,
          camera_id: cameraId,
          roi_points: normalizedPoints
        })
      });
      
      if (!response.ok) {
        throw new Error("Failed to process video");
      }
      
      const data = await response.json();
      
      // Append a timestamp to avoid browser caching of the new video file
      setProcessedVideoUrl(`${data.processed_url}?t=${new Date().getTime()}`);
      
      if (onViolationAlert) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        onViolationAlert(`✅ Processing complete for ${cameraId} at ${timeStr}`);
      }
      
    } catch (err) {
      console.error(err);
      alert("Error processing video on backend.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: 'black', borderRadius: '0 0 8px 8px', overflow: 'hidden', position: 'relative' }}>
      
      {/* Video Player */}
      <video
        ref={videoRef}
        src={currentVideoSrc}
        autoPlay
        muted
        loop
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'fill' }}
      />
      
      {/* SVG Overlay for ROI Drawing */}
      {!processedVideoUrl && (
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
      )}

      {/* Loading Overlay */}
      {isProcessing && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
          <div className="spinner" style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #ef4444', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <p style={{ marginTop: '16px', fontWeight: 'bold' }}>Processing Video Offline...</p>
          <style>{`
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          `}</style>
        </div>
      )}

      {/* ROI Controls */}
      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', gap: '8px' }}>
        <button
          onClick={handleClearLane}
          disabled={isProcessing}
          style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: isProcessing ? 'not-allowed' : 'pointer', opacity: isProcessing ? 0.5 : 1 }}
        >
          Clear
        </button>
        {!processedVideoUrl && (
          <button
            onClick={handleProcessVideo}
            disabled={isProcessing}
            style={{ padding: '6px 12px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: isProcessing ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: isProcessing ? 0.5 : 1 }}
          >
            {isProcessing ? 'Processing...' : 'Process Video'}
          </button>
        )}
      </div>

      {/* Status Indicator */}
      <div className="live-badge" style={{ position: 'absolute', bottom: '12px', left: '12px', zIndex: 10 }}>
        <span style={{ color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.5)', backgroundColor: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>
          {processedVideoUrl ? 'PROCESSED' : 'RAW'}
        </span>
      </div>
    </div>
  );
};

export default RecordedVideoPlayer;
