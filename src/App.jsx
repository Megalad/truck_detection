import { useState, useEffect } from "react";
import "./styles.css";
import LiveCCTVPlayer from "./components/LiveCCTVPlayer";
import CameraNetworkMap from "./components/CameraNetworkMap";
import RecordedPlayback from "./components/RecordedPlayback";

function LiveMonitoringView() {
  const camTV73RUrl = "http://1.4.213.19:1929/live/TV73R-M7-64_872-IPT.stream/playlist.m3u8";
  const camTV09LUrl = "http://1.4.213.19:1926/live/TV09L-M7-06_200-SKR.stream/playlist.m3u8";
  const camTV75RUrl = "http://1.4.213.19:1929/live/TV75R-M7-66_826-IPT.stream/playlist.m3u8";

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
            <strong>TV73R M7-64+872-IPT</strong>
          </div>
          <div className="video-frame">
            <LiveCCTVPlayer streamUrl={camTV73RUrl} cameraId="TV73R" onViolationAlert={handleViolationAlert} />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>TV09L M7-06+200-SKR</strong>
          </div>
          <div className="video-frame">
            <LiveCCTVPlayer streamUrl={camTV09LUrl} cameraId="TV09L" onViolationAlert={handleViolationAlert} />
          </div>
        </article>

        <article className="camera-panel">
          <div className="camera-header">
            <strong>TV75R M7-66+826-PT</strong>
          </div>
          <div className="video-frame">
            <LiveCCTVPlayer streamUrl={camTV75RUrl} cameraId="TV75R" onViolationAlert={handleViolationAlert} />
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

  // Filter State
  const [searchId, setSearchId] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterCamera, setFilterCamera] = useState("All Cameras");

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

  const filteredViolations = violations.filter((row) => {
    const matchesId = row.violation_id.toLowerCase().includes(searchId.toLowerCase());
    
    let matchesDate = true;
    if (filterDate) {
      const rowDate = new Date(row.timestamp).toISOString().split("T")[0];
      matchesDate = rowDate === filterDate;
    }

    const matchesCamera = filterCamera === "All Cameras" || row.camera_location === filterCamera;

    return matchesId && matchesDate && matchesCamera;
  });

  const handleClearFilters = () => {
    setSearchId("");
    setFilterDate("");
    setFilterCamera("All Cameras");
  };

  return (
    <section className="evidence-container" style={{ position: 'relative' }}>
      
      {/* Filter Bar (Tailwind CSS) */}
      <div className="bg-white p-4 mb-6 rounded-lg border border-gray-200 shadow-sm flex flex-col md:flex-row gap-4 items-end" style={{ backgroundColor: 'white', padding: '16px', marginBottom: '24px', borderRadius: '8px', border: '1px solid #e5e7eb', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: '500', color: '#374151', marginBottom: '4px' }}>Search ID</label>
          <input 
            type="text" 
            placeholder="Search by Violation ID..." 
            style={{ width: '100%', padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', color: '#1f2937' }}
            value={searchId}
            onChange={(e) => setSearchId(e.target.value)}
          />
        </div>

        <div style={{ flex: '1 1 200px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: '500', color: '#374151', marginBottom: '4px' }}>Date</label>
          <input 
            type="date" 
            style={{ width: '100%', padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', color: '#1f2937' }}
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
          />
        </div>

        <div style={{ flex: '1 1 200px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: '500', color: '#374151', marginBottom: '4px' }}>Camera Location</label>
          <select 
            style={{ width: '100%', padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', color: '#1f2937', backgroundColor: 'white' }}
            value={filterCamera}
            onChange={(e) => setFilterCamera(e.target.value)}
          >
            <option value="All Cameras">All Cameras</option>
            <option value="TV73R">TV73R</option>
            <option value="TV09L">TV09L</option>
            <option value="TV75R">TV75R</option>
          </select>
        </div>

        <button 
          onClick={handleClearFilters}
          style={{ padding: '8px 20px', backgroundColor: '#f9fafb', color: '#4b5563', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', fontWeight: '500', cursor: 'pointer', height: '38px', whiteSpace: 'nowrap' }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f3f4f6'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#f9fafb'}
        >
          Clear Filters
        </button>
      </div>

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
          {filteredViolations.map((row) => (
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
          {filteredViolations.length === 0 && (
            <tr><td colSpan="5" style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>No violations found matching filters.</td></tr>
          )}
        </tbody>
      </table>

      {selectedViolation && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', maxWidth: '1200px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: 'white', fontSize: '20px' }}>Evidence ID: {selectedViolation.violation_id}</h3>
              <button onClick={() => setSelectedViolation(null)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '24px' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              {/* Left Column - Money Shot */}
              <div style={{ flex: '1 1 400px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ margin: 0, color: '#94a3b8' }}>The Proof (Money Shot)</h4>
                {selectedViolation.evidence_snapshot_url ? (
                  <div style={{ borderRadius: '8px', overflow: 'hidden', border: '2px solid #334155', backgroundColor: '#000', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <img 
                      src={selectedViolation.evidence_snapshot_url} 
                      alt="Violation Snapshot" 
                      style={{ width: '100%', maxHeight: '400px', display: 'block', objectFit: 'contain' }} 
                    />
                  </div>
                ) : (
                  <div style={{ padding: '40px', textAlign: 'center', backgroundColor: '#0f172a', borderRadius: '8px', color: '#64748b', border: '2px dashed #334155' }}>
                    No snapshot available for this record.
                  </div>
                )}
                <div style={{ backgroundColor: '#0f172a', padding: '16px', borderRadius: '8px', fontSize: '14px', color: '#cbd5e1' }}>
                  <p style={{ margin: '0 0 8px 0' }}><strong>Timestamp:</strong> {new Date(selectedViolation.timestamp).toLocaleString()}</p>
                  <p style={{ margin: 0 }}><strong>Location:</strong> {selectedViolation.camera_location}</p>
                </div>
              </div>

              {/* Right Column - Video Context */}
              <div style={{ flex: '1 1 500px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <h4 style={{ margin: 0, color: '#94a3b8' }}>Video Context</h4>
                <div style={{ position: 'relative', width: '100%', borderRadius: '8px', overflow: 'hidden', border: '2px solid #334155', backgroundColor: '#000' }}>
                  <video controls autoPlay loop muted src={selectedViolation.evidence_video_url} style={{ width: '100%', display: 'block' }} />
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
          <h1 className="portal-title">Do Do System</h1>
          <p className="portal-subtitle">Monitoring system for right-lane truck violations.</p>
        </div>
        <nav className="nav-tabs">
          <button 
            className={currentView === "live" ? "active" : ""} 
            onClick={() => setCurrentView("live")}
          >
            Live Monitoring
          </button>
          <button 
            className={currentView === "playback" ? "active" : ""} 
            onClick={() => setCurrentView("playback")}
          >
            Recorded Playback
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
        <div style={{ display: currentView === "live" ? "block" : "none" }}>
          <LiveMonitoringView />
        </div>
        <div style={{ display: currentView === "playback" ? "block" : "none" }}>
          <RecordedPlayback />
        </div>
        {currentView === "evidence" && <EvidenceHistoryView />}
        {currentView === "analytics" && <AnalyticsView />}
        {currentView === "status" && <NodeStatusView />}
      </main>
    </>
  );
}
