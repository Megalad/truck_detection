import re

with open('src/App.jsx', 'r') as f:
    content = f.read()

content = content.replace(
    '<div className="camera-full-view" style={{ display: \'flex\', gap: \'24px\', height: \'100%\' }}>',
    '<div className="camera-full-view" style={{ display: \'flex\', flexWrap: \'wrap\', gap: \'24px\', height: \'100%\' }}>'
)

content = content.replace(
    '<div style={{ flex: \'1 1 70%\', display: \'flex\', flexDirection: \'column\', gap: \'16px\' }}>',
    '<div style={{ flex: \'1 1 65%\', minWidth: \'320px\', display: \'flex\', flexDirection: \'column\', gap: \'16px\' }}>'
)

content = content.replace(
    '<div style={{ height: \'600px\', width: \'100%\', position: \'relative\' }}>',
    '<div style={{ width: \'100%\', aspectRatio: \'16/9\', position: \'relative\' }}>'
)

content = content.replace(
    'gridTemplateColumns: \'1fr 1fr\'',
    'gridTemplateColumns: \'repeat(auto-fit, minmax(200px, 1fr))\''
)

content = content.replace(
    '<div style={{ flex: \'1 1 30%\', backgroundColor: \'#1e293b\', borderRadius: \'12px\', border: \'1px solid #334155\', display: \'flex\', flexDirection: \'column\', maxHeight: \'calc(100vh - 150px)\' }}>',
    '<div style={{ flex: \'1 1 30%\', minWidth: \'300px\', backgroundColor: \'#1e293b\', borderRadius: \'12px\', border: \'1px solid #334155\', display: \'flex\', flexDirection: \'column\', maxHeight: \'calc(100vh - 150px)\' }}>'
)

with open('src/App.jsx', 'w') as f:
    f.write(content)
