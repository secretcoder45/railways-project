/**
 * build-routes.mjs
 *
 * Reads trains.json, stations.json, and schedules.json and produces a compact
 * prebuilt_routes.json that the matcher can load directly.
 *
 * schedules.json is ~130 MB, so we stream-parse it to avoid the peak memory
 * spike of JSON.parse (string + parsed objects ≈ 330 MB).
 */

import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";

const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), "runtime_data");
const rawTrainsFile = process.env.RAW_TRAINS_FILE || path.join(dataRoot, "trains.json");
const rawStationsFile = process.env.RAW_STATIONS_FILE || path.join(dataRoot, "stations.json");
const rawSchedulesFile = process.env.RAW_SCHEDULES_FILE || path.join(dataRoot, "schedules.json");
const prebuiltFile = process.env.PREBUILT_ROUTES_FILE || path.join(dataRoot, "prebuilt_routes.json");

const MAP_BOUNDS = {
  minLon: 68.18624878,
  minLat: 6.75425577,
  maxLon: 97.41516113,
  maxLat: 35.50133133,
};

const RESAMPLE_POINTS = 200;

/* ── Geometry helpers (same as matcher.js) ──────────────────────── */

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function lonLatToNorm(coord) {
  const [lon, lat] = coord;
  const x = (lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon);
  const y = (MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  return [+clamp01(x).toFixed(6), +clamp01(y).toFixed(6)];
}

function euclidean(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function lineLength(points) {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) sum += euclidean(points[i], points[i + 1]);
  return sum;
}

function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function resampleLine(points, n) {
  if (!points.length) return [];
  if (points.length === 1) return Array.from({ length: n }, () => points[0]);

  const dists = [0];
  for (let i = 0; i < points.length - 1; i++) {
    dists.push(dists[dists.length - 1] + euclidean(points[i], points[i + 1]));
  }

  const total = dists[dists.length - 1];
  if (total === 0) return Array.from({ length: n }, () => points[0]);

  const step = total / (n - 1);
  const out = [points[0]];
  let target = step;
  let idx = 1;

  while (out.length < n - 1) {
    while (idx < dists.length && dists[idx] < target) idx++;
    if (idx >= points.length) break;

    const prev = points[idx - 1];
    const curr = points[idx];
    const prevD = dists[idx - 1];
    const currD = dists[idx];

    if (currD === prevD) {
      out.push(curr);
    } else {
      const t = (target - prevD) / (currD - prevD);
      out.push([
        +(prev[0] + (curr[0] - prev[0]) * t).toFixed(6),
        +(prev[1] + (curr[1] - prev[1]) * t).toFixed(6),
      ]);
    }
    target += step;
  }

  out.push(points[points.length - 1]);
  while (out.length < n) out.push(points[points.length - 1]);
  return out;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function routeLengthKm(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) total += haversineKm(coords[i], coords[i + 1]);
  return total;
}

function parseTimeMin(value) {
  if (!value || value === "None") return null;
  const [hh, mm] = String(value).split(":");
  const h = Number(hh);
  const m = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function scheduleSortKey(s) {
  const day = Number(s.day) || 1;
  const arr = parseTimeMin(s.arrival);
  const dep = parseTimeMin(s.departure);
  const tm = arr != null && dep != null ? Math.min(arr, dep) : arr ?? dep ?? 1e9;
  return day * 2000 + tm;
}

/* ── Streaming JSON array parser ───────────────────────────────── */

/**
 * Yields one parsed JS object at a time from a JSON file that contains
 * a top-level array of objects: [{...}, {...}, ...].
 * Peak memory: O(single_object_json_length) instead of O(entire_file).
 */
async function* streamJsonArray(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let partial = "";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (esc) {
        if (depth > 0) partial += ch;
        esc = false;
        continue;
      }
      if (ch === "\\" && inStr) {
        if (depth > 0) partial += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        if (depth > 0) partial += ch;
        continue;
      }
      if (inStr) {
        if (depth > 0) partial += ch;
        continue;
      }

      if (ch === "{") {
        depth++;
        partial += ch;
        continue;
      }
      if (ch === "}") {
        partial += ch;
        depth--;
        if (depth === 0) {
          yield JSON.parse(partial);
          partial = "";
        }
        continue;
      }

      if (depth > 0) partial += ch;
    }
  }
}

