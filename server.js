/**
 * Node server: serves the built React app and the lightweight REST routes.
 *
 *   GET /camera.json            master CCTV list (metadata for the camera info panel)
 *   GET /api/health             database connectivity check
 *   GET /api/violations         violation records for Evidence & History and the charts
 *   GET /cctv/:cameraId/:file   same-origin proxy for the cameras' HTTP-only HLS streams
 *
 * Detection, ROI and admin routes live in the Python server (scripts/live_server.py).
 */
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

// Master CCTV list (112 cameras); src/cameras.js is a curated subset of it. It lives at the
// repo root rather than public/, so it is served explicitly - and must be registered before
// the SPA catch-all below, which would otherwise answer with index.html.
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

// CCTV proxy. The camera servers are plain HTTP, which browsers block as mixed content on
// an HTTPS page, so streams are relayed through this same-origin route.
//
// HLS playlists reference their sub-playlists and .ts segments by relative filename, so this
// one route serves all three without rewriting. Only cameras listed in src/cameras.js can be
// proxied (it is not an open proxy).
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

  // `timeout` is the maximum silence (no bytes received), not total time. Segments are ~10s
  // of video and the camera server often takes 10-15s to deliver one, with pauses.
  const upstreamReq = http.get(base + request.params.file, { timeout: 20000 }, (upstreamRes) => {
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
    // Live playlists and segments change constantly: never cache them.
    response.setHeader("Cache-Control", "no-store");
    upstreamRes.pipe(response);
  });
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
  upstreamReq.on("error", (error) => {
    console.error(`[cctv-proxy] ${request.params.cameraId}/${request.params.file}:`, error.message);
    if (!response.headersSent) response.status(502).end("Camera stream unreachable");
    else response.destroy(); // failed mid-segment: abort so the player retries instead of hanging
  });
  // Viewer left (camera switched, tab closed): stop the download to save upstream bandwidth.
  response.on("close", () => {
    if (!response.writableFinished) upstreamReq.destroy();
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
