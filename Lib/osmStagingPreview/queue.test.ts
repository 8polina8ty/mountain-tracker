import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createApprovedListItems,
  createPreviewNavigation,
  createPreviewQueueState,
  validateManifestApprovedRows,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewMetadataRecord,
  type PreviewStagingRouteRow,
  type PreviewStagingSummitRow,
  type StoredPreviewQaDecision,
} from "./core.ts";
import { AUTO_APPROVAL_ENABLED } from "./auto-qa.ts";
import {
  getPreviewQueueDefinition,
  parsePreviewQueueId,
  previewQueueHref,
  validatePreviewQueueContract,
  type PreviewQueueArtifact,
} from "./queue-core.ts";

const QUEUE_TOTAL = 150;

function metadataRecord(sourceRelationId: string, index: number): PreviewMetadataRecord {
  return {
    sourceRelationId,
    canonicalRouteSourceId: sourceRelationId,
    idempotencyKey: `key-${sourceRelationId}`,
    payloadHash: `hash-${sourceRelationId}`,
    routeName: `Route ${sourceRelationId}`,
    semanticType: "summit_route",
    qualityScore: 100,
    distanceMeters: 1_000 + index,
    componentCount: 1,
    auditFlags: [],
    warnings: [],
    countryCode: "AT",
    countryName: "Austria",
    admin1Code: "AT-7",
    admin1Name: "Tyrol",
    administrationStatus: "ASSIGNED",
    summit: {
      peakOsmId: `peak-${sourceRelationId}`,
      peakName: `Peak ${sourceRelationId}`,
      peakElevationMeters: 2_000,
      peakCoordinates: [10, 47],
      mountainId: 1_000 + index,
      mountainName: `Mountain ${sourceRelationId}`,
      mountainElevationMeters: 2_000,
      matchClassification: "EXACT_MOUNTAIN_MATCH",
      finalAssociation: "CONFIRMED",
      finalConfidence: 1,
      minimumGeometryDistanceMeters: 1,
      endpointDistanceMeters: 2,
    },
    diagnostics: {
      totalDistanceMeters: 1_000 + index,
      componentLengthsMeters: [1_000 + index],
      boundingBox: {
        minimumLongitude: 10,
        minimumLatitude: 47,
        maximumLongitude: 10.01,
        maximumLatitude: 47.01,
      },
      startCoordinate: [10, 47],
      endCoordinate: [10.01, 47.01],
      summitCoordinate: [10.01, 47.01],
      endpointDistanceMeters: 2,
      startToSummitDistanceMeters: 1_000,
      straightLineDistanceMeters: 1_000,
      routeToStraightLineRatio: 1,
      routeToStraightLineStatus: "AVAILABLE",
      topologyClassification: "SIMPLE",
      connectedGroupCount: 1,
      physicalEndpointCount: 2,
      endpointOrientationReason: "CONFIRMED_SUMMIT_ENDPOINT",
      endpointSelectionAmbiguous: false,
      endpointSelectionWarning: null,
      geometryPointCount: 2,
    },
  };
}

