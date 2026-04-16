import fs from "fs/promises";
import path from "path";

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), "data");
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(DATA_ROOT, "processed", "datameet_routes.jsonl");

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

function parseAnnotation(annotationGeoJson) {
  if (annotationGeoJson?.properties?.pixel_line && Array.isArray(annotationGeoJson.properties.pixel_line)) {
    return annotationGeoJson.properties.pixel_line;
  }

  if (annotationGeoJson?.type === "Feature" && annotationGeoJson?.geometry?.type === "LineString") {
    return (annotationGeoJson.geometry.coordinates || []).map(lonLatToNorm);
  }

  if (annotationGeoJson?.type === "FeatureCollection") {
    const f = (annotationGeoJson.features || []).find((x) => x?.geometry?.type === "LineString");
    if (f?.properties?.pixel_line && Array.isArray(f.properties.pixel_line)) return f.properties.pixel_line;
    if (f?.geometry?.coordinates) return f.geometry.coordinates.map(lonLatToNorm);
  }

  return null;
}

async function loadRoutes() {
  if (routesCache) return routesCache;
  let content;
  try {
    content = await fs.readFile(ROUTES_FILE, "utf8");
  } catch {
    throw new Error(`Unable to load routes dataset at ${ROUTES_FILE}. Set ROUTES_FILE or DATA_ROOT correctly.`);
  }
  routesCache = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((route) => {
      const normRoute = (route.sampled_200 || route.route_line || []).map(lonLatToNorm);
      const sampledNorm = resampleLine(normRoute, RESAMPLE_POINTS);
      return {
        ...route,
        sampled_norm_200: sampledNorm,
        bbox_norm: bbox(sampledNorm),
        length_norm: lineLength(sampledNorm),
      };
    });
  return routesCache;
}

export async function runMatch(annotationGeoJson) {
  const ann = parseAnnotation(annotationGeoJson);
  if (!ann || ann.length < 2) throw new Error("Annotation must be a GeoJSON LineString");

  const annotationResampled = resampleLine(ann, RESAMPLE_POINTS);
  const annLen = lineLength(annotationResampled);
  const b = bbox(annotationResampled);
  const annBox = [b[0] - BBOX_PAD, b[1] - BBOX_PAD, b[2] + BBOX_PAD, b[3] + BBOX_PAD];

  const routes = await loadRoutes();
  const candidates = [];

  for (const route of routes) {
    if (route.length_norm < annLen * LENGTH_RATIO_MIN) continue;
    if (route.length_norm > annLen * LENGTH_RATIO_MAX) continue;
    if (!bboxIntersects(route.bbox_norm, annBox)) continue;

    const d = discreteFrechet(annotationResampled, route.sampled_norm_200);
    candidates.push({
      train_no: route.train_no,
      train_name: route.train_name,
      distance_px_norm: d,
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

    // If a corridor is dense, widen a bit to capture parallel trains.
    if (best.length < minReturn) {
      const expandedCutoff = Math.max(bestDistance * EXPANDED_MULTIPLIER, bestDistance + EXPANDED_ABS_PAD);
      best = candidates.filter((c) => c.distance_px_norm <= expandedCutoff);
    }

    // // Keep a very small floor so we do not force many weak matches.
    if (best.length < minReturn) {
      best = candidates.slice(0, Math.min(minReturn, candidates.length));
    }

    best = best.slice(0, MAX_RETURNED_ROUTES);
  }

  return {
    annotation_length_norm: annLen,
    candidates: candidates.length,
    best_count: best.length,
    best,
  };
}

export function clearRouteCache() {
  routesCache = null;
}
