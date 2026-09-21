// Replay ("Plan B") mode: each camera can play a local recording, public/demo/<cameraId>.mp4,
// in place of its CCTV stream. The frames still go through the same WebSocket / detection /
// evidence pipeline as live, so everything downstream behaves identically; only the video source
// changes (and the badge says REPLAY, not LIVE).
import { useSyncExternalStore } from 'react';

const KEY = 'replayMode';
const listeners = new Set();

const read = () => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
};
let state = read();

export function setReplayMode(on) {
  state = Boolean(on);
  try { localStorage.setItem(KEY, state ? '1' : '0'); } catch { /* private mode etc. */ }
  listeners.forEach((l) => l());
}

export function useReplayMode() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

export const demoClipUrl = (cameraId) => `/demo/${cameraId}.mp4`;

// A missing file is usually answered with index.html (SPA fallback, HTTP 200), so check the type.
export async function demoClipExists(cameraId) {
  try {
    const res = await fetch(demoClipUrl(cameraId), { method: 'HEAD' });
    return res.ok && (res.headers.get('content-type') || '').startsWith('video/');
  } catch {
    return false;
  }
}
