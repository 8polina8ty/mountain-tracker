import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRouteRoadSafety,
  createPhase11C9RoadSafetyReport,
  evaluatePedestrianAccess,
  requireSafeRoadSafetyRecords,
  verifyPhase11C9RoadSafetyPublicationGate,
  verifyPhase11C9RoadSafetyReport,
  type RoadSafetySourceDatasetIdentity,
  type RoadSafetyWay,
} from "./phase11c9-road-safety.ts";

const sourceDatasetIdentity: RoadSafetySourceDatasetIdentity = {
  pbfPath: "data/osm/source/alps-latest.osm.pbf",
  pbfSizeBytes: 2_310_928_096,
  pbfModifiedMilliseconds: 1_787_606_468_000,
  pbfSha256: "a".repeat(64),
  pipelineDatasetFingerprint: "b".repeat(64),
  pipelineGeneratedAt: "2026-08-25T01:54:50.930Z",
  checkpointPath: "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite",
  checkpointManifestSha256: "c".repeat(64),
  motorwayIndexContentHash: "d".repeat(64),
};

function way(
  id: number,
  coordinates: Array<[number, number]>,
  tags: Record<string, string> = { highway: "path" },
  nodeIds?: number[],
): RoadSafetyWay {
  return {
    id,
    tags,
    nodes: coordinates.map((coordinate, index) => ({
      nodeId: nodeIds?.[index] ?? id * 100 + index,
      coordinate,
    })),
  };
}

function analyze(input?: {
  routeWay?: RoadSafetyWay;
  roadWay?: RoadSafetyWay;
}) {
  return analyzeRouteRoadSafety({
    canonicalRelationId: "123",
    stagingRouteId: "00000000-0000-4000-8000-000000000123",
    routeType: "hiking",
    routeWays: [input?.routeWay ?? way(1, [[0, 0], [2, 0]])],
    nearbyMotorwayWays: input?.roadWay ? [input.roadWay] : [],
    sourceDatasetIdentity,
  });
}

test("hiking relation containing highway=motorway is blocked", () => {
  const result = analyze({ routeWay: way(1, [[0, 0], [1, 0]], { highway: "motorway" }) });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.motorwayOverlapWayIds, [1]);
  assert.ok(result.reasonCodes.includes("MOTORWAY_OVERLAP"));
});

test("hiking relation containing highway=motorway_link is blocked", () => {
  const result = analyze({ routeWay: way(2, [[0, 0], [1, 0]], { highway: "motorway_link" }) });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasonCodes.includes("MOTORWAY_LINK_OVERLAP"));
});

test("route member foot=no is blocked", () => {
  const result = analyze({ routeWay: way(3, [[0, 0], [1, 0]], { highway: "path", foot: "no" }) });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasonCodes.includes("PEDESTRIAN_ACCESS_FORBIDDEN"));
});

test("access=no without foot override is blocked", () => {
  assert.equal(evaluatePedestrianAccess({ access: "no" }), "FORBIDDEN");
  const result = analyze({ routeWay: way(4, [[0, 0], [1, 0]], { highway: "path", access: "no" }) });
  assert.equal(result.status, "BLOCKED");
});

test("access=private with foot=permissive respects the pedestrian override", () => {
  assert.equal(
    evaluatePedestrianAccess({ access: "private", foot: "permissive" }),
    "ALLOWED",
  );
  const result = analyze({
    routeWay: way(5, [[0, 0], [1, 0]], {
      highway: "path",
      access: "private",
      foot: "permissive",
    }),
  });
  assert.equal(result.status, "SAFE");
  assert.deepEqual(result.forbiddenAccessWayIds, []);
});

test("hiking route crossing a motorway at an explicit equal layer is blocked", () => {
  const result = analyze({
    routeWay: way(6, [[0, 0], [2, 0]], { highway: "path", layer: "0" }),
    roadWay: way(60, [[1, -1], [1, 1]], { highway: "motorway", layer: "0" }),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.motorwayCrossings[0].decision, "UNSAFE_AT_GRADE_MOTORWAY_CROSSING");
});

test("hiking bridge crossing a motorway at a different layer is safe", () => {
  const result = analyze({
    routeWay: way(7, [[0, 0], [2, 0]], { highway: "path", bridge: "yes", layer: "1" }),
    roadWay: way(70, [[1, -1], [1, 1]], { highway: "motorway", layer: "0" }),
  });
  assert.equal(result.status, "SAFE");
  assert.equal(result.safeGradeSeparatedCrossings.length, 1);
});

test("hiking route above a motorway tunnel is safe", () => {
  const result = analyze({
    routeWay: way(8, [[0, 0], [2, 0]], { highway: "path", layer: "0" }),
    roadWay: way(80, [[1, -1], [1, 1]], {
      highway: "motorway",
      tunnel: "yes",
      layer: "-1",
    }),
  });
  assert.equal(result.status, "SAFE");
  assert.equal(result.safeGradeSeparatedCrossings[0].decision, "SAFE_GRADE_SEPARATED_CROSSING");
});

test("geometric motorway intersection without grade evidence requires manual review", () => {
  const result = analyze({
    routeWay: way(9, [[0, 0], [2, 0]]),
    roadWay: way(90, [[1, -1], [1, 1]], { highway: "motorway" }),
  });
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(result.ambiguousCrossings.length, 1);
  assert.ok(result.reasonCodes.includes("AMBIGUOUS_MOTORWAY_CROSSING"));
});

test("primary or trunk way with valid pedestrian access is not treated as motorway", () => {
  for (const highway of ["primary", "trunk"]) {
    const result = analyze({
      routeWay: way(10, [[0, 0], [2, 0]], { highway, foot: "yes" }),
    });
    assert.equal(result.status, "SAFE");
    assert.ok(result.reasonCodes.includes("MAJOR_ROAD_CROSSING_REVIEW"));
  }
});

test("ambiguous access values require manual review", () => {
  const result = analyze({
    routeWay: way(11, [[0, 0], [1, 0]], { highway: "path", access: "destination" }),
  });
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.reasonCodes.includes("ROAD_ACCESS_AMBIGUOUS"));
});

