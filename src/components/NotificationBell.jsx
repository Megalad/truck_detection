// Violation alert UI: the header bell with its alert list, and the pop-up toast.
import { useEffect, useRef, useState } from 'react';
import { CAMERAS } from '../cameras';
import { useAlerts, markAllRead, clearAlerts, TOAST_MS } from '../alerts';

const cameraTitle = (id) => CAMERAS.find((c) => c.id === id)?.title || id;
const timeStr = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const BellIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

// Header bell: unread badge + dropdown of recent alerts. Opening it marks them read;
// clicking an alert calls onSelect(cameraId) so the app can jump to that camera.
export function NotificationBell({ onSelect }) {
  const { alerts, unread } = useAlerts();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const toggle = () => {
    if (!open) markAllRead();
    setOpen(!open);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        aria-label={unread ? `${unread} new violation alerts` : 'Violation alerts'}
        className="relative p-2 rounded-full text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      >
        <BellIcon className="w-6 h-6" />
        {/* Small badge on the bell's top-right corner, ringed white so it never hides the icon */}
        {unread > 0 && (
          <span className="absolute top-1 right-1 translate-x-1/3 -translate-y-1/3 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] leading-none font-bold flex items-center justify-center ring-2 ring-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-[min(22rem,calc(100vw-2rem))] bg-white rounded-xl shadow-2xl border border-gray-200 z-[90] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <strong className="text-gray-900 text-sm">Violation alerts</strong>
            <div className="flex items-center gap-3 text-xs">
              {alerts.length > 0 && (
                <button onClick={clearAlerts} className="text-amber-600 hover:text-amber-700 font-semibold">Clear</button>
              )}
            </div>
          </div>
          {alerts.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">
              No alerts yet. Alerts appear here for cameras open on this page.
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y divide-gray-100">
              {alerts.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => { setOpen(false); onSelect?.(a.cameraId); }}
                    className="w-full flex gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                  >
                    {a.snapshot ? (
                      <img src={a.snapshot} alt="" className="w-20 h-12 object-cover rounded bg-gray-100 shrink-0" />
                    ) : (
                      <div className="w-20 h-12 rounded bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                        <BellIcon className="w-5 h-5" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">{cameraTitle(a.cameraId)}</div>
                      <div className="text-xs text-red-600">Restricted-lane violation</div>
                      <div className="text-xs text-gray-500">{timeStr(a.time)}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Top-right toast for the newest alert, shown for TOAST_MS. Click to jump to the camera.
export function AlertToast({ onSelect }) {
  const { alerts } = useAlerts();
  const latest = alerts[0];
  const [shownId, setShownId] = useState(null);
  const [mountedAt] = useState(Date.now);

  useEffect(() => {
    // Only toast alerts that arrive while the page is open, not ones restored from storage.
    if (!latest || latest.time < mountedAt) return undefined;
    setShownId(latest.id);
    const t = setTimeout(() => setShownId(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [latest, mountedAt]);

  if (!latest || shownId !== latest.id) return null;
  return (
    <button
      onClick={() => { setShownId(null); onSelect?.(latest.cameraId); }}
      className="fixed top-4 right-4 z-[95] flex items-center gap-3 max-w-[calc(100vw-2rem)] rounded-xl px-4 py-3 text-left bg-red-600 hover:bg-red-700 text-white shadow-lg transition-colors alert-toast-in"
    >
      <BellIcon className="w-5 h-5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold">Violation detected</span>
        <span className="block text-xs text-white/80 truncate">{cameraTitle(latest.cameraId)} · {timeStr(latest.time)}</span>
      </span>
    </button>
  );
}