function fixtures() {
  const relationIds = Array.from({ length: QUEUE_TOTAL }, (_, index) => String(index + 1));
  const artifact: PreviewQueueArtifact = {
    artifactType: "PHASE11C4_NEW_QA_QUEUE",
    newRoutesQueued: QUEUE_TOTAL,
    queue: relationIds.map((sourceRelationId) => ({
      sourceRelationId,
      canonicalRouteSourceId: sourceRelationId,
    })),
  };
  const metadataRecords = relationIds.map(metadataRecord);
  const manifest: PreviewManifest = {
    schemaVersion: 1,
    contractVersion: "mountain-tracker-osm-route/v1",
    datasetFingerprint: "dataset",
    recordCount: QUEUE_TOTAL,
    expectedSummitAssociationCount: QUEUE_TOTAL,
    records: metadataRecords
      .map((record) => ({
        idempotencyKey: record.idempotencyKey,
        payloadHash: record.payloadHash,
        sourceRelationId: record.sourceRelationId,
        canonicalRouteSourceId: record.canonicalRouteSourceId,
        expectedSummitAssociationCount: 1,
        mountainMatches: [
          {
            peakOsmId: record.summit.peakOsmId,
            mountainId: record.summit.mountainId,
            classification: "EXACT_MOUNTAIN_MATCH" as const,
          },
        ],
      }))
      .reverse(),
    manifestHash: "fixture",
  };
  const metadata: PreviewMetadataDocument = {
    schemaVersion: 1,
    contractVersion: manifest.contractVersion,
    datasetFingerprint: manifest.datasetFingerprint,
    manifestHash: manifest.manifestHash,
    recordCount: QUEUE_TOTAL,
    records: [...metadataRecords].reverse(),
  };
  const routes: PreviewStagingRouteRow[] = metadataRecords.map((record) => ({
    id: `route-${record.sourceRelationId}`,
    contract_version: manifest.contractVersion,
    idempotency_key: record.idempotencyKey,
    payload_hash: record.payloadHash,
    source_relation_id: record.sourceRelationId,
    canonical_source_id: record.canonicalRouteSourceId,
    route_name: record.routeName,
    semantic_type: record.semanticType,
    quality_score: record.qualityScore,
    distance_meters: record.distanceMeters,
    matched_primary_mountain_id: record.summit.mountainId,
    audit_flags: record.auditFlags,
    import_eligibility: "AUTO_IMPORT_READY",
  }));
  const summits: PreviewStagingSummitRow[] = metadataRecords.map((record) => ({
    staging_route_id: `route-${record.sourceRelationId}`,
    peak_osm_id: record.summit.peakOsmId,
    mountain_id: record.summit.mountainId,
    mountain_match_classification: "EXACT_MOUNTAIN_MATCH",
    final_association: "CONFIRMED",
    final_confidence: record.summit.finalConfidence,
    minimum_geometry_distance_meters: record.summit.minimumGeometryDistanceMeters,
    endpoint_distance_meters: record.summit.endpointDistanceMeters,
  }));
  return { artifact, manifest, metadata, routes, summits };
}

function resolvedList(qaDecisions: StoredPreviewQaDecision[] = []) {
  const value = fixtures();
  const contract = validatePreviewQueueContract({
    definition: getPreviewQueueDefinition("phase11c4"),
    artifact: value.artifact,
    manifest: value.manifest,
    metadata: value.metadata,
  });
  const validated = validateManifestApprovedRows({
    manifest: contract.manifest,
    routes: value.routes,
    summits: value.summits,
    expectedRecordCount: QUEUE_TOTAL,
    preserveManifestOrder: true,
  });
  return createApprovedListItems({
    validated,
    metadata: contract.metadata,
    qaDecisions,
    expectedRecordCount: QUEUE_TOTAL,
  });
}

test("phase11c4 resolves exactly 150 staged records in artifact order", () => {
  const list = resolvedList();
  assert.equal(list.length, QUEUE_TOTAL);
  assert.deepEqual(
    list.map((route) => route.sourceRelationId),
    Array.from({ length: QUEUE_TOTAL }, (_, index) => String(index + 1)),
  );
});

test("unknown and repeated queue query IDs fail closed", () => {
  assert.equal(parsePreviewQueueId(undefined), null);
  assert.equal(parsePreviewQueueId("phase11c4"), "phase11c4");
  assert.equal(parsePreviewQueueId("phase11d"), "phase11d");
  assert.equal(parsePreviewQueueId("phase11e"), "phase11e");
  assert.equal(parsePreviewQueueId("phase11f"), "phase11f");
  assert.equal(getPreviewQueueDefinition("phase11d").expectedTotal, 600);
  assert.equal(getPreviewQueueDefinition("phase11e").expectedTotal, 704);
  assert.throws(() => parsePreviewQueueId("../../secret"), /Unknown/);
  assert.throws(() => parsePreviewQueueId(["phase11c4", "phase11c4"]), /Unknown/);
});

test("duplicate queue relations fail closed", () => {
  const value = fixtures();
  value.artifact.queue[1] = { ...value.artifact.queue[0] };
  assert.throws(
    () =>
      validatePreviewQueueContract({
        definition: getPreviewQueueDefinition("phase11c4"),
        artifact: value.artifact,
        manifest: value.manifest,
        metadata: value.metadata,
      }),
    /duplicate route identities/,
  );
});

test("unresolved or unexpected staging relations fail closed", () => {
  const value = fixtures();
  value.manifest.records[0] = {
    ...value.manifest.records[0],
    sourceRelationId: "999",
    canonicalRouteSourceId: "999",
  };
  assert.throws(
    () =>
      validatePreviewQueueContract({
        definition: getPreviewQueueDefinition("phase11c4"),
        artifact: value.artifact,
        manifest: value.manifest,
        metadata: value.metadata,
      }),
    /Unresolved queue relation|unexpected relation/,
  );
});

