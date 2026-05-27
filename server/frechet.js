/**
 * frechet.js — Trajectory alignment engine (JS port)
 *
 * Discrete Fréchet Distance between a reference railway route and
 * inspection coordinates, using Haversine km for deviation metrics.
 * Includes DP traceback to identify the exact max-deviation point.
 */

import { haversineKm, resampleLine } from "./geo-utils.js";

const RESAMPLE_POINTS = 200;
const DEFAULT_THRESHOLD_KM = 2.0;

/**
 * Bottom-up DP for Discrete Fréchet Distance.
 * @param {[number,number][]} p - Reference polyline (resampled)
 * @param {[number,number][]} q - Inspection polyline (resampled)
 * @returns {{ matrix: number[][], distance: number }}
 */
function computeFrechetMatrix(p, q) {
  const n = p.length;
  const m = q.length;

  if (n === 0 || m === 0) {
    return { matrix: [], distance: Infinity };
  }

  const ca = Array.from({ length: n }, () => Array(m).fill(0));

  ca[0][0] = haversineKm(p[0], q[0]);

  for (let i = 1; i < n; i++) {
    ca[i][0] = Math.max(ca[i - 1][0], haversineKm(p[i], q[0]));
  }

  for (let j = 1; j < m; j++) {
    ca[0][j] = Math.max(ca[0][j - 1], haversineKm(p[0], q[j]));
  }

  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      const d = haversineKm(p[i], q[j]);
      ca[i][j] = Math.max(
        Math.min(ca[i - 1][j], ca[i - 1][j - 1], ca[i][j - 1]),
        d,
      );
    }
  }

  return { matrix: ca, distance: ca[n - 1][m - 1] };
}

/**
 * Walk back through the DP matrix to find the max-deviation pair.
 * @param {[number,number][]} p
 * @param {[number,number][]} q
 * @param {number[][]} ca
 * @returns {{ reference_point: [number,number], inspection_point: [number,number], deviation_km: number }}
 */
function findMaxDeviationPoint(p, q, ca) {
  let maxDev = 0;
  let maxRef = p[0];
  let maxInsp = q[0];

  let i = p.length - 1;
  let j = q.length - 1;

  while (i > 0 || j > 0) {
    const d = haversineKm(p[i], q[j]);
    if (d > maxDev) {
      maxDev = d;
      maxRef = p[i];
      maxInsp = q[j];
    }

    if (i === 0) {
      j--;
    } else if (j === 0) {
      i--;
    } else {
      const diag = ca[i - 1][j - 1];
      const left = ca[i][j - 1];
      const up = ca[i - 1][j];

      if (diag <= left && diag <= up) {
        i--;
        j--;
      } else if (up <= left) {
        i--;
      } else {
        j--;
      }
    }
  }

  const d0 = haversineKm(p[0], q[0]);
  if (d0 > maxDev) {
    maxDev = d0;
    maxRef = p[0];
    maxInsp = q[0];
  }

  return {
    reference_point: maxRef,
    inspection_point: maxInsp,
    deviation_km: Math.round(maxDev * 100) / 100,
  };
}

/**
 * Verify alignment of inspection coordinates against a reference route.
 *
 * @param {string} routeId - Train number
 * @param {[number,number][]} inspectionCoordinates - [lon, lat] pairs
 * @param {import('./spatial-index.js').SpatialIndex} spatialIndex
 * @param {number} thresholdKm - Compliance threshold (default 2.0 km)
 * @returns {object} AlignmentResult
 */
export function verifyAlignment(routeId, inspectionCoordinates, spatialIndex, thresholdKm = DEFAULT_THRESHOLD_KM) {
  const route = spatialIndex.getRouteById(routeId);
  if (!route) {
    throw new Error(`Route not found: train_no="${routeId}". Check the route ID and try again.`);
  }

  const referenceCoords = route.route_line;
  if (!referenceCoords || referenceCoords.length < 2) {
    throw new Error(`Route ${routeId} has insufficient coordinate data.`);
  }

  if (inspectionCoordinates.length < 2) {
    throw new Error("Inspection coordinates must contain at least 2 points.");
  }

  const refResampled = resampleLine(referenceCoords, RESAMPLE_POINTS);
  const inspResampled = resampleLine(inspectionCoordinates, RESAMPLE_POINTS);

  const { matrix, distance } = computeFrechetMatrix(refResampled, inspResampled);
  const maxDeviation = findMaxDeviationPoint(refResampled, inspResampled, matrix);

  const frechetRounded = Math.round(distance * 100) / 100;

  return {
    status: frechetRounded <= thresholdKm ? "COMPLIANT" : "MISALIGNMENT_DETECTED",
    frechet_distance_km: frechetRounded,
    compliance_threshold_km: thresholdKm,
    max_deviation: maxDeviation,
    reference_point_count: RESAMPLE_POINTS,
    inspection_point_count: RESAMPLE_POINTS,
    route_info: {
      train_no: route.train_no,
      train_name: route.train_name,
      route_length_km: Math.round(route.route_length_km * 100) / 100,
    },
  };
}
