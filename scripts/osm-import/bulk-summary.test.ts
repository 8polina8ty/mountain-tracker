import assert from "node:assert/strict";
import test from "node:test";

import { OSM_ATTRIBUTION } from "./bulk-route-reconstruction.ts";
import {
  BULK_DIAGNOSTIC_SAMPLE_LIMIT,
  BulkSummaryCollector,
} from "./bulk-summary.ts";
import type {
  FinalAssociationResult,
  FinalSummitAssociation,
  RouteAnalysisResult,
} from "./route-analysis.ts";
import type { RouteSemanticType } from "./route-classifier.ts";
import type {
  RouteSimilarityClassification,
  RouteSimilarityResult,
} from "./route-similarity.ts";

function association(
  finalAssociation: FinalSummitAssociation,
  peakSourceId: string,
  finalConfidence = 0.8,
): FinalAssociationResult {
  return {
    peakSourceId,
    peakSourceUrl: `https://www.openstreetmap.org/node/${peakSourceId}`,
    peakName: `Peak ${peakSourceId}`,
    peakElevation: 2_500,
    geometricClassification:
      finalAssociation === "REJECTED" ? "REJECTED" : "MATCHED",
    geometricConfidence: finalConfidence,
    minDistanceMeters: Number(peakSourceId) || 1,
    endpointDistanceMeters: 5,
    nearEndpoint: true,
    routeSemanticType: "local_hike",
    finalAssociation,
    finalConfidence,
    reasons: [`${finalAssociation} fixture`],
  };
}

function analysis(
  routeSourceId: string,
  semanticType: RouteSemanticType,
  summitAssociations: FinalAssociationResult[],
): RouteAnalysisResult {
  return {
    routeSourceId,
    routeSourceUrl: `https://www.openstreetmap.org/relation/${routeSourceId}`,
    routeName: `Route ${routeSourceId}`,
    semanticType,
    semanticConfidence: 0.8,
    semanticReasons: [],
    qualityScore: 80,
    qualityReasons: [],
    routeMetadata: {
      ref: null,
      network: null,
      operator: null,
      routeType: "hiking",
      from: null,
      to: null,
      roundtrip: null,
      osmcSymbol: null,
      distanceMeters: 1_000,
      coordinatePoints: 10,
      geometryType: "LineString",
      componentCount: 1,
    },
    components: [],
    summitAssociations: summitAssociations.map((item) => ({
      ...item,
      routeSemanticType: semanticType,
    })),
  };
}

function comparison(
  sourceId: string,
  classification: RouteSimilarityClassification,
  approximateShapeSimilarity: number,
): RouteSimilarityResult {
  return {
    routeA: { sourceId: `${sourceId}a`, name: `Route ${sourceId}a` },
    routeB: { sourceId: `${sourceId}b`, name: `Route ${sourceId}b` },
    metrics: {
      routeALengthMeters: 1_000,
      routeBLengthMeters: 900,
      lengthRatio: 0.9,
      routeASampleCount: 20,
      routeBSampleCount: 18,
      componentCountA: 1,
      componentCountB: 1,
      endpointForwardDistanceMeters: 20,
      endpointReversedDistanceMeters: 900,
      directionIndependentEndpointDistanceMeters: 20,
      endpointScore: 0.8,
      componentEndpointCoverage: 1,
      routeAIsClosedLoop: false,
      routeBIsClosedLoop: false,
      coverageAByB: 0.9,
      coverageBByA: 0.85,
      symmetricCoverage: 0.85,
      identityCoverageAByB: 0.8,
      identityCoverageBByA: 0.75,
      identitySymmetricCoverage: 0.75,
      boundingBoxAgreement: 0.9,
      geometricIdentityScore: 0.75,
      strongGeometricIdentity: false,
      approximateShapeSimilarity,
      sharedConfirmedSummitIds: [],
      sharedAssociatedSummitIds: [],
    },
    classification,
    confidence: 0.75,
    reasons: [`${classification} fixture`],
  };
}

