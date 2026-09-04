import React, { useState } from 'react';
import RecordedVideoPlayer from './RecordedVideoPlayer';

export default function RecordedPlayback() {
  const [tickerMessage, setTickerMessage] = useState("Viewing raw historical feeds. Draw an ROI and click 'Process Video' to detect violations.");

  return (
    <section>
      <div className="live-grid">
        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 1 (INBOUND) Vibhavadi</strong>
          </div>
          <div className="video-frame" style={{ height: '300px', backgroundColor: 'black' }}>
            <RecordedVideoPlayer 
              videoFile="re1_processed.mp4" 
              cameraId="recorded1" 
              onViolationAlert={(msg) => setTickerMessage(msg)}
            />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 2 (INBOUND) Bangna-Trat</strong>
          </div>
          <div className="video-frame" style={{ height: '300px', backgroundColor: 'black' }}>
            <RecordedVideoPlayer 
              videoFile="re2_processed.mp4" 
              cameraId="recorded2"
              onViolationAlert={(msg) => setTickerMessage(msg)}
            />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 3 (OUTBOUND) Bangna-Trat</strong>
          </div>
          <div className="video-frame" style={{ height: '300px', backgroundColor: 'black' }}>
            <RecordedVideoPlayer 
              videoFile="r3.mp4" 
              cameraId="recorded3"
              onViolationAlert={(msg) => setTickerMessage(msg)}
            />
          </div>
        </article>
      </div>

      <div className="alert-ticker-container">
        <span className="ticker-label">Playback Info</span>
        <div className="ticker-scroll">
          <div className="ticker-content">
            {tickerMessage}
          </div>
        </div>
      </div>
    </section>
  );
}
