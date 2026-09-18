import { useEffect, useMemo, useState } from 'react';
import { CAMERAS } from '../cameras';

// All four charts are built from the same /api/violations records (the only
// truck data this system persists — a detection only reaches the DB once it's
// confirmed as a lane violation, see live_server.py's save_video_and_db). So
// "Truck Count by Lane" and "Truck detection by time of the day" reflect
// logged violations, not raw detector output. Callers see that via each
// card's subtitle rather than a title that overclaims what's behind it.

const ACCENT = '#d97706'; // matches the app's existing amber-600 brand accent

// Semantic chart colors (distinct from ACCENT, which stays the default for
// charts with no speed/violation-volume meaning attached, e.g. lane/hour
// breakdowns).
export const VIOLATIONS_VOLUME_COLOR = '#F97316'; // line charts tracking violation counts
export const NORMAL_SPEED_COLOR = '#3B82F6';       // speed-distribution bars at or under the limit
export const OVERSPEED_COLOR = '#EF4444';          // speed-distribution bars over the limit
const OVERSPEED_THRESHOLD_KMH = 100;

const HOUR_LABELS = [
  '12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
  '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p',
];

// Smallest "nice" number that's still >= value * 1.1 (10% headroom so the
// tallest bar/point doesn't touch the top edge). The old version only had
// four residual steps (1/2/5/10), which could nearly double the axis for a
// value just over a step (e.g. 25 -> 50, half the chart empty); this denser
// step list keeps the axis close to the actual data.
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const target = value * 1.1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const residual = target / magnitude;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const niceResidual = steps.find((s) => s >= residual) ?? 10;
  return niceResidual * magnitude;
}

// Evenly-spaced label indices that always include the first and last point.
// A naive "every Nth index, plus force the last one" scheme can land the
// forced last label right next to the previous shown one (e.g. "Sep 10" and
// "Sep 11" back to back) — spacing indices evenly across the full range
// instead guarantees no two shown labels are closer than the others.
function pickLabelIndices(n, maxLabels) {
  if (n <= maxLabels) return new Set(Array.from({ length: n }, (_, i) => i));
  const idx = new Set();
  for (let i = 0; i < maxLabels; i++) {
    idx.add(Math.round((i * (n - 1)) / (maxLabels - 1)));
  }
  return idx;
}

