import { useState } from "react";
import "./styles.css";
import LiveCCTVPlayer from "./components/LiveCCTVPlayer";
import CameraNetworkMap from "./components/CameraNetworkMap";

function LiveMonitoringView() {
  const camera1Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_008_IN.stream/playlist.m3u8";
  const camera2Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_IN.stream/playlist.m3u8";
  const camera3Url = "https://camerai1.iticfoundation.org/pass/180.180.242.207:1935/Phase3/PER_3_009_OUT.stream/playlist.m3u8"; // Fixed broken URL

  return (
    <section>
      <div className="live-grid">
        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 1 (INBOUND) Vibhavadi Km.24</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}> 
            <LiveCCTVPlayer streamUrl={camera1Url} cameraId="camera1" />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 2 (INBOUND) Bangna-Trat Km.6</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}>
            <LiveCCTVPlayer streamUrl={camera2Url} cameraId="camera2" />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>Camera 3 (OUTBOUND) Bangna-Trat Km.6</strong>
          </div>
          <div className="video-frame h-[300px]" style={{ height: '300px' }}>
            <LiveCCTVPlayer streamUrl={camera3Url} cameraId="camera3" />
          </div>
        </article>
      </div>

      <div className="alert-ticker-container">
        <span className="ticker-label">Live Alerts</span>
        <div className="ticker-scroll">
          <div className="ticker-content">
            🔴 Potential Section 35 Violation on Camera 1 (Bangna-Trat Km.6) at 14:02 | 🔴 Heavy Truck Detected on Right Lane Camera 2 (Vibhavadi Km.24) at 13:58 | 🔴 Potential Section 35 Violation on Camera 1 (Bangna-Trat Km.6) at 13:45
          </div>
        </div>
      </div>
    </section>
  );
}

function EvidenceHistoryView() {
  const dummyData = [
    { id: "V-9082", time: "2026-06-22 13:45:12", camera: "Bangna-Trat Km.6", plate: "1ฒข 9821 BKK", status: "Pending Review" },
    { id: "V-9081", time: "2026-06-22 13:12:05", camera: "Vibhavadi Km.24", plate: "7กค 5542 BKK", status: "Ticket Issued" },
    { id: "V-9080", time: "2026-06-22 12:55:30", camera: "Bangna-Trat Km.6", plate: "2ฒง 1123 BKK", status: "Pending Review" },
    { id: "V-9079", time: "2026-06-22 11:30:45", camera: "Vibhavadi Km.24", plate: "3ฒฎ 4455 BKK", status: "Ticket Issued" },
    { id: "V-9078", time: "2026-06-22 10:15:22", camera: "Bangna-Trat Km.6", plate: "5ฒต 7788 BKK", status: "Ticket Issued" },
  ];

  return (
    <section className="evidence-container">
      <table className="evidence-table">
        <thead>
          <tr>
            <th>Violation ID</th>
            <th>Timestamp</th>
            <th>Camera Location</th>
            <th>Mock License Plate</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {dummyData.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.id}</strong></td>
              <td>{row.time}</td>
              <td>{row.camera}</td>
              <td><span style={{background: '#f1f5f9', padding: '4px 8px', borderRadius: '4px', fontWeight: 600}}>{row.plate}</span></td>
              <td>
                <span className={`badge-status ${row.status === "Pending Review" ? "badge-pending" : "badge-issued"}`}>
                  {row.status}
                </span>
              </td>
              <td>
                <button className="btn-evidence">View Evidence</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
