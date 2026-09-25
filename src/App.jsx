/**
 * App shell: header (navigation, admin status, alert bell) and the four views -
 * Live Monitoring, Violations, Analytics and Project Report.
 */
import { useState, useEffect, useRef, useMemo } from "react";
import "./styles.css";
import { CAMERAS } from "./cameras";
import LiveCCTVPlayer from "./components/LiveCCTVPlayer";
import CameraMap from "./components/CameraMap";
import ProjectReport from "./components/ProjectReport";
import ReportCharts from "./components/ReportCharts";
import ViewToggle from "./components/ViewToggle";
import FocusView from "./components/FocusView";
import ReplayToggle from "./components/ReplayToggle";
import AdminLoginModal from "./components/AdminLoginModal";
import { adminLogout, getAdminToken, requestAdminLogin, useAdminSession } from "./adminAuth";
import { NotificationBell, AlertToast } from "./components/NotificationBell";
import { useAlerts } from "./alerts";
import ModelMenuSection from "./components/ModelMenuSection";
import { downloadTicket } from "./ticket";

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
            <div className="absolute right-0 mt-2 w-44 bg-white rounded-md shadow-lg border border-gray-200 z-50 py-1">
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
              <ModelMenuSection cameraId={cam.id} onPicked={() => setIsMenuOpen(false)} />
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

  // Bell/toast "jump to camera": App switches to this tab, then asks us (via this event)
  // to open that camera in Focus view.
  useEffect(() => {
    const onFocusCamera = (e) => {
      const idx = CAMERAS.findIndex((c) => c.id === e.detail);
      if (idx === -1) return;
      setActiveCameraIndex(idx);
      setCurrentView('focus');
    };
    window.addEventListener('focus-camera', onFocusCamera);
    return () => window.removeEventListener('focus-camera', onFocusCamera);
  }, []);

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
      {/* flex-wrap + gap-y: heading + 3 controls in one unwrapped row was a real overflow
          risk on a narrow phone (nothing here could ever reflow); wrapping lets the controls
          drop to their own row under the heading instead. */}
      <div className="flex flex-wrap justify-between items-center gap-x-4 gap-y-3 mb-6">
        <h2 className="text-xl font-bold text-gray-900">Live Camera Feeds</h2>
        <div className="flex flex-wrap items-center gap-3">
          <ReplayToggle />
          {currentView === 'grid' && (
            <div className="flex items-center gap-2 bg-gray-100 rounded-full p-1 border border-gray-200 shadow-inner">
              <button
                onClick={() => setVisibleCameraCount((c) => Math.max(MIN_GRID_CAMERAS, c - 1))}
                disabled={visibleCameraCount <= MIN_GRID_CAMERAS}
                className="w-10 h-10 flex items-center justify-center rounded-full text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                className="w-10 h-10 flex items-center justify-center rounded-full text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
      ) : currentView === 'map' ? (
        <CameraMap
          cameras={CAMERAS}
          cameraInfoList={cameraInfoList}
          onOpenCamera={(idx) => { setActiveCameraIndex(idx); setCurrentView('focus'); }}
        />
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

// Admin-only "Download Ticket" button: builds the violation's PDF ticket (see ticket.js),
// including the same truck's sightings on other cameras (shared route_match_id).
function TicketButton({ row, violations, compact = false }) {
  const session = useAdminSession();
  const [busy, setBusy] = useState(false);
  if (!session) return null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const related = row.route_match_id
        ? violations.filter((v) => v.route_match_id === row.route_match_id && v.id !== row.id)
        : [];
      await downloadTicket(row, related, session.username || "admin");
    } catch (err) {
      console.error("Ticket generation failed:", err);
      window.alert("Could not generate the ticket. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title="Download this violation as a PDF ticket"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors ${compact ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"}`}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
      </svg>
      {busy ? "Preparing..." : compact ? "Ticket" : "Download Ticket"}
    </button>
  );
}

// Admin-only delete: removes the violation record from the database and its evidence photo
// (DELETE /api/violations/:id on the Python server, which checks the admin session).
function DeleteViolationButton({ row, onDeleted, compact = false }) {
  const session = useAdminSession();
  const [busy, setBusy] = useState(false);
  if (!session) return null;

  const handleClick = async () => {
    if (!window.confirm(`Permanently delete violation ${row.violation_id} and its evidence photo?\n\nThis cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/violations/${row.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${getAdminToken()}` },
      });
      if (res.status === 401) {
        adminLogout();
        window.alert("Your admin session has expired. Please sign in again.");
        return;
      }
      if (!res.ok) {
        // Only the endpoint's own "not found" means the record is already gone. Any other
        // 404 (e.g. a server without this endpoint yet) must not look like a success.
        const body = await res.json().catch(() => null);
        if (!(res.status === 404 && body?.detail === "Violation not found")) throw new Error(`HTTP ${res.status}`);
      }
      onDeleted(row.id);
    } catch (err) {
      console.error("Delete failed:", err);
      window.alert("Could not delete this violation. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title="Delete this violation and its evidence photo"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60 transition-colors ${compact ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm"}`}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M4 7h16M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
      </svg>
      {busy ? "Deleting..." : "Delete"}
    </button>
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

  // Filter options are built from the cameras that actually have violations,
  // so every listed camera has records and none with records is missing.
  const cameraOptions = useMemo(() => {
    const set = new Set(violations.map((v) => v.camera_location).filter(Boolean));
    return ["All Cameras", ...[...set].sort()];
  }, [violations]);

  const handleDeleted = (id) => {
    setViolations((list) => list.filter((v) => v.id !== id));
    setSelectedViolation((sel) => (sel && sel.id === id ? null : sel));
  };

  const handleClearFilters = () => {
    setSearchId("");
    setFilterDate("");
    setFilterCamera("All Cameras");
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

      {/* Table Container. overflow-x-auto: a 6-column table can't reflow to a narrow
          screen the way flex/grid layouts can - the standard, safe fix is letting it
          scroll horizontally within its own box (swipe to see the rest) rather than
          overflowing the page or squishing every column unreadably thin. */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto overflow-y-hidden">
        <table className="w-full text-left border-collapse">
          <thead className="bg-gray-50 text-gray-500 text-xs font-semibold uppercase border-b border-gray-200">
            <tr>
              <th className="px-6 py-4">Violation ID</th>
              <th className="px-6 py-4">Snapshot</th>
              <th className="px-6 py-4">Timestamp</th>
              <th className="px-6 py-4">Camera Location</th>
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
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <button 
                      className="bg-amber-600 hover:bg-amber-700 text-white transition-colors border-none px-4 py-2 rounded-lg font-semibold text-xs whitespace-nowrap" 
                      onClick={() => setSelectedViolation(row)}
                    >
                      View Evidence
                    </button>
                    <TicketButton row={row} violations={violations} compact />
                    <DeleteViolationButton row={row} onDeleted={handleDeleted} compact />
                  </div>
                </td>
              </tr>
            ))}
            {filteredViolations.length === 0 && (
              <tr><td colSpan="5" className="text-center py-8 text-gray-500">No violations found matching filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedViolation && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ backgroundColor: '#ffffff', padding: '24px', borderRadius: '12px', maxWidth: '1200px', width: '100%', maxHeight: '90vh', overflowY: 'auto', border: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: '#111827', fontSize: '20px' }}>Evidence ID: {selectedViolation.violation_id}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <TicketButton row={selectedViolation} violations={violations} />
                <DeleteViolationButton row={selectedViolation} onDeleted={handleDeleted} />
                <button onClick={() => setSelectedViolation(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '24px' }}>✕</button>
              </div>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <h4 style={{ margin: 0, color: '#6b7280' }}>The Proof (Money Shot)</h4>
              <div className="border-2 border-yellow-400 rounded-lg overflow-hidden bg-black shadow-sm">
                <EvidenceSnapshot src={selectedViolation.evidence_snapshot_url} />
              </div>
              <div style={{ backgroundColor: '#f9fafb', padding: '16px', borderRadius: '8px', fontSize: '14px', color: '#374151', border: '1px solid #e5e7eb' }}>
                <p style={{ margin: '0 0 8px 0' }}><strong>Timestamp:</strong> {new Date(selectedViolation.timestamp).toLocaleString()}</p>
                <p style={{ margin: 0 }}><strong>Location:</strong> {selectedViolation.camera_location}</p>
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

// Right end of the header: a "Sign in" button when signed out, or the signed-in admin's
// avatar menu. Log out sits inside the menu rather than as an always-visible link, so it
// can't be hit by accident.
function UserMenu() {
  const session = useAdminSession();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!session) {
    return (
      <button
        onClick={() => requestAdminLogin(() => {})}
        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Sign in
      </button>
    );
  }
  const name = session.username || "admin";
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={name}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-800 text-sm font-bold uppercase text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 transition-colors"
      >
        {name.charAt(0)}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg z-[90]">
          <div className="px-4 py-2 border-b border-gray-100">
            <div className="text-sm font-semibold text-gray-900">{name}</div>
            <div className="text-xs text-gray-500">Administrator</div>
          </div>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); if (window.confirm("Log out of the admin session?")) adminLogout(); }}
            className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

