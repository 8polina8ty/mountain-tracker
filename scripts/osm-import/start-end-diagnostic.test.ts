import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateRouteDiagnostics } from "../../Lib/osmStagingPreview/core.ts";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
} from "../../Lib/osmStagingPreview/topology.ts";
import type { RouteGeometry } from "./peak-matcher.ts";
import {
  createGeometrySanityReview,
  createGeometryWarnings,
} from "./phase8-prewrite.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";
import {
  analyzeStartEndTopology,
  buildStartEndDiagnosticArtifact,
  type StartEndDiagnosticRouteInput,
} from "./start-end-diagnostic.ts";

function line(...coordinates: Array<[number, number]>): RouteGeometry {
  return { type: "LineString", coordinates };
}

function multi(...components: Array<Array<[number, number]>>): RouteGeometry {
  return { type: "MultiLineString", coordinates: components };
}

let planPromise: Promise<{ records: ImportPlanRecord[] }> | null = null;
let manifestPromise: Promise<{ records: Array<{ idempotencyKey: string }> }> | null = null;

function loadPlan(): Promise<{ records: ImportPlanRecord[] }> {
  planPromise ??= readFile("data/osm/alps/staging/import-plan.json", "utf8").then(
    (value) => JSON.parse(value) as { records: ImportPlanRecord[] },
  );
  return planPromise;
}

function loadManifest(): Promise<{ records: Array<{ idempotencyKey: string }> }> {
  manifestPromise ??= readFile(
    "data/osm/alps/staging/first-write-manifest.json",
    "utf8",
  ).then(
    (value) => JSON.parse(value) as { records: Array<{ idempotencyKey: string }> },
  );
  return manifestPromise;
}

async function planRecord(sourceRelationId: string): Promise<ImportPlanRecord> {
  const plan = await loadPlan();
  const record = plan.records.find((value) => value.sourceRelationId === sourceRelationId);
  assert.ok(record);
  return record;
}

test("single LineString has two physical endpoints", () => {
  const result = analyzeStartEndTopology(line([10, 46], [10.01, 46.01]));
  assert.equal(result.orderingClassification, "SINGLE_LINESTRING");
  assert.equal(result.physicalEndpointCount, 2);
  assert.equal(result.displayedStartIsPhysicalEndpoint, true);
  assert.equal(result.displayedEndIsPhysicalEndpoint, true);
});

test("normal ordered MultiLineString preserves a continuous chain", () => {
  const result = analyzeStartEndTopology(
    multi(
      [[10, 46], [10.01, 46]],
      [[10.01, 46], [10.02, 46]],
    ),
  );
  assert.equal(result.orderingClassification, "ORDERED");
  assert.deepEqual(result.orderedComponentIndexes, [0, 1]);
  assert.equal(result.genuinelyDisconnected, false);
});

test("reversed component is distinguished from disconnected geometry", () => {
  const result = analyzeStartEndTopology(
    multi(
      [[10.01, 46], [10, 46]],
      [[10.01, 46], [10.02, 46]],
    ),
  );
  assert.equal(result.orderingClassification, "REVERSED_COMPONENT");
  assert.deepEqual(result.reversedComponentIndexes, [0]);
  assert.equal(result.displayedStartIsPhysicalEndpoint, false);
  assert.equal(result.genuinelyDisconnected, false);
});

test("reversed component order is identified without inventing a connection", () => {
  const result = analyzeStartEndTopology(
    multi(
      [[10.01, 46], [10.02, 46]],
      [[10, 46], [10.01, 46]],
    ),
  );
  assert.equal(result.orderingClassification, "REORDERED_COMPONENTS");
  assert.deepEqual(result.orderedComponentIndexes, [1, 0]);
  assert.equal(result.componentsReordered, true);
});

test("disconnected MultiLineString retains four physical endpoints", () => {
  const result = analyzeStartEndTopology(
    multi(
      [[10, 46], [10.01, 46]],
      [[11, 46], [11.01, 46]],
    ),
  );
  assert.equal(result.orderingClassification, "DISCONNECTED");
  assert.equal(result.genuinelyDisconnected, true);
  assert.equal(result.componentGroupCount, 2);
  assert.equal(result.physicalEndpointCount, 4);
  assert.equal(result.ambiguousStartEnd, true);
});

