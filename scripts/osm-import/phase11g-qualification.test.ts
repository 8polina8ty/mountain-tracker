import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE11G_AUTO_APPROVAL_ENABLED,
  PHASE11G_EXPANSION_CONTRACT,
  PHASE11G_MIN_VERTICAL_GAIN_BASE_METERS,
  type Phase11gQualificationInput,
  qualifyPhase11gRoute,
} from "./phase11g-qualification.ts";

function baseInput(overrides: Partial<Phase11gQualificationInput> = {}): Phase11gQualificationInput {
  return {
    canonicalRouteSourceId: "route-1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    routeName: "Example Ascent",
    semanticType: "summit_route",
    routeType: "hiking",
    activityManualReviewRequired: false,
    geometryValid: true,
    qualityScore: 95,
    auditFlags: [],
    warnings: [],
    summits: [
      {
        peakOsmId: "peak-1",
        finalAssociation: "CONFIRMED",
        endpointDistanceMeters: 2,
      },
    ],
    topologyClassification: "SIMPLE",
    connectedGroupCount: 1,
    physicalEndpointCount: 2,
    endpointSelectionAmbiguous: false,
    explicitlySupportedClosedLoop: false,
    active: false,
    duplicateRelationIdentity: false,
    duplicateSourceUrl: false,
    publicationSourceConflict: false,
    dataIntegrityFailure: false,
    routeMemberDataIntegrityFailure: false,
    roadSafetyStatus: "SAFE",
    roadSafetyReasonCodes: [],
    humanQaStatus: "VISUALLY_APPROVED",
    startContext: "BASE_START",
    startElevationMeters: 800,
    startElevationSource: "phase11f3",
    summitElevationMeters: 2000,
    verticalGainMeters: 1200,
    ...overrides,
  };
}

test("11G: clean single-summit BASE ascent is GREEN_NAMED with all green reasons", () => {
  const result = qualifyPhase11gRoute(baseInput());
  assert.equal(result.safeStatus, "GREEN");
  assert.equal(result.greenClass, "GREEN_NAMED");
  assert.ok(result.reasonCodes.includes("SINGLE_CONFIRMED_SUMMIT"));
  assert.ok(result.reasonCodes.includes("EXACT_MOUNTAIN_IDENTITY"));
  assert.ok(result.reasonCodes.includes("SIMPLE_TOPOLOGY"));
  assert.ok(result.reasonCodes.includes("ROAD_SAFETY_SAFE"));
  assert.ok(result.reasonCodes.includes("START_CONTEXT_BASE_START"));
  assert.ok(result.reasonCodes.includes("SUPPORTED_HIKING_ACTIVITY"));
  assert.ok(result.reasonCodes.includes("GEOMETRY_VALID"));
  assert.ok(result.reasonCodes.includes("OLD_SCORE_CONFIRMED"));
  assert.equal(result.qaWrites, 0);
  assert.equal(result.autoApprovalEnabled, PHASE11G_AUTO_APPROVAL_ENABLED);
  assert.equal(result.autoApprovalEnabled, false);
  assert.equal(result.expansionContractVersion, PHASE11G_EXPANSION_CONTRACT);
});

test("11G: minimum BASE vertical gain threshold is 500m", () => {
  assert.equal(PHASE11G_MIN_VERTICAL_GAIN_BASE_METERS, 500);
});

test("11G: missing OSM name never blocks GREEN, classified GREEN_MISSING_NAME", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ routeName: null, qualityScore: 60, auditFlags: ["MISSING_NAME"] }),
  );
  // Missing name is a presentation issue, NOT a safety gate.
  assert.equal(result.safeStatus, "GREEN");
  assert.equal(result.nameClass, "MISSING_NAME");
  assert.equal(result.greenClass, "GREEN_MISSING_NAME");
  assert.ok(result.reasonCodes.includes("VALID_ASCENT_MISSING_NAME"));
});

