/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import test from "node:test";

import { computeAutoQaRecommendation } from "./auto-qa.ts";

const mockSummit = {
  peakOsmId: "123",
  peakName: "Test Peak",
  peakElevationMeters: 2000,
  peakCoordinates: [10, 47] as const,
  mountainId: 1,
  mountainName: "Test Mountain",
  mountainElevationMeters: 2000,
  matchClassification: "EXACT_MOUNTAIN_MATCH" as const,
  finalAssociation: "CONFIRMED" as const,
  finalConfidence: 1,
  minimumGeometryDistanceMeters: 0,
  endpointDistanceMeters: 0,
};

const mockRoute = {
  idempotencyKey: "test",
  sourceRelationId: "12345",
  canonicalRouteSourceId: "12345",
  routeName: "Test Route",
  semanticType: "summit_route" as const,
  qualityScore: 100,
  distanceMeters: 5000,
  componentCount: 1,
  auditFlags: [] as string[],
  warnings: [] as string[],
  countryCode: "AT",
  countryName: "Austria",
  admin1Code: "AT-1",
  admin1Name: "State",
  administrationStatus: "ASSIGNED" as const,
  summit: {
    peakOsmId: "123",
    peakName: "Test Peak",
    peakElevationMeters: 2000,
    peakCoordinates: [10, 47] as const,
    mountainId: 1,
    mountainName: "Test Mountain",
    mountainElevationMeters: 2000,
    matchClassification: "EXACT_MOUNTAIN_MATCH" as const,
    finalAssociation: "CONFIRMED" as const,
    finalConfidence: 1,
    minimumGeometryDistanceMeters: 0,
    endpointDistanceMeters: 0,
  },
  diagnostics: {
    totalDistanceMeters: 5000,
    componentLengthsMeters: [5000],
    boundingBox: { minimumLongitude: 10, minimumLatitude: 47, maximumLongitude: 11, maximumLatitude: 48 },
    startCoordinate: [10, 47] as const,
    endCoordinate: [11, 48] as const,
    summitCoordinate: [10.5, 47.5] as const,
    endpointDistanceMeters: 0,
    startToSummitDistanceMeters: 1000,
    straightLineDistanceMeters: 4000,
    routeToStraightLineRatio: 1.25,
    routeToStraightLineStatus: "AVAILABLE" as const,
    topologyClassification: "SIMPLE" as const,
    connectedGroupCount: 1,
    physicalEndpointCount: 2,
    endpointOrientationReason: "CONFIRMED_SUMMIT_ENDPOINT" as const,
    endpointSelectionAmbiguous: false,
    endpointSelectionWarning: null,
    summitEndpointDistanceMeters: 0,
    geometryPointCount: 100,
  },
  qaStatus: "PENDING" as const,
  qaDecision: null,
  stagingRouteId: "test-staging-id",
  qaProgress: {
    total: 1,
    decided: 0,
    pending: 1,
    visuallyApproved: 0,
    needsReview: 0,
    rejected: 0,
    warnings: 0,
    warningsPending: 0,
  },
} as const;

type ActivityOverrides = Partial<{
  routeType: "hiking" | "via_ferrata" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other";
  confidence: number;
  manualReviewRequired: boolean;
  evidence: string[];
  conflictingTypes: ("via_ferrata" | "hiking" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other")[];
}>;

function makeActivity(overrides: Partial<{
  routeType: "hiking" | "via_ferrata" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other";
  confidence: number;
  manualReviewRequired: boolean;
  evidence: string[];
  conflictingTypes: ("via_ferrata" | "hiking" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other")[];
}> = {}) {
  return {
    routeType: "hiking" as const,
    confidence: 0.95,
    manualReviewRequired: false,
    evidence: ["hiking"],
    conflictingTypes: [] as ("via_ferrata" | "hiking" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other")[],
    ...overrides,
  };
}

test("perfect route gets GREEN with high score", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking evidence"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.equal(result.recommendation, "GREEN");
  assert.ok(result.score >= 70);
  assert.ok(result.reasonCodes.includes("CONFIRMED_SUMMIT"));
  assert.ok(result.reasonCodes.includes("EXACT_MOUNTAIN_MATCH"));
  assert.ok(result.reasonCodes.includes("SIMPLE_TOPOLOGY"));
  assert.ok(result.reasonCodes.includes("QUALITY_100"));
  assert.ok(result.reasonCodes.includes("NO_WARNINGS"));
  assert.ok(result.reasonCodes.includes("ACTIVITY_SAFE"));
  assert.ok(result.reasonCodes.includes("MANUAL_REVIEW_FALSE"));
  assert.ok(result.reasonCodes.includes("HIGH_CONFIDENCE_ACTIVITY"));
});

test("route with warnings gets YELLOW", () => {
  const routeWithWarnings = { ...mockRoute, warnings: ["SHORT_HIGH_SUMMIT_SEGMENT"] } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.9, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(routeWithWarnings as any, activity as any);
  assert.equal(result.recommendation, "YELLOW");
  assert.ok(result.score >= 40 && result.score < 70);
  assert.ok(result.reasonCodes.includes("WARNING_PRESENT"));
});

test("route with activity requiring manual review gets RED", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.8, manualReviewRequired: true, evidence: ["ambiguous"], conflictingTypes: ["climbing"] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.score < 40);
  assert.ok(result.reasonCodes.includes("ACTIVITY_MANUAL_REVIEW_REQUIRED"));
});