test("queue identity and payload hash drift fail closed", () => {
  const value = fixtures();
  value.metadata.records[0] = { ...value.metadata.records[0], payloadHash: "drift" };
  assert.throws(
    () =>
      validatePreviewQueueContract({
        definition: getPreviewQueueDefinition("phase11c4"),
        artifact: value.artifact,
        manifest: value.manifest,
        metadata: value.metadata,
      }),
    /metadata drift/,
  );
});

test("queue navigation, position, and counters remain queue scoped", () => {
  const decisions: StoredPreviewQaDecision[] = ["1", "2"].map((id) => ({
    stagingRouteId: `route-${id}`,
    status: "VISUALLY_APPROVED",
    reviewerNote: null,
    reviewedAt: "2026-08-28T12:00:00Z",
    reviewerUserId: "reviewer",
    version: 1,
  }));
  const list = resolvedList(decisions);
  assert.deepEqual(createPreviewQueueState(list, "route-75"), {
    position: 75,
    total: 150,
    reviewed: 2,
    remaining: 148,
  });
  const navigation = createPreviewNavigation(list, "route-75");
  assert.equal(navigation.previousId, "route-74");
  assert.equal(navigation.nextId, "route-76");
  assert.throws(() => createPreviewQueueState(list, "route-outside"), /selected queue/);
});

test("compact queue context is preserved from list through detail and save navigation", async () => {
  assert.equal(
    previewQueueHref("/internal/osm-staging/route-1", "phase11c4"),
    "/internal/osm-staging/route-1?queue=phase11c4",
  );
  const [listSource, detailSource, formSource] = await Promise.all([
    readFile("components/internal/OsmStagingRouteList.tsx", "utf8"),
    readFile("app/[locale]/internal/osm-staging/[stagingRouteId]/page.tsx", "utf8"),
    readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8"),
  ]);
  assert.match(listSource, /previewQueueHref/);
  assert.match(detailSource, /Back to QA list[\s\S]*queueId/);
  assert.match(formSource, /previewQueueHref\(`\/internal\/osm-staging\/\$\{destinationId\}`/);
});

test("direct legacy mode and authorization gate remain in place", async () => {
  const [pageSource, serverSource] = await Promise.all([
    readFile("app/[locale]/internal/osm-staging/page.tsx", "utf8"),
    readFile("Lib/osmStagingPreview/server.ts", "utf8"),
  ]);
  assert.match(pageSource, /requireOsmStagingPreviewAccess\(\)/);
  assert.match(serverSource, /queueId: PreviewQueueId \| null = null/);
  assert.match(serverSource, /loadLocalContracts\(\)/);
});

test("Auto-QA automatic approval remains disabled", () => {
  assert.equal(AUTO_APPROVAL_ENABLED, false);
});

test("Phase 11D is an explicit fixed-path queue and rejects artifact drift", () => {
  const value = fixtures();
  assert.throws(
    () => validatePreviewQueueContract({
      definition: getPreviewQueueDefinition("phase11d"),
      artifact: value.artifact,
      manifest: value.manifest,
      metadata: value.metadata,
    }),
    /artifact count or type is invalid/,
  );
  assert.doesNotMatch(getPreviewQueueDefinition("phase11d").artifactPath, /\.\.|[?&]path=/);
});

test("Phase 11E is an explicit fixed-path queue", () => {
  const definition = getPreviewQueueDefinition("phase11e");
  assert.equal(definition.expectedArtifactType, "PHASE11E_SCALE_QA_QUEUE");
  assert.doesNotMatch(definition.artifactPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.stagingManifestPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.previewMetadataPath, /\.\.|[?&]path=/);
});

test("Phase 11F is an explicit fixed-path calibration queue", () => {
  const definition = getPreviewQueueDefinition("phase11f");
  assert.equal(definition.expectedArtifactType, "PHASE11F_GREEN_CALIBRATION_QUEUE");
  assert.equal(definition.expectedTotal, 298);
  assert.doesNotMatch(definition.artifactPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.stagingManifestPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.previewMetadataPath, /\.\.|[?&]path=/);
});
