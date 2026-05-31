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
import { Trie } from "./trie.js";

export class SpatialIndex {
  constructor() {
    this.tree = new RBush();
    this.routes = [];
    this.routeBBoxes = [];
    this.loaded = false;
    this.trainNoIndex = new Map(); // O(1) lookup by train_no
    this.searchTrie = new Trie(20); // prefix trie for name/number autocomplete
    this.stationIndex = new Map(); // code → {name, lat, lon} for all unique stations
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
    this._buildSearchIndex();
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
    this._buildSearchIndex();
    console.log(`[spatial-index] R-tree built with ${items.length} entries, trie nodes: ${this.searchTrie.nodeCount} ✓`);
  }

  /**
   * Build trainNoIndex (HashMap) and searchTrie (Trie) over all loaded routes.
   * Called once after routes are available — O(N × k) where k = avg name length.
   */
  _buildSearchIndex() {
    for (const route of this.routes) {
      this.trainNoIndex.set(route.train_no, route);
      this.searchTrie.insert(route.train_name, route);
      this.searchTrie.insert(route.train_no, route);
      for (const s of route.stations || []) {
        if (s.code && !this.stationIndex.has(s.code)) {
          this.stationIndex.set(s.code, { name: s.name, lat: s.lat, lon: s.lon });
        }
      }
    }
    console.log(`[spatial-index] Station index: ${this.stationIndex.size} unique stations`);
  }

  /**
   * Find all unique stations within radiusDeg of any point in annotationCoords.
   * Uses bounding-box pre-filter then exact Haversine check — O(S) worst case
   * where S = number of unique stations (~8,500).
   *
   * @param {[number,number][]} annotationCoords - [lon, lat] pairs
   * @param {number} radiusDeg - Search radius in degrees (default 0.15 ≈ 17 km)
   * @returns {{ code, name, lat, lon, distance_km }[]} sorted by distance
   */
  queryNearbyStations(annotationCoords, radiusDeg = 0.15) {
    if (!this.loaded) throw new Error("SpatialIndex has not been loaded yet");
    if (!annotationCoords || annotationCoords.length === 0) return [];

    // Annotation bounding box for pre-filter
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of annotationCoords) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
    const bLon0 = minLon - radiusDeg, bLon1 = maxLon + radiusDeg;
    const bLat0 = minLat - radiusDeg, bLat1 = maxLat + radiusDeg;
    const radiusKm = radiusDeg * 111.32;

    const results = [];
    for (const [code, st] of this.stationIndex) {
      if (st.lon < bLon0 || st.lon > bLon1 || st.lat < bLat0 || st.lat > bLat1) continue;
      let minDist = Infinity;
      for (const [lon, lat] of annotationCoords) {
        const d = haversineKm([lon, lat], [st.lon, st.lat]);
        if (d < minDist) minDist = d;
      }
      if (minDist <= radiusKm) {
        results.push({ code, name: st.name, lat: st.lat, lon: st.lon,
          distance_km: Math.round(minDist * 100) / 100 });
      }
    }
    results.sort((a, b) => a.distance_km - b.distance_km);
    return results;
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
   * O(1) HashMap lookup (replaced O(N) linear scan).
   * @param {string} trainNo
   * @returns {object|undefined}
   */
  getRouteById(trainNo) {
    return this.trainNoIndex.get(trainNo);
  }

  /**
   * Search routes by name or number.
   *
   * Fast path: O(k) trie prefix lookup (k = query length). Handles the common
   * case — autocomplete-style queries like "raj", "12301", "shatabdi".
   *
   * Fallback: O(N) substring scan for mid-word queries that don't match any
   * prefix (e.g. querying "press" to find "RAJDHANI EXPRESS").
   *
   * @param {string} query - Search string
   * @param {number} maxResults - Max results (default 20)
   * @returns {object[]} Raw route objects
   */
  searchRoutes(query, maxResults = 20) {
    if (!this.loaded) throw new Error("SpatialIndex has not been loaded yet");

    const q = query.toLowerCase().trim();
    if (!q) return [];

    // Fast path: O(k) trie prefix match
    const trieHits = this.searchTrie.search(q, maxResults);
    if (trieHits.length > 0) return trieHits;

    // Fallback: O(N) substring scan (mid-word queries)
    const results = [];
    for (const route of this.routes) {
      if (
        (route.train_name || "").toLowerCase().includes(q) ||
        (route.train_no || "").toLowerCase().includes(q) ||
        (route.train_type || "").toLowerCase().includes(q)
      ) {
        results.push(route);
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
