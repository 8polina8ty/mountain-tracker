import assert from "node:assert/strict";
import test from "node:test";

import type { RoadSafetyReasonCode, RoadSafetyStatus } from "./phase11c9-road-safety.ts";
import {
  assertMachineGreenCannotPublish,
  PHASE11D_AUTO_APPROVAL_ENABLED,
  qualifyPhase11dRoute,
  selectPhase11dQueue,
  type Phase11dQualificationInput,
} from "./phase11d-qualification.ts";

function input(overrides: Partial<Phase11dQualificationInput> = {}): Phase11dQualificationInput {
  return {
    sourceRelationId: "123",
    canonicalRouteSourceId: "123",
    sourceUrl: "https://www.openstreetmap.org/relation/123",
    stagingIdempotencyKey: "openstreetmap:relation:123:v1",
    stagingPayloadHash: "a".repeat(64),
    semanticType: "summit_route",
    routeType: "hiking",
    activityManualReviewRequired: false,
    geometryValid: true,
    qualityScore: 100,
    auditFlags: [],
    warnings: [],
    summits: [{
      peakOsmId: "456",
      mountainId: 7,
      finalAssociation: "CONFIRMED",
      mountainMatchClassification: "EXACT_MOUNTAIN_MATCH",
    }],
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
    humanQaStatus: null,
    startContext: "BASE_START",
    ...overrides,
  };
}

function road(status: RoadSafetyStatus, reason: RoadSafetyReasonCode) {
  return { roadSafetyStatus: status, roadSafetyReasonCodes: [reason] };
}

test("strict two-endpoint safe hiking route is GREEN-compatible", () => {
  const result = qualifyPhase11dRoute(input());
  assert.equal(result.status, "GREEN");
  assert.equal(result.autoApprovalEnabled, false);
  assert.equal(result.qaWrites, 0);
});

test("one physical endpoint is RED with NO_VALID_START_FINISH", () => {
  const result = qualifyPhase11dRoute(input({
    topologyClassification: "BRANCHING",
    physicalEndpointCount: 1,
    endpointSelectionAmbiguous: true,
  }));
  assert.equal(result.status, "RED");
  assert.ok(result.reasonCodes.includes("NO_VALID_START_FINISH"));
});

test("more than two ambiguous endpoints are RED", () => {
  const result = qualifyPhase11dRoute(input({
    topologyClassification: "BRANCHING",
    physicalEndpointCount: 3,
    endpointSelectionAmbiguous: true,
  }));
  assert.equal(result.status, "RED");
  assert.ok(result.reasonCodes.includes("COMPLEX_TOPOLOGY"));
});

test("disconnected topology is RED", () => {
  const result = qualifyPhase11dRoute(input({
    topologyClassification: "DISCONNECTED",
    connectedGroupCount: 2,
    physicalEndpointCount: 4,
    endpointSelectionAmbiguous: true,
  }));
  assert.equal(result.status, "RED");
  assert.ok(result.reasonCodes.includes("NO_VALID_START_FINISH"));
});

test("explicit supported closed loop is retained as YELLOW", () => {
  const result = qualifyPhase11dRoute(input({
    topologyClassification: "AMBIGUOUS",
    physicalEndpointCount: 0,
    endpointSelectionAmbiguous: true,
    explicitlySupportedClosedLoop: true,
  }));
  assert.equal(result.status, "YELLOW");
  assert.ok(result.reasonCodes.includes("CLOSED_LOOP_REVIEW"));
  assert.ok(!result.reasonCodes.includes("NO_VALID_START_FINISH"));
});

test("motorway and motorway_link overlap remain mandatory RED", () => {
  for (const reason of ["MOTORWAY_OVERLAP", "MOTORWAY_LINK_OVERLAP"] as const) {
    assert.equal(qualifyPhase11dRoute(input(road("BLOCKED", reason))).status, "RED");
  }
});

test("forbidden pedestrian access and unsafe at-grade crossing are RED", () => {
  for (const reason of ["PEDESTRIAN_ACCESS_FORBIDDEN", "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"] as const) {
    assert.equal(qualifyPhase11dRoute(input(road("BLOCKED", reason))).status, "RED");
  }
});

