import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import multer from "multer";
import mysql from "mysql2/promise";
import { CAMERAS } from "./src/cameras.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3001;
const uploadsPath = path.join(__dirname, "uploads");
const outputsPath = path.join(__dirname, "outputs");
const calibrationPath = path.join(__dirname, "public", "calibration_results");
const localPythonPath = path.join(__dirname, ".venv", "bin", "python");
const pythonBin = fs.existsSync(localPythonPath) ? localPythonPath : "python3";
const modelPaths = {
  model_1: path.join(__dirname, "models", "model_v1.pt"),
  model_2: path.join(__dirname, "models", "model_v2.pt"),
  model_current: path.join(__dirname, "models", "model_v6.pt"),
};

fs.mkdirSync(uploadsPath, { recursive: true });
fs.mkdirSync(outputsPath, { recursive: true });

const upload = multer({
  dest: uploadsPath,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype === "video/mp4") {
      callback(null, true);
      return;
    }

    callback(new Error("Only MP4 videos are supported."));
  },
});

app.use(express.json());
app.use("/outputs", express.static(outputsPath));
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

app.get("/api/models", (_request, response) => {
  const models = Object.entries(modelPaths).map(([id, filePath]) => {
    const fileName = path.basename(filePath);
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    return {
      id,
      fileName,
      available: Boolean(stats),
      sizeMb: stats ? Number((stats.size / 1024 / 1024).toFixed(2)) : null,
    };
  });

  response.json({ models });
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

app.post("/api/infer", upload.single("video"), (request, response) => {
  const selectedModel = request.body.model || "model_current";
  const modelPath = modelPaths[selectedModel];
  const roi = typeof request.body.roi === "string" && request.body.roi.length > 0 ? request.body.roi : null;

  if (!modelPath || !fs.existsSync(modelPath)) {
    if (request.file?.path) fs.rmSync(request.file.path, { force: true });
    response.status(400).json({ error: "Selected model is not available." });
    return;
  }

  if (!request.file) {
    response.status(400).json({ error: "Upload an MP4 video before running inference." });
    return;
  }

  const jobId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const inputPath = path.join(uploadsPath, `${jobId}.mp4`);
  const outputName = `${jobId}-enforcement.mp4`;
  const outputPath = path.join(outputsPath, outputName);

  fs.renameSync(request.file.path, inputPath);

  const worker = spawn(pythonBin, [
    path.join(__dirname, "scripts", "run_inference.py"),
    "--model",
    modelPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--fps",
    "30",
    "--threshold-seconds",
    "5",
    "--conf",
    "0.5",
    "--device",
    process.env.YOLO_DEVICE || "auto",
    ...(roi ? ["--roi", roi] : []),
  ]);

  let stdout = "";
  let stderr = "";

  worker.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  worker.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  worker.on("close", (code) => {
    fs.rmSync(inputPath, { force: true });

    if (code !== 0 || !fs.existsSync(outputPath)) {
      response.status(500).json({
        error: "Inference failed. Check Python dependencies and model compatibility.",
        details: stderr || stdout,
      });
      return;
    }

    response.json({
      ok: true,
      model: selectedModel,
      outputUrl: `/outputs/${outputName}`,
      log: stdout.trim(),
    });
  });
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