function routeFixtures(): RouteAnalysisResult[] {
  return [
    analysis("1", "local_hike", [
      association("CONFIRMED", "1", 0.9),
      association("REVIEW", "2", 0.8),
      association("REJECTED", "3", 0.2),
    ]),
    analysis("2", "summit_route", [
      association("CONFIRMED", "4", 0.95),
      association("CONFIRMED", "5", 0.85),
    ]),
    analysis("3", "long_distance_trail", [
      association("REVIEW", "6", 0.88),
      association("REVIEW", "7", 0.7),
    ]),
    analysis("4", "unknown", [association("REJECTED", "8", 0.1)]),
    analysis("5", "via_ferrata", []),
  ];
}

test("association aggregate counts include every final classification", () => {
  const collector = new BulkSummaryCollector();
  routeFixtures().forEach((route) => collector.addRouteAnalysis(route));

  assert.deepEqual(collector.build().summitAssociations, {
    CONFIRMED: 3,
    REVIEW: 3,
    REJECTED: 2,
  });
});

test("route aggregates distinguish multiple confirmed summits", () => {
  const collector = new BulkSummaryCollector();
  routeFixtures().forEach((route) => collector.addRouteAnalysis(route));

  assert.deepEqual(collector.build().routesBySummitAssociation, {
    withConfirmedSummit: 2,
    withExactlyOneConfirmedSummit: 1,
    withMultipleConfirmedSummits: 1,
    withReviewButNoConfirmed: 1,
    withNoConfirmedOrReview: 2,
    averageConfirmedAssociationsPerRouteWithConfirmed: 1.5,
    maximumConfirmedSummitsOnOneRoute: 2,
  });
});

test("REVIEW-only routes are not counted as confirmed or unassociated", () => {
  const collector = new BulkSummaryCollector();
  collector.addRouteAnalysis(
    analysis("review", "local_hike", [association("REVIEW", "1")]),
  );

  const counts = collector.build().routesBySummitAssociation;
  assert.equal(counts.withConfirmedSummit, 0);
  assert.equal(counts.withReviewButNoConfirmed, 1);
  assert.equal(counts.withNoConfirmedOrReview, 0);
});

test("semantic association cross-tab retains association classifications", () => {
  const collector = new BulkSummaryCollector();
  routeFixtures().forEach((route) => collector.addRouteAnalysis(route));

  const crossTab = collector.build().semanticAssociationCrossTab;
  assert.deepEqual(crossTab.local_hike, {
    CONFIRMED: 1,
    REVIEW: 1,
    REJECTED: 1,
  });
  assert.deepEqual(crossTab.summit_route, {
    CONFIRMED: 2,
    REVIEW: 0,
    REJECTED: 0,
  });
  assert.deepEqual(crossTab.long_distance_trail, {
    CONFIRMED: 0,
    REVIEW: 2,
    REJECTED: 0,
  });
});

test("confirmed diagnostic sample is bounded and keeps the top confidence", () => {
  const collector = new BulkSummaryCollector();
  for (let index = 0; index < 30; index += 1) {
    collector.addRouteAnalysis(
      analysis(String(index), "summit_route", [
        association("CONFIRMED", String(index), index / 100),
      ]),
    );
  }

  const sample = collector.build().diagnosticSamples.confirmedAssociations;
  assert.equal(sample.length, BULK_DIAGNOSTIC_SAMPLE_LIMIT);
  assert.equal(sample[0].finalConfidence, 0.29);
  assert.equal(sample.at(-1)?.finalConfidence, 0.05);
  assert.deepEqual(Object.keys(sample[0]), [
    "routeSourceId",
    "routeName",
    "semanticType",
    "routeQualityScore",
    "peakSourceId",
    "peakName",
    "peakElevationMeters",
    "minimumGeometryDistanceMeters",
    "endpointDistanceMeters",
    "finalConfidence",
    "reasons",
  ]);
});

