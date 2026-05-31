/**
 * mcp-handler.js — MCP Server with Streamable HTTP transport
 *
 * Creates a Model Context Protocol server that exposes geospatial railway
 * validation and exploration tools over HTTP, allowing Claude Desktop
 * (or any MCP client) to connect remotely.
 *
 * Tools:
 *   1. get_nearby_rail_segments  — R-tree spatial query
 *   2. verify_track_alignment    — Discrete Fréchet Distance verification
 *   3. search_trains             — Search trains by name/number/type
 *   4. get_route_details         — Full route info with stations & geometry
 *   5. get_saved_annotation      — Read the last saved annotation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { verifyAlignment } from "./frechet.js";

// ─── Session Management ──────────────────────────────────────────────────────

const sessions = new Map();

// ─── Create MCP Server ───────────────────────────────────────────────────────

/**
 * Create and configure a new McpServer instance with all tools registered.
 *
 * @param {import('./spatial-index.js').SpatialIndex} spatialIndex
 * @param {string} annotationPath - Path to the saved annotation.geojson
 * @returns {McpServer}
 */
function createMcpServer(spatialIndex, stationGraph, annotationPath) {
  const server = new McpServer({
    name: "railways-validation-engine",
    version: "1.0.0",
  });

  // ── Tool 1: get_nearby_rail_segments ─────────────────────────────────────

  server.tool(
    "get_nearby_rail_segments",
    "Query railway segments near a geographic coordinate. Uses an R-tree spatial index over 5,199 Indian railway routes for O(log N) retrieval, with post-filter Haversine distance verification. Returns matching train routes with metadata. Coordinates are excluded by default to keep response size small.",
    {
      latitude: z.number().min(-90).max(90).describe("Query centre latitude (e.g. 28.6139 for New Delhi)"),
      longitude: z.number().min(-180).max(180).describe("Query centre longitude (e.g. 77.2090 for New Delhi)"),
      buffer_radius_degrees: z.number().min(0.01).max(5.0).default(0.5)
        .describe("Search radius in degrees (default 0.5 ≈ 55 km). 1 degree ≈ 111 km."),
      max_results: z.number().int().min(1).max(200).default(30)
        .describe("Maximum number of segments to return (default 30, max 200)."),
      include_coords: z.boolean().default(false)
        .describe("If true, include trimmed segment_coords arrays. Keep false (default) to avoid large payloads."),
    },
    async ({ latitude, longitude, buffer_radius_degrees, max_results, include_coords }) => {
      console.log(`[mcp] get_nearby_rail_segments(${latitude}, ${longitude}, ${buffer_radius_degrees}°, max=${max_results})`);

      try {
        const segments = spatialIndex.queryRadius(latitude, longitude, buffer_radius_degrees);
        const limited = segments.slice(0, max_results);

        const outputSegments = limited.map((seg) => {
          const base = {
            route_id: seg.route_id,
            train_name: seg.train_name,
            train_type: seg.train_type,
            station_count: seg.station_count,
            route_length_km: seg.route_length_km,
            nearest_distance_km: seg.nearest_distance_km,
            total_coord_count: seg.segment_coords.length,
          };

          if (!include_coords) return base;

          const coords = seg.segment_coords;
          const trimmed = coords.length > 20
            ? [...coords.slice(0, 10), ...coords.slice(-10)]
            : coords;

          return { ...base, segment_coords: trimmed };
        });

        const response = {
          query: { lat: latitude, lon: longitude, radius_deg: buffer_radius_degrees },
          segments_found: segments.length,
          segments_returned: limited.length,
          segments: outputSegments,
          note: segments.length > max_results
            ? `Showing top ${max_results} of ${segments.length} matches by proximity. Increase max_results to see more.`
            : undefined,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 2: verify_track_alignment ───────────────────────────────────────

  server.tool(
    "verify_track_alignment",
    "Verify the alignment of field-inspection coordinates against a reference railway route using the Discrete Fréchet Distance algorithm. Returns COMPLIANT or MISALIGNMENT_DETECTED with the exact deviation metrics and the geographic point of maximum deviation.",
    {
      route_id: z.string().describe("Train number to verify against (e.g. '12301' for Rajdhani Express)"),
      inspection_coordinates: z.array(z.tuple([z.number(), z.number()]))
        .min(2)
        .describe("Array of [longitude, latitude] coordinate pairs from field inspection or GPS telemetry"),
      compliance_threshold_km: z.number().min(0.1).max(50.0).default(2.0)
        .describe("Maximum acceptable Fréchet distance in km (default 2.0 km)"),
    },
    async ({ route_id, inspection_coordinates, compliance_threshold_km }) => {
      console.log(`[mcp] verify_track_alignment(route=${route_id}, points=${inspection_coordinates.length}, threshold=${compliance_threshold_km} km)`);

      try {
        const result = verifyAlignment(route_id, inspection_coordinates, spatialIndex, compliance_threshold_km);

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 3: search_trains ────────────────────────────────────────────────

  server.tool(
    "search_trains",
    "Search Indian railway trains by name, number, or type. Returns matching trains with metadata including station count, route length, and type. Use this to find a train before querying its route details or verifying alignment.",
    {
      query: z.string().min(1).describe("Search term — can be a train name (e.g. 'Rajdhani'), number (e.g. '12301'), or type (e.g. 'Superfast')"),
      max_results: z.number().int().min(1).max(50).default(10)
        .describe("Maximum number of results to return (default 10)"),
    },
    async ({ query, max_results }) => {
      console.log(`[mcp] search_trains(query="${query}", max=${max_results})`);

      try {
        const results = spatialIndex.searchRoutes(query, max_results);

        const output = results.map((r) => ({
          train_no: r.train_no,
          train_name: r.train_name,
          train_type: r.train_type,
          station_count: r.station_count,
          route_length_km: r.route_length_km,
          origin: r.stations?.[0]?.name || "Unknown",
          destination: r.stations?.[r.stations.length - 1]?.name || "Unknown",
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ query, results_count: output.length, results: output }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 4: get_route_details ────────────────────────────────────────────

  server.tool(
    "get_route_details",
    "Get full details of a specific railway route by train number. Returns all stations with coordinates, arrival/departure times, the complete route geometry, and summary metadata. Use this after search_trains to get deep route info.",
    {
      train_no: z.string().describe("Train number (e.g. '12301')"),
      include_geometry: z.boolean().default(false)
        .describe("If true, include the full route_line coordinate array. Default false to keep payload small."),
    },
    async ({ train_no, include_geometry }) => {
      console.log(`[mcp] get_route_details(train_no="${train_no}", geometry=${include_geometry})`);

      try {
        const route = spatialIndex.getRouteById(train_no);
        if (!route) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Route not found: train_no="${train_no}"` }) }],
            isError: true,
          };
        }

        const result = {
          train_no: route.train_no,
          train_name: route.train_name,
          train_type: route.train_type,
          station_count: route.station_count,
          route_length_km: Math.round(route.route_length_km * 100) / 100,
          stations: (route.stations || []).map((s) => ({
            seq: s.seq,
            code: s.station_code || s.code,
            name: s.station_name || s.name,
            lat: s.lat,
            lon: s.lon,
            day: s.day,
            arrival: s.arrival,
            departure: s.departure,
          })),
        };

        if (include_geometry && route.route_line) {
          result.route_line = route.route_line;
          result.coordinate_count = route.route_line.length;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 5: get_saved_annotation ─────────────────────────────────────────

  server.tool(
    "get_saved_annotation",
    "Read the most recently saved user annotation from the server. Returns the GeoJSON FeatureCollection that the user drew on the map. Use this to understand what the user has annotated before running matching or alignment checks.",
    {},
    async () => {
      console.log(`[mcp] get_saved_annotation()`);

      try {
        const raw = await readFile(annotationPath, "utf-8");
        const geojson = JSON.parse(raw);

        const featureCount = geojson?.features?.length || 0;
        const summary = {
          type: geojson.type,
          feature_count: featureCount,
          stroke_count: geojson?.properties?.stroke_count || featureCount,
        };

        return {
          content: [
            { type: "text", text: JSON.stringify({ summary, annotation: geojson }, null, 2) },
          ],
        };
      } catch (err) {
        if (err.code === "ENOENT") {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "No annotation has been saved yet. The user needs to draw on the map and export first." }) }],
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 6: plan_journey ─────────────────────────────────────────────────

  server.tool(
    "plan_journey",
    "Find the minimum-time rail journey between two Indian railway stations using Dijkstra's shortest path algorithm over a weighted station adjacency graph (8,500+ nodes, 400K+ edges). Returns the full path with train numbers, station names, and per-leg travel times.",
    {
      from_station_code: z.string().min(1).describe("Origin station code in uppercase (e.g. 'NDLS' for New Delhi, 'MAS' for Chennai Central, 'CSTM' for Mumbai CST)"),
      to_station_code:   z.string().min(1).describe("Destination station code in uppercase (e.g. 'MAS', 'HWH', 'BCT')"),
    },
    async ({ from_station_code, to_station_code }) => {
      const src = from_station_code.trim().toUpperCase();
      const dst = to_station_code.trim().toUpperCase();
      console.log(`[mcp] plan_journey(${src} → ${dst})`);

      try {
        if (stationGraph.meta.size === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Station graph is still loading." }) }],
            isError: true,
          };
        }

        const journey = stationGraph.dijkstra(src, dst);
        if (!journey) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `No rail path found between ${src} and ${dst}.`,
              hint: "Verify station codes are correct uppercase abbreviations (e.g. NDLS, MAS, HWH, BCT, PUNE).",
            }) }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(journey, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] ERROR: ${message}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─── Express Route Setup ─────────────────────────────────────────────────────

/**
 * Mount the /mcp endpoint on an Express app.
 *
 * @param {import('express').Application} app - The Express app
 * @param {import('./spatial-index.js').SpatialIndex} spatialIndex
 * @param {{ annotationPath: string, authToken?: string }} opts
 */
export function setupMcpRoutes(app, spatialIndex, stationGraph, opts = {}) {
  const { annotationPath, authToken } = opts;

  // ── Optional auth middleware for /mcp ─────────────────────────────────────

  const authMiddleware = (req, res, next) => {
    if (!authToken) return next();

    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${authToken}`) {
      return res.status(401).json({ error: "Unauthorized — invalid or missing Bearer token" });
    }
    return next();
  };

  // ── POST /mcp — Handle JSON-RPC requests ─────────────────────────────────

  app.post("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const transport = sessions.get(sessionId);
        await transport.handleRequest(req, res, req.body);
      } else if (!sessionId) {
        // New session — create transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        const server = createMcpServer(spatialIndex, stationGraph, annotationPath);

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
          console.log(`[mcp] Session closed: ${sid}`);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        // Store session after successful handling (sessionId is set after init)
        if (transport.sessionId) {
          sessions.set(transport.sessionId, transport);
          console.log(`[mcp] New session: ${transport.sessionId}`);
        }
      } else {
        // Session ID provided but not found
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found. Send initialize request without session ID." },
          id: null,
        });
      }
    } catch (err) {
      console.error("[mcp] Request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ── GET /mcp — SSE stream for server-to-client notifications ─────────────

  app.get("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: "Invalid or missing session ID" });
    }

    const transport = sessions.get(sessionId);
    await transport.handleRequest(req, res);
  });

  // ── DELETE /mcp — Close a session ────────────────────────────────────────

  app.delete("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
      console.log(`[mcp] Session deleted: ${sessionId}`);
    } else {
      res.status(200).end();
    }
  });

  console.log("[mcp] MCP Streamable HTTP endpoint mounted at /mcp ✓");
}