// A rect with rounded top corners, square baseline — the mark spec for bars.
function roundedTopRectPath(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return '';
  const radius = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}
    L${x},${y + radius}
    Q${x},${y} ${x + radius},${y}
    L${x + w - radius},${y}
    Q${x + w},${y} ${x + w},${y + radius}
    L${x + w},${y + h}
    Z`;
}

// ---- Aggregation helpers ---------------------------------------------------

export function buildDaySeries(violations, days) {
  const counts = new Map();
  for (const v of violations) {
    const d = new Date(v.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const series = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      value: counts.get(key) || 0,
    });
  }
  return series;
}

export function buildSpeedBuckets(violations) {
  // 20 km/h bins, not 10 - halves how many bars/labels the chart needs
  // (e.g. 0-140 km/h is 7 labels instead of 14), which is what was making
  // the x-axis labels overlap into an unreadable strip.
  const bucketSize = 20;
  const speeds = violations
    .map((v) => Number(v.speed_kmh))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const maxSpeed = speeds.length ? Math.max(...speeds) : 0;
  const bucketCount = Math.max(1, Math.ceil((maxSpeed + 1) / bucketSize));
  const counts = new Array(bucketCount).fill(0);
  for (const s of speeds) {
    counts[Math.min(bucketCount - 1, Math.floor(s / bucketSize))] += 1;
  }
  return counts.map((value, i) => {
    const rangeStart = i * bucketSize;
    return {
      label: `${rangeStart}–${rangeStart + bucketSize}`,
      value,
      color: rangeStart >= OVERSPEED_THRESHOLD_KMH ? OVERSPEED_COLOR : NORMAL_SPEED_COLOR,
    };
  });
}

// Always shows all 15 currently-monitored cameras (see src/cameras.js — the
// same list Live Monitoring renders), even ones with zero violations so far,
// instead of only whichever camera_location values happen to already be in
// the DB. Older/test entries that predate the current camera list (e.g.
// "camera1"/"recorded1") still get counted, just folded into one "Other"
// bar at the end rather than cluttering the axis with stale IDs.
function buildLaneCounts(violations) {
  const counts = new Map();
  for (const v of violations) {
    const key = v.camera_location || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const currentIds = new Set(CAMERAS.map((c) => c.id));
  const current = CAMERAS.map((c) => ({ label: c.id, value: counts.get(c.id) || 0 }))
    .sort((a, b) => b.value - a.value);

  const legacyTotal = [...counts.entries()]
    .filter(([key]) => !currentIds.has(key))
    .reduce((sum, [, v]) => sum + v, 0);

  return legacyTotal > 0 ? [...current, { label: 'Other (legacy)', value: legacyTotal }] : current;
}

export function buildHourCounts(violations) {
  const counts = new Array(24).fill(0);
  for (const v of violations) {
    const d = new Date(v.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    counts[d.getHours()] += 1;
  }
  return counts.map((value, i) => ({ label: HOUR_LABELS[i], value }));
}

// ---- Chart primitives -------------------------------------------------------
// Hand-rolled inline SVG (no chart library in this project) with a per-mark
// hover tooltip, per the dataviz interaction spec — bars/points are their own
// hit target, values never gated behind hover (the "View table" toggle below
// carries the same numbers without needing to hover at all).

export function BarChart({ data, color = ACCENT, height = 220, sparseLabels = false }) {
  const [hover, setHover] = useState(null);
  const width = 600;
  const paddingLeft = 40;
  const paddingBottom = 26;
  const paddingTop = 12;
  const paddingRight = 12;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;
  const n = data.length;
  const maxVal = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const slot = chartW / Math.max(1, n);
  const barW = Math.max(2, Math.min(24, slot - 2));
  const labelIdx = useMemo(() => pickLabelIndices(n, sparseLabels ? 8 : n), [n, sparseLabels]);

  const ticks = [0, maxVal / 2, maxVal];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="bar chart">
        {ticks.map((t, i) => {
          const y = paddingTop + chartH - (t / maxVal) * chartH;
          return (
            <g key={i}>
              <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
              <text x={paddingLeft - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
                {Math.round(t).toLocaleString()}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = paddingLeft + i * slot + (slot - barW) / 2;
          const barH = (d.value / maxVal) * chartH;
          const y = paddingTop + chartH - barH;
          const isHover = hover === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseMove={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onTouchStart={() => setHover(i)}
              style={{ cursor: 'pointer' }}
            >
              <rect x={paddingLeft + i * slot} y={paddingTop} width={slot} height={chartH} fill="transparent" />
              <path d={roundedTopRectPath(x, y, barW, barH, 4)} fill={d.color || color} opacity={isHover ? 1 : 0.85} />
              {labelIdx.has(i) && (
                <text
                  x={paddingLeft + i * slot + slot / 2}
                  y={height - paddingBottom + 14}
                  // Center labels never clip; the first/last would run past the
                  // viewBox edge if centered on their slot, so anchor those
                  // inward instead of letting the text overhang and get cut off.
                  textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                  fontSize="10"
                  fill="#64748b"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute px-2 py-1 rounded-md bg-gray-900 text-white text-xs shadow-lg whitespace-nowrap z-10"
          style={{ left: `${((hover + 0.5) / n) * 100}%`, top: 0, transform: 'translate(-50%, -110%)' }}
        >
          <div className="font-semibold">{data[hover].value.toLocaleString()}</div>
          <div className="text-gray-300">{data[hover].label}</div>
        </div>
      )}
    </div>
  );
}

export function LineChart({ data, color = ACCENT, height = 220 }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const width = 600;
  const paddingLeft = 40;
  const paddingBottom = 26;
  const paddingTop = 12;
  const paddingRight = 12;
  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;
  const n = data.length;
  const maxVal = niceMax(Math.max(1, ...data.map((d) => d.value)));

  const xAt = (i) => paddingLeft + (n <= 1 ? chartW / 2 : (i / (n - 1)) * chartW);
  const yAt = (v) => paddingTop + chartH - (v / maxVal) * chartH;

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(d.value)}`).join(' ');
  const areaPath = `${linePath} L${xAt(n - 1)},${paddingTop + chartH} L${xAt(0)},${paddingTop + chartH} Z`;
  const ticks = [0, maxVal / 2, maxVal];
  const labelIdx = useMemo(() => pickLabelIndices(n, 7), [n]);

  const handleMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * width;
    const idx = Math.max(0, Math.min(n - 1, Math.round(((px - paddingLeft) / chartW) * (n - 1))));
    setHoverIdx(idx);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleMove}
        onTouchMove={handleMove}
        role="img"
        aria-label="line chart"
      >
        {ticks.map((t, i) => {
          const y = yAt(t);
          return (
            <g key={i}>
              <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
              <text x={paddingLeft - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
                {Math.round(t).toLocaleString()}
              </text>
            </g>
          );
        })}
        <path d={areaPath} fill={color} opacity="0.1" stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map(
          (d, i) =>
            labelIdx.has(i) && (
              <text
                key={i}
                x={xAt(i)}
                y={height - paddingBottom + 14}
                // Same edge-anchoring as BarChart: a centered label on the last
                // point runs past the viewBox and gets clipped (this is exactly
                // what "Sep 11" did before), so anchor the end points inward.
                textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                fontSize="10"
                fill="#64748b"
              >
                {d.label}
              </text>
            )
        )}
        {hoverIdx !== null && (
          <>
            <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={paddingTop} y2={paddingTop + chartH} stroke="#cbd5e1" strokeWidth="1" />
            <circle cx={xAt(hoverIdx)} cy={yAt(data[hoverIdx].value)} r="4" fill={color} stroke="#ffffff" strokeWidth="2" />
          </>
        )}
      </svg>
      {hoverIdx !== null && data[hoverIdx] && (
        <div
          className="pointer-events-none absolute px-2 py-1 rounded-md bg-gray-900 text-white text-xs shadow-lg whitespace-nowrap z-10"
          style={{ left: `${(xAt(hoverIdx) / width) * 100}%`, top: 0, transform: 'translate(-50%, -110%)' }}
        >
          <div className="font-semibold">{data[hoverIdx].value.toLocaleString()} violations</div>
          <div className="text-gray-300">{data[hoverIdx].label}</div>
        </div>
      )}
    </div>
  );
}

