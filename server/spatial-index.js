/**
 * spatial-index.js — R-Tree spatial index over Indian railway routes (JS port)
 *
 * Loads prebuilt_routes.json, inserts each route's bounding box into an
 * RBush R-tree, and provides O(log N) spatial queries with Haversine post-filter.
 */

import RBush from "rbush";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { haversineKm, bboxFromCoords } from "./geo-utils.js";

export class SpatialIndex {
  constructor() {
    this.tree = new RBush();
    this.routes = [];
    this.routeBBoxes = [];
    this.loaded = false;
  }

  /**
   * Load routes from the prebuilt JSON file and bulk-insert into R-tree.
   * @param {string} dataRoot - Path to directory containing prebuilt_routes.json
   */
  async load(dataRoot) {
    if (this.loaded) return;

    const filePath = join(dataRoot, "prebuilt_routes.json");
    console.log(`[spatial-index] Loading routes from ${filePath}…`);

    const raw = await readFile(filePath, "utf-8");
    this.routes = JSON.parse(raw);

    console.log(`[spatial-index] Parsed ${this.routes.length} routes, building R-tree…`);

    const items = [];

    for (let i = 0; i < this.routes.length; i++) {
      const route = this.routes[i];
      const coords = route.route_line;
      if (!coords || coords.length === 0) continue;

      const bb = bboxFromCoords(coords);
      this.routeBBoxes[i] = bb;

      items.push({
        minX: bb.minX,
        minY: bb.minY,
        maxX: bb.maxX,
        maxY: bb.maxY,
        routeIndex: i,
      });
    }

    this.tree.load(items);
    this.loaded = true;
    console.log(`[spatial-index] R-tree built with ${items.length} entries ✓`);
  }

  /**
   * Load routes from an already-parsed array (shared with matcher.js).
   * @param {object[]} routes - Pre-loaded routes array
   */
  loadFromArray(routes) {
    if (this.loaded) return;

    this.routes = routes;
    console.log(`[spatial-index] Building R-tree from ${routes.length} shared routes…`);

    const items = [];

    for (let i = 0; i < this.routes.length; i++) {
      const route = this.routes[i];
      const coords = route.route_line;
      if (!coords || coords.length === 0) continue;

      const bb = bboxFromCoords(coords);
      this.routeBBoxes[i] = bb;

      items.push({
        minX: bb.minX,
        minY: bb.minY,
        maxX: bb.maxX,
        maxY: bb.maxY,
        routeIndex: i,
      });
    }

    this.tree.load(items);
    this.loaded = true;
    console.log(`[spatial-index] R-tree built with ${items.length} entries ✓`);
  }

  /**
   * Query all segments whose bounding box intersects a buffer around the
   * given point, then post-filter by Haversine distance.
   *
   * @param {number} lat - Query centre latitude
   * @param {number} lon - Query centre longitude
   * @param {number} bufferDeg - Search radius in degrees (default 0.5 ≈ 55 km)
   * @returns {{ route_id: string, train_name: string, train_type: string, station_count: number, route_length_km: number, segment_coords: [number,number][], nearest_distance_km: number }[]}
   */
  queryRadius(lat, lon, bufferDeg = 0.5) {
    if (!this.loaded) throw new Error("SpatialIndex has not been loaded yet");

    const queryBBox = {
      minX: lon - bufferDeg,
      minY: lat - bufferDeg,
      maxX: lon + bufferDeg,
      maxY: lat + bufferDeg,
    };

    const candidates = this.tree.search(queryBBox);
    const queryPoint = [lon, lat];
    const results = [];

    for (const candidate of candidates) {
      const route = this.routes[candidate.routeIndex];
      const coords = route.route_line;

      // Find closest point on route to query centre
      let minDist = Infinity;
      for (const coord of coords) {
        const d = haversineKm(queryPoint, coord);
        if (d < minDist) minDist = d;
      }

      // 1° latitude ≈ 111.32 km
      const bufferKm = bufferDeg * 111.32;

      if (minDist <= bufferKm) {
        results.push({
          route_id: route.train_no,
          train_name: route.train_name,
          train_type: route.train_type,
          station_count: route.station_count,
          route_length_km: Math.round(route.route_length_km * 100) / 100,
          segment_coords: coords,
          nearest_distance_km: Math.round(minDist * 100) / 100,
        });
      }
    }

    results.sort((a, b) => a.nearest_distance_km - b.nearest_distance_km);
    return results;
  }

  /**
   * Look up a single route by train number.
   * @param {string} trainNo
   * @returns {object|undefined}
   */
  getRouteById(trainNo) {
    return this.routes.find((r) => r.train_no === trainNo);
  }

  /**
   * Search routes by name, number, or type.
   * @param {string} query - Search string
   * @param {number} maxResults - Max results (default 20)
   * @returns {object[]}
   */
  searchRoutes(query, maxResults = 20) {
    if (!this.loaded) throw new Error("SpatialIndex has not been loaded yet");

    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results = [];
    for (const route of this.routes) {
      const nameMatch = (route.train_name || "").toLowerCase().includes(q);
      const noMatch = (route.train_no || "").toLowerCase().includes(q);
      const typeMatch = (route.train_type || "").toLowerCase().includes(q);

      if (nameMatch || noMatch || typeMatch) {
        results.push({
          train_no: route.train_no,
          train_name: route.train_name,
          train_type: route.train_type,
          station_count: route.station_count,
          route_length_km: Math.round(route.route_length_km * 100) / 100,
          stations: route.stations,
          route_line: route.route_line,
        });
        if (results.length >= maxResults) break;
      }
    }

    return results;
  }

  /** Total loaded route count. */
  get routeCount() {
    return this.routes.length;
  }
}
