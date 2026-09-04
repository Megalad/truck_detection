import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# Add the CameraFullView component before LiveMonitoringView
camera_full_view = """
function CameraFullView({ cameraId, cameraTitle, streamUrl, cameraInfoList, onClose, onViolationAlert }) {
  const info = cameraInfoList.find(c => c.title && c.title.includes(cameraId));
  const [recentLogs, React_useState] = useState([]);
  
  // Note: we can use the top-level useState but here we will just call useState directly since it's already imported
  // Aliasing just for safety since it's a raw string replacement
  
  useEffect(() => {
    const fetchLogs = () => {
      fetch('/api/violations')
        .then(res => res.json())
        .then(data => {
          if (data.violations) {
            const filtered = data.violations
               .filter(v => v.camera_location === cameraId)
               .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))
               .slice(0, 10);
            React_useState(filtered);
          }
        });
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [cameraId]);

  return (
    <div className="camera-full-view" style={{ display: 'flex', gap: '24px', height: '100%' }}>
      {/* LEFT COLUMN: Video & Details */}
      <div style={{ flex: '1 1 70%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
         <button onClick={onClose} style={{ alignSelf: 'flex-start', padding: '8px 16px', backgroundColor: '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
           &larr; Back to Grid
         </button>
         
         <div style={{ backgroundColor: '#1e293b', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}>
           <div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155' }}>
             <h2 style={{ margin: 0, color: 'white' }}>{cameraTitle}</h2>
           </div>
           <div style={{ height: '600px', width: '100%', position: 'relative' }}>
             <LiveCCTVPlayer streamUrl={streamUrl} cameraId={cameraId} onViolationAlert={onViolationAlert} />
           </div>
         </div>

         {info ? (
           <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#cbd5e1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
             <div><strong>Viewpoint (EN):</strong> {info.viewpoint_en}</div>
             <div><strong>Viewpoint (TH):</strong> {info.viewpoint_th}</div>
             <div><strong>Route:</strong> {info.route}</div>
             <div><strong>Direction:</strong> {info.direction === 'R' ? 'Right / Outbound' : 'Left / Inbound'}</div>
             <div><strong>KM Marker:</strong> {info.km}</div>
             <div><strong>Coordinates:</strong> {info.latitude}, {info.longitude}</div>
           </div>
         ) : (
           <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#cbd5e1' }}>
              Loading camera details from JSON...
           </div>
         )}
      </div>

      {/* RIGHT COLUMN: Violation Logs */}
      <div style={{ flex: '1 1 30%', backgroundColor: '#1e293b', borderRadius: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 150px)' }}>
        <div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155', borderTopLeftRadius: '12px', borderTopRightRadius: '12px' }}>
          <h3 style={{ margin: 0, color: '#ef4444' }}>🔴 Live Violation Logs</h3>
        </div>
        <div style={{ overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
           {recentLogs.length === 0 ? (
             <div style={{ color: '#64748b', textAlign: 'center', padding: '40px 20px' }}>No recent violations.</div>
           ) : (
             recentLogs.map(log => (
               <div key={log.violation_id} style={{ backgroundColor: '#0f172a', borderRadius: '8px', overflow: 'hidden', border: '1px solid #334155' }}>
                 {log.evidence_snapshot_url && (
                   <img src={log.evidence_snapshot_url} style={{ width: '100%', height: '180px', objectFit: 'cover' }} alt="Violation" />
                 )}
                 <div style={{ padding: '12px', fontSize: '14px', color: '#cbd5e1' }}>
                   <div style={{ color: '#ef4444', fontWeight: 'bold', fontSize: '16px', marginBottom: '4px' }}>Speed: {log.speed_kmh} km/h</div>
                   <div>Time: {new Date(log.timestamp).toLocaleTimeString()}</div>
                 </div>
               </div>
             ))
           )}
        </div>
      </div>
    </div>
  );
}

function LiveMonitoringView"""

content = content.replace("function LiveMonitoringView", camera_full_view)

# Now modify LiveMonitoringView
# Find LiveMonitoringView declaration and add state
start_idx = content.find('function LiveMonitoringView() {')
end_idx = content.find('return (', start_idx)

state_additions = """
  const [cameraInfoList, setCameraInfoList] = useState([]);
  const [expandedCamera, setExpandedCamera] = useState(null);

  useEffect(() => {
    fetch('/camera.json')
      .then(res => res.json())
      .then(json => {
        if(json.data && json.data.cctv) setCameraInfoList(json.data.cctv);
      })
      .catch(err => console.error(err));
  }, []);
"""

content = content[:end_idx] + state_additions + "\n  " + content[end_idx:]

# Modify the return block to toggle between grid and full view
# Replace `<section>` with conditional render

section_idx = content.find('<section>', end_idx)
grid_start = content.find('<div className="live-grid">', section_idx)
grid_end = content.find('</div>\n\n      <div className="alert-ticker-container">', grid_start) + 6

# We will wrap the grid in a check `!expandedCamera`
new_grid = """
      {expandedCamera ? (
        <CameraFullView 
           cameraId={expandedCamera.id} 
           cameraTitle={expandedCamera.title} 
           streamUrl={expandedCamera.url} 
           cameraInfoList={cameraInfoList} 
           onClose={() => setExpandedCamera(null)} 
           onViolationAlert={handleViolationAlert} 
        />
      ) : (
        <div className="live-grid">
"""

content = content[:grid_start] + new_grid + content[grid_start+27:grid_end] + "\n      )}\n" + content[grid_end:]

# Add Expand buttons to the panels
content = content.replace(
    '<strong>TV73R M7-64+872-IPT</strong>',
    '<strong>TV73R M7-64+872-IPT</strong>\n            <button onClick={() => setExpandedCamera({id: "TV73R", title: "TV73R M7-64+872-IPT", url: camTV73RUrl})} style={{ background: "#3b82f6", color: "white", border: "none", padding: "4px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>Expand</button>'
)

content = content.replace(
    '<strong>TV09L M7-06+200-SKR</strong>',
    '<strong>TV09L M7-06+200-SKR</strong>\n            <button onClick={() => setExpandedCamera({id: "TV09L", title: "TV09L M7-06+200-SKR", url: camTV09LUrl})} style={{ background: "#3b82f6", color: "white", border: "none", padding: "4px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>Expand</button>'
)

content = content.replace(
    '<strong>TV75R M7-66+826-PT</strong>',
    '<strong>TV75R M7-66+826-PT</strong>\n            <button onClick={() => setExpandedCamera({id: "TV75R", title: "TV75R M7-66+826-PT", url: camTV75RUrl})} style={{ background: "#3b82f6", color: "white", border: "none", padding: "4px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>Expand</button>'
)

# And fix the camera header style so the button floats right
content = content.replace('className="camera-header"', 'className="camera-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}')

with open('src/App.jsx', 'w') as f:
    f.write(content)
