import re

with open('src/components/LiveCCTVPlayer.jsx', 'r') as f:
    content = f.read()

# Add isEditingRoi state
content = content.replace(
    'const [isDrawingFinished, setIsDrawingFinished] = useState(false);',
    'const [isDrawingFinished, setIsDrawingFinished] = useState(false);\n  const [isEditingRoi, setIsEditingRoi] = useState(false);\n  const [normalizedPointsState, setNormalizedPointsState] = useState([]);'
)

# Update handleSvgClick
content = content.replace(
    'if (isDrawingFinished) return;',
    'if (!isEditingRoi || isDrawingFinished) return;'
)

# Replace handleFinishDrawing to save normalizedPointsState
content = content.replace(
    'localStorage.setItem(`roi_${cameraId}`, JSON.stringify(normalizedPoints));',
    'localStorage.setItem(`roi_${cameraId}`, JSON.stringify(normalizedPoints));\n    setNormalizedPointsState(normalizedPoints);'
)

# Update useEffect to use ResizeObserver
resize_effect = """
  // Responsive Canvas Alignment using ResizeObserver
  useEffect(() => {
    if (!svgRef.current) return;
    const resizeObserver = new ResizeObserver(entries => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && normalizedPointsState.length > 0) {
          const absolutePoints = normalizedPointsState.map(p => ({
            x: p.x * width,
            y: p.y * height
          }));
          setPolygonPoints(absolutePoints);
        }
      }
    });
    resizeObserver.observe(svgRef.current);
    return () => resizeObserver.disconnect();
  }, [normalizedPointsState]);

  useEffect(() => {
"""
content = content.replace('  useEffect(() => {\n    const saved = localStorage.getItem', resize_effect + '    const saved = localStorage.getItem')

content = content.replace(
    'setPolygonPoints(absolutePoints);\n            setIsDrawingFinished(true);',
    'setPolygonPoints(absolutePoints);\n            setNormalizedPointsState(normalizedPoints);\n            setIsDrawingFinished(true);'
)

# Update SVG cursor
content = content.replace(
    "cursor: isDrawingFinished ? 'default' : 'crosshair'",
    "cursor: (isEditingRoi && !isDrawingFinished) ? 'crosshair' : 'default'"
)

# Replace Controls
controls_old = """      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', gap: '8px' }}>
        <button
          onClick={handleClearLane}
          style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer' }}
        >
          Clear Lane
        </button>
        <button
          onClick={handleFinishDrawing}
          style={{ padding: '6px 12px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          Finish Drawing
        </button>
      </div>"""

controls_new = """      {/* ROI Controls */}
      <div style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 20, display: 'flex', gap: '8px' }}>
        <button
          onClick={() => setIsEditingRoi(!isEditingRoi)}
          style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          {isEditingRoi ? '✖ Close Settings' : '✏️ Edit ROI'}
        </button>
        {isEditingRoi && (
          <>
            <button
              onClick={handleClearLane}
              style={{ padding: '6px 12px', backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', border: '1px solid white', borderRadius: '4px', cursor: 'pointer' }}
            >
              Clear Lane
            </button>
            <button
              onClick={handleFinishDrawing}
              style={{ padding: '6px 12px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              Finish Drawing
            </button>
          </>
        )}
      </div>"""

content = content.replace(controls_old, controls_new)

with open('src/components/LiveCCTVPlayer.jsx', 'w') as f:
    f.write(content)
