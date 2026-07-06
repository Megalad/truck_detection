import { useState, useEffect } from "react";
import "./styles.css";
import LiveCCTVPlayer from "./components/LiveCCTVPlayer";
import CameraNetworkMap from "./components/CameraNetworkMap";

function LiveMonitoringView() {
  const camera1Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_008_IN.stream/playlist.m3u8";
  const camera2Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_IN.stream/playlist.m3u8";
  const camera3Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_OUT.stream/playlist.m3u8"; // Fixed broken URL

  const [latestAlert, setLatestAlert] = useState(null);

  const handleViolationAlert = (alertMsg) => {
    setLatestAlert(alertMsg);
    setTimeout(() => {
      setLatestAlert(null);
    }, 5000);
  };

  return (
    <section>
      <div className="live-grid">
        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 1 (INBOUND) Vibhavadi Km.24</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}> 
            <LiveCCTVPlayer streamUrl={camera1Url} cameraId="camera1" onViolationAlert={handleViolationAlert} />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 2 (INBOUND) Bangna-Trat Km.6</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}>
            <LiveCCTVPlayer streamUrl={camera2Url} cameraId="camera2" onViolationAlert={handleViolationAlert} />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 3 (OUTBOUND) Bangna-Trat Km.6</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}>
            <LiveCCTVPlayer streamUrl={camera3Url} cameraId="camera3" onViolationAlert={handleViolationAlert} />
          </div>
        </article>
      </div>

      <div className="alert-ticker-container">
        <span className="ticker-label">Live Alerts</span>
        <div className="ticker-scroll">
          <div className="ticker-content">
            {latestAlert ? latestAlert : "No current alerts."}
          </div>
        </div>
      </div>
    </section>
  );
}

function EvidenceHistoryView() {
  const [violations, setViolations] = useState([]);
  const [selectedViolation, setSelectedViolation] = useState(null);

  useEffect(() => {
    fetch("/api/violations")
      .then(res => {
        if (!res.ok) {
           throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (data.violations) {
          setViolations(data.violations);
        }
      })
      .catch(err => console.error("Network Fetch Error / /api/violations:", err));
  }, []);

  return (
    <section className="evidence-container" style={{ position: 'relative' }}>
      <table className="evidence-table">
        <thead>
          <tr>
            <th>Violation ID</th>
            <th>Video Name</th>
            <th>Timestamp</th>
            <th>Camera Location</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {violations.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.violation_id}</strong></td>
              <td>{row.video_name || "N/A"}</td>
              <td>{new Date(row.timestamp).toLocaleString()}</td>
              <td>{row.camera_location}</td>
              <td>
                <button className="btn-evidence" onClick={() => setSelectedViolation(row)}>View Evidence</button>
              </td>
            </tr>
          ))}
          {violations.length === 0 && (
            <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No violations found.</td></tr>
          )}
        </tbody>
      </table>

      {selectedViolation && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '8px', maxWidth: '800px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, color: 'white' }}>Evidence Video: {selectedViolation.video_name}</h3>
              <button onClick={() => setSelectedViolation(null)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '18px' }}>✕</button>
            </div>
            <div style={{ position: 'relative', width: '100%', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}>
              <video controls autoPlay src={selectedViolation.evidence_video_url} style={{ width: '100%', display: 'block' }} />
              {selectedViolation.roi_polygon && (
                <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }} viewBox="0 0 1 1" preserveAspectRatio="none">
                  <polygon 
                    points={(typeof selectedViolation.roi_polygon === 'string' ? JSON.parse(selectedViolation.roi_polygon) : selectedViolation.roi_polygon).map(p => `${p.x},${p.y}`).join(' ')} 
                    fill="rgba(255, 0, 0, 0.2)" 
                    stroke="red" 
                    strokeWidth="0.005" 
                  />
                </svg>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AnalyticsView() {
  return (
    <section className="analytics-grid">
      <article className="chart-card">
        <h3>Violations by Hour (Today)</h3>
        <div className="mock-bar-chart">
          <div className="bar" style={{height: '40%'}} data-label="08:00"></div>
          <div className="bar" style={{height: '70%'}} data-label="09:00"></div>
          <div className="bar" style={{height: '50%'}} data-label="10:00"></div>
          <div className="bar" style={{height: '90%'}} data-label="11:00"></div>
          <div className="bar" style={{height: '60%'}} data-label="12:00"></div>
          <div className="bar" style={{height: '30%'}} data-label="13:00"></div>
          <div className="bar" style={{height: '80%'}} data-label="14:00"></div>
        </div>
      </article>

      <article className="chart-card">
        <h3>Violations by Weather Condition</h3>
        <div className="mock-pie-chart">
          <div className="pie"></div>
        </div>
        <div style={{display: 'flex', justifyContent: 'center', gap: '16px', marginTop: '24px'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{width: '12px', height: '12px', background: 'var(--corp-blue)', borderRadius: '50%'}}></span> Clear (60%)
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{width: '12px', height: '12px', background: 'var(--text-muted)', borderRadius: '50%'}}></span> Overcast (25%)
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{width: '12px', height: '12px', background: 'var(--alert-red)', borderRadius: '50%'}}></span> Rain (15%)
          </div>
        </div>
      </article>
    </section>
  );
}

function NodeStatusView() {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <CameraNetworkMap />
    </section>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState("live");

  return (
    <>
      <header>
        <div className="header-brand">
          <span className="team-name">Team Unique</span>
          <h1 className="portal-title">Do Do — Section 35 Enforcement Portal</h1>
          <p className="portal-subtitle">Interactive monitoring system for right-lane truck violations.</p>
        </div>
        <nav className="nav-tabs">
          <button 
            className={currentView === "live" ? "active" : ""} 
            onClick={() => setCurrentView("live")}
          >
            Live Monitoring
          </button>
          <button 
            className={currentView === "evidence" ? "active" : ""} 
            onClick={() => setCurrentView("evidence")}
          >
            Evidence & History
          </button>
          <button 
            className={currentView === "analytics" ? "active" : ""} 
            onClick={() => setCurrentView("analytics")}
          >
            Analytics
          </button>
          <button 
            className={currentView === "status" ? "active" : ""} 
            onClick={() => setCurrentView("status")}
          >
            Node Status
          </button>
        </nav>
      </header>

      <main>
        {currentView === "live" && <LiveMonitoringView />}
        {currentView === "evidence" && <EvidenceHistoryView />}
        {currentView === "analytics" && <AnalyticsView />}
        {currentView === "status" && <NodeStatusView />}
      </main>
    </>
  );
}
