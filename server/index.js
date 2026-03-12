import express from "express";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearRouteCache, runMatch } from "./matcher.js";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 5050;

const DATA_DIR = "/Users/palash/Desktop/Railways Project/data";
const OUTPUT_PATH = path.join(DATA_DIR, "annotation.geojson");
const BUILD_SCRIPT = path.join(DATA_DIR, "scripts", "build_datameet_routes.mjs");

app.use(express.json({ limit: "10mb" }));

app.post("/api/annotation", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || payload.type !== "Feature" || !payload.geometry) {
      return res.status(400).json({ error: "Invalid GeoJSON" });
    }

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload));
    return res.json({ ok: true, path: OUTPUT_PATH });
  } catch {
    return res.status(500).json({ error: "Failed to save annotation" });
  }
});

app.post("/api/build-dataset", async (_req, res) => {
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
