import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# 1. Unify Backgrounds (Video Header, Metadata Panel, Log Panel to #0f172a)
# Currently Video Header is: <div style={{ padding: '16px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155' }}> (Already #0f172a)
# Metadata panel is: <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#cbd5e1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
# Let's change Metadata panel bg to #0f172a
content = content.replace(
    "backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px'",
    "backgroundColor: '#0f172a', padding: '24px', borderRadius: '12px'"
)

# Currently Log Panel Wrapper bg is: <div style={{ flex: '1 1 30%', minWidth: '300px', backgroundColor: '#1e293b', borderRadius: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 150px)' }}>
# Change log panel wrapper to #0f172a, and log cards to #1e293b (as suggested by the snippet)
content = content.replace(
    "minWidth: '300px', backgroundColor: '#1e293b', borderRadius: '12px'",
    "minWidth: '300px', backgroundColor: '#0f172a', borderRadius: '12px'"
)

# Log header bg is already #0f172a, let's keep it or make it transparent to blend with #0f172a wrapper.
# Actually, the user snippet suggests `#1e293b` for the log item card itself.

# 2. Replace the log item map block with the user's snippet.
# Let's find the current map block.
log_old_regex = re.compile(r'recentLogs\.map\(log => \(\s*<div key=\{log\.violation_id\}.*?</div>\s*\)\)\s*\}', re.DOTALL)

log_new = """recentLogs.map(log => {
               // Extract last 6 chars for cleaner ID display
               const shortId = log.violation_id.slice(-6);
               
               return (
                 <div key={log.violation_id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', backgroundColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155', cursor: 'pointer' }}>
                   {/* Thumbnail */}
                   {log.evidence_snapshot_url ? (
                     <img 
                       src={log.evidence_snapshot_url} 
                       style={{ width: '70px', height: '40px', objectFit: 'cover', borderRadius: '4px', border: '1px solid #475569' }} 
                       alt="thumb" 
                     />
                   ) : (
                     <div style={{ width: '70px', height: '40px', backgroundColor: '#0f172a', borderRadius: '4px', border: '1px solid #475569' }}></div>
                   )}
                   
                   {/* Details */}
                   <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                       <span style={{ width: '8px', height: '8px', backgroundColor: '#ef4444', borderRadius: '50%' }}></span>
                       <span style={{ color: '#f8fafc', fontSize: '14px', fontWeight: '600' }}>V-{shortId}</span>
                     </div>
                     <span style={{ color: '#94a3b8', fontSize: '12px', marginLeft: '14px' }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                   </div>

                   {/* Speed Indicator */}
                   {log.speed_kmh && (
                     <div style={{ color: '#ef4444', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>
                       {log.speed_kmh} km/h
                     </div>
                   )}
                 </div>
               );
             })
           }"""

content = log_old_regex.sub(log_new, content)

with open('src/App.jsx', 'w') as f:
    f.write(content)