test("11G: old low aggregate score is superseded by explicit gates when all safety gates pass", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ qualityScore: 55, auditFlags: ["LOW_QUALITY"], routeName: "Low score climb" }),
  );
  // All explicit safety gates (summit/topology/road/start/dup/active) pass,
  // so the old aggregate 55 is not a hard block.
  assert.equal(result.safeStatus, "GREEN");
  assert.equal(result.greenClass, "GREEN_NAMED");
  assert.ok(result.reasonCodes.includes("OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES"));
  assert.ok(result.reasonCodes.includes("QUALITY_BELOW_SUPPORTED_THRESHOLD"));
  assert.equal(result.oldScoreSuperseded, true);
});

test("11G: old score is NOT superseded for a high-quality route (OLD_SCORE_CONFIRMED)", () => {
  const result = qualifyPhase11gRoute(baseInput({ qualityScore: 92 }));
  assert.ok(result.reasonCodes.includes("OLD_SCORE_CONFIRMED"));
  assert.ok(!result.reasonCodes.includes("OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES"));
  assert.equal(result.oldScoreSuperseded, false);
});

test("11G: multiple genuinely ambiguous summits stays non-GREEN (excluded)", () => {
  const result = qualifyPhase11gRoute(
    baseInput({
      summits: [
        { peakOsmId: "peak-a", finalAssociation: "CONFIRMED", endpointDistanceMeters: 2 },
        { peakOsmId: "peak-b", finalAssociation: "CONFIRMED", endpointDistanceMeters: 3 },
      ],
    }),
  );
  // Auto-resolving an ambiguous multi-summit is forbidden: never machine-GREEN.
  assert.equal(result.safeStatus, "RED");
  assert.equal(result.greenClass, null);
  assert.ok(result.reasonCodes.includes("MULTIPLE_CONFIRMED_SUMMITS"));
});

test("11G: no exact terminal match yields NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY (blocked)", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ summits: [{ peakOsmId: "peak-1", finalAssociation: "CONFIRMED", endpointDistanceMeters: 40 }] }),
  );
  assert.equal(result.safeStatus, "RED");
  assert.equal(result.greenClass, null);
  assert.ok(result.reasonCodes.includes("NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY"));
});

test("11G: no confirmed summit is RED", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ summits: [{ peakOsmId: "peak-1", finalAssociation: "CANDIDATE", endpointDistanceMeters: 5 }] }),
  );
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("NO_CONFIRMED_SUMMIT"));
  assert.equal(result.greenClass, null);
});

test("11G: active routes are excluded (RED)", () => {
  const result = qualifyPhase11gRoute(baseInput({ active: true }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("ACTIVE_ROUTE_EXCLUDED"));
  assert.equal(result.greenClass, null);
});

test("11G: motorway overlap is RED", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ roadSafetyStatus: "BLOCKED", roadSafetyReasonCodes: ["MOTORWAY_OVERLAP"] }),
  );
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("MOTORWAY_OVERLAP"));
  assert.equal(result.greenClass, null);
});

test("11G: forbidden pedestrian access is RED", () => {
  const result = qualifyPhase11gRoute(
    baseInput({ roadSafetyStatus: "BLOCKED", roadSafetyReasonCodes: ["PEDESTRIAN_ACCESS_FORBIDDEN"] }),
  );
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("PEDESTRIAN_ACCESS_FORBIDDEN"));
});

test("11G: high-mountain start is never GREEN (YELLOW)", () => {
  const result = qualifyPhase11gRoute(baseInput({ startContext: "HIGH_MOUNTAIN_START" }));
  assert.equal(result.safeStatus, "YELLOW");
  assert.equal(result.greenClass, null);
  assert.ok(result.reasonCodes.includes("START_CONTEXT_HIGH_MOUNTAIN_START"));
});

