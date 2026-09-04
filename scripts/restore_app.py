import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

camera_full_view = """
function CameraFullView({ cameraId, cameraTitle, streamUrl, cameraInfoList, onClose, onViolationAlert }) {
  const info = cameraInfoList.find(c => c.title && c.title.includes(cameraId));
  const [recentLogs, setRecentLogs] = useState([]);
  
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
            setRecentLogs(filtered);
          }
        });
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [cameraId]);

  return (
    <div className="camera-full-view" style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', height: '100%' }}>
      {/* LEFT COLUMN: Video & Details */}
      <div style={{ flex: '1 1 65%', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
         <button onClick={onClose} style={{ alignSelf: 'flex-start', padding: '8px 16px', backgroundColor: '#334155', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
           &larr; Back to Grid
         </button>
         
         <div style={{ backgroundColor: '#0f172a', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}>
           <div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155' }}>
             <h2 style={{ margin: 0, color: 'white' }}>{cameraTitle}</h2>
           </div>
           <div style={{ width: '100%', aspectRatio: '16/9', position: 'relative' }}>
             <LiveCCTVPlayer streamUrl={streamUrl} cameraId={cameraId} onViolationAlert={onViolationAlert} />
           </div>
         </div>

         {info ? (
           <div style={{ backgroundColor: '#0f172a', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#cbd5e1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
             <div><strong>Viewpoint (EN):</strong> {info.viewpoint_en}</div>
             <div><strong>Viewpoint (TH):</strong> {info.viewpoint_th}</div>
             <div><strong>Route:</strong> {info.route}</div>
             <div><strong>Direction:</strong> {info.direction === 'R' ? 'Right / Outbound' : 'Left / Inbound'}</div>
             <div><strong>KM Marker:</strong> {info.km}</div>
             <div><strong>Coordinates:</strong> {info.latitude}, {info.longitude}</div>
           </div>
         ) : (
           <div style={{ backgroundColor: '#0f172a', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#cbd5e1' }}>
              Loading camera details from JSON...
           </div>
         )}
      </div>

      {/* RIGHT COLUMN: Violation Logs */}
      <div style={{ flex: '1 1 30%', minWidth: '300px', backgroundColor: '#0f172a', borderRadius: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 150px)' }}>
        <div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155', borderTopLeftRadius: '12px', borderTopRightRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '10px', height: '10px', backgroundColor: '#ef4444', borderRadius: '50%', boxShadow: '0 0 8px rgba(239,68,68,0.5)' }}></span>
          <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '16px', fontWeight: '600' }}>Live Violation Logs</h3>
        </div>
        <div style={{ overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
           {recentLogs.length === 0 ? (
             <div style={{ color: '#64748b', textAlign: 'center', padding: '40px 20px' }}>No recent violations.</div>
           ) : (
             recentLogs.map(log => {
               const shortId = log.violation_id.slice(-6);
               return (
                 <div 
                   key={log.violation_id} 
                   style={{ 
                     display: 'flex', 
                     alignItems: 'center', 
                     gap: '12px', 
                     padding: '12px', 
                     backgroundColor: '#1e293b', 
                     borderRadius: '8px', 
                     border: '1px solid #334155', 
                     cursor: 'pointer',
                     transition: 'background-color 0.2s ease'
                   }}
                   onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#334155'}
                   onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#1e293b'}
                 >
                   {/* Thumbnail */}
                   <div style={{ width: '70px', height: '40px', backgroundColor: '#0f172a', borderRadius: '4px', border: '1px solid #475569', flexShrink: 0, overflow: 'hidden' }}>
                     {log.evidence_snapshot_url ? (
                       <img 
                         src={log.evidence_snapshot_url} 
                         style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                         alt="thumb" 
                       />
                     ) : (
                       <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '10px' }}>No Img</div>
                     )}
                   </div>
                   
                   {/* Details */}
                   <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                       <span style={{ minWidth: '8px', height: '8px', backgroundColor: '#ef4444', borderRadius: '50%' }}></span>
                       <span style={{ color: '#f8fafc', fontSize: '14px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                         V-{shortId}
                       </span>
                     </div>
                     <span style={{ color: '#94a3b8', fontSize: '12px', marginLeft: '14px' }}>
                       {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                     </span>
                   </div>

                   {/* Speed Indicator */}
                   {log.speed_kmh && (
                     <div style={{ color: '#ef4444', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace', whiteSpace: 'nowrap', paddingLeft: '8px' }}>
                       {log.speed_kmh} km/h
                     </div>
                   )}
                 </div>
               );
             })
           )}
        </div>
      </div>
    </div>
  );
}

function LiveMonitoringView"""

content = content.replace("function LiveMonitoringView", camera_full_view)

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
section_idx = content.find('<section>', end_idx)
grid_start = content.find('<div className="live-grid">', section_idx)
grid_end = content.find('</div>\n\n      <div className="alert-ticker-container">', grid_start) + 6

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