test("review diagnostic sample is bounded and confidence-sorted", () => {
  const collector = new BulkSummaryCollector();
  for (let index = 29; index >= 0; index -= 1) {
    collector.addRouteAnalysis(
      analysis(String(index), "local_hike", [
        association("REVIEW", String(index), index / 100),
      ]),
    );
  }

  const sample = collector.build().diagnosticSamples.reviewAssociations;
  assert.equal(sample.length, BULK_DIAGNOSTIC_SAMPLE_LIMIT);
  assert.equal(sample[0].finalConfidence, 0.29);
  assert.equal(sample.at(-1)?.finalConfidence, 0.05);
});

test("similarity classification aggregate counts cover all Phase 4 outcomes", () => {
  const collector = new BulkSummaryCollector();
  const classifications: RouteSimilarityClassification[] = [
    "EXACT_DUPLICATE",
    "NEAR_DUPLICATE",
    "SAME_VARIANT",
    "DIFFERENT_VARIANT",
    "UNRELATED",
  ];
  classifications.forEach((classification, index) =>
    collector.addSimilarity(comparison(String(index), classification, 0.9)),
  );

  assert.deepEqual(collector.build().similarityClassifications, {
    EXACT_DUPLICATE: 1,
    NEAR_DUPLICATE: 1,
    SAME_VARIANT: 1,
    DIFFERENT_VARIANT: 1,
    UNRELATED: 1,
  });
});

test("highest-similarity non-duplicate list is bounded and excludes duplicates", () => {
  const collector = new BulkSummaryCollector();
  collector.addSimilarity(comparison("exact", "EXACT_DUPLICATE", 1));
  collector.addSimilarity(comparison("near", "NEAR_DUPLICATE", 0.99));
  for (let index = 0; index < 30; index += 1) {
    collector.addSimilarity(
      comparison(String(index), "SAME_VARIANT", index / 100),
    );
  }

  const sample = collector.build().diagnosticSamples
    .highestSimilarityNonDuplicatePairs;
  assert.equal(sample.length, BULK_DIAGNOSTIC_SAMPLE_LIMIT);
  assert.equal(sample[0].approximateShapeSimilarity, 0.29);
  assert.equal(sample.at(-1)?.approximateShapeSimilarity, 0.05);
  assert.ok(
    sample.every(
      (item) =>
        item.classification !== "EXACT_DUPLICATE" &&
        item.classification !== "NEAR_DUPLICATE",
    ),
  );
});

test("OpenStreetMap attribution serializes as correct UTF-8", () => {
  const json = JSON.stringify({ attribution: OSM_ATTRIBUTION });
  const bytes = Buffer.from(json, "utf8");

  assert.equal(OSM_ATTRIBUTION, "\u00a9 OpenStreetMap contributors");
  assert.equal(json.includes("Â"), false);
  assert.notEqual(bytes.indexOf(Buffer.from([0xc2, 0xa9])), -1);
  assert.equal(JSON.parse(bytes.toString("utf8")).attribution, OSM_ATTRIBUTION);
});

test("summary observability is deterministic across input order", () => {
  const routes = routeFixtures();
  const comparisons = [
    comparison("1", "SAME_VARIANT", 0.8),
    comparison("2", "UNRELATED", 0.3),
    comparison("3", "DIFFERENT_VARIANT", 0.7),
  ];
  const forward = new BulkSummaryCollector();
  routes.forEach((route) => forward.addRouteAnalysis(route));
  comparisons.forEach((item) => forward.addSimilarity(item));
  const reverse = new BulkSummaryCollector();
  routes.toReversed().forEach((route) => reverse.addRouteAnalysis(route));
  comparisons.toReversed().forEach((item) => reverse.addSimilarity(item));

  assert.deepEqual(reverse.build(), forward.build());
});