// Speed distribution bars carry meaning through color (normal vs. over the
// limit), so a small legend spells that out in text too rather than leaving
// it to color alone.
export function SpeedLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-gray-500 -mt-1 mb-1">
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: NORMAL_SPEED_COLOR }} />
        Normal (&le; 100 km/h)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: OVERSPEED_COLOR }} />
        Overspeed (&gt; 100 km/h)
      </span>
    </div>
  );
}

// Card chrome shared by all four charts, plus the "View table" fallback the
// dataviz accessibility pass calls for — same numbers, no hover required.
export function ChartCard({ title, subtitle, tableColumns, tableData, children }) {
  const [showTable, setShowTable] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-gray-900 font-semibold text-base m-0">{title}</h3>
          {subtitle && <p className="text-gray-400 text-xs mt-1 m-0">{subtitle}</p>}
        </div>
        <button
          onClick={() => setShowTable((s) => !s)}
          className="text-xs font-medium text-gray-500 hover:text-amber-600 border border-gray-200 hover:border-amber-300 rounded-md px-2 py-1 transition-colors whitespace-nowrap"
        >
          {showTable ? 'View chart' : 'View table'}
        </button>
      </div>

      {showTable ? (
        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500 text-xs uppercase border-b border-gray-200 sticky top-0 bg-white">
              <tr>
                {tableColumns.map((c) => (
                  <th key={c} className="py-2 pr-4">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-gray-900">
              {tableData.map((row, i) => (
                <tr key={i} className="border-b border-gray-100">
                  {row.map((cell, j) => (
                    <td key={j} className="py-2 pr-4">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export default function ReportCharts() {
  const [violations, setViolations] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error

  useEffect(() => {
    fetch('/api/violations')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setViolations(data.violations || []);
        setStatus('ready');
      })
      .catch((err) => {
        console.error('Report charts: failed to load /api/violations', err);
        setStatus('error');
      });
  }, []);

  const byDay = useMemo(() => buildDaySeries(violations, 14), [violations]);
  const bySpeed = useMemo(() => buildSpeedBuckets(violations), [violations]);
  const byLane = useMemo(() => buildLaneCounts(violations), [violations]);
  const byHour = useMemo(() => buildHourCounts(violations), [violations]);

  if (status === 'loading') {
    return <div className="text-gray-500 text-center py-16">Loading report data…</div>;
  }
  if (status === 'error') {
    return <div className="text-red-500 text-center py-16">Could not load violation data for the report charts.</div>;
  }

  return (
    <section className="bg-gray-50">
      {violations.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-3 mb-6 text-gray-500 text-sm">
          No violation records yet — charts below will fill in once violations are logged.
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard
          title="Lane violations over time"
          subtitle="Confirmed violations per day, last 14 days"
          tableColumns={['Date', 'Violations']}
          tableData={byDay.map((d) => [d.label, d.value])}
        >
          <LineChart data={byDay} color={VIOLATIONS_VOLUME_COLOR} />
        </ChartCard>

        <ChartCard
          title="Speed distribution"
          subtitle="Recorded speed at time of violation (km/h)"
          tableColumns={['Speed range (km/h)', 'Count']}
          tableData={bySpeed.map((d) => [d.label, d.value])}
        >
          <SpeedLegend />
          <BarChart data={bySpeed} sparseLabels />
        </ChartCard>

        <ChartCard
          title="Truck Count by Lane"
          subtitle="Violations per monitored camera / lane (all 15 active cameras)"
          tableColumns={['Camera / lane', 'Count']}
          tableData={byLane.map((d) => [d.label, d.value])}
        >
          <BarChart data={byLane} sparseLabels />
        </ChartCard>

        <ChartCard
          title="Truck detection by time of the day"
          subtitle="Violations by hour of day, local time"
          tableColumns={['Hour', 'Count']}
          tableData={byHour.map((d) => [d.label, d.value])}
        >
          <BarChart data={byHour} sparseLabels />
        </ChartCard>
      </div>
    </section>
  );
}