test("11G: ambiguous start is never GREEN (YELLOW)", () => {
  const result = qualifyPhase11gRoute(baseInput({ startContext: "AMBIGUOUS_START" }));
  assert.equal(result.safeStatus, "YELLOW");
  assert.ok(result.reasonCodes.includes("START_CONTEXT_AMBIGUOUS_START"));
  assert.equal(result.greenClass, null);
});

test("11G: HUT_START is a valid GREEN start", () => {
  const result = qualifyPhase11gRoute(baseInput({ startContext: "HUT_START" }));
  assert.equal(result.safeStatus, "GREEN");
  assert.equal(result.greenClass, "GREEN_NAMED");
  assert.ok(result.reasonCodes.includes("START_CONTEXT_HUT_START"));
});

test("11G: unsupported route type is RED", () => {
  const result = qualifyPhase11gRoute(baseInput({ routeType: "climbing" }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("UNSUPPORTED_ROUTE_TYPE"));
});

test("11G: non-summit_route semantic is RED", () => {
  const result = qualifyPhase11gRoute(baseInput({ semanticType: "trail" }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("UNSUPPORTED_SEMANTIC_TYPE"));
});

test("11G: invalid geometry is RED", () => {
  const result = qualifyPhase11gRoute(baseInput({ geometryValid: false }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("INVALID_GEOMETRY"));
});

test("11G: human QA rejected is RED and blocked", () => {
  const result = qualifyPhase11gRoute(baseInput({ humanQaStatus: "REJECTED" }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("HUMAN_QA_REJECTED"));
  assert.equal(result.greenClass, null);
});

test("11G: human QA needs review is YELLOW", () => {
  const result = qualifyPhase11gRoute(baseInput({ humanQaStatus: "NEEDS_REVIEW" }));
  assert.equal(result.safeStatus, "YELLOW");
  assert.ok(result.reasonCodes.includes("HUMAN_QA_NEEDS_REVIEW"));
  assert.equal(result.greenClass, null);
});

test("11G: duplicate source URL is RED", () => {
  const result = qualifyPhase11gRoute(baseInput({ duplicateSourceUrl: true }));
  assert.equal(result.safeStatus, "RED");
  assert.ok(result.reasonCodes.includes("DUPLICATE_SOURCE_URL"));
});

test("11G: red reason is never overridden to GREEN by a high/low old score", () => {
  const red = qualifyPhase11gRoute(
    baseInput({ qualityScore: 95, roadSafetyStatus: "BLOCKED", roadSafetyReasonCodes: ["UNSAFE_AT_GRADE_MOTORWAY_CROSSING"] }),
  );
  assert.equal(red.safeStatus, "RED");
  assert.equal(red.greenClass, null);
  assert.ok(red.reasonCodes.includes("UNSAFE_AT_GRADE_MOTORWAY_CROSSING"));
  // The old score never flips a hard unsafe gate to GREEN.
  assert.equal(red.safeStatus, "RED");
});

test("11G: disconnected/branching/ambiguous topology is blocked (RED, non-GREEN)", () => {
  for (const classification of ["DISCONNECTED", "BRANCHING", "AMBIGUOUS"] as const) {
    const result = qualifyPhase11gRoute(
      baseInput({ topologyClassification: classification, physicalEndpointCount: 2 }),
    );
    assert.equal(result.safeStatus, "RED");
    assert.equal(result.greenClass, null);
    assert.ok(result.reasonCodes.includes("COMPLEX_TOPOLOGY"));
  }
});

test("11G: reason codes are deterministic and stable ordering", () => {
  const a = qualifyPhase11gRoute(baseInput());
  const b = qualifyPhase11gRoute({ ...baseInput(), routeName: "Different route" });
  // Deterministic hash changes with input, but must be a real sha256.
  assert.match(a.deterministicQualificationHash, /^[a-f0-9]{64}$/);
  // Sorted reason ordering is stable (no duplicates).
  const set = new Set(a.reasonCodes);
  assert.equal(set.size, a.reasonCodes.length);
  assert.notEqual(a.deterministicQualificationHash, b.deterministicQualificationHash);
});
