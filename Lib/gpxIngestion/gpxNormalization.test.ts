import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCoordinateDistanceMeters,
  GpxGeometryTooShortError,
  GpxNormalizationError,
  normalizeGpxGeometry,
  normalizeGpxSegments,
} from "./gpxNormalization.ts";

test("computes haversine distance", () => {
  const distance = calculateCoordinateDistanceMeters([0, 0], [0, 0.001]);
  assert.ok(distance > 100 && distance < 130);
});

test("normalizes one segment with deterministic metrics and hashes", () => {
  const result = normalizeGpxSegments(
    [{
      points: [
        { coordinate: [8.5, 47, 1_000], time: "2026-01-01T10:00:00Z" },
        { coordinate: [8.51, 47.01, 1_200], time: "2026-01-01T10:10:00Z" },
        { coordinate: [8.52, 47.02, 1_100], time: "2026-01-01T10:20:00Z" },
      ],
    }],
    new TextEncoder().encode("<gpx/>"),
  );
  assert.equal(result.geometry.geometry.type, "LineString");
  assert.equal(result.geometry.pointCount, 3);
  assert.equal(result.geometry.minimumElevationM, 1_000);
  assert.equal(result.geometry.maximumElevationM, 1_200);
  assert.equal(result.geometry.elevationGainM, 200);
  assert.equal(result.geometry.durationSeconds, 1_200);
  assert.deepEqual(result.geometry.startCoordinate, [8.5, 47, 1_000]);
  assert.deepEqual(result.geometry.endCoordinate, [8.52, 47.02, 1_100]);
  assert.match(result.rawContentHash!, /^[0-9a-f]{64}$/);
});

test("preserves multiple trkseg boundaries as MultiLineString", () => {
  const result = normalizeGpxSegments(
    [
      { points: [
        { coordinate: [8.5, 47], time: null },
        { coordinate: [8.6, 47.1], time: null },
      ] },
      { points: [
        { coordinate: [8.7, 47.2], time: null },
        { coordinate: [8.8, 47.3], time: null },
      ] },
    ],
    null,
  );
  assert.equal(result.geometry.geometry.type, "MultiLineString");
  assert.equal(result.geometry.pointCount, 4);
  assert.equal(result.geometry.elevationGainM, null);
});

test("same normalized geometry produces stable level 2 identity", () => {
  const points = [[8.5, 47], [8.51, 47.01]] as const;
  const left = normalizeGpxGeometry(points).geometry.normalizedGeometryHash;
  const right = normalizeGpxGeometry(points).geometry.normalizedGeometryHash;
  assert.equal(left, right);
});

test("reversed route has different level 2 but same level 3 identity", () => {
  const points = [[8.5, 47], [8.51, 47.01], [8.52, 47.02]] as const;
  const forward = normalizeGpxGeometry(points).geometry;
  const reverse = normalizeGpxGeometry([...points].reverse()).geometry;
  assert.notEqual(forward.normalizedGeometryHash, reverse.normalizedGeometryHash);
  assert.equal(
    forward.directionNeutralGeometryHash,
    reverse.directionNeutralGeometryHash,
  );
});

test("rejects too-short, invalid, and point-bomb inputs", () => {
  assert.throws(() => normalizeGpxGeometry([[8.5, 47]]), GpxGeometryTooShortError);
  assert.throws(
    () => normalizeGpxGeometry([[999, 47], [8.5, 47]]),
    (error) => error instanceof GpxNormalizationError && error.code === "INVALID_COORDINATE",
  );
  assert.throws(
    () =>
      normalizeGpxGeometry(
        [[8.5, 47], [8.6, 47.1], [8.7, 47.2]],
        { maximumTrackPoints: 2 },
      ),
    (error) =>
      error instanceof GpxNormalizationError &&
      error.code === "POINT_LIMIT_EXCEEDED",
  );
});
