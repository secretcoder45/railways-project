import express from "express";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearRouteCache, runMatch, getRoutes } from "./matcher.js";
import { SpatialIndex } from "./spatial-index.js";
import { verifyAlignment } from "./frechet.js";
import { setupMcpRoutes } from "./mcp-handler.js";
import { LRUCache } from "./lru-cache.js";
import { StationGraph } from "./graph.js";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 5050;

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), "runtime_data");
const OUTPUT_PATH = process.env.ANNOTATION_PATH || path.join(DATA_ROOT, "annotation.geojson");
const BUILD_SCRIPT = process.env.BUILD_SCRIPT || path.join(DATA_ROOT, "scripts", "build_datameet_routes.mjs");
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

// ─── Shared Spatial Index ────────────────────────────────────────────────────

const spatialIndex = new SpatialIndex();

// LRU cache for route geometry responses — capacity 200 entries
// Each entry: { trainNo }:{geometry} → serialised route result object
const routeCache = new LRUCache(200);

const stationGraph = new StationGraph();

// Extract [lon, lat] coords from a GeoJSON annotation for geographic operations.
function extractLonLatCoords(annotationGeoJson) {
  const coords = [];
  const fromGeom = (geom) => {
    if (geom?.type === "LineString") coords.push(...(geom.coordinates || []));
    if (geom?.type === "MultiLineString") {
      for (const l of geom.coordinates || []) coords.push(...l);
    }
  };
  if (annotationGeoJson?.type === "Feature") fromGeom(annotationGeoJson.geometry);
  if (annotationGeoJson?.type === "FeatureCollection") {
    for (const f of annotationGeoJson.features || []) fromGeom(f.geometry);
  }
  return coords;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

// ─── Existing API Endpoints (unchanged) ──────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "railways-matcher",
    mcp: spatialIndex.routeCount > 0 ? "ready" : "loading",
    routes: spatialIndex.routeCount,
    stations: stationGraph.meta.size,
    graph_edges: stationGraph.edgeCount,
    route_cache: routeCache.stats(),
  });
});