test("ambiguous motorway crossing and road access are YELLOW", () => {
  for (const reason of ["AMBIGUOUS_MOTORWAY_CROSSING", "ROAD_ACCESS_AMBIGUOUS"] as const) {
    assert.equal(
      qualifyPhase11dRoute(input(road("MANUAL_REVIEW_REQUIRED", reason))).status,
      "YELLOW",
    );
  }
});

test("proven safe grade-separated crossing remains GREEN-compatible", () => {
  assert.equal(qualifyPhase11dRoute(input({ roadSafetyStatus: "SAFE" })).status, "GREEN");
});

test("multiple confirmed summits require YELLOW review", () => {
  const result = qualifyPhase11dRoute(input({ summits: [
    input().summits[0],
    { ...input().summits[0], peakOsmId: "789", mountainId: 8 },
  ] }));
  assert.equal(result.status, "YELLOW");
  assert.ok(result.reasonCodes.includes("MULTIPLE_CONFIRMED_SUMMITS"));
});

test("duplicate identities, ACTIVE routes, and unsupported activities are RED", () => {
  assert.equal(qualifyPhase11dRoute(input({ duplicateRelationIdentity: true })).status, "RED");
  assert.equal(qualifyPhase11dRoute(input({ active: true })).status, "RED");
  assert.equal(qualifyPhase11dRoute(input({ routeType: "via_ferrata" })).status, "RED");
});

test("qualification is deterministic", () => {
  assert.deepEqual(qualifyPhase11dRoute(input()), qualifyPhase11dRoute(input()));
});

test("startContext is mandatory: missing/ambiguous evidence fails GREEN as YELLOW", () => {
  const missing = qualifyPhase11dRoute(input({ startContext: undefined }));
  assert.equal(missing.status, "YELLOW");
  assert.ok(missing.reasonCodes.includes("START_CONTEXT_AMBIGUOUS_START"));
  const ambiguous = qualifyPhase11dRoute(input({ startContext: "AMBIGUOUS_START" }));
  assert.equal(ambiguous.status, "YELLOW");
  assert.ok(ambiguous.reasonCodes.includes("START_CONTEXT_AMBIGUOUS_START"));
  const highMountain = qualifyPhase11dRoute(input({ startContext: "HIGH_MOUNTAIN_START" }));
  assert.equal(highMountain.status, "YELLOW");
  assert.ok(highMountain.reasonCodes.includes("START_CONTEXT_HIGH_MOUNTAIN_START"));
});

test("BASE_START and HUT_START remain GREEN-compatible start contexts", () => {
  for (const startContext of ["BASE_START", "HUT_START"] as const) {
    assert.equal(qualifyPhase11dRoute(input({ startContext })).status, "GREEN");
  }
});

test("queue is deterministic, GREEN-first, and contains no RED", () => {
  const green = qualifyPhase11dRoute(input());
  const yellow = qualifyPhase11dRoute(input({ sourceRelationId: "124", canonicalRouteSourceId: "124", sourceUrl: "https://www.openstreetmap.org/relation/124", qualityScore: 85 }));
  const red = qualifyPhase11dRoute(input({ sourceRelationId: "125", canonicalRouteSourceId: "125", sourceUrl: "https://www.openstreetmap.org/relation/125", active: true }));
  const first = selectPhase11dQueue([red, yellow, green], 2);
  const second = selectPhase11dQueue([yellow, green, red], 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((record) => record.status), ["GREEN", "YELLOW"]);
});

test("machine GREEN never becomes a human QA write or publication approval", () => {
  const green = qualifyPhase11dRoute(input());
  assert.equal(PHASE11D_AUTO_APPROVAL_ENABLED, false);
  assert.equal(green.qaWrites, 0);
  assert.throws(
    () => assertMachineGreenCannotPublish({ qualification: green, humanQaStatus: "REJECTED" }),
    /HUMAN_QA_REQUIRED/,
  );
  assert.doesNotThrow(
    () => assertMachineGreenCannotPublish({ qualification: green, humanQaStatus: "VISUALLY_APPROVED" }),
  );
});

test("an authoritative human rejection prevents false GREEN", () => {
  const result = qualifyPhase11dRoute(input({ humanQaStatus: "REJECTED" }));
  assert.equal(result.status, "RED");
  assert.ok(result.reasonCodes.includes("HUMAN_QA_REJECTED"));
});