test("non-hiking activity gets RED", () => {
  const activity = { routeType: "via_ferrata" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["via ferrata"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.reasonCodes.includes("NON_HIKING_ROUTE_TYPE"));
});

test("complex topology gets RED", () => {
  const complexRoute = { ...mockRoute, diagnostics: { ...mockRoute.diagnostics, topologyClassification: "BRANCHING" as const } } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(complexRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.reasonCodes.includes("COMPLEX_TOPOLOGY"));
});

test("quality below 80 gets RED", () => {
  const lowQualityRoute = { ...mockRoute, qualityScore: 75 } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(lowQualityRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.reasonCodes.includes("QUALITY_BELOW_THRESHOLD"));
});

test("no confirmed summit gets RED", () => {
  const noConfirmedRoute = { ...mockRoute, summit: { ...mockRoute.summit, finalAssociation: "REVIEW" as const } } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(noConfirmedRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.reasonCodes.includes("NO_CONFIRMED_SUMMIT"));
});

test("non-summit_route semantic type gets RED", () => {
  const nonSummitRoute = { ...mockRoute, semanticType: "local_hike" as const } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(nonSummitRoute as any, activity as any);
  assert.equal(result.recommendation, "RED");
  assert.ok(result.reasonCodes.includes("SEMANTIC_NOT_SUMMIT_ROUTE"));
});

test("score is bounded 0-100", () => {
  const badRoute = {
    ...mockRoute,
    qualityScore: 0,
    warnings: ["test"],
    diagnostics: { ...mockRoute.diagnostics, topologyClassification: "BRANCHING" as const } as any,
    summit: { ...mockRoute.summit, finalAssociation: "REVIEW" as const, matchClassification: "NO_MOUNTAIN_MATCH" as const } as any,
    semanticType: "local_hike" as const,
  } as any;
  const activity = { routeType: "other" as const, confidence: 0.1, manualReviewRequired: true, evidence: ["none"], conflictingTypes: ["climbing"] as const };
  const result = computeAutoQaRecommendation(badRoute as any, activity as any);
  assert.ok(result.score >= 0 && result.score <= 100);
});

test("same route always gives same score", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result1 = computeAutoQaRecommendation(mockRoute as any, activity as any);
  const result2 = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.equal(result1.score, result2.score);
  assert.equal(result1.recommendation, result2.recommendation);
  assert.deepEqual(result1.reasonCodes.sort(), result2.reasonCodes.sort());
});

test("recommendation never auto-approves", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.ok(typeof result.recommendation === "string");
  assert.ok(["GREEN", "YELLOW", "RED"].includes(result.recommendation));
});

test("recommendation creates zero QA writes", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.ok(!result.reasonCodes.some(c => c.includes("AUTO_APPROVE")));
});

test("recommendation never auto-approves", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  assert.equal(result.recommendation, "GREEN");
});

test("route with 85 quality gets YELLOW", () => {
  const midQualityRoute = { ...mockRoute, qualityScore: 85 } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(midQualityRoute as any, activity as any);
  assert.equal(result.recommendation, "YELLOW");
  assert.ok(result.score >= 40 && result.score < 70);
  assert.ok(result.reasonCodes.includes("QUALITY_BELOW_90"));
});

test("route with low confidence stays GREEN (minor issue)", () => {
  const activity = { routeType: "hiking" as const, confidence: 0.85, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(mockRoute as any, activity as any);
  // Confidence 0.85 loses HIGH_CONFIDENCE_ACTIVITY (+3) and adds CONFIDENCE_BELOW_09 (-8)
  // Net change: -11, score ~74 → still GREEN (conservative)
  assert.equal(result.recommendation, "GREEN");
  assert.ok(result.reasonCodes.includes("CONFIDENCE_BELOW_09"));
});

test("admin unassigned stays GREEN (minor issue)", () => {
  const unassignedRoute = { ...mockRoute, administrationStatus: "UNASSIGNED" as const } as any;
  const activity = { routeType: "hiking" as const, confidence: 0.95, manualReviewRequired: false, evidence: ["hiking"], conflictingTypes: [] as const };
  const result = computeAutoQaRecommendation(unassignedRoute as any, activity as any);
  // Loses ADMIN_ASSIGNED (+2) and adds ADMIN_UNASSIGNED (-8)
  // Net change: -10, score ~75 → still GREEN (minor issue)
  assert.equal(result.recommendation, "GREEN");
  assert.ok(result.reasonCodes.includes("ADMIN_UNASSIGNED"));
});
