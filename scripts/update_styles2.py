with open('src/App.jsx', 'r') as f:
    content = f.read()

start_str = "recentLogs.map(log => ("
end_str = "))\n           )}"

start_idx = content.find(start_str)
end_idx = content.find(end_str, start_idx) + len(end_str)

if start_idx != -1 and end_idx != -1:
    log_new = """recentLogs.map(log => {
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
    
    content = content[:start_idx] + log_new + content[end_idx:]
    with open('src/App.jsx', 'w') as f:
        f.write(content)
    print("Replaced!")
else:
    print("Not found", start_idx, end_idx)