const NAV_ITEMS = [
  { id: "live", label: "Live Monitoring" },
  { id: "evidence", label: "Violations" },
  { id: "charts", label: "Analytics" },
  { id: "report", label: "Project Report" },
];

export default function App() {
  const [currentView, setCurrentView] = useState("live");
  const { unread } = useAlerts();

  // "(3) Do Do — ..." in the browser tab while there are unread alerts.
  useEffect(() => {
    const base = "Do Do — Section 35 Enforcement Portal";
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread]);

  const jumpToCamera = (cameraId) => {
    setCurrentView("live");
    window.dispatchEvent(new CustomEvent("focus-camera", { detail: cameraId }));
  };

  return (
    <>
      {/* One shared sign-in modal for the whole app - see adminAuth.js's requestAdminLogin
          for why this replaced a separate copy inside every LiveCCTVPlayer instance. */}
      <AdminLoginModal />
      <AlertToast onSelect={jumpToCamera} />
      {/* Header: brand | page tabs | notifications + account. On narrow screens the tabs
          drop to their own full-width, horizontally scrollable row. */}
      <header className="flex flex-wrap items-center justify-between gap-x-8 px-4 sm:px-8 bg-white shadow-sm border-b border-gray-200">
        <div className="py-4">
          <h1 className="text-gray-900 text-2xl sm:text-3xl font-extrabold tracking-tight leading-tight">Do Do Vision</h1>
          <p className="text-gray-500 text-xs sm:text-sm font-medium">Section 35 Enforcement Portal</p>
        </div>
        <nav aria-label="Main" className="order-last w-full overflow-x-auto sm:order-none sm:w-auto sm:flex-1 self-stretch">
          <ul className="flex h-full gap-x-6 sm:gap-x-8">
            {NAV_ITEMS.map((item) => {
              const active = currentView === item.id;
              return (
                <li key={item.id} className="flex">
                  <button
                    onClick={() => setCurrentView(item.id)}
                    aria-current={active ? "page" : undefined}
                    className={`whitespace-nowrap py-3 sm:py-0 px-1 text-[15px] font-semibold transition-colors border-b-2 ${active ? "text-amber-600 border-amber-600" : "text-gray-500 hover:text-gray-900 border-transparent"}`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex items-center gap-2 sm:gap-3 py-4">
          <NotificationBell onSelect={jumpToCamera} />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 p-8 bg-gray-50">
        <div style={{ display: currentView === "live" ? "block" : "none" }}>
          <LiveMonitoringView />
        </div>
        {currentView === "evidence" && <EvidenceHistoryView />}
        {currentView === "charts" && <ReportCharts />}

        {currentView === "report" && <ProjectReport />}
      </main>
      <footer className="px-4 sm:px-8 py-4 text-center text-xs text-gray-400 bg-gray-50 border-t border-gray-200">
        Do Do Vision · by Team Unique
      </footer>
    </>
  );
}
