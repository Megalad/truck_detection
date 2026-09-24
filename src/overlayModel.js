// Per-camera detection-model choice for the admin box-vs-segmentation comparison:
// "box" = production model on /ws (default), "seg" = experimental model on the isolated
// /ws-test endpoint (never files violations). Shared so the camera's ⋮ menu, the compact
// on-video toggle and the "SEG TEST" badge stay in sync. In-memory only on purpose: a
// page reload always returns every camera to the production model.
import { useSyncExternalStore } from 'react';

const models = {}; // cameraId -> 'box' | 'seg'
const listeners = new Set();

export function setOverlayModel(cameraId, model) {
  if ((models[cameraId] || 'box') === model) return;
  models[cameraId] = model;
  listeners.forEach((l) => l());
}

export function useOverlayModel(cameraId) {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => models[cameraId] || 'box',
  );
}
