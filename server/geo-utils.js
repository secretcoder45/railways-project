/**
 * geo-utils.js — Shared geospatial utility functions (JS port)
 *
 * Haversine great-circle distance, polyline resampling, and bounding-box
 * utilities used by spatial-index.js and frechet.js.
 *
 * All coordinates are [longitude, latitude] decimal-degree pairs.
 */

/** Mean radius of Earth in km (WGS-84 mean). */
const R_EARTH_KM = 6_371.0088;

/** Degrees → radians multiplier. */
const DEG2RAD = Math.PI / 180;

/**
 * Great-circle distance between two geographic coordinates.
 * @param {[number,number]} a - [lon, lat]
 * @param {[number,number]} b - [lon, lat]
 * @returns {number} Distance in kilometres
 */
export function haversineKm(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;

  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dPhi = (lat2 - lat1) * DEG2RAD;
  const dLam = (lon2 - lon1) * DEG2RAD;

  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;

  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Total length of a polyline in kilometres.
 * @param {[number,number][]} coords
 * @returns {number}
 */
export function polylineLength(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    sum += haversineKm(coords[i], coords[i + 1]);
  }
  return sum;
}

/**
 * Resample a polyline to exactly `n` evenly-spaced points using linear
 * interpolation along cumulative Haversine arc-length.
 *
 * @param {[number,number][]} coords - Source polyline [lon, lat][]
 * @param {number} n - Number of output points (default 200)
 * @returns {[number,number][]}
 */
export function resampleLine(coords, n = 200) {
  if (coords.length === 0) return [];
  if (coords.length === 1) return Array.from({ length: n }, () => [...coords[0]]);

  const dists = [0];
  for (let i = 0; i < coords.length - 1; i++) {
    dists.push(dists[dists.length - 1] + haversineKm(coords[i], coords[i + 1]));
  }

  const total = dists[dists.length - 1];
  if (total === 0) return Array.from({ length: n }, () => [...coords[0]]);

  const step = total / (n - 1);
  const out = [[...coords[0]]];
  let target = step;
  let idx = 1;

  while (out.length < n - 1) {
    while (idx < dists.length && dists[idx] < target) idx++;
    if (idx >= coords.length) break;

    const prev = coords[idx - 1];
    const curr = coords[idx];
    const prevD = dists[idx - 1];
    const currD = dists[idx];

    if (currD === prevD) {
      out.push([...curr]);
    } else {
      const t = (target - prevD) / (currD - prevD);
      out.push([
        prev[0] + (curr[0] - prev[0]) * t,
        prev[1] + (curr[1] - prev[1]) * t,
      ]);
    }
    target += step;
  }

  out.push([...coords[coords.length - 1]]);
  while (out.length < n) out.push([...coords[coords.length - 1]]);

  return out;
}

/**
 * Compute the axis-aligned bounding box of a set of coordinates.
 * @param {[number,number][]} coords - Array of [lon, lat]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function bboxFromCoords(coords) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [lon, lat] of coords) {
    if (lon < minX) minX = lon;
    if (lat < minY) minY = lat;
    if (lon > maxX) maxX = lon;
    if (lat > maxY) maxY = lat;
  }

  return { minX, minY, maxX, maxY };
}
