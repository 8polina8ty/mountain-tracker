import assert from "node:assert/strict";
import test from "node:test";

import {
  matchPeaksToRoute,
  matchPeakToRoute,
  type Coordinate,
  type MatchablePeak,
  type MatchableRoute,
  type RouteGeometry,
} from "./peak-matcher.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;

function coordinateFromMeters(east: number, north: number): Coordinate {
  return [
    (east / EARTH_RADIUS_METERS) * (180 / Math.PI),
    (north / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function route(geometry: RouteGeometry): MatchableRoute {
  const components =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.coordinates;

  return {
    sourceId: "route-1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    name: "Test route",
    ref: null,
    network: null,
    operator: null,
    geometry,
    stats: {
      distanceMeters: 0,
      coordinatePoints: components.reduce(
        (total, component) => total + component.length,
        0,
      ),
      componentCount: components.length,
    },
    metadata: {
      route: "hiking",
      from: null,
      to: null,
      roundtrip: null,
      osmcSymbol: null,
    },
  };
}

function peak(
  sourceId: string,
  coordinates: Coordinate,
  name = `Peak ${sourceId}`,
): MatchablePeak {
  return {
    sourceId,
    sourceUrl: `https://www.openstreetmap.org/node/${sourceId}`,
    name,
    coordinates,
    elevationMeters: 2_000,
  };
}

function horizontalRoute(startMeters: number, endMeters: number): MatchableRoute {
  return route({
    type: "LineString",
    coordinates: [
      coordinateFromMeters(startMeters, 0),
      coordinateFromMeters(endMeters, 0),
    ],
  });
}

test("peak directly on a segment is MATCHED", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-100, 100),
    peak("1", coordinateFromMeters(25, 0)),
  );

  assert.ok(candidate);
  assert.equal(candidate.classification, "MATCHED");
  assert.ok(candidate.minDistanceMeters < 0.1);
});

test("segment projection finds a peak between widely spaced coordinates", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-2_000, 2_000),
    peak("2", coordinateFromMeters(0, 10)),
  );

  assert.ok(candidate);
  assert.ok(Math.abs(candidate.minDistanceMeters - 10) < 0.2);
  assert.ok(Math.abs(candidate.projectionFraction - 0.5) < 0.001);
});

test("peak 20 m from route is MATCHED", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-500, 500),
    peak("3", coordinateFromMeters(0, 20)),
  );

  assert.ok(candidate);
  assert.equal(candidate.classification, "MATCHED");
  assert.ok(Math.abs(candidate.minDistanceMeters - 20) < 0.2);
});

test("peak 100 m from route is POSSIBLE", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-500, 500),
    peak("4", coordinateFromMeters(0, 100)),
  );

  assert.ok(candidate);
  assert.equal(candidate.classification, "POSSIBLE");
  assert.ok(Math.abs(candidate.minDistanceMeters - 100) < 0.2);
});

test("peak more than 150 m from route is REJECTED inside candidate radius", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-500, 500),
    peak("5", coordinateFromMeters(0, 200)),
  );

  assert.ok(candidate);
  assert.equal(candidate.classification, "REJECTED");
  assert.ok(Math.abs(candidate.minDistanceMeters - 200) < 0.2);
});

test("MultiLineString gap is not treated as a route segment", () => {
  const candidate = matchPeakToRoute(
    route({
      type: "MultiLineString",
      coordinates: [
        [coordinateFromMeters(-100, 0), coordinateFromMeters(-50, 0)],
        [coordinateFromMeters(50, 0), coordinateFromMeters(100, 0)],
      ],
    }),
    peak("6", coordinateFromMeters(0, 0)),
  );

  assert.ok(candidate);
  assert.ok(Math.abs(candidate.minDistanceMeters - 50) < 0.2);
  const expectedEndpoint = coordinateFromMeters(-50, 0);
  assert.ok(
    Math.abs(candidate.nearestRouteCoordinate[0] - expectedEndpoint[0]) < 1e-7,
  );
  assert.equal(candidate.nearestRouteCoordinate[1], expectedEndpoint[1]);
});

test("endpoint-assisted rule produces MATCHED classification", () => {
  const candidate = matchPeakToRoute(
    horizontalRoute(-100, 0),
    peak("7", coordinateFromMeters(50, 0)),
  );

  assert.ok(candidate);
  assert.equal(candidate.classification, "MATCHED");
  assert.equal(candidate.nearEndpoint, true);
  assert.ok(Math.abs(candidate.endpointDistanceMeters - 50) < 0.2);
});

test("one route can match multiple peaks", () => {
  const candidates = matchPeaksToRoute(horizontalRoute(-500, 500), [
    peak("8", coordinateFromMeters(-100, 10)),
    peak("9", coordinateFromMeters(100, 20)),
    peak("10", coordinateFromMeters(0, 600)),
  ]);

  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((candidate) => candidate.classification),
    ["MATCHED", "MATCHED"],
  );
});