test("branching MultiLineString reports multiple physical endpoints", () => {
  const result = analyzeStartEndTopology(
    multi(
      [[10, 46], [10.01, 46]],
      [[10.01, 46], [10.02, 46]],
      [[10.01, 46], [10.01, 46.01]],
    ),
  );
  assert.equal(result.genuinelyDisconnected, false);
  assert.equal(result.physicalEndpointCount, 3);
  assert.equal(result.ambiguousStartEnd, true);
  assert.equal(result.orderingClassification, "AMBIGUOUS_TOPOLOGY");
});

test("Sentiero della Loffa regression is connected with a non-physical array start", async () => {
  const record = await planRecord("1144001");
  const storedGeometry = JSON.stringify(record.contract.route.geometry);
  const result = analyzeStartEndTopology(record.contract.route.geometry);
  assert.equal(result.componentCount, 2);
  assert.equal(result.pointCount, 129);
  assert.equal(result.orderingClassification, "REVERSED_COMPONENT");
  assert.equal(result.genuinelyDisconnected, false);
  assert.equal(result.displayedStartIsPhysicalEndpoint, false);
  assert.equal(result.displayedEndIsPhysicalEndpoint, true);
  assert.deepEqual(result.reversedComponentIndexes, [0]);
  assert.deepEqual(result.physicalEndpoints.map((value) => value.coordinate), [
    [11.1696067, 45.7495493],
    [11.1761777, 45.7469932],
  ]);
  assert.equal(result.pairwiseEndpointDistances[0].startToStartMeters, 0);
  const selection = selectRouteEndpoints(
    analyzeRouteTopology(record.contract.route.geometry),
    [record.contract.confirmedSummits[0].peakCoordinates!],
  );
  assert.equal(selection.orientationReason, "CONFIRMED_SUMMIT_ENDPOINT");
  assert.deepEqual(selection.startCoordinate, [11.1696067, 45.7495493]);
  assert.deepEqual(selection.endCoordinate, [11.1761777, 45.7469932]);
  const diagnostics = calculateRouteDiagnostics({
    geometry: record.contract.route.geometry,
    summitCoordinate: record.contract.confirmedSummits[0].peakCoordinates!,
    totalDistanceMeters: record.contract.route.distanceMeters,
    endpointDistanceMeters: record.contract.confirmedSummits[0].endpointDistanceMeters,
  });
  assert.equal(diagnostics.routeToStraightLineRatio, 1.92);
  const review = createGeometrySanityReview(record);
  assert.equal(review.routeToStraightLineRatio, 1.92);
  assert.equal(
    createGeometryWarnings(record, review).includes(
      "HIGH_ROUTE_TO_STRAIGHT_LINE_RATIO",
    ),
    false,
  );
  assert.equal(JSON.stringify(record.contract.route.geometry), storedGeometry);
});

test("relation 2210868 receives physical summit-oriented markers without geometry mutation", async () => {
  const record = await planRecord("2210868");
  const storedGeometry = JSON.stringify(record.contract.route.geometry);
  const topology = analyzeRouteTopology(record.contract.route.geometry);
  const selection = selectRouteEndpoints(topology, [
    record.contract.confirmedSummits[0].peakCoordinates!,
  ]);
  assert.equal(topology.classification, "CONNECTED_TWO_ENDPOINTS");
  assert.deepEqual(selection.startCoordinate, [15.8710018, 47.6413338]);
  assert.deepEqual(selection.endCoordinate, [15.860309, 47.6296728]);
  assert.equal(topology.physicalEndpoints.some((value) =>
    JSON.stringify(value.coordinate) === JSON.stringify(selection.startCoordinate)), true);
  assert.equal(topology.physicalEndpoints.some((value) =>
    JSON.stringify(value.coordinate) === JSON.stringify(selection.endCoordinate)), true);
  assert.equal(JSON.stringify(record.contract.route.geometry), storedGeometry);
});

test("relation 4103375 receives inferred physical markers and remains explicitly ambiguous", async () => {
  const record = await planRecord("4103375");
  const storedGeometry = JSON.stringify(record.contract.route.geometry);
  const topology = analyzeRouteTopology(record.contract.route.geometry);
  const selection = selectRouteEndpoints(topology, [
    record.contract.confirmedSummits[0].peakCoordinates!,
  ]);
  assert.equal(topology.classification, "BRANCHING");
  assert.equal(topology.physicalEndpointCount, 4);
  assert.equal(topology.ambiguousStartEnd, true);
  assert.equal(selection.available, true);
  assert.deepEqual(selection.startCoordinate, [11.6686224, 46.7979373]);
  assert.deepEqual(selection.endCoordinate, [11.686882, 46.8595389]);
  assert.equal(selection.orientationReason, "INFERRED_BRANCHING_PHYSICAL_ENDPOINTS");
  assert.equal(selection.ambiguous, true);
  assert.equal(selection.warning, "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS");
  assert.equal(topology.physicalEndpoints.some((value) =>
    JSON.stringify(value.coordinate) === JSON.stringify(selection.startCoordinate)), true);
  assert.equal(topology.physicalEndpoints.some((value) =>
    JSON.stringify(value.coordinate) === JSON.stringify(selection.endCoordinate)), true);
  assert.equal(JSON.stringify(record.contract.route.geometry), storedGeometry);
});

