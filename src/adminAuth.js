// Single shared admin session (one operator role, not per-person accounts - see
// scripts/live_server.py's /api/admin/login). Editing an ROI requires this; viewing the
// ROI another admin (or a previous session) saved does not - that comes from the server
// over the camera's own websocket (CURRENT_ROI), same for every viewer.
//
// The token lives in sessionStorage: it survives a page refresh (so the operator isn't
// forced to re-login mid-demo) but not a closed tab or a different device/browser - a
// stranger on their own laptop starts logged out, same as anyone else.
import { useSyncExternalStore } from 'react';

const KEY = 'adminSession'; // sessionStorage: {token, expires_at}
const listeners = new Set();

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.token || !session?.expires_at || Date.now() / 1000 > session.expires_at) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

let state = read();

function setState(session) {
  state = session;
  try {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode etc. */ }
  listeners.forEach((l) => l());
}

export function useAdminSession() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

export function getAdminToken() {
  return state?.token || null;
}

// Throws with a message safe to show the user (the server's own detail string, e.g.
// "Incorrect username or password" or "Admin login is not configured").
export async function adminLogin(username, password) {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail || `Login failed (HTTP ${res.status}).`);
  setState({ token: data.token, expires_at: data.expires_at, username });
}

export function adminLogout() {
  const token = state?.token;
  setState(null);
  if (token) {
    fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => {}); // best effort - the client-side session is already cleared either way
  }
}

// Shared sign-in modal requests. AdminLoginModal.jsx renders a single modal at the App level;
// any component calls requestAdminLogin(onSuccess, contextLabel) to open it. onSuccess runs
// after a successful sign-in - or immediately, with no modal, if already signed in.
let pendingRequest = null; // { onSuccess, contextLabel } | null
const requestListeners = new Set();

function setPendingRequest(next) {
  pendingRequest = next;
  requestListeners.forEach((l) => l());
}

export function useAdminLoginRequest() {
  return useSyncExternalStore(
    (cb) => { requestListeners.add(cb); return () => requestListeners.delete(cb); },
    () => pendingRequest,
  );
}

// contextLabel: shown in the modal, e.g. "the restricted-lane region for TV03CL2".
export function requestAdminLogin(onSuccess, contextLabel) {
  if (getAdminToken()) { onSuccess(); return; } // already signed in - skip the modal entirely
  setPendingRequest({ onSuccess, contextLabel });
}

// Called by AdminLoginModal on Cancel, or right after a successful sign-in (once it has
// already run the pending request's onSuccess itself).
export function clearAdminLoginRequest() {
  setPendingRequest(null);
}
