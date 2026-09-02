import assert from "node:assert/strict";
import test from "node:test";

import type { Coordinate, RouteGeometry } from "./peak-matcher.ts";
import { normalizeRouteGeometry, reverseRouteGeometry } from "./route-geometry.ts";
import { buildDuplicateGroups } from "./route-groups.ts";
import {
  compareRoutes,
  type ComparableRoute,
  type RouteSimilarityResult,
} from "./route-similarity.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;

function coordinateFromMeters(east: number, north: number): Coordinate {
  const latitude = 47;
  return [
    11 +
      (east /
        (EARTH_RADIUS_METERS * Math.cos((latitude * Math.PI) / 180))) *
        (180 / Math.PI),
    latitude + (north / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function line(points: Array<[east: number, north: number]>): RouteGeometry {
  return {
    type: "LineString",
    coordinates: points.map(([east, north]) =>
      coordinateFromMeters(east, north),
    ),
  };
}

function route(
  sourceId: string,
  geometry: RouteGeometry,
  confirmedPeakIds: string[] = [],
  name = `Route ${sourceId}`,
): ComparableRoute {
  return {
    sourceId,
    name,
    geometry,
    summitEvidence: {
      confirmedPeakIds,
      associatedPeakIds: [...confirmedPeakIds],
    },
  };
}

function fakeComparison(
  sourceIdA: string,
  sourceIdB: string,
  classification: RouteSimilarityResult["classification"],
): RouteSimilarityResult {
  return {
    routeA: { sourceId: sourceIdA, name: `Route ${sourceIdA}` },
    routeB: { sourceId: sourceIdB, name: `Route ${sourceIdB}` },
    metrics: {
      routeALengthMeters: 1_000,
      routeBLengthMeters: 1_000,
      lengthRatio: 1,
      routeASampleCount: 41,
      routeBSampleCount: 41,
      componentCountA: 1,
      componentCountB: 1,
      endpointForwardDistanceMeters: 0,
      endpointReversedDistanceMeters: 1_000,
      directionIndependentEndpointDistanceMeters: 0,
      endpointScore: 1,
      componentEndpointCoverage: 1,
      routeAIsClosedLoop: false,
      routeBIsClosedLoop: false,
      coverageAByB: 1,
      coverageBByA: 1,
      symmetricCoverage: 1,
      identityCoverageAByB: 1,
      identityCoverageBByA: 1,
      identitySymmetricCoverage: 1,
      boundingBoxAgreement: 1,
      geometricIdentityScore: 1,
      strongGeometricIdentity: true,
      approximateShapeSimilarity: 1,
      sharedConfirmedSummitIds: [],
      sharedAssociatedSummitIds: [],
    },
    classification,
    confidence: 1,
    reasons: [],
  };
}

test("identical geometry is an EXACT_DUPLICATE", () => {
  const geometry = line([
    [0, 0],
    [1_000, 0],
  ]);
  assert.equal(
    compareRoutes(route("a", geometry), route("b", geometry)).classification,
    "EXACT_DUPLICATE",
  );
});

test("reversed identical geometry is direction-independent", () => {
  const geometry = line([
    [0, 0],
    [500, 200],
    [1_000, 0],
  ]);
  assert.equal(
    compareRoutes(
      route("a", geometry),
      route("b", reverseRouteGeometry(geometry)),
    ).classification,
    "EXACT_DUPLICATE",
  );
});

test("identical MultiLineString components compare independent of order", () => {
  const first: RouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [coordinateFromMeters(0, 0), coordinateFromMeters(500, 0)],
      [coordinateFromMeters(1_000, 0), coordinateFromMeters(1_500, 0)],
    ],
  };
  const reordered: RouteGeometry = {
    type: "MultiLineString",
    coordinates: [...first.coordinates].reverse(),
  };
  const result = compareRoutes(route("a", first), route("b", reordered));

  assert.equal(result.metrics.endpointScore, 0);
  assert.equal(result.metrics.strongGeometricIdentity, true);
  assert.equal(result.classification, "EXACT_DUPLICATE");
});

test("identical MultiLineString components compare independent of direction", () => {
  const first: RouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [coordinateFromMeters(0, 0), coordinateFromMeters(500, 0)],
      [coordinateFromMeters(1_000, 0), coordinateFromMeters(1_500, 0)],
    ],
  };
  const reversedComponents: RouteGeometry = {
    type: "MultiLineString",
    coordinates: first.coordinates.map((component) => [...component].reverse()),
  };

  assert.equal(
    compareRoutes(route("a", first), route("b", reversedComponents))
      .classification,
    "EXACT_DUPLICATE",
  );
});

test("same closed loop with a different starting point is an exact duplicate", () => {
  const original = line([
    [0, 0],
    [200, 0],
    [200, 200],
    [0, 200],
    [0, 0],
  ]);
  const shifted = line([
    [200, 200],
    [0, 200],
    [0, 0],
    [200, 0],
    [200, 200],
  ]);
  const result = compareRoutes(route("a", original), route("b", shifted));

  assert.equal(result.metrics.routeAIsClosedLoop, true);
  assert.equal(result.metrics.routeBIsClosedLoop, true);
  assert.equal(result.classification, "EXACT_DUPLICATE");
});

test("same closed loop reversed is an exact duplicate", () => {
  const original = line([
    [0, 0],
    [200, 0],
    [200, 200],
    [0, 200],
    [0, 0],
  ]);

  assert.equal(
    compareRoutes(
      route("a", original),
      route("b", reverseRouteGeometry(original)),
    ).classification,
    "EXACT_DUPLICATE",
  );
});

