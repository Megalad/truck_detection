import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { CAMERAS } from "./src/cameras.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3001;
const calibrationPath = path.join(__dirname, "public", "calibration_results");

app.use(express.json());
app.use("/calibration_results", express.static(calibrationPath));

// The org's master CCTV list (112 cameras) - src/cameras.js's curated subset is derived from
// it, and FocusView reads it directly for each camera's route/km/coordinates metadata. It's a
// repo-root file, not in public/, so Vite's build doesn't pick it up automatically - serve it
// explicitly (and before the SPA catch-all below, or that would swallow this route and hand
// back index.html instead - which is exactly what was happening: a 200 of HTML, not JSON, so
// the fetch silently failed and "Loading camera details from JSON..." never went away).
const cameraJsonPath = path.join(__dirname, "camera.json");
app.get("/camera.json", (_request, response) => {
  if (!fs.existsSync(cameraJsonPath)) {
    response.status(404).json({ error: "camera.json not found" });
    return;
  }
  response.sendFile(cameraJsonPath);
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "section-35-enforcement-api",
    timestamp: new Date().toISOString(),
  });
});

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '12345678',
  database: 'section35_db'
};

app.get("/api/violations", async (request, response) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    connection.on('error', function(err) {
      console.error('Database connection error:', err);
    });

    const [rows] = await connection.execute('SELECT * FROM violations ORDER BY timestamp DESC');
    await connection.end();
    response.json({ violations: rows });
  } catch (error) {
    console.error("Database Fetch Error:", error);
    response.status(500).json({ error: "Failed to fetch violations" });
  }
});

// CCTV proxy: the camera servers are plain HTTP (http://1.4.213.19:...). Fetching that
// directly from the browser works fine when the page itself is loaded over HTTP, but once
// the site is reached over HTTPS (e.g. https://dodovision.me via Cloudflare) browsers
// silently block it as "mixed content" - the <video> just never loads, no visible error.
// Routing the stream through this same-origin endpoint instead fixes that for both cases.
//
// Every camera's HLS playlist/segment references the next file by a bare relative filename
// (checked against the live streams; no absolute URLs anywhere in them), so the browser
// resolves "chunklist_x.m3u8" or "media_x_1.ts" against wherever it fetched the current file
// from - meaning this one route, unmodified, transparently serves the master playlist, the
// sub-playlist it points to, AND the .ts segments the sub-playlist points to. No playlist
// rewriting needed. cameraBaseUrls comes from src/cameras.js (the same list the Live
// Monitoring grid uses), so this can only ever proxy a camera already on that list, not an
// arbitrary host - it's not an open proxy.
const cameraBaseUrls = Object.fromEntries(
  CAMERAS.filter((c) => c.url.endsWith("playlist.m3u8")).map((c) => [c.id, c.url.slice(0, -"playlist.m3u8".length)])
);
const CCTV_FILENAME_RE = /^[A-Za-z0-9_.-]+\.(m3u8|ts)$/;

app.get("/cctv/:cameraId/:file", (request, response) => {
  const base = cameraBaseUrls[request.params.cameraId];
  if (!base) {
    response.status(404).end("Unknown camera");
    return;
  }
  if (!CCTV_FILENAME_RE.test(request.params.file)) {
    response.status(400).end("Bad filename");
    return;
  }

  const upstreamReq = http.get(base + request.params.file, { timeout: 8000 }, (upstreamRes) => {
    if (upstreamRes.statusCode !== 200) {
      response.status(502).end("Camera stream unavailable");
      upstreamRes.resume();
      return;
    }
    response.setHeader(
      "Content-Type",
      upstreamRes.headers["content-type"] ||
        (request.params.file.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl")
    );
    // Playlists and segments are both short-lived (a live stream, not a fixed asset) -
    // never let the browser/CDN reuse a stale one.
    response.setHeader("Cache-Control", "no-store");
    upstreamRes.pipe(response);
  });
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", (error) => {
    console.error(`[cctv-proxy] ${request.params.cameraId}/${request.params.file}:`, error.message);
    if (!response.headersSent) response.status(502).end("Camera stream unreachable");
  });
});

const distPath = path.join(__dirname, "dist");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Section 35 Node server running on http://localhost:${port}`);
});
