import fs from "fs/promises";
import path from "path";

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), "data");
const RAW_TRAINS_FILE = process.env.RAW_TRAINS_FILE || path.join(DATA_ROOT, "trains.json");
const RAW_STATIONS_FILE = process.env.RAW_STATIONS_FILE || path.join(DATA_ROOT, "stations.json");
const RAW_SCHEDULES_FILE = process.env.RAW_SCHEDULES_FILE || path.join(DATA_ROOT, "schedules.json");

// Bounds from india-states.geojson
const MAP_BOUNDS = {
  minLon: 68.18624878,
  minLat: 6.75425577,
  maxLon: 97.41516113,
  maxLat: 35.50133133,
};

const RESAMPLE_POINTS = 200;
const LENGTH_RATIO_MIN = 0.3;
const LENGTH_RATIO_MAX = 3.5;
const BBOX_PAD = 0.05;
const STROKE_MAX_PENALTY_WEIGHT = 0.15;

const MAX_RETURNED_ROUTES = 20;
const SIMILARITY_MULTIPLIER = 1.22;
const SIMILARITY_ABS_PAD = 0.025;
const DENSE_CORRIDOR_CANDIDATES = 1200;
const MIN_RETURN_DEFAULT = 1;
const MIN_RETURN_DENSE = 3;
const EXPANDED_MULTIPLIER = 1.35;
const EXPANDED_ABS_PAD = 0.05;