test("different sampling density still detects the same route", () => {
  const sparse = line([
    [0, 0],
    [2_000, 0],
  ]);
  const dense = line(
    Array.from({ length: 21 }, (_, index) => [index * 100, 0]),
  );
  assert.equal(
    compareRoutes(route("a", sparse), route("b", dense)).classification,
    "EXACT_DUPLICATE",
  );
});

test("small GPS offset remains duplicate-level", () => {
  const original = line([
    [0, 0],
    [1_000, 0],
  ]);
  const noisy = line([
    [0, 5],
    [1_000, 5],
  ]);
  assert.equal(
    compareRoutes(route("a", original), route("b", noisy)).classification,
    "EXACT_DUPLICATE",
  );
});

test("route with a trimmed start is a NEAR_DUPLICATE", () => {
  const full = line([
    [0, 0],
    [2_000, 0],
  ]);
  const trimmed = line([
    [100, 0],
    [2_000, 0],
  ]);
  assert.equal(
    compareRoutes(route("a", full), route("b", trimmed)).classification,
    "NEAR_DUPLICATE",
  );
});

test("short route contained in a long route is not a duplicate", () => {
  const long = line([
    [0, 0],
    [3_000, 0],
  ]);
  const subset = line([
    [1_200, 0],
    [1_800, 0],
  ]);
  const result = compareRoutes(route("a", long), route("b", subset));

  assert.ok(result.metrics.coverageBByA > 0.98);
  assert.ok(result.metrics.coverageAByB < 0.3);
  assert.notEqual(result.classification, "EXACT_DUPLICATE");
  assert.notEqual(result.classification, "NEAR_DUPLICATE");
});

test("shared approach followed by divergence is SAME_VARIANT", () => {
  const first = line([
    [0, 0],
    [1_000, 0],
    [2_000, 0],
  ]);
  const second = line([
    [0, 0],
    [1_000, 0],
    [2_000, 1_000],
  ]);
  assert.equal(
    compareRoutes(route("a", first), route("b", second)).classification,
    "SAME_VARIANT",
  );
});

test("same confirmed summit with different corridors is DIFFERENT_VARIANT", () => {
  const first = line([
    [0, 0],
    [1_000, 0],
  ]);
  const second = line([
    [0, 1_000],
    [1_000, 1_000],
  ]);
  assert.equal(
    compareRoutes(
      route("a", first, ["summit"]),
      route("b", second, ["summit"]),
    ).classification,
    "DIFFERENT_VARIANT",
  );
});

test("geographically separate routes are UNRELATED", () => {
  assert.equal(
    compareRoutes(
      route("a", line([[0, 0], [1_000, 0]])),
      route("b", line([[10_000, 0], [11_000, 0]])),
    ).classification,
    "UNRELATED",
  );
});

test("identical geometry duplicates despite different route names", () => {
  const geometry = line([
    [0, 0],
    [1_000, 0],
  ]);

  assert.equal(
    compareRoutes(
      route("a", geometry, [], "North Ridge"),
      route("b", geometry, [], "Completely Different Name"),
    ).classification,
    "EXACT_DUPLICATE",
  );
});

test("similar route names do not duplicate different geometry", () => {
  assert.equal(
    compareRoutes(
      route("a", line([[0, 0], [1_000, 0]]), [], "Summit Trail"),
      route(
        "b",
        line([[0, 2_000], [1_000, 2_000]]),
        [],
        "Summit Trail Variant",
      ),
    ).classification,
    "UNRELATED",
  );
});

test("MultiLineString normalization preserves gaps", () => {
  const normalized = normalizeRouteGeometry({
    type: "MultiLineString",
    coordinates: [
      [coordinateFromMeters(0, 0), coordinateFromMeters(100, 0)],
      [coordinateFromMeters(900, 0), coordinateFromMeters(1_000, 0)],
    ],
  });

  assert.equal(normalized.components.length, 2);
  assert.ok(normalized.lengthMeters < 250);
  assert.ok(
    normalized.components.every((component) =>
      component.every(
        (coordinate) =>
          calculateEastOffset(coordinate) < 200 ||
          calculateEastOffset(coordinate) > 800,
      ),
    ),
  );
});

test("duplicate grouping excludes SAME_VARIANT relationships", () => {
  const grouped = buildDuplicateGroups(
    [
      { sourceId: "1", name: "One", qualityScore: 80, metadataRichness: 3 },
      { sourceId: "2", name: "Two", qualityScore: 90, metadataRichness: 3 },
      { sourceId: "3", name: "Three", qualityScore: 100, metadataRichness: 5 },
    ],
    [
      fakeComparison("1", "2", "NEAR_DUPLICATE"),
      fakeComparison("2", "3", "SAME_VARIANT"),
    ],
  );

  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(grouped.groups[0].memberSourceIds, ["1", "2"]);
  assert.deepEqual(grouped.ungroupedSourceIds, ["3"]);
});

test("canonical selection is deterministic by quality, metadata, then source ID", () => {
  const grouped = buildDuplicateGroups(
    [
      { sourceId: "10", name: "Ten", qualityScore: 90, metadataRichness: 4 },
      { sourceId: "2", name: "Two", qualityScore: 90, metadataRichness: 4 },
      { sourceId: "3", name: "Three", qualityScore: 80, metadataRichness: 9 },
    ],
    [
      fakeComparison("10", "2", "EXACT_DUPLICATE"),
      fakeComparison("2", "3", "NEAR_DUPLICATE"),
    ],
  );

  assert.equal(grouped.groups[0].canonicalSourceId, "2");
});

function calculateEastOffset(coordinate: Coordinate): number {
  return (
    (coordinate[0] - 11) *
    (Math.PI / 180) *
    EARTH_RADIUS_METERS *
    Math.cos((47 * Math.PI) / 180)
  );
}
