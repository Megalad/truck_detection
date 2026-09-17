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
        "**/public/evidence_videos/**",
        "**/public/recorded_videos/**",
      ],
    },
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
