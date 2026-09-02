import assert from "node:assert/strict";
import test from "node:test";

import type {
  Coordinate,
  PeakMatchCandidate,
  RouteGeometry,
} from "./peak-matcher.ts";
import {
  analyzeComponentEndpoints,
  analyzeRoute,
  decideSummitAssociation,
} from "./route-analysis.ts";
import {
  calculateRouteQuality,
  classifyRouteSemantics,
  type ClassifiableRoute,
  type RouteSemanticClassification,
} from "./route-classifier.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;

function coordinateFromMeters(east: number, north: number): Coordinate {
  return [
    (east / EARTH_RADIUS_METERS) * (180 / Math.PI),
    (north / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function route(
  overrides: Partial<ClassifiableRoute> & {
    geometry?: RouteGeometry;
  } = {},
): ClassifiableRoute {
  const geometry: RouteGeometry = overrides.geometry ?? {
    type: "LineString",
    coordinates: [coordinateFromMeters(0, 0), coordinateFromMeters(1_000, 0)],
  };
  const components =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.coordinates;

  return {
    sourceId: "route-1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    name: "Local ridge hike",
    ref: null,
    network: "lwn",
    operator: null,
    stats: {
      distanceMeters: 5_000,
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
      osmcSymbol: "red:red:white_bar",
      tags: {},
    },
    ...overrides,
    geometry,
  };
}

function candidate(
  overrides: Partial<PeakMatchCandidate> = {},
): PeakMatchCandidate {
  return {
    peakSourceId: "peak-1",
    peakSourceUrl: "https://www.openstreetmap.org/node/1",
    peakName: "Testspitze",
    peakElevation: 2_500,
    peakCoordinate: coordinateFromMeters(1_000, 0),
    minDistanceMeters: 0,
    nearestRouteCoordinate: coordinateFromMeters(1_000, 0),
    componentIndex: 0,
    segmentIndex: 0,
    projectionFraction: 1,
    endpointDistanceMeters: 0,
    nearestEndpointCoordinate: coordinateFromMeters(1_000, 0),
    nearestEndpointComponentIndex: 0,
    nearestEndpointPosition: "end",
    nearEndpoint: true,
    classification: "MATCHED",
    confidence: 0.98,
    reasons: [],
    ...overrides,
  };
}

function semantics(
  semanticType: RouteSemanticClassification["semanticType"],
): RouteSemanticClassification {
  return { semanticType, confidence: 0.8, reasons: ["test semantics"] };
}

test("exact summit endpoint produces summit semantics and CONFIRMED association", () => {
  const exactCandidate = candidate();
  const classification = classifyRouteSemantics(route(), [exactCandidate]);
  const association = decideSummitAssociation(exactCandidate, classification);

  assert.equal(classification.semanticType, "summit_route");
  assert.equal(association.finalAssociation, "CONFIRMED");
});

test("long-distance trail passing near a peak is not confirmed", () => {
  const longRoute = route({
    name: "[E4] Europäischer Fernwanderweg",
    ref: "E4",
    network: "iwn",
    stats: { distanceMeters: 80_000, coordinatePoints: 2, componentCount: 1 },
  });
  const possibleCandidate = candidate({
    minDistanceMeters: 85,
    endpointDistanceMeters: 2_000,
    nearEndpoint: false,
    classification: "POSSIBLE",
    confidence: 0.59,
  });
  const classification = classifyRouteSemantics(longRoute, [possibleCandidate]);
  const association = decideSummitAssociation(possibleCandidate, classification);

  assert.equal(classification.semanticType, "long_distance_trail");
  assert.equal(association.finalAssociation, "REVIEW");
});

test("POSSIBLE geometry cannot automatically confirm", () => {
  const association = decideSummitAssociation(
    candidate({
      minDistanceMeters: 100,
      endpointDistanceMeters: 100,
      classification: "POSSIBLE",
      confidence: 0.5,
    }),
    semantics("summit_route"),
  );

  assert.equal(association.finalAssociation, "REVIEW");
});

test("unknown route ending exactly at a summit can be confirmed", () => {
  const association = decideSummitAssociation(
    candidate(),
    semantics("unknown"),
  );

  assert.equal(association.finalAssociation, "CONFIRMED");
});

test("fragmented MultiLineString preserves component endpoint analysis", () => {
  const fragmented = route({
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [coordinateFromMeters(0, 0), coordinateFromMeters(100, 0)],
        [coordinateFromMeters(900, 0), coordinateFromMeters(1_000, 0)],
      ],
    },
  });
  const endpoints = analyzeComponentEndpoints(fragmented, [
    {
      sourceId: "peak-1",
      sourceUrl: "https://www.openstreetmap.org/node/1",
      name: "End peak",
      coordinates: coordinateFromMeters(1_000, 0),
      elevationMeters: 2_000,
    },
  ]);

  assert.equal(endpoints.length, 2);
  assert.deepEqual(endpoints[0].end, coordinateFromMeters(100, 0));
  assert.deepEqual(endpoints[1].start, coordinateFromMeters(900, 0));
  assert.equal(endpoints[1].nearestEndPeak?.distanceMeters, 0);
});

test("named local-scale route is classified as local_hike", () => {
  const classification = classifyRouteSemantics(
    route({ name: "Ehrwalder Rundweg", network: "lwn" }),
    [],
  );

  assert.equal(classification.semanticType, "local_hike");
});

test("explicit via ferrata identity requires and uses supporting route evidence", () => {
  const classification = classifyRouteSemantics(
    route({
      name: "Adler Klettersteig",
      network: "rwn",
      metadata: {
        route: "hiking",
        from: null,
        to: null,
        roundtrip: null,
        osmcSymbol: "red:red:white_bar",
        tags: {},
      },
    }),
    [],
  );

  assert.equal(classification.semanticType, "via_ferrata");
});

test("route with no nearby peaks has no summit association", () => {
  const analysis = analyzeRoute(route(), [], []);

  assert.equal(analysis.summitAssociations.length, 0);
  assert.equal(analysis.components[0].nearestStartPeak, null);
  assert.equal(analysis.components[0].nearestEndPeak, null);
});

test("quality score penalizes fragmented geometry", () => {
  const connected = route();
  const fragmentedGeometry: Coordinate[][] = Array.from(
    { length: 10 },
    (_, index) => [
      coordinateFromMeters(index * 100, 0),
      coordinateFromMeters(index * 100 + 50, 0),
    ],
  );
  const fragmented = route({
    geometry: { type: "MultiLineString", coordinates: fragmentedGeometry },
    stats: {
      distanceMeters: 5_000,
      coordinatePoints: 20,
      componentCount: 10,
    },
  });

  assert.ok(
    calculateRouteQuality(fragmented).score < calculateRouteQuality(connected).score,
  );
});

test("long-distance exact summit crossing and endpoint both remain review-only", () => {
  const longSemantics = semantics("long_distance_trail");
  const crossing = decideSummitAssociation(
    candidate({ endpointDistanceMeters: 500, nearEndpoint: false }),
    longSemantics,
  );
  const endpoint = decideSummitAssociation(candidate(), longSemantics);

  assert.equal(crossing.finalAssociation, "REVIEW");
  assert.equal(endpoint.finalAssociation, "REVIEW");
  assert.ok(endpoint.finalConfidence > crossing.finalConfidence);
});
