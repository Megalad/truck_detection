import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# 1. Unify Backgrounds
content = content.replace(
    "backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px'",
    "backgroundColor: '#0f172a', padding: '24px', borderRadius: '12px'"
)

content = content.replace(
    "minWidth: '300px', backgroundColor: '#1e293b', borderRadius: '12px'",
    "minWidth: '300px', backgroundColor: '#0f172a', borderRadius: '12px'"
)

# 2. Update Panel Header
old_header_regex = re.compile(r"<div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155', borderTopLeftRadius: '12px', borderTopRightRadius: '12px' }}>\s*<h3 style={{ margin: 0, color: '#ef4444' }}>🔴 Live Violation Logs</h3>\s*</div>")

new_header = """<div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155', borderTopLeftRadius: '12px', borderTopRightRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '10px', height: '10px', backgroundColor: '#ef4444', borderRadius: '50%', boxShadow: '0 0 8px rgba(239,68,68,0.5)' }}></span>
          <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '16px', fontWeight: '600' }}>Live Violation Logs</h3>
        </div>"""

content = old_header_regex.sub(new_header, content)

# 3. Update Log Map logic
log_map_regex = re.compile(r"\{recentLogs\.length === 0 \? \(.*?\)\s*\)\s*\}", re.DOTALL)

log_new = """{recentLogs.length === 0 ? (
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
           )}"""

content = log_map_regex.sub(log_new, content)

with open('src/App.jsx', 'w') as f:
    f.write(content)
print("Applied successfully!")
