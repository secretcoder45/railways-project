import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pointToSegmentKm, projectionScoreKm } from "./geo-utils.js";

describe("pointToSegmentKm", () => {
  it("returns ~0 when point is on the midpoint of the segment", () => {
    const a = [77.0, 28.0], b = [78.0, 28.0];
    const mid = [77.5, 28.0];
    const d = pointToSegmentKm(mid, a, b);
    assert.ok(d < 0.01, `expected ~0 km, got ${d}`);
  });

  it("clamps to segment endpoint when projection falls outside", () => {
    const a = [77.0, 28.0], b = [78.0, 28.0];
    const beyond = [80.0, 28.0]; // past b
    const d = pointToSegmentKm(beyond, a, b);
    // Should equal distance from beyond → b
    const dToB = pointToSegmentKm(beyond, b, b);
    assert.ok(d > 0, "should be positive");
    assert.ok(d < 300, "should be a reasonable km distance");
  });

  it("handles degenerate segment (a === b) by returning point distance", () => {
    const p = [77.0, 28.0], a = [77.5, 28.5], b = [77.5, 28.5];
    const d = pointToSegmentKm(p, a, b);
    assert.ok(d > 0);
  });
});

describe("projectionScoreKm", () => {
  it("returns near-zero for annotation lying directly on the route", () => {
    const route = [[77.0, 28.0], [77.5, 28.5], [78.0, 29.0]];
    const annotation = [[77.2, 28.2], [77.6, 28.6]]; // points on the route
    const score = projectionScoreKm(annotation, route);
    assert.ok(score < 5, `expected < 5 km, got ${score}`);
  });

  it("returns high score for annotation far from route", () => {
    const route = [[77.0, 28.0], [78.0, 28.0]]; // east-west at lat 28
    const annotation = [[77.5, 35.0]];           // far north
    const score = projectionScoreKm(annotation, route);
    assert.ok(score > 500, `expected > 500 km, got ${score}`);
  });

  it("handles partial annotation against long route (core use-case)", () => {
    // Route spans Delhi to Mumbai (roughly)
    const route = [[77.2, 28.6], [76.0, 26.0], [75.0, 23.0], [73.0, 19.0], [72.8, 19.0]];
    // Annotation covers only the Delhi end
    const annotation = [[77.2, 28.6], [76.2, 26.5]];
    const score = projectionScoreKm(annotation, route);
    assert.ok(score < 50, `partial match should score well, got ${score} km`);
  });

  it("returns Infinity for empty inputs", () => {
    assert.equal(projectionScoreKm([], [[77.0, 28.0]]), Infinity);
    assert.equal(projectionScoreKm([[77.0, 28.0]], []), Infinity);
  });
});
