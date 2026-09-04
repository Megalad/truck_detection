import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# 1. Add the variable
new_url = '  const camTV27CL2Url = "http://1.4.213.19:1926/live/TV27CL2-M7-20_790-LKB.stream/playlist.m3u8";\n'
content = content.replace('const camTV75RUrl = "http://1.4.213.19:1929/live/TV75R-M7-66_826-IPT.stream/playlist.m3u8";', 
                          'const camTV75RUrl = "http://1.4.213.19:1929/live/TV75R-M7-66_826-IPT.stream/playlist.m3u8";\n' + new_url)

# 2. Add the article
new_article = """
        <article className="camera-panel">
          <div className="camera-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>TV27CL2 M7-20+790-LKB</strong>
            <button onClick={() => setExpandedCamera({id: "TV27CL2", title: "TV27CL2 M7-20+790-LKB", url: camTV27CL2Url})} style={{ background: "#3b82f6", color: "white", border: "none", padding: "4px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>Expand</button>
          </div>
          <div className="video-frame">
            <LiveCCTVPlayer streamUrl={camTV27CL2Url} cameraId="TV27CL2" onViolationAlert={handleViolationAlert} />
          </div>
        </article>
"""

# Insert before closing live-grid div
# Wait, the closing of live-grid is:
#         </article>
#       </div>
#       )}

content = content.replace('</article>\n      </div>\n      )}', '</article>' + new_article + '      </div>\n      )}')

with open('src/App.jsx', 'w') as f:
    f.write(content)