/* ── Main build ────────────────────────────────────────────────── */

export async function buildPrebuiltRoutes() {
  // Skip if already built
  try {
    const st = await fs.stat(prebuiltFile);
    if (st.isFile() && st.size > 1024 * 1024) {
      console.log(`[build-routes] prebuilt routes already present: ${prebuiltFile} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
      return;
    }
  } catch {
    // file doesn't exist — proceed with build
  }

  console.log("[build-routes] loading trains.json ...");
  const trainsGeo = JSON.parse(await fs.readFile(rawTrainsFile, "utf8"));

  console.log("[build-routes] loading stations.json ...");
  const stationsGeo = JSON.parse(await fs.readFile(rawStationsFile, "utf8"));

  // Build station lookup
  const stationByCode = new Map();
  for (const f of stationsGeo.features || []) {
    const code = f?.properties?.code;
    const c = f?.geometry?.coordinates;
    if (!code || !Array.isArray(c) || c.length < 2) continue;
    stationByCode.set(code, {
      code,
      name: f.properties?.name || code,
      lat: c[1],
      lon: c[0],
    });
  }

  // Build train metadata lookup
  const trainByNo = new Map();
  for (const f of trainsGeo.features || []) {
    const p = f?.properties || {};
    if (!p.number) continue;
    trainByNo.set(String(p.number), p);
  }

  // Stream schedules — group by train number
  console.log("[build-routes] streaming schedules.json ...");
  const schedulesByTrain = new Map();
  let recordCount = 0;

  for await (const s of streamJsonArray(rawSchedulesFile)) {
    const no = String(s.train_number || "").trim();
    if (!no) continue;
    if (!schedulesByTrain.has(no)) schedulesByTrain.set(no, []);
    // Keep only needed fields to save memory
    schedulesByTrain.get(no).push({
      station_code: s.station_code,
      station_name: s.station_name,
      day: s.day,
      arrival: s.arrival,
      departure: s.departure,
    });
    recordCount++;
    if (recordCount % 100000 === 0) {
      console.log(`[build-routes]   ... ${recordCount} schedule records streamed`);
    }
  }
  console.log(`[build-routes] ${recordCount} schedule records across ${schedulesByTrain.size} trains`);

  // Build routes
  console.log("[build-routes] building route index ...");
  const routes = [];

  for (const [trainNo, list] of schedulesByTrain.entries()) {
    list.sort((a, b) => scheduleSortKey(a) - scheduleSortKey(b));

    const stations = [];
    const coords = [];
    let prevCode = null;

    for (const s of list) {
      const code = s.station_code;
      if (!code || code === prevCode) continue;
      prevCode = code;
      const st = stationByCode.get(code);
      if (!st) continue;

      stations.push({
        seq: stations.length + 1,
        code,
        name: s.station_name || st.name,
        lat: st.lat,
        lon: st.lon,
        day: s.day,
        arrival: s.arrival,
        departure: s.departure,
      });
      coords.push([st.lon, st.lat]);
    }

    if (coords.length < 2) continue;

    const p = trainByNo.get(trainNo) || {};
    const routeLenKm = Number(p.distance) > 0 ? Number(p.distance) : routeLengthKm(coords);

    const normRoute = coords.map(lonLatToNorm);
    const sampledNorm = resampleLine(normRoute, RESAMPLE_POINTS);

    routes.push({
      train_no: trainNo,
      train_name: p.name || list[0]?.station_name || `Train ${trainNo}`,
      train_type: p.type || null,
      route_length_km: +routeLenKm.toFixed(1),
      station_count: stations.length,
      route_line: coords.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]),
      stations,
      sampled_norm_200: sampledNorm,
      bbox_norm: bbox(sampledNorm),
      length_norm: +lineLength(sampledNorm).toFixed(6),
    });
  }

  // Free the heavy map before writing
  schedulesByTrain.clear();

  console.log(`[build-routes] ${routes.length} routes built, writing ${prebuiltFile} ...`);
  await fs.mkdir(path.dirname(prebuiltFile), { recursive: true });
  await fs.writeFile(prebuiltFile, JSON.stringify(routes));

  const stat = await fs.stat(prebuiltFile);
  console.log(`[build-routes] done — ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

// Allow running standalone: node scripts/build-routes.mjs
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  buildPrebuiltRoutes().catch((err) => {
    console.error(`[build-routes] FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}