test("road safety output is deterministic", () => {
  const first = analyze({
    routeWay: way(12, [[0, 0], [2, 0]], { highway: "path", layer: "1" }),
    roadWay: way(120, [[1, -1], [1, 1]], { highway: "motorway", layer: "0" }),
  });
  const second = analyze({
    routeWay: way(12, [[0, 0], [2, 0]], { layer: "1", highway: "path" }),
    roadWay: way(120, [[1, -1], [1, 1]], { layer: "0", highway: "motorway" }),
  });
  assert.equal(first.deterministicResultHash, second.deterministicResultHash);
});

test("blocked and manual-review routes never enter a publication batch", () => {
  const safe = analyze();
  const blocked = analyze({ routeWay: way(13, [[0, 0], [1, 0]], { foot: "no" }) });
  const manual = analyze({ routeWay: way(14, [[0, 0], [1, 0]], { access: "destination" }) });
  blocked.canonicalRelationId = "124";
  manual.canonicalRelationId = "125";
  const records = [safe, blocked, manual].map((record) => ({
    canonicalRouteSourceId: record.canonicalRelationId,
    geometryHash: `${record.status}-geometry`,
  }));
  const selected = requireSafeRoadSafetyRecords(records, [safe, blocked, manual]);
  assert.deepEqual(selected, [records[0]]);

  const gateRecords = Array.from({ length: 100 }, (_, index) =>
    analyzeRouteRoadSafety({
      canonicalRelationId: String(index + 1),
      stagingRouteId: `gate-${index + 1}`,
      routeType: "hiking",
      routeWays: [way(index + 300, [[0, 0], [1, 0]],
        index === 0 ? { highway: "motorway" } : { highway: "path" })],
      nearbyMotorwayWays: [],
      sourceDatasetIdentity,
    }));
  const unsafeReport = createPhase11C9RoadSafetyReport({
    lockedManifestPath: "data/osm/alps/publication/phase11c3-v2-batch-100.json",
    lockedManifestHash: "e".repeat(64),
    sourceDatasetIdentity,
    records: gateRecords,
  });
  assert.throws(() => verifyPhase11C9RoadSafetyPublicationGate({
    report: unsafeReport,
    manifestPath: unsafeReport.lockedManifestPath,
    manifestHash: unsafeReport.lockedManifestHash,
    manifestRecords: gateRecords.map((record) => ({
      canonicalRouteSourceId: record.canonicalRelationId,
      stagingRouteId: record.stagingRouteId,
    })),
    pipelineDatasetFingerprint: sourceDatasetIdentity.pipelineDatasetFingerprint,
  }), /PHASE11C9_ROAD_SAFETY_NOT_SAFE/);
});

test("safe road-safety filtering preserves publication identity and hashes", () => {
  const safe = analyze();
  const record = {
    canonicalRouteSourceId: safe.canonicalRelationId,
    candidateContentHash: "candidate",
    targetPayloadHash: "target",
    geometryHash: "geometry",
  };
  const selected = requireSafeRoadSafetyRecords([record], [safe]);
  assert.strictEqual(selected[0], record);
  assert.deepEqual(selected[0], record);
});

test("road-safety report is deterministic and records zero production writes", () => {
  const records = Array.from({ length: 100 }, (_, index) =>
    analyzeRouteRoadSafety({
      canonicalRelationId: String(index + 1),
      stagingRouteId: `staging-${index + 1}`,
      routeType: "hiking",
      routeWays: [way(index + 200, [[0, 0], [1, 0]])],
      nearbyMotorwayWays: [],
      sourceDatasetIdentity,
    }));
  const report = createPhase11C9RoadSafetyReport({
    lockedManifestPath: "data/osm/alps/publication/phase11c3-v2-batch-100.json",
    lockedManifestHash: "e".repeat(64),
    sourceDatasetIdentity,
    records,
  });
  verifyPhase11C9RoadSafetyReport(report);
  verifyPhase11C9RoadSafetyPublicationGate({
    report,
    manifestPath: "data/osm/alps/publication/phase11c3-v2-batch-100.json",
    manifestHash: "e".repeat(64),
    manifestRecords: records.map((record) => ({
      canonicalRouteSourceId: record.canonicalRelationId,
      stagingRouteId: record.stagingRouteId,
    })),
    pipelineDatasetFingerprint: sourceDatasetIdentity.pipelineDatasetFingerprint,
  });
  assert.deepEqual(report.writes, {
    rpcCalls: 0,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  });
});
