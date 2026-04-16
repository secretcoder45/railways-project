import express from "express";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearRouteCache, runMatch } from "./matcher.js";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 5050;

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), "runtime_data");
const OUTPUT_PATH = process.env.ANNOTATION_PATH || path.join(DATA_ROOT, "annotation.geojson");
const BUILD_SCRIPT = process.env.BUILD_SCRIPT || path.join(DATA_ROOT, "scripts", "build_datameet_routes.mjs");
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "railways-matcher" });
});

app.post("/api/annotation", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || payload.type !== "Feature" || !payload.geometry) {
      return res.status(400).json({ error: "Invalid GeoJSON" });
    }

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload));
    return res.json({ ok: true, path: OUTPUT_PATH });
  } catch {
    return res.status(500).json({ error: "Failed to save annotation" });
  }
});

app.post("/api/build-dataset", async (_req, res) => {
  try {
    await fs.access(BUILD_SCRIPT);
  } catch {
    return res.status(400).json({ error: "Dataset build script not found", build_script: BUILD_SCRIPT });
  }

  try {
    const { stdout } = await execFileAsync("node", [BUILD_SCRIPT]);
    clearRouteCache();
    return res.json({ ok: true, message: stdout.trim() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to build datameet dataset", details: err.message });
  }
});

app.post("/api/match", async (req, res) => {
  try {
    const annotation = req.body?.annotation || req.body;
    const result = await runMatch(annotation);
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to match" });
  }
});

app.post("/api/match-last", async (_req, res) => {
  try {
    const annotationRaw = JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
    const result = await runMatch(annotationRaw);
    return res.json({ ok: true, result, annotation_path: OUTPUT_PATH });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to match last annotation" });
  }
});

app.listen(PORT, () => {
  // server ready
});