test("relation 11192622 remains disconnected with no fabricated global markers", async () => {
  const record = await planRecord("11192622");
  const topology = analyzeRouteTopology(record.contract.route.geometry);
  const selection = selectRouteEndpoints(topology, [
    record.contract.confirmedSummits[0].peakCoordinates!,
  ]);
  assert.equal(topology.classification, "DISCONNECTED");
  assert.equal(topology.connectedGroupCount, 4);
  assert.equal(topology.physicalEndpointCount, 9);
  assert.equal(selection.available, false);
  assert.equal(selection.startCoordinate, null);
  assert.equal(selection.endCoordinate, null);
  assert.equal(selection.warning, "DISCONNECTED_GLOBAL_ENDPOINTS_UNAVAILABLE");
});

test("all 46 reviewed routes preserve geometry and use only physical global endpoints", async () => {
  const [plan, manifest] = await Promise.all([loadPlan(), loadManifest()]);
  const reviewedKeys = new Set(manifest.records.map((record) => record.idempotencyKey));
  const records = plan.records.filter((record) => reviewedKeys.has(record.idempotencyKey));
  assert.equal(records.length, 46);
  const classifications = new Map<string, number>();
  for (const record of records) {
    const storedGeometry = JSON.stringify(record.contract.route.geometry);
    const topology = analyzeRouteTopology(record.contract.route.geometry);
    const summitCoordinates = record.contract.confirmedSummits
      .map((summit) => summit.peakCoordinates)
      .filter((coordinate): coordinate is [number, number] => coordinate !== null);
    const selection = selectRouteEndpoints(topology, summitCoordinates);
    classifications.set(
      topology.classification,
      (classifications.get(topology.classification) ?? 0) + 1,
    );
    assert.equal(JSON.stringify(record.contract.route.geometry), storedGeometry);
    if (topology.classification === "DISCONNECTED") {
      assert.equal(selection.available, false);
      assert.equal(selection.startCoordinate, null);
      assert.equal(selection.endCoordinate, null);
      continue;
    }
    if (!selection.available) continue;
    const physicalCoordinates = topology.physicalEndpoints.map((endpoint) =>
      JSON.stringify(endpoint.coordinate));
    assert.ok(physicalCoordinates.includes(JSON.stringify(selection.startCoordinate)));
    assert.ok(physicalCoordinates.includes(JSON.stringify(selection.endCoordinate)));
  }
  assert.deepEqual(Object.fromEntries(classifications), {
    SIMPLE: 42,
    CONNECTED_TWO_ENDPOINTS: 2,
    BRANCHING: 1,
    DISCONNECTED: 1,
  });
});

function artifactRoute(sourceRelationId: string): StartEndDiagnosticRouteInput {
  return {
    stagingRouteId: `route-${sourceRelationId}`,
    sourceRelationId,
    canonicalSourceId: sourceRelationId,
    routeName: `Route ${sourceRelationId}`,
    semanticType: "summit_route",
    qualityScore: 100,
    distanceMeters: 1000,
    geometry: line([10, 46], [10.01, 46.01]),
    warnings: [],
    summit: { peakOsmId: "1", name: "Peak", coordinate: [10.01, 46.01] },
    mountain: { id: 1, name: "Mountain", coordinate: [10.01, 46.01] },
    payloadHashMatchesManifest: true,
    geometryMatchesLocalPlan: true,
    geometryMatchesReconstruction: true,
  };
}

test("diagnostic artifact generation is deterministic and source-ID sorted", () => {
  const input = {
    manifestDatasetFingerprint: "fingerprint",
    manifestRecordCount: 2,
    routes: [artifactRoute("20"), artifactRoute("10")],
  };
  const first = buildStartEndDiagnosticArtifact(input);
  const second = buildStartEndDiagnosticArtifact(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.routes.map((route) => route.sourceRelationId), ["10", "20"]);
  assert.equal(first.databaseWrites, 0);
});