let routesCache = null;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function lonLatToNorm(coord) {
  const [lon, lat] = coord;
  const x = (lon - MAP_BOUNDS.minLon) / (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon);
  const y = (MAP_BOUNDS.maxLat - lat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  return [clamp01(x), clamp01(y)];
}

function pixelNormPoint(coord) {
  const [x, y] = coord;
  return [clamp01(Number(x)), clamp01(Number(y))];
}

function euclidean(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function lineLength(points) {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i += 1) sum += euclidean(points[i], points[i + 1]);
  return sum;
}

function bbox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function resampleLine(points, n) {
  if (!points.length) return [];
  if (points.length === 1) return Array.from({ length: n }, () => points[0]);

  const dists = [0];
  for (let i = 0; i < points.length - 1; i += 1) {
    dists.push(dists[dists.length - 1] + euclidean(points[i], points[i + 1]));
  }

  const total = dists[dists.length - 1];
  if (total === 0) return Array.from({ length: n }, () => points[0]);

  const step = total / (n - 1);
  const out = [points[0]];
  let target = step;
  let idx = 1;

  while (out.length < n - 1) {
    while (idx < dists.length && dists[idx] < target) idx += 1;
    if (idx >= points.length) break;

    const prev = points[idx - 1];
    const curr = points[idx];
    const prevD = dists[idx - 1];
    const currD = dists[idx];

    if (currD === prevD) {
      out.push(curr);
    } else {
      const t = (target - prevD) / (currD - prevD);
      out.push([prev[0] + (curr[0] - prev[0]) * t, prev[1] + (curr[1] - prev[1]) * t]);
    }
    target += step;
  }

  out.push(points[points.length - 1]);
  while (out.length < n) out.push(points[points.length - 1]);
  return out;
}

function discreteFrechet(p, q) {
  const n = p.length;
  const m = q.length;
  if (!n || !m) return Infinity;

  const ca = Array.from({ length: n }, () => Array(m).fill(-1));

  function c(i, j) {
    if (ca[i][j] >= 0) return ca[i][j];
    const d = euclidean(p[i], q[j]);
    if (i === 0 && j === 0) ca[i][j] = d;
    else if (i > 0 && j === 0) ca[i][j] = Math.max(c(i - 1, 0), d);
    else if (i === 0 && j > 0) ca[i][j] = Math.max(c(0, j - 1), d);
    else ca[i][j] = Math.max(Math.min(c(i - 1, j), c(i - 1, j - 1), c(i, j - 1)), d);
    return ca[i][j];
  }

  return c(n - 1, m - 1);
}

function toPixelLine(line) {
  if (!Array.isArray(line)) return null;
  const out = line
    .filter((pt) => Array.isArray(pt) && pt.length >= 2)
    .map(pixelNormPoint)
    .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  return out.length >= 2 ? out : null;
}

function toLonLatLine(line) {
  if (!Array.isArray(line)) return null;
  const out = line
    .filter((pt) => Array.isArray(pt) && pt.length >= 2)
    .map(lonLatToNorm)
    .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  return out.length >= 2 ? out : null;
}

function parseFeatureToStrokes(feature) {
  const strokes = [];
  if (!feature) return strokes;

  if (Array.isArray(feature?.properties?.pixel_strokes)) {
    for (const s of feature.properties.pixel_strokes) {
      const line = toPixelLine(s);
      if (line) strokes.push(line);
    }
  }

  if (Array.isArray(feature?.properties?.pixel_line)) {
    const line = toPixelLine(feature.properties.pixel_line);
    if (line) strokes.push(line);
  }

  const geom = feature?.geometry;
  if (geom?.type === "LineString") {
    const line = toLonLatLine(geom.coordinates || []);
    if (line) strokes.push(line);
  }

  if (geom?.type === "MultiLineString") {
    for (const l of geom.coordinates || []) {
      const line = toLonLatLine(l);
      if (line) strokes.push(line);
    }
  }

  return strokes;
}

function parseAnnotation(annotationGeoJson) {
  if (!annotationGeoJson) return [];

  if (annotationGeoJson.type === "FeatureCollection") {
    const out = [];
    for (const f of annotationGeoJson.features || []) out.push(...parseFeatureToStrokes(f));
    return out;
  }

  if (annotationGeoJson.type === "Feature") {
    return parseFeatureToStrokes(annotationGeoJson);
  }

  return [];
}

function parseTimeMin(value) {
  if (!value || value === "None") return null;
  const [hh, mm] = String(value).split(":");
  const h = Number(hh);
  const m = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function scheduleSortKey(s, idx) {
  const day = Number(s.day) || 1;
  const arr = parseTimeMin(s.arrival);
  const dep = parseTimeMin(s.departure);
  const tm = arr != null && dep != null ? Math.min(arr, dep) : arr ?? dep ?? 1e9;
  return day * 2000 + tm + idx / 1e6;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function routeLengthKm(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) total += haversineKm(coords[i], coords[i + 1]);
  return total;
}

async function readJsonOrThrow(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error(`Unable to load ${label} at ${filePath}. Ensure normal/raw database files exist.`);
  }
}

async function loadRoutes() {
  if (routesCache) return routesCache;

  const [trainsGeo, stationsGeo, schedules] = await Promise.all([
    readJsonOrThrow(RAW_TRAINS_FILE, "trains"),
    readJsonOrThrow(RAW_STATIONS_FILE, "stations"),
    readJsonOrThrow(RAW_SCHEDULES_FILE, "schedules"),
  ]);

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

  const trainByNo = new Map();
  for (const f of trainsGeo.features || []) {
    const p = f?.properties || {};
    if (!p.number) continue;
    trainByNo.set(String(p.number), p);
  }

  const schedulesByTrain = new Map();
  (schedules || []).forEach((s, idx) => {
    const no = String(s.train_number || "").trim();
    if (!no) return;
    if (!schedulesByTrain.has(no)) schedulesByTrain.set(no, []);
    schedulesByTrain.get(no).push({ ...s, _idx: idx });
  });

  const built = [];
  for (const [trainNo, list] of schedulesByTrain.entries()) {
    list.sort((a, b) => scheduleSortKey(a, a._idx) - scheduleSortKey(b, b._idx));

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

    built.push({
      train_no: trainNo,
      train_name: p.name || list[0]?.train_name || `Train ${trainNo}`,
      train_type: p.type || null,
      route_length_km: routeLenKm,
      station_count: stations.length,
      route_line: coords,
      stations,
      sampled_norm_200: sampledNorm,
      bbox_norm: bbox(sampledNorm),
      length_norm: lineLength(sampledNorm),
    });
  }

  routesCache = built;
  return routesCache;
}

export async function runMatch(annotationGeoJson) {
  const annStrokesRaw = parseAnnotation(annotationGeoJson);
  if (!annStrokesRaw.length) throw new Error("Annotation must contain at least one valid stroke");

  const annStrokes = annStrokesRaw
    .map((s) => resampleLine(s, RESAMPLE_POINTS))
    .filter((s) => s.length >= 2);
  if (!annStrokes.length) throw new Error("Annotation must contain at least one valid stroke");

  const strokeLengths = annStrokes.map((s) => lineLength(s));
  const annLen = strokeLengths.reduce((a, b) => a + b, 0);
  if (annLen <= 0) throw new Error("Annotation must contain non-zero path length");

  const mergedPoints = annStrokes.flat();
  const b = bbox(mergedPoints);
  const annBox = [b[0] - BBOX_PAD, b[1] - BBOX_PAD, b[2] + BBOX_PAD, b[3] + BBOX_PAD];

  const routes = await loadRoutes();
  const candidates = [];

  for (const route of routes) {
    if (route.length_norm < annLen * LENGTH_RATIO_MIN) continue;
    if (route.length_norm > annLen * LENGTH_RATIO_MAX) continue;
    if (!bboxIntersects(route.bbox_norm, annBox)) continue;

    let weighted = 0;
    let maxStrokeDistance = 0;

    for (let i = 0; i < annStrokes.length; i += 1) {
      const d = discreteFrechet(annStrokes[i], route.sampled_norm_200);
      weighted += d * strokeLengths[i];
      if (d > maxStrokeDistance) maxStrokeDistance = d;
    }

    const avgDistance = weighted / annLen;
    const score = avgDistance + maxStrokeDistance * STROKE_MAX_PENALTY_WEIGHT;

    candidates.push({
      train_no: route.train_no,
      train_name: route.train_name,
      train_type: route.train_type,
      distance_px_norm: score,
      route_length_km: route.route_length_km,
      station_count: route.station_count,
      route_line: route.route_line,
      stations: route.stations,
    });
  }

  candidates.sort((a, b2) => a.distance_px_norm - b2.distance_px_norm);

  let best = [];
  if (candidates.length > 0) {
    const bestDistance = candidates[0].distance_px_norm;
    const denseCorridor = candidates.length >= DENSE_CORRIDOR_CANDIDATES;
    const minReturn = denseCorridor ? MIN_RETURN_DENSE : MIN_RETURN_DEFAULT;

    const smartCutoff = Math.max(bestDistance * SIMILARITY_MULTIPLIER, bestDistance + SIMILARITY_ABS_PAD);
    best = candidates.filter((c) => c.distance_px_norm <= smartCutoff);

    if (best.length < minReturn) {
      const expandedCutoff = Math.max(bestDistance * EXPANDED_MULTIPLIER, bestDistance + EXPANDED_ABS_PAD);
      best = candidates.filter((c) => c.distance_px_norm <= expandedCutoff);
    }

    if (best.length < minReturn) {
      best = candidates.slice(0, Math.min(minReturn, candidates.length));
    }

    best = best.slice(0, MAX_RETURNED_ROUTES);
  }

  return {
    annotation_length_norm: annLen,
    annotation_stroke_count: annStrokes.length,
    candidates: candidates.length,
    best_count: best.length,
    best,
  };
}

export function clearRouteCache() {
  routesCache = null;
}
