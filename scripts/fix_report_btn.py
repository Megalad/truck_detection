with open('src/App.jsx', 'r') as f:
    content = f.read()

old_btn = """          <button 
            className={currentView === "status" ? "active" : ""} 
            onClick={() => setCurrentView("status")}
          >
            Report
          </button>"""

new_btn = """          <button 
            className={currentView === "report" ? "active" : ""} 
            onClick={() => setCurrentView("report")}
            style={{ backgroundColor: "#3b82f6", color: "white", fontWeight: "bold", marginLeft: "16px", borderRadius: "8px" }}
          >
            📝 Project Report
          </button>"""

content = content.replace(old_btn, new_btn)

# Also remove NodeStatusView if it's no longer used
content = content.replace('{currentView === "status" && <NodeStatusView />}', '')

with open('src/App.jsx', 'w') as f:
    f.write(content)

