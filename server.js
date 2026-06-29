import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3001;
const uploadsPath = path.join(__dirname, "uploads");
const outputsPath = path.join(__dirname, "outputs");
const localPythonPath = path.join(__dirname, ".venv", "bin", "python");
const pythonBin = fs.existsSync(localPythonPath) ? localPythonPath : "python3";
const modelPaths = {
  model_1: path.join(__dirname, "model_v1.pt"),
  model_2: path.join(__dirname, "model_v2.pt"),
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

app.post("/api/infer", upload.single("video"), (request, response) => {
  const selectedModel = request.body.model || "model_2";
  const modelPath = modelPaths[selectedModel];

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
    selectedModel === "model_2" ? "0.40" : "0.35",
    "--device",
    process.env.YOLO_DEVICE || "cpu",
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
