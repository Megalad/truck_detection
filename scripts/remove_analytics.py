import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

# 1. Remove Analytics Button
analytics_btn_regex = re.compile(r'\s*<button[^>]*onClick=\{\(\) => setCurrentView\("analytics"\)\}[^>]*>\s*Analytics\s*</button>')
content = analytics_btn_regex.sub('', content)

# 2. Remove Analytics View rendering
content = content.replace('{currentView === "analytics" && <AnalyticsView />}', '')

with open('src/App.jsx', 'w') as f:
    f.write(content)
