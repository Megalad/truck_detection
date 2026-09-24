import { useSyncExternalStore } from 'react';

// One shared store for on-page violation alerts: the header bell (list + unread badge),
// the toast and the tab-title counter all read it.
// LiveCCTVPlayer calls pushAlert() when the server sends VIOLATION_ALERT. Alerts come
// only from cameras open in this tab (the browser is what feeds frames to detection).

const STORAGE_KEY = 'violationAlerts';
const MAX_ALERTS = 50;
export const TOAST_MS = 5000;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.alerts)) {
      return { alerts: saved.alerts, unread: saved.unread || 0 };
    }
  } catch { /* private mode / bad JSON - start empty */ }
  return { alerts: [], unread: 0 };
}

let state = load();
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ alerts: state.alerts, unread: state.unread }));
  } catch { /* storage unavailable - alerts still work for this page load */ }
  listeners.forEach((l) => l());
}

export function useAlerts() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

export function pushAlert({ cameraId, message, snapshot }) {
  const now = Date.now();
  const alert = { id: `${now}-${cameraId}`, cameraId, message, snapshot: snapshot || '', time: now };
  setState({
    alerts: [alert, ...state.alerts].slice(0, MAX_ALERTS),
    unread: state.unread + 1,
  });
}

export const markAllRead = () => setState({ unread: 0 });
export const clearAlerts = () => setState({ alerts: [], unread: 0 });

// Dev only (stripped from production builds): fake an alert from the browser console,
// e.g. __testViolation('TV27CL1'), to check the bell and toast without a real truck.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__testViolation = (cameraId = 'TV27CL1') =>
    pushAlert({ cameraId, message: 'Test violation', snapshot: '' });
}
