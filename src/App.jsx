import { useState, useEffect, useRef, useMemo } from "react";
import "./styles.css";
import { CAMERAS } from "./cameras";
import LiveCCTVPlayer from "./components/LiveCCTVPlayer";
import CameraNetworkMap from "./components/CameraNetworkMap";
import ProjectReport from "./components/ProjectReport";
import ReportCharts from "./components/ReportCharts";
import ViewToggle from "./components/ViewToggle";
import FocusView from "./components/FocusView";
import SpeedLimitControl from "./components/SpeedLimitControl";
import ReplayToggle from "./components/ReplayToggle";
import { adminLogout, useAdminSession } from "./adminAuth";

const VideoCard = ({ cam, idx, setActiveCameraIndex, setCurrentView, handleViolationAlert }) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleEditRoi = () => {
    setIsMenuOpen(false);
    window.dispatchEvent(new CustomEvent(`toggle-roi-${cam.id}`));
  };

  return (
    <article className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-md flex flex-col relative z-0">
      <div className="px-5 py-4 border-b border-gray-200 flex justify-between items-center bg-white">
        <strong className="text-gray-900 font-medium tracking-wide">{cam.title}</strong>
        
        <div className="relative" ref={menuRef}>
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="text-gray-500 hover:text-gray-900 p-1 rounded-md hover:bg-gray-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>

          {isMenuOpen && (
            <div className="absolute right-0 mt-2 w-36 bg-white rounded-md shadow-lg border border-gray-200 z-50 py-1">
              <button
                onClick={() => {
                  setActiveCameraIndex(idx);
                  setCurrentView('focus');
                  setIsMenuOpen(false);
                }}
                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors"
              >
                Focus
              </button>
              <button
                onClick={handleEditRoi}
                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-amber-600 transition-colors border-t border-gray-100"
              >
                Edit ROI
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="relative w-full bg-black aspect-video z-0">
        <LiveCCTVPlayer streamUrl={cam.url} cameraId={cam.id} onViolationAlert={handleViolationAlert} />
      </div>
    </article>
  );
};

function LiveMonitoringView() {
  const MIN_GRID_CAMERAS = 2;
  const MAX_GRID_CAMERAS = CAMERAS.length;

  const [currentView, setCurrentView] = useState("grid");
  const [visibleCameraCount, setVisibleCameraCount] = useState(MIN_GRID_CAMERAS);
  const [activeCameraIndex, setActiveCameraIndex] = useState(0);
  const [latestAlert, setLatestAlert] = useState(null);

  const handleViolationAlert = (alertMsg) => {
    setLatestAlert(alertMsg);
    setTimeout(() => {
      setLatestAlert(null);
    }, 5000);
  };

  const [cameraInfoList, setCameraInfoList] = useState([]);

  useEffect(() => {
    fetch('/camera.json')
      .then(res => res.json())
      .then(json => {
        if(json.data && json.data.cctv) setCameraInfoList(json.data.cctv);
      })
      .catch(err => console.error(err));
  }, []);

  return (
    <section>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-gray-900">Live Camera Feeds</h2>
        <div className="flex items-center gap-3">
          <ReplayToggle />
          <SpeedLimitControl />
          {currentView === 'grid' && (
            <div className="flex items-center gap-2 bg-gray-100 rounded-full p-1 border border-gray-200 shadow-inner">
              <button
                onClick={() => setVisibleCameraCount((c) => Math.max(MIN_GRID_CAMERAS, c - 1))}
                disabled={visibleCameraCount <= MIN_GRID_CAMERAS}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Show fewer cameras"
              >
                &minus;
              </button>
              <span className="text-sm font-semibold text-gray-700 w-20 text-center">
                {visibleCameraCount} camera{visibleCameraCount !== 1 ? "s" : ""}
              </span>
              <button
                onClick={() => setVisibleCameraCount((c) => Math.min(MAX_GRID_CAMERAS, c + 1))}
                disabled={visibleCameraCount >= MAX_GRID_CAMERAS}
                className="w-8 h-8 flex items-center justify-center rounded-full text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Show more cameras"
              >
                +
              </button>
            </div>
          )}
          <ViewToggle currentView={currentView} onViewChange={setCurrentView} />
        </div>
      </div>

      {currentView === 'grid' ? (
        <div className="live-grid">
          {CAMERAS.slice(0, visibleCameraCount).map((cam, idx) => (
            <VideoCard
              key={cam.id}
              cam={cam}
              idx={idx}
              setActiveCameraIndex={setActiveCameraIndex}
              setCurrentView={setCurrentView}
              handleViolationAlert={handleViolationAlert}
            />
          ))}
        </div>
      ) : (
        <FocusView
          cameras={CAMERAS}
          activeCameraIndex={activeCameraIndex}
          setActiveCameraIndex={setActiveCameraIndex}
          handleViolationAlert={handleViolationAlert}
          cameraInfoList={cameraInfoList}
        />
      )}
    </section>
  );
}

// Shows an evidence snapshot, falling back to a neutral placeholder when the
// URL is missing/empty or the image fails to load (e.g. legacy rows whose
// media paths now 404). `thumb` renders the compact ~80px table version.
function EvidenceSnapshot({ src, thumb = false }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        style={{
          width: thumb ? 80 : "100%",
          height: thumb ? 48 : 260,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#f3f4f6",
          color: "#9ca3af",
          border: "1px dashed #e5e7eb",
          borderRadius: "8px",
          fontSize: thumb ? "10px" : "14px",
          textAlign: "center",
          padding: thumb ? "2px" : "20px",
          boxSizing: "border-box",
        }}
      >
        No snapshot{thumb ? "" : " available for this record."}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="Evidence snapshot"
      onError={() => setFailed(true)}
      style={
        thumb
          ? {
              width: 80,
              height: 48,
              objectFit: "cover",
              borderRadius: "8px",
              border: "1px solid #334155",
              display: "block",
            }
          : {
              width: "100%",
              maxHeight: "70vh",
              objectFit: "contain",
              borderRadius: "8px",
              display: "block",
            }
      }
    />
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

  // Camera options come from whatever cameras actually have logged violations,
  // so the filter never lists a camera with nothing to show or - worse - omits
  // one that does (a hardcoded 3-camera list previously made every other
  // camera silently return "no violations" when selected, which it can't be,
  // since there's no way to select it).
  const cameraOptions = useMemo(() => {
    const set = new Set(violations.map((v) => v.camera_location).filter(Boolean));
    return ["All Cameras", ...[...set].sort()];
  }, [violations]);

  const handleClearFilters = () => {
    setSearchId("");
    setFilterDate("");
    setFilterCamera("All Cameras");
  };

  // Speed is recorded at violation time; tolerate whichever field name the API
  // sends (or none) and never throw on a missing value.
  const formatSpeed = (row) => {
    const raw = row.speed_kmh ?? row.speed ?? row.violation_speed;
    const num = Number(raw);
    if (raw === undefined || raw === null || raw === "" || Number.isNaN(num)) return "—";
    return `${num.toFixed(1)} km/h`;
  };

  return (
    <section className="bg-gray-50 relative">
      
      {/* Filter Bar */}
      <div className="bg-white p-4 mb-6 rounded-xl border border-gray-200 shadow-sm flex flex-col md:flex-row gap-4 items-stretch md:items-end">
        
        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Search ID</label>
          <input 
            type="text" 
            placeholder="Search by Violation ID..." 
            className="w-full px-4 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg text-sm placeholder-gray-400 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
            value={searchId}
            onChange={(e) => setSearchId(e.target.value)}
          />
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input 
            type="date" 
            className="w-full px-4 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
          />
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Camera Location</label>
          <select 
            className="w-full px-4 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
            value={filterCamera}
            onChange={(e) => setFilterCamera(e.target.value)}
          >
            {cameraOptions.map((cam) => (
              <option key={cam} value={cam}>{cam}</option>
            ))}
          </select>
        </div>

        <button 
          onClick={handleClearFilters}
          className="px-5 py-2 h-[38px] text-sm font-medium rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 border border-gray-300 transition-colors whitespace-nowrap"
        >
          Clear Filters
        </button>
      </div>

      {/* Table Container */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead className="bg-gray-50 text-gray-500 text-xs font-semibold uppercase border-b border-gray-200">
            <tr>
              <th className="px-6 py-4">Violation ID</th>
              <th className="px-6 py-4">Snapshot</th>
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Camera Location</th>
              <th className="px-6 py-4">Speed</th>
              <th className="px-6 py-4">Action</th>
            </tr>
          </thead>
          <tbody className="text-gray-900">
            {filteredViolations.map((row) => (
              <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4 font-medium">{row.violation_id}</td>
                <td className="px-6 py-4"><EvidenceSnapshot src={row.evidence_snapshot_url} thumb /></td>
                <td className="px-6 py-4">{new Date(row.timestamp).toLocaleString()}</td>
                <td className="px-6 py-4">{row.camera_location}</td>
                <td className="px-6 py-4">{formatSpeed(row)}</td>
                <td className="px-6 py-4">
                  <button 
                    className="bg-amber-600 hover:bg-amber-700 text-white transition-colors border-none px-4 py-2 rounded-lg font-semibold text-xs" 
                    onClick={() => setSelectedViolation(row)}
                  >
                    View Evidence
                  </button>
                </td>
              </tr>
            ))}
            {filteredViolations.length === 0 && (
              <tr><td colSpan="6" className="text-center py-8 text-gray-500">No violations found matching filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedViolation && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', maxWidth: '1200px', width: '100%', maxHeight: '90vh', overflowY: 'auto', border: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: '#111827', fontSize: '20px' }}>Evidence ID: {selectedViolation.violation_id}</h3>
              <button onClick={() => setSelectedViolation(null)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '24px' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <h4 style={{ margin: 0, color: '#6b7280' }}>The Proof (Money Shot)</h4>
              <div className="border-2 border-yellow-400 rounded-lg overflow-hidden bg-black shadow-sm">
                <EvidenceSnapshot src={selectedViolation.evidence_snapshot_url} />
              </div>
              <div style={{ backgroundColor: '#f9fafb', padding: '16px', borderRadius: '8px', fontSize: '14px', color: '#374151', border: '1px solid #e5e7eb' }}>
                <p style={{ margin: '0 0 8px 0' }}><strong>Timestamp:</strong> {new Date(selectedViolation.timestamp).toLocaleString()}</p>
                <p style={{ margin: '0 0 8px 0' }}><strong>Location:</strong> {selectedViolation.camera_location}</p>
                <p style={{ margin: 0 }}><strong>Speed:</strong> {formatSpeed(selectedViolation)}</p>
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

// Shown in the main nav whenever an admin session is active (see adminAuth.js) - the
// only persistent, always-visible sign of "you're signed in" and way to log out; before
// this, "Log out" only existed inside a specific camera's ROI-editing controls, gone the
// moment that camera wasn't in edit mode.
function AdminStatus() {
  const session = useAdminSession();
  if (!session) return null;
  return (
    <div className="flex items-center gap-2 pb-4 ml-auto sm:ml-0">
      <span className="text-xs font-medium text-gray-500">
        Signed in as <span className="text-gray-800 font-semibold">{session.username || "admin"}</span>
      </span>
      <button
        onClick={() => { if (window.confirm("Log out of the admin session?")) adminLogout(); }}
        className="text-xs font-semibold text-amber-600 hover:text-amber-700 underline underline-offset-2"
      >
        Log out
      </button>
    </div>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState("live");

  return (
    <>
      <header className="flex flex-wrap justify-between items-end gap-x-6 gap-y-2 px-4 sm:px-8 pt-6 bg-white shadow-sm border-b border-gray-200">
        <div className="flex flex-col gap-1 pb-5">
          <span className="text-amber-600 text-xs font-bold uppercase tracking-wider">By Team Unique</span>
          <h1 className="text-gray-900 text-3xl font-extrabold tracking-tight">Do Do Vision</h1>
        </div>
        <nav className="flex flex-wrap items-end gap-x-6 gap-y-2 sm:gap-x-8 pb-3">
          <button
            className={`pb-4 px-1 text-[15px] font-semibold transition-colors border-b-2 ${currentView === "live" ? "text-amber-600 border-amber-600" : "text-gray-500 hover:text-gray-900 border-transparent"}`}
            onClick={() => setCurrentView("live")}
          >
            Live Monitoring
          </button>
          <button
            className={`pb-4 px-1 text-[15px] font-semibold transition-colors border-b-2 ${currentView === "evidence" ? "text-amber-600 border-amber-600" : "text-gray-500 hover:text-gray-900 border-transparent"}`}
            onClick={() => setCurrentView("evidence")}
          >
            Evidence & History
          </button>
          <button
            className={`pb-4 px-1 text-[15px] font-semibold transition-colors border-b-2 ${currentView === "charts" ? "text-amber-600 border-amber-600" : "text-gray-500 hover:text-gray-900 border-transparent"}`}
            onClick={() => setCurrentView("charts")}
          >
            Report Chart
          </button>
          <button
            className="px-4 py-2 mb-1 text-[15px] font-bold rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors border-none"
            onClick={() => setCurrentView("report")}
          >
            Project Report
          </button>
          <AdminStatus />
        </nav>
      </header>

      <main className="flex-1 p-8 bg-gray-50">
        <div style={{ display: currentView === "live" ? "block" : "none" }}>
          <LiveMonitoringView />
        </div>
        {currentView === "evidence" && <EvidenceHistoryView />}
        {currentView === "charts" && <ReportCharts />}

        {currentView === "report" && <ProjectReport />}
      </main>
    </>
  );
}
