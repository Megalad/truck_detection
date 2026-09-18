import { useEffect, useMemo, useState } from 'react';
import {
  ChartCard,
  LineChart,
  BarChart,
  SpeedLegend,
  buildDaySeries,
  buildSpeedBuckets,
  buildHourCounts,
  VIOLATIONS_VOLUME_COLOR,
} from './ReportCharts';

// Per-camera version of the Report Chart tab's charts, scoped to this one
// camera_location so it's meaningful sitting directly under that camera's
// video instead of the aggregate-across-all-cameras view.
export default function CameraCharts({ cameraId }) {
  const [violations, setViolations] = useState([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    const fetchData = () => {
      fetch('/api/violations')
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          setViolations((data.violations || []).filter((v) => v.camera_location === cameraId));
          setStatus('ready');
        })
        .catch((err) => {
          console.error('Camera charts: failed to load /api/violations', err);
          setStatus('error');
        });
    };
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [cameraId]);

  const byDay = useMemo(() => buildDaySeries(violations, 14), [violations]);
  const bySpeed = useMemo(() => buildSpeedBuckets(violations), [violations]);
  const todaysViolations = useMemo(() => {
    const now = new Date();
    return violations.filter((v) => {
      const d = new Date(v.timestamp);
      return (
        !Number.isNaN(d.getTime()) &&
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    });
  }, [violations]);
  const byHour = useMemo(() => buildHourCounts(todaysViolations), [todaysViolations]);

  if (status === 'loading') {
    return <div className="text-gray-500 text-center py-10 text-sm">Loading charts…</div>;
  }
  if (status === 'error') {
    return <div className="text-red-500 text-center py-10 text-sm">Could not load chart data.</div>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {violations.length === 0 && (
        <div className="sm:col-span-2 bg-white border border-gray-200 rounded-xl px-5 py-3 text-gray-500 text-sm">
          No violation records yet for this camera.
        </div>
      )}
      <ChartCard
        title="Violations over time"
        subtitle="Confirmed violations per day, last 14 days"
        tableColumns={['Date', 'Violations']}
        tableData={byDay.map((d) => [d.label, d.value])}
      >
        <LineChart data={byDay} height={180} color={VIOLATIONS_VOLUME_COLOR} />
      </ChartCard>

      <ChartCard
        title="Speed distribution"
        subtitle="Recorded speed at time of violation (km/h)"
        tableColumns={['Speed range (km/h)', 'Count']}
        tableData={bySpeed.map((d) => [d.label, d.value])}
      >
        <SpeedLegend />
        <BarChart data={bySpeed} height={180} />
      </ChartCard>

      <div className="sm:col-span-2">
        <ChartCard
          title="Violations by time of day"
          subtitle="Confirmed violations by hour, today, local time"
          tableColumns={['Hour', 'Violations']}
          tableData={byHour.map((d) => [d.label, d.value])}
        >
          {violations.length > 0 && todaysViolations.length === 0 ? (
            <div className="text-gray-500 text-center py-10 text-sm">No violations recorded yet today.</div>
          ) : (
            <BarChart data={byHour} height={180} sparseLabels />
          )}
        </ChartCard>
      </div>
    </div>
  );
}
