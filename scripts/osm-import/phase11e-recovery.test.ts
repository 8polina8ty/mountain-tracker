import assert from "node:assert/strict";
import test from "node:test";

import { analyzeRouteTopology } from "../../Lib/osmStagingPreview/topology.ts";
import type { OplRelation, OplWay } from "./opl-parser.ts";
import {
  PHASE11E_GREEN_MINIMUM_QUALITY,
  classifyTopologyCause,
  createSummitRouteExclusionLedger,
  qualifyPhase11eRoute,
  recoverDeterministicMemberChain,
  recoveredRouteQuality,
  resolveExactMountainIdentity,
  type Phase11eMemberStore,
} from "./phase11e-recovery.ts";
import { PHASE11D_GREEN_MINIMUM_QUALITY } from "./phase11d-qualification.ts";

function way(id: number, nodes: Array<[number, [number, number]]>): OplWay {
  return {
    type: "way",
    id,
    tags: { highway: "path" },
    nodes: nodes.map(([nodeId, coordinate]) => ({ nodeId, coordinate })),
  };
}

function store(relation: OplRelation, ways: OplWay[]): Phase11eMemberStore {
  const byId = new Map(ways.map((value) => [value.id, value]));
  return {
    getRelation: (id) => id === relation.id ? relation : null,
    getWay: (id) => byId.get(id) ?? null,
  };
}

function relation(
  members: Array<{ type?: "way" | "relation"; ref: number; role?: string }>,
): OplRelation {
  return {
    type: "relation",
    id: 100,
    tags: { type: "route", route: "hiking" },
    members: members.map((member) => ({
      type: member.type ?? "way",
      ref: member.ref,
      role: member.role ?? "",
    })),
  };
}

test("recovers an out-of-order member chain using every OSM way exactly once", () => {
  const ways = [
    way(10, [[1, [10, 47]], [2, [10.01, 47.01]]]),
    way(20, [[2, [10.01, 47.01]], [3, [10.02, 47.02]]]),
    way(30, [[3, [10.02, 47.02]], [4, [10.03, 47.03]]]),
  ];
  const result = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 3,
    store: store(relation([{ ref: 20 }, { ref: 10 }, { ref: 30 }]), ways),
  });
  assert.equal(result.status, "RECOVERED");
  if (result.status !== "RECOVERED") return;
  assert.deepEqual(result.memberWayIds, [10, 20, 30]);
  assert.deepEqual(result.discardedWayIds, []);
  assert.equal(result.geometry.type, "LineString");
  assert.equal(result.geometry.coordinates.length, 4);
  assert.equal(new Set(result.orderedWayIds).size, 3);
});

test("ambiguous alternative roles fail closed", () => {
  const result = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 2,
    store: store(
      relation([{ ref: 10 }, { ref: 20, role: "alternative" }]),
      [
        way(10, [[1, [10, 47]], [2, [10.01, 47.01]]]),
        way(20, [[2, [10.01, 47.01]], [3, [10.02, 47.02]]]),
      ],
    ),
  });
  assert.deepEqual(result.status, "BLOCKED");
  if (result.status === "BLOCKED") {
    assert.equal(result.reasonCode, "EXPLICIT_ALTERNATIVE_OR_SPUR_ROLE");
  }
});

test("disconnected and duplicate member geometry remain blocked", () => {
  const ways = [
    way(10, [[1, [10, 47]], [2, [10.01, 47.01]]]),
    way(20, [[3, [11, 48]], [4, [11.01, 48.01]]]),
  ];
  const disconnected = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 2,
    store: store(relation([{ ref: 10 }, { ref: 20 }]), ways),
  });
  assert.equal(disconnected.status, "BLOCKED");
  const duplicate = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 2,
    store: store(relation([{ ref: 10 }, { ref: 10 }]), ways),
  });
  assert.equal(duplicate.status, "BLOCKED");
  if (duplicate.status === "BLOCKED") assert.equal(duplicate.reasonCode, "DUPLICATE_WAY_MEMBER");
});

test("valid explicit loops are categorized for review, not recovered as an open path", () => {
  const topology = analyzeRouteTopology({
    type: "LineString",
    coordinates: [[10, 47], [10.01, 47], [10, 47]],
  });
  const recovery = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 1,
    store: store(
      relation([{ ref: 10 }]),
      [way(10, [[1, [10, 47]], [2, [10.01, 47]], [1, [10, 47]]])],
    ),
  });
  assert.equal(classifyTopologyCause({
    topology,
    explicitlySupportedClosedLoop: true,
    recovery,
  }), "VALID_CLOSED_LOOP");
});

