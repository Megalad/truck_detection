import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // Vite always treats files under publicDir ("public/") as static assets
      // and fires a full-page reload whenever one changes — even though these
      // four subfolders are runtime output written by the Python/Express
      // backends (calibration snapshots, evidence media), not app source. Left
      // unignored, saving a new file here (e.g. auto-calibration writing
      // "<camera>_vp.jpg" the moment it finishes) can trigger a reload right as
      // the frontend is mid-fetch for that very file — showing a broken image
      // instead of the calibration result. .venv/uploads/outputs were already
      // ignored; the public/ ones were the gap.
      ignored: [
        "**/.venv/**",
        "**/uploads/**",
        "**/outputs/**",
        "**/public/calibration_results/**",
        "**/public/evidence_snapshots/**",
        "**/public/recorded_videos/**",
      ],
    },
    proxy: {
      // A handful of /api/* routes are actually implemented on the Python server
      // (scripts/live_server.py), not the Node one - admin login/logout and
      // recorded-video processing. Production nginx.conf already carves these out
      // (location ~ ^/api/(process_recorded|admin/login|admin/logout)$); this dev
      // proxy needs the same exceptions, listed before the generic "/api"
      // catch-all below so they take precedence. Without this, e.g. adminAuth.js's
      // fetch('/api/admin/login') goes to Node instead, which has no such route -
      // Express's default 404 on an unmatched POST, not the Python error you'd expect.
      "/api/admin/login": "http://localhost:8000",
      "/api/violations/": "http://localhost:8000", // DELETE one record (GET /api/violations stays on Node)
      "/api/admin/logout": "http://localhost:8000",
      "/api/process_recorded": "http://localhost:8000",
      "/api/detect_demo": "http://localhost:8000",
      "/api": "http://localhost:3001",
      // Runtime-written media (see the `ignored` comment above for why these
      // can't be trusted to Vite's own public-dir serving): proxied straight
      // to the Python backend, which mounts and reads them live per request.
      "/evidence_snapshots": "http://localhost:8000",
      "/recorded_videos": "http://localhost:8000",
      // CCTV playlists/segments (server.js's /cctv/:cameraId/:file proxy).
      // Without this, a request like /cctv/TV03CL2/playlist.m3u8 doesn't match
      // any proxy entry, so Vite's own SPA fallback answers with index.html
      // instead (200 OK, but text/html) - the player silently gets a webpage
      // instead of a stream and never plays. Only breaks the dev server;
      // production nginx already has no such gap (it proxies "/" wholesale).
      "/cctv": "http://localhost:3001",
    },
  },
});