app.post("/api/annotation", async (req, res) => {
  try {
    const payload = req.body;
    const isFeature = payload?.type === "Feature" && payload?.geometry;
    const isFeatureCollection = payload?.type === "FeatureCollection" && Array.isArray(payload?.features);
    if (!payload || (!isFeature && !isFeatureCollection)) {
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

    // Station detection from geographic coordinates (if available in GeoJSON geometry)
    const lonLatCoords = extractLonLatCoords(annotation);
    const nearbyStations = lonLatCoords.length > 0 && spatialIndex.routeCount > 0
      ? spatialIndex.queryNearbyStations(lonLatCoords, 0.15)
      : [];

    return res.json({ ok: true, result, nearby_stations: nearbyStations });
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

// ─── NEW REST API Endpoints ──────────────────────────────────────────────────

/**
 * GET /api/nearby-segments
 * Query railway segments near a coordinate.
 *   ?lat=28.6139&lon=77.2090&radius=0.5&max=30&coords=false
 */
app.get("/api/nearby-segments", (req, res) => {
  try {
    if (spatialIndex.routeCount === 0) {
      return res.status(503).json({ error: "Spatial index is still loading. Try again in a moment." });
    }

    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 0.5;
    const max = parseInt(req.query.max) || 30;
    const includeCoords = req.query.coords === "true";

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: "lat and lon query parameters are required" });
    }

    const segments = spatialIndex.queryRadius(lat, lon, radius);
    const limited = segments.slice(0, max);

    const output = limited.map((seg) => {
      const base = {
        route_id: seg.route_id,
        train_name: seg.train_name,
        train_type: seg.train_type,
        station_count: seg.station_count,
        route_length_km: seg.route_length_km,
        nearest_distance_km: seg.nearest_distance_km,
      };

      if (!includeCoords) return base;

      const coords = seg.segment_coords;
      const trimmed = coords.length > 20
        ? [...coords.slice(0, 10), ...coords.slice(-10)]
        : coords;
      return { ...base, segment_coords: trimmed };
    });

    return res.json({
      query: { lat, lon, radius_deg: radius },
      segments_found: segments.length,
      segments_returned: limited.length,
      segments: output,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/verify-alignment
 * Verify inspection coordinates against a reference route.
 *   body: { route_id, inspection_coordinates, compliance_threshold_km }
 */
app.post("/api/verify-alignment", (req, res) => {
  try {
    if (spatialIndex.routeCount === 0) {
      return res.status(503).json({ error: "Spatial index is still loading. Try again in a moment." });
    }

    const { route_id, inspection_coordinates, compliance_threshold_km = 2.0 } = req.body;

    if (!route_id) {
      return res.status(400).json({ error: "route_id is required" });
    }
    if (!Array.isArray(inspection_coordinates) || inspection_coordinates.length < 2) {
      return res.status(400).json({ error: "inspection_coordinates must be an array of at least 2 [lon, lat] pairs" });
    }

    const result = verifyAlignment(route_id, inspection_coordinates, spatialIndex, compliance_threshold_km);
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/routes/:trainNo
 * Get full details for a specific train route.
 *   ?geometry=true to include route_line coordinates
 */
app.get("/api/routes/:trainNo", (req, res) => {
  try {
    if (spatialIndex.routeCount === 0) {
      return res.status(503).json({ error: "Spatial index is still loading." });
    }

    const trainNo = req.params.trainNo;
    const includeGeometry = req.query.geometry === "true";
    const cacheKey = `${trainNo}:${includeGeometry}`;

    // LRU cache hit — O(1), skip index lookup and object construction
    const cached = routeCache.get(cacheKey);
    if (cached) return res.json(cached);

    const route = spatialIndex.getRouteById(trainNo); // O(1) HashMap lookup
    if (!route) {
      return res.status(404).json({ error: `Route not found: ${trainNo}` });
    }

    const result = {
      train_no: route.train_no,
      train_name: route.train_name,
      train_type: route.train_type,
      station_count: route.station_count,
      route_length_km: Math.round(route.route_length_km * 100) / 100,
      stations: route.stations || [],
    };

    if (includeGeometry && route.route_line) {
      result.route_line = route.route_line;
      result.coordinate_count = route.route_line.length;
    }

    const response = { ok: true, route: result };
    routeCache.put(cacheKey, response);
    return res.json(response);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/search-trains
 * Search trains by name, number, or type.
 *   ?q=rajdhani&max=10
 */
app.get("/api/search-trains", (req, res) => {
  try {
    if (spatialIndex.routeCount === 0) {
      return res.status(503).json({ error: "Spatial index is still loading." });
    }

    const query = req.query.q;
    const max = parseInt(req.query.max) || 10;

    if (!query) {
      return res.status(400).json({ error: "q query parameter is required" });
    }

    const results = spatialIndex.searchRoutes(query, max);

    const output = results.map((r) => ({
      train_no: r.train_no,
      train_name: r.train_name,
      train_type: r.train_type,
      station_count: r.station_count,
      route_length_km: Math.round(r.route_length_km * 100) / 100,
      origin: r.stations?.[0]?.name || "Unknown",
      destination: r.stations?.[r.stations.length - 1]?.name || "Unknown",
    }));

    return res.json({ query, results_count: output.length, results: output });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/journey?from=NDLS&to=MAS
 * Dijkstra's shortest path (min travel time) between two station codes.
 */
app.get("/api/journey", (req, res) => {
  try {
    const from = String(req.query.from || "").trim().toUpperCase();
    const to   = String(req.query.to   || "").trim().toUpperCase();

    if (!from || !to) {
      return res.status(400).json({ error: "from and to station codes are required (e.g. ?from=NDLS&to=MAS)" });
    }
    if (stationGraph.meta.size === 0) {
      return res.status(503).json({ error: "Station graph is still loading. Try again in a moment." });
    }

    const journey = stationGraph.dijkstra(from, to);
    if (!journey) {
      return res.status(404).json({ error: `No rail path found between ${from} and ${to}. Check station codes.` });
    }

    return res.json({ ok: true, journey });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── MCP Endpoint Mount ──────────────────────────────────────────────────────

setupMcpRoutes(app, spatialIndex, stationGraph, {
  annotationPath: OUTPUT_PATH,
  authToken: MCP_AUTH_TOKEN || undefined,
});

// ─── Server Start + Spatial Index Bootstrap ──────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Bootstrap spatial index from the shared matcher route data
  (async () => {
    try {
      console.log("[server] Loading routes for spatial index…");
      const routes = await getRoutes();
      spatialIndex.loadFromArray(routes);
      stationGraph.build(routes);
      console.log(`[server] Spatial index ready: ${spatialIndex.routeCount} routes, MCP tools online ✓`);
    } catch (err) {
      console.error("[server] Failed to bootstrap spatial index:", err.message);
      console.error("[server] MCP tools and new REST APIs will be unavailable until data is loaded.");
    }
  })();
});