test("exact mountain recovery accepts only a unique immutable OSM identity", () => {
  const mountains = [
    { id: 7, osmId: "123", name: "Unrelated name" },
    { id: 8, osmId: "456", name: "Same displayed name" },
  ];
  assert.deepEqual(resolveExactMountainIdentity("123", mountains), {
    status: "EXACT",
    mountainId: 7,
  });
  assert.deepEqual(resolveExactMountainIdentity("999", mountains), {
    status: "MISSING",
    mountainIds: [],
  });
  assert.deepEqual(resolveExactMountainIdentity("456", [
    ...mountains,
    { id: 9, osmId: "456", name: "Duplicate exact identity" },
  ]), { status: "AMBIGUOUS", mountainIds: [8, 9] });
});

test("quality recovery uses the unchanged score threshold and only corrected geometry", () => {
  assert.equal(PHASE11E_GREEN_MINIMUM_QUALITY, PHASE11D_GREEN_MINIMUM_QUALITY);
  const recovery = recoverDeterministicMemberChain({
    relationId: "100",
    originalComponentCount: 3,
    store: store(
      relation([{ ref: 20 }, { ref: 10 }, { ref: 30 }]),
      [
        way(10, [[1, [10, 47]], [2, [10.01, 47.01]]]),
        way(20, [[2, [10.01, 47.01]], [3, [10.02, 47.02]]]),
        way(30, [[3, [10.02, 47.02]], [4, [10.03, 47.03]]]),
      ],
    ),
  });
  assert.equal(recovery.status, "RECOVERED");
  if (recovery.status !== "RECOVERED") return;
  const quality = recoveredRouteQuality({
    sourceId: "100",
    sourceUrl: "https://www.openstreetmap.org/relation/100",
    name: "Exact route",
    ref: "1",
    network: "lwn",
    operator: "Club",
    geometry: { type: "MultiLineString", coordinates: [
      [[10.01, 47.01], [10.02, 47.02]],
      [[10, 47], [10.01, 47.01]],
      [[10.02, 47.02], [10.03, 47.03]],
    ] },
    stats: { distanceMeters: 4_000, coordinatePoints: 6, componentCount: 3 },
    metadata: { route: "hiking", from: "Start", to: "Summit", roundtrip: null, osmcSymbol: "red:white:red", tags: {} },
  }, recovery);
  assert.ok(quality.score >= PHASE11E_GREEN_MINIMUM_QUALITY);
  assert.ok(quality.reasons.includes("+20 connected LineString geometry"));
});

function qualificationInput(humanQaStatus: "REJECTED" | "NEEDS_REVIEW") {
  return {
    sourceRelationId: "100",
    canonicalRouteSourceId: "100",
    sourceUrl: "https://www.openstreetmap.org/relation/100",
    stagingIdempotencyKey: "key",
    stagingPayloadHash: "hash",
    semanticType: "summit_route",
    routeType: "hiking" as const,
    activityManualReviewRequired: false,
    geometryValid: true,
    qualityScore: 100,
    auditFlags: [],
    warnings: [],
    summits: [{ peakOsmId: "123", mountainId: 7, finalAssociation: "CONFIRMED", mountainMatchClassification: "EXACT_MOUNTAIN_MATCH" }],
    topologyClassification: "SIMPLE" as const,
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
    roadSafetyStatus: "SAFE" as const,
    roadSafetyReasonCodes: [],
    humanQaStatus,
  };
}

test("human REJECTED and NEEDS_REVIEW decisions remain authoritative", () => {
  assert.equal(qualifyPhase11eRoute({ qualificationInput: qualificationInput("REJECTED"), recovery: null }).status, "RED");
  assert.equal(qualifyPhase11eRoute({ qualificationInput: qualificationInput("NEEDS_REVIEW"), recovery: null }).status, "YELLOW");
});

test("recovery and exclusion ledgers are deterministic", () => {
  const input = {
    summitRouteRelationIds: ["20", "10", "30"],
    canonicalRoutes: [
      { canonicalRouteSourceId: "10", sourceRouteIds: ["10", "20"] },
      { canonicalRouteSourceId: "30", sourceRouteIds: ["30"] },
    ] as never,
    eligibilityRecords: [
      { canonicalRouteSourceId: "10", eligibility: "AUTO_IMPORT_READY" },
      { canonicalRouteSourceId: "30", eligibility: "MANUAL_REVIEW_REQUIRED", qualityScore: 60, auditFlags: [] },
    ] as never,
    candidateRelationIds: new Set(["10"]),
  };
  const first = createSummitRouteExclusionLedger(input);
  const second = createSummitRouteExclusionLedger(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.includedRelationIds, ["10"]);
  assert.deepEqual(first.exclusionDistribution, {
    DUPLICATE_RELATION_REPRESENTATION: 1,
    PHASE7_QUALITY_BELOW_AUTO_THRESHOLD: 1,
  });
});
