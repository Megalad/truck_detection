import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# 1. Add import
if 'import ProjectReport' not in content:
    content = content.replace('import RecordedPlayback from "./components/RecordedPlayback";',
                              'import RecordedPlayback from "./components/RecordedPlayback";\nimport ProjectReport from "./components/ProjectReport";')

# 2. Add Navigation Button
nav_target = '<button \n            className={currentView === "status" ? "active" : ""} \n            onClick={() => setCurrentView("status")}\n          >\n            Node Status\n          </button>'
if 'Project Report' not in content:
    new_nav = nav_target + '\n          <button \n            className={currentView === "report" ? "active" : ""} \n            onClick={() => setCurrentView("report")}\n            style={{ marginLeft: "auto", backgroundColor: "#3b82f6", color: "white", fontWeight: "bold" }}\n          >\n            📝 Project Report\n          </button>'
    content = content.replace(nav_target, new_nav)

# 3. Add Component Route
main_target = '{currentView === "status" && <NodeStatusView />}\n      </main>'
if '<ProjectReport />' not in content:
    new_main = '{currentView === "status" && <NodeStatusView />}\n        {currentView === "report" && <ProjectReport />}\n      </main>'
    content = content.replace(main_target, new_main)

with open('src/App.jsx', 'w') as f:
    f.write(content)
print("Updated Nav!")
