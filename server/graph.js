/**
 * graph.js — Station adjacency graph with Dijkstra's shortest path
 *
 * Nodes  = station codes  (~8,500 unique stations)
 * Edges  = consecutive station pairs within every train route
 * Weight = travel time in minutes between consecutive stops
 *
 * Dijkstra with a binary min-heap finds the minimum-time journey
 * between any two stations in O((V + E) log V).
 */

import { haversineKm } from "./geo-utils.js";

// ─── Binary Min-Heap ─────────────────────────────────────────────────────────

class MinHeap {
  constructor() {
    this.h = []; // [{cost, node}]
  }

  push(cost, node) {
    this.h.push({ cost, node });
    this._up(this.h.length - 1);
  }

  pop() {
    const top = this.h[0];
    const last = this.h.pop();
    if (this.h.length > 0) {
      this.h[0] = last;
      this._down(0);
    }
    return top;
  }

  get size() { return this.h.length; }

  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p].cost <= this.h[i].cost) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }

  _down(i) {
    const n = this.h.length;
    while (true) {
      let s = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.h[l].cost < this.h[s].cost) s = l;
      if (r < n && this.h[r].cost < this.h[s].cost) s = r;
      if (s === i) break;
      [this.h[s], this.h[i]] = [this.h[i], this.h[s]];
      i = s;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTimeMin(val) {
  if (!val || val === "None") return null;
  const parts = String(val).split(":");
  const h = Number(parts[0]), m = Number(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function edgeWeightMinutes(fromSt, toSt) {
  const dep = parseTimeMin(fromSt.departure);
  const arr = parseTimeMin(toSt.arrival);
  if (dep !== null && arr !== null) {
    const diff = arr - dep;
    return diff > 0 ? diff : diff + 1440; // midnight crossing
  }
  // Fallback: estimate at 60 km/h average speed
  const km = haversineKm([fromSt.lon, fromSt.lat], [toSt.lon, toSt.lat]);
  return Math.max(1, Math.round((km / 60) * 60));
}

// ─── Station Graph ────────────────────────────────────────────────────────────

export class StationGraph {
  constructor() {
    this.adj  = new Map(); // code → [{to, trainNo, trainName, weight}]
    this.meta = new Map(); // code → {name, lat, lon}
  }

  /**
   * Build adjacency list from all loaded routes.
   * Each consecutive station pair in a route becomes a directed edge.
   * O(total_stations_across_all_routes) ≈ O(417K)
   */
  build(routes) {
    for (const route of routes) {
      const stations = route.stations;
      if (!stations || stations.length < 2) continue;

      for (let i = 0; i < stations.length - 1; i++) {
        const a = stations[i];
        const b = stations[i + 1];
        if (!a.code || !b.code) continue;

        if (!this.meta.has(a.code))
          this.meta.set(a.code, { name: a.name, lat: a.lat, lon: a.lon });
        if (!this.meta.has(b.code))
          this.meta.set(b.code, { name: b.name, lat: b.lat, lon: b.lon });

        if (!this.adj.has(a.code)) this.adj.set(a.code, []);
        this.adj.get(a.code).push({
          to: b.code,
          trainNo: route.train_no,
          trainName: route.train_name,
          weight: edgeWeightMinutes(a, b),
        });
      }
    }
    console.log(`[graph] ${this.meta.size} stations, ${this.edgeCount} directed edges ✓`);
  }

  get edgeCount() {
    let n = 0;
    for (const edges of this.adj.values()) n += edges.length;
    return n;
  }

  /**
   * Dijkstra's shortest path (minimum travel time) between two station codes.
   *
   * @param {string} src - Origin station code (e.g. "NDLS")
   * @param {string} dst - Destination station code (e.g. "MAS")
   * @returns {object|null} Journey object, or null if no path exists
   */
  dijkstra(src, dst) {
    if (src === dst) {
      return {
        from_code: src, from_name: this.meta.get(src)?.name || src,
        to_code: dst,   to_name:   this.meta.get(dst)?.name || dst,
        total_minutes: 0, total_hours: 0, direct_train: true, stops: 0,
        path: [{ station_code: src, station_name: this.meta.get(src)?.name || src,
                 via_train_no: null, via_train_name: null, leg_minutes: 0 }],
      };
    }

    if (!this.adj.has(src)) return null;

    const dist = new Map();
    const prev = new Map(); // code → { from, trainNo, trainName, weight }
    const heap = new MinHeap();

    dist.set(src, 0);
    heap.push(0, src);

    while (heap.size > 0) {
      const { cost, node } = heap.pop();
      if (cost > (dist.get(node) ?? Infinity)) continue; // stale entry
      if (node === dst) break;

      for (const edge of this.adj.get(node) || []) {
        const newCost = cost + edge.weight;
        if (newCost < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, newCost);
          prev.set(edge.to, { from: node, trainNo: edge.trainNo,
                              trainName: edge.trainName, weight: edge.weight });
          heap.push(newCost, edge.to);
        }
      }
    }

    if (!dist.has(dst)) return null;

    // Reconstruct path from dst → src, then reverse
    const steps = [];
    let cur = dst;
    while (cur && cur !== src) {
      const p = prev.get(cur);
      if (!p) break;
      steps.unshift({
        station_code:   cur,
        station_name:   this.meta.get(cur)?.name || cur,
        via_train_no:   p.trainNo,
        via_train_name: p.trainName,
        leg_minutes:    p.weight,
      });
      cur = p.from;
    }
    steps.unshift({
      station_code:   src,
      station_name:   this.meta.get(src)?.name || src,
      via_train_no:   null,
      via_train_name: null,
      leg_minutes:    0,
    });

    const totalMin = Math.round(dist.get(dst));
    return {
      from_code:    src,
      from_name:    this.meta.get(src)?.name || src,
      to_code:      dst,
      to_name:      this.meta.get(dst)?.name || dst,
      total_minutes: totalMin,
      total_hours:   Math.round((totalMin / 60) * 10) / 10,
      direct_train:  steps.length === 2,
      stops:         steps.length - 1,
      path:          steps,
    };
  }

  /**
   * Return all unique train numbers that depart from a given station.
   */
  getTrainsFromStation(code) {
    return [...new Set((this.adj.get(code) || []).map(e => e.trainNo))];
  }
}
