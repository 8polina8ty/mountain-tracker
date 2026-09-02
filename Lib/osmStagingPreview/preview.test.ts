import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluatePreviewAccess } from "./access-policy.ts";
import { executeQaDecisionMutation, type QaMutationTarget } from "./mutation-core.ts";
import {
  buildRouteFeatureCollection,
  calculateRouteDiagnostics,
  createApprovedListItems,
  createPreviewNavigation,
  filterPreviewRoutes,
  isQaStatus,
  isPublicationCandidate,
  osmRelationUrl,
  parseQaDecisionInput,
  summarizeQaProgress,
  validateManifestApprovedRows,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewRouteGeometry,
  type PreviewQaStatus,
  type PreviewStagingRouteRow,
  type PreviewStagingSummitRow,
} from "./core.ts";

function fixtures() {
  const manifestRecords = Array.from({ length: 46 }, (_, index) => {
    const id = String(index + 1);
    return {
      idempotencyKey: `openstreetmap:relation:${id}:mountain-tracker-osm-route/v1`,
      payloadHash: `hash-${id}`,
      sourceRelationId: id,
      canonicalRouteSourceId: id,
      expectedSummitAssociationCount: 1,
      mountainMatches: [
        {
          peakOsmId: `peak-${id}`,
          mountainId: index + 100,
          classification: "EXACT_MOUNTAIN_MATCH" as const,
        },
      ],
    };
  });
  const manifest: PreviewManifest = {
    schemaVersion: 1,
    contractVersion: "mountain-tracker-osm-route/v1",
    datasetFingerprint: "dataset",
    recordCount: 46,
    expectedSummitAssociationCount: 46,
    records: manifestRecords,
    manifestHash: "manifest",
  };
  const routes: PreviewStagingRouteRow[] = manifestRecords.map((record, index) => ({
    id: `route-${record.sourceRelationId}`,
    contract_version: manifest.contractVersion,
    idempotency_key: record.idempotencyKey,
    payload_hash: record.payloadHash,
    source_relation_id: record.sourceRelationId,
    canonical_source_id: record.canonicalRouteSourceId,
    route_name: `Route ${record.sourceRelationId}`,
    semantic_type: "summit_route",
    quality_score: 100,
    distance_meters: 1_000 + index,
    matched_primary_mountain_id: record.mountainMatches[0].mountainId,
    audit_flags: [],
    import_eligibility: "AUTO_IMPORT_READY",
  }));
  const summits: PreviewStagingSummitRow[] = manifestRecords.map((record) => ({
    staging_route_id: `route-${record.sourceRelationId}`,
    peak_osm_id: record.mountainMatches[0].peakOsmId,
    mountain_id: record.mountainMatches[0].mountainId,
    mountain_match_classification: "EXACT_MOUNTAIN_MATCH",
    final_association: "CONFIRMED",
    final_confidence: 1,
    minimum_geometry_distance_meters: 1,
    endpoint_distance_meters: 2,
  }));
  const metadata: PreviewMetadataDocument = {
    schemaVersion: 1,
    contractVersion: manifest.contractVersion,
    datasetFingerprint: manifest.datasetFingerprint,
    manifestHash: manifest.manifestHash,
    recordCount: 46,
    records: manifestRecords.map((record, index) => ({
      sourceRelationId: record.sourceRelationId,
      canonicalRouteSourceId: record.canonicalRouteSourceId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      routeName: `Route ${record.sourceRelationId}`,
      semanticType: "summit_route",
      qualityScore: 100,
      distanceMeters: 1_000 + index,
      componentCount: 1,
      auditFlags: [],
      warnings: index === 1 || index === 4 ? ["VISUAL_WARNING"] : [],
      countryCode: "AT",
      countryName: "Austria",
      admin1Code: "AT-7",
      admin1Name: "Tyrol",
      administrationStatus: "ASSIGNED",
      summit: {
        peakOsmId: record.mountainMatches[0].peakOsmId,
        peakName: `Peak ${record.sourceRelationId}`,
        peakElevationMeters: 2_000,
        peakCoordinates: [10, 47],
        mountainId: record.mountainMatches[0].mountainId,
        mountainName: `Mountain ${record.sourceRelationId}`,
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
    })),
  };
  return { manifest, routes, summits, metadata };
}

test("only the exact manifest-approved route set becomes visible", () => {
  const value = fixtures();
  const validated = validateManifestApprovedRows(value);
  const list = createApprovedListItems({ validated, metadata: value.metadata });
  assert.equal(list.length, 46);
  assert.deepEqual(
    new Set(list.map((route) => route.idempotencyKey)),
    new Set(value.manifest.records.map((record) => record.idempotencyKey)),
  );
});

test("manifest order wins over chunk and database response order", () => {
  const value = fixtures();
  const validated = validateManifestApprovedRows({
    ...value,
    routes: [...value.routes].reverse(),
    summits: [...value.summits].reverse(),
    preserveManifestOrder: true,
  });
  assert.deepEqual(
    validated.map(({ manifest }) => manifest.idempotencyKey),
    value.manifest.records.map((record) => record.idempotencyKey),
  );
});

test("missing and duplicate required staging identities fail closed", () => {
  const missing = fixtures();
  missing.routes.pop();
  assert.throws(
    () => validateManifestApprovedRows(missing),
    /does not exactly match the reviewed manifest/,
  );

  const duplicate = fixtures();
  duplicate.routes[1] = { ...duplicate.routes[0], id: "duplicate-route" };
  assert.throws(() => validateManifestApprovedRows(duplicate), /Duplicate staging route key/);

  const missingSummit = fixtures();
  missingSummit.summits.pop();
  assert.throws(() => validateManifestApprovedRows(missingSummit), /Summit count mismatch/);
});

test("payload hash mismatch fails closed", () => {
  const value = fixtures();
  value.routes[0].payload_hash = "changed";
  assert.throws(() => validateManifestApprovedRows(value), /Payload hash mismatch/);
});

test("wrong contract version fails closed", () => {
  const value = fixtures();
  value.routes[0].contract_version = "wrong";
  assert.throws(() => validateManifestApprovedRows(value), /Wrong contract version/);
});

test("non-CONFIRMED summit fails closed", () => {
  const value = fixtures();
  value.summits[0].final_association = "REVIEW";
  assert.throws(() => validateManifestApprovedRows(value), /Non-CONFIRMED/);
});

test("non-exact mountain match fails closed", () => {
  const value = fixtures();
  value.summits[0].mountain_match_classification = "PROBABLE_MOUNTAIN_MATCH";
  assert.throws(() => validateManifestApprovedRows(value), /Non-exact/);
});

test("route list serialization excludes full geometry", () => {
  const value = fixtures();
  const list = createApprovedListItems({
    validated: validateManifestApprovedRows(value),
    metadata: value.metadata,
  });
  assert.equal(Object.hasOwn(list[0], "geometry"), false);
  assert.doesNotMatch(JSON.stringify(list), /"coordinates":\[\[10/);
});

test("individual preview supplies geometry to the shared map", async () => {
  const source = await readFile("app/[locale]/internal/osm-staging/[stagingRouteId]/page.tsx", "utf8");
  assert.match(source, /geometry=\{detail\.geometry\}/);
  assert.match(await readFile("Lib/osmStagingPreview/server.ts", "utf8"), /geometry_geojson,payload/);
});

test("service-role credentials never enter client components", async () => {
  const source = await Promise.all([
    readFile("components/internal/OsmStagingRouteList.tsx", "utf8"),
    readFile("components/internal/OsmStagingRouteMap.tsx", "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(source, /SUPABASE_SECRET|SERVICE_ROLE|createAdminClient|process\.env/);
});

test("MultiLineString components remain disconnected", () => {
  const geometry: PreviewRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10, 47], [10.01, 47.01]],
      [[11, 48], [11.01, 48.01]],
    ],
  };
  const collection = buildRouteFeatureCollection(geometry);
  assert.equal(collection.features[0].geometry.type, "MultiLineString");
  assert.deepEqual(collection.features[0].geometry.coordinates, geometry.coordinates);
});

test("QA decision model accepts only the four isolated statuses", () => {
  for (const status of ["PENDING", "VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"]) {
    assert.equal(isQaStatus(status), true);
  }
  assert.equal(isQaStatus("PUBLISHED"), false);
});

test("ordinary and unauthenticated users cannot access the preview", () => {
  assert.equal(evaluatePreviewAccess({ nodeEnv: "development", enabled: "true", allowedUserIds: "admin", authenticatedUserId: null }).allowed, false);
  assert.equal(evaluatePreviewAccess({ nodeEnv: "development", enabled: "true", allowedUserIds: "admin", authenticatedUserId: "ordinary" }).allowed, false);
});

test("production is fail-closed regardless of configuration", () => {
  assert.deepEqual(evaluatePreviewAccess({ nodeEnv: "production", enabled: "true", allowedUserIds: "admin", authenticatedUserId: "admin" }), {
    allowed: false,
    reason: "PRODUCTION_DISABLED",
  });
});

test("previous and next navigation follows deterministic reviewed order", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata });
  assert.deepEqual(createPreviewNavigation(routes, "route-3"), {
    previousId: "route-2",
    nextId: "route-4",
    previousWarningId: "route-2",
    nextWarningId: "route-5",
    previousPendingId: "route-2",
    nextPendingId: "route-4",
  });
});

test("warning navigation stops cleanly at the first and last warning", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata });
  assert.equal(createPreviewNavigation(routes, "route-2").previousWarningId, null);
  assert.equal(createPreviewNavigation(routes, "route-5").nextWarningId, null);
});

test("geometry diagnostics calculate components without bridges", () => {
  const diagnostics = calculateRouteDiagnostics({
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [[10, 47], [10.01, 47]],
        [[11, 48], [11.01, 48]],
      ],
    },
    summitCoordinate: [11.01, 48],
    totalDistanceMeters: 2_000,
    endpointDistanceMeters: 0,
  });
  assert.equal(diagnostics.componentLengthsMeters.length, 2);
  assert.equal(diagnostics.geometryPointCount, 4);
  assert.equal(diagnostics.endpointDistanceMeters, 0);
});

test("OSM relation navigation uses only the validated numeric relation ID", () => {
  assert.equal(osmRelationUrl("11192622"), "https://www.openstreetmap.org/relation/11192622");
  assert.throws(() => osmRelationUrl("node/1"), /Invalid OSM relation ID/);
});

test("staging preview server cannot write or read mountain_routes", async () => {
  const source = await readFile("Lib/osmStagingPreview/server.ts", "utf8");
  assert.doesNotMatch(source, /mountain_routes|\.insert\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(source, /\.from\([^)]*\)[\s\S]{0,120}\.update\(/);
});

test("visual-QA SQL remains isolated, RLS-enabled, and service-only", async () => {
  const source = await readFile("database/osm_staging_visual_qa.sql", "utf8");
  assert.match(source, /create table public\.osm_staging_route_visual_qa/);
  assert.match(source, /enable row level security/);
  assert.match(source, /revoke all[^;]+from public, anon, authenticated/);
  assert.match(source, /grant select[^;]+to service_role/);
  assert.match(source, /grant execute[^;]+to service_role/);
  assert.doesNotMatch(source, /mountain_routes|gps_activities|ascents|journal/i);
});

test("visual-QA rollback can remove only its isolated decision table", async () => {
  const source = await readFile("database/osm_staging_visual_qa_rollback.sql", "utf8");
  assert.match(source, /drop table if exists public\.osm_staging_route_visual_qa/);
  assert.match(source, /drop table if exists public\.osm_staging_route_visual_qa_history/);
  assert.match(source, /drop function if exists public\.record_osm_staging_visual_qa_decision/);
  assert.doesNotMatch(source, /mountain_routes|osm_route_import_staging;/i);
});

test("QA controls remain disabled before the manual SQL deployment", async () => {
  const source = await readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8");
  assert.match(source, /disabled=!writesAvailable|disabled=\{!writesAvailable/);
  assert.match(source, /SQL is not applied/);
});

const QA_ROUTE_ID = "00000000-0000-4000-8000-000000000001";

function qaTarget(): QaMutationTarget {
  const value = fixtures();
  return {
    stagingRouteId: QA_ROUTE_ID,
    contractVersion: value.manifest.contractVersion,
    importEligibility: "AUTO_IMPORT_READY",
    metadata: value.metadata.records[0],
    manifest: value.manifest.records[0],
  };
}

function qaInput(status: string = "VISUALLY_APPROVED") {
  return {
    stagingRouteId: QA_ROUTE_ID,
    status,
    reviewerNote: "Checked",
    expectedVersion: null,
  };
}

test("unauthorized user cannot write QA", async () => {
  let wrote = false;
  await assert.rejects(
    executeQaDecisionMutation(qaInput(), {
      authorize: async () => { throw new Error("NOT_AUTHORIZED"); },
      validateTarget: async () => qaTarget(),
      writeDecision: async () => { wrote = true; throw new Error("unexpected"); },
    }),
    /NOT_AUTHORIZED/,
  );
  assert.equal(wrote, false);
});

test("production cannot authorize a QA write", () => {
  assert.equal(evaluatePreviewAccess({ nodeEnv: "production", enabled: "true", allowedUserIds: "reviewer", authenticatedUserId: "reviewer" }).allowed, false);
});

test("missing preview flag cannot authorize a QA write", () => {
  assert.equal(evaluatePreviewAccess({ nodeEnv: "development", enabled: undefined, allowedUserIds: "reviewer", authenticatedUserId: "reviewer" }).allowed, false);
});

test("non-manifest route is rejected before a QA write", async () => {
  let wrote = false;
  await assert.rejects(executeQaDecisionMutation(qaInput(), {
    authorize: async () => ({ userId: "reviewer" }),
    validateTarget: async () => { throw new Error("outside the reviewed manifest"); },
    writeDecision: async () => { wrote = true; throw new Error("unexpected"); },
  }), /outside the reviewed manifest/);
  assert.equal(wrote, false);
});

async function expectTargetDriftRejected(mutator: (target: QaMutationTarget) => void) {
  const target = qaTarget();
  mutator(target);
  let wrote = false;
  await assert.rejects(executeQaDecisionMutation(qaInput(), {
    authorize: async () => ({ userId: "reviewer" }),
    validateTarget: async () => target,
    writeDecision: async () => { wrote = true; throw new Error("unexpected"); },
  }), /reviewed-manifest validation/);
  assert.equal(wrote, false);
}

test("payload drift is rejected before a QA write", async () => {
  await expectTargetDriftRejected((target) => { target.metadata.payloadHash = "drift"; });
});

test("wrong contract is rejected before a QA write", async () => {
  await expectTargetDriftRejected((target) => { target.contractVersion = "wrong"; });
});

test("non-CONFIRMED association is rejected before a QA write", async () => {
  await expectTargetDriftRejected((target) => {
    target.metadata.summit.finalAssociation = "REVIEW" as "CONFIRMED";
  });
});

test("non-EXACT mountain match is rejected before a QA write", async () => {
  await expectTargetDriftRejected((target) => {
    target.metadata.summit.matchClassification = "PROBABLE_MOUNTAIN_MATCH" as "EXACT_MOUNTAIN_MATCH";
  });
});

test("arbitrary QA status is rejected", () => {
  assert.throws(() => parseQaDecisionInput(qaInput("PUBLISHED")), /Invalid QA decision status/);
});

test("reviewer note is trimmed and line endings normalized", () => {
  assert.equal(parseQaDecisionInput({ ...qaInput(), reviewerNote: "  first\r\nsecond  " }).reviewerNote, "first\nsecond");
});

test("reviewer note length is bounded", () => {
  assert.throws(() => parseQaDecisionInput({ ...qaInput(), reviewerNote: "x".repeat(1001) }), /at most 1000/);
});

test("reviewer note rejects HTML-like input", () => {
  assert.throws(() => parseQaDecisionInput({ ...qaInput(), reviewerNote: "<script>alert(1)</script>" }), /plain text/);
});

test("absence of a QA row maps deterministically to PENDING", () => {
  const value = fixtures();
  const list = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata, qaDecisions: [] });
  assert.equal(list[0].qaStatus, "PENDING");
  assert.equal(list[0].qaDecision, null);
});

async function persistedStatus(status: "VISUALLY_APPROVED" | "NEEDS_REVIEW" | "REJECTED") {
  return executeQaDecisionMutation(qaInput(status), {
    authorize: async () => ({ userId: "reviewer-uuid" }),
    validateTarget: async () => qaTarget(),
    writeDecision: async (input) => ({ status: input.status, reviewerNote: input.reviewerNote, reviewedAt: "2026-08-25T12:00:00.000Z", version: 1, changed: true }),
  });
}

test("approve decision persists through the atomic writer", async () => {
  assert.equal((await persistedStatus("VISUALLY_APPROVED")).status, "VISUALLY_APPROVED");
});

test("needs-review decision persists through the atomic writer", async () => {
  assert.equal((await persistedStatus("NEEDS_REVIEW")).status, "NEEDS_REVIEW");
});

test("reject decision persists through the atomic writer", async () => {
  assert.equal((await persistedStatus("REJECTED")).status, "REJECTED");
});

test("decision update carries the expected optimistic version", async () => {
  let expectedVersion: number | null = null;
  const result = await executeQaDecisionMutation({ ...qaInput("NEEDS_REVIEW"), expectedVersion: 1 }, {
    authorize: async () => ({ userId: "reviewer-uuid" }),
    validateTarget: async () => qaTarget(),
    writeDecision: async (input) => {
      expectedVersion = input.expectedVersion;
      return { status: input.status, reviewerNote: input.reviewerNote, reviewedAt: "2026-08-25T12:01:00.000Z", version: 2, changed: true };
    },
  });
  assert.equal(expectedVersion, 1);
  assert.equal(result.version, 2);
});

test("reviewer UUID comes only from server authorization", async () => {
  let reviewerUserId = "";
  await executeQaDecisionMutation({ ...qaInput(), reviewerId: "attacker" }, {
    authorize: async () => ({ userId: "trusted-reviewer-uuid" }),
    validateTarget: async () => qaTarget(),
    writeDecision: async (input) => {
      reviewerUserId = input.reviewerUserId;
      return { status: input.status, reviewerNote: input.reviewerNote, reviewedAt: "2026-08-25T12:00:00.000Z", version: 1, changed: true };
    },
  });
  assert.equal(reviewerUserId, "trusted-reviewer-uuid");
});

test("history preserves every decision transition", async () => {
  const sql = await readFile("database/osm_staging_visual_qa.sql", "utf8");
  assert.match(sql, /create table public\.osm_staging_route_visual_qa_history/);
  assert.equal((sql.match(/insert into public\.osm_staging_route_visual_qa_history/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /(?:update|delete) public\.osm_staging_route_visual_qa_history/i);
});

test("stale concurrent updates return a conflict", async () => {
  const sql = await readFile("database/osm_staging_visual_qa.sql", "utf8");
  assert.match(sql, /p_expected_version is distinct from v_current\.version/);
  assert.match(sql, /errcode = '40001', message = 'QA_DECISION_CONFLICT'/);
});

test("QA mutation has one atomic RPC and no direct table mutation", async () => {
  const source = await readFile("app/[locale]/internal/osm-staging/actions.ts", "utf8");
  assert.equal((source.match(/\.rpc\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /\.from\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
});

test("QA mutation cannot modify staging evidence", async () => {
  const source = await readFile("app/[locale]/internal/osm-staging/actions.ts", "utf8");
  assert.doesNotMatch(source, /osm_route_import_(?:summit_)?staging/);
});

test("QA mutation has no mountain route publication path", async () => {
  const sources = await Promise.all([
    readFile("app/[locale]/internal/osm-staging/actions.ts", "utf8"),
    readFile("Lib/osmStagingPreview/mutation-core.ts", "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(sources, /mountain_routes|mountains|community|gpx|ascents|journals/i);
  assert.equal(isPublicationCandidate("VISUALLY_APPROVED"), true);
  assert.equal(isPublicationCandidate("NEEDS_REVIEW"), false);
});

test("list status counts reflect persisted decisions", () => {
  const value = fixtures();
  const validated = validateManifestApprovedRows(value);
  const qaDecisions = [
    { stagingRouteId: "route-1", status: "VISUALLY_APPROVED" as const, reviewerNote: null, reviewedAt: "2026-08-25T12:00:00Z", reviewerUserId: "reviewer", version: 1 },
    { stagingRouteId: "route-2", status: "NEEDS_REVIEW" as const, reviewerNote: null, reviewedAt: "2026-08-25T12:00:00Z", reviewerUserId: "reviewer", version: 1 },
    { stagingRouteId: "route-3", status: "REJECTED" as const, reviewerNote: null, reviewedAt: "2026-08-25T12:00:00Z", reviewerUserId: "reviewer", version: 1 },
  ];
  assert.deepEqual(summarizeQaProgress(createApprovedListItems({ validated, metadata: value.metadata, qaDecisions })), {
    total: 46, decided: 3, pending: 43, visuallyApproved: 1, needsReview: 1, rejected: 1,
    warnings: 2, warningsPending: 1,
  });
});

test("every Phase 10 QA state filter is deterministic", () => {
  const value = fixtures();
  const routes = createApprovedListItems({
    validated: validateManifestApprovedRows(value),
    metadata: value.metadata,
    qaDecisions: [
      { stagingRouteId: "route-1", status: "VISUALLY_APPROVED", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 },
      { stagingRouteId: "route-2", status: "NEEDS_REVIEW", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 },
      { stagingRouteId: "route-3", status: "REJECTED", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 },
    ],
  });
  assert.equal(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "ALL" }).length, 46);
  assert.deepEqual(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "VISUALLY_APPROVED" }).map((route) => route.stagingRouteId), ["route-1"]);
  assert.deepEqual(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "NEEDS_REVIEW" }).map((route) => route.stagingRouteId), ["route-2"]);
  assert.deepEqual(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "REJECTED" }).map((route) => route.stagingRouteId), ["route-3"]);
  assert.equal(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "PENDING" }).length, 43);
});

test("warning-only filter remains independent of decision status", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata });
  assert.deepEqual(filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "WITH", status: "ALL" }).map((route) => route.stagingRouteId), ["route-2", "route-5"]);
});

test("status filtering returns only the selected persisted state", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata, qaDecisions: [{ stagingRouteId: "route-1", status: "VISUALLY_APPROVED", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 }] });
  const filtered = filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "ALL", status: "VISUALLY_APPROVED" });
  assert.deepEqual(filtered.map((route) => route.stagingRouteId), ["route-1"]);
});

test("Warnings + Pending filter excludes decided warning routes", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata, qaDecisions: [{ stagingRouteId: "route-2", status: "VISUALLY_APPROVED", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 }] });
  const filtered = filterPreviewRoutes(routes, { country: "ALL", quality: "ALL", warning: "WARNINGS_PENDING", status: "ALL" });
  assert.deepEqual(filtered.map((route) => route.stagingRouteId), ["route-5"]);
});

test("Save & Next navigation is wired to the deterministic next route", async () => {
  const source = await readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8");
  assert.match(source, /Save &amp; next/);
  assert.match(source, /destination === "NEXT" \? nextRouteId/);
});

test("Save & Next Pending navigation wraps to the next pending route", () => {
  const value = fixtures();
  const routes = createApprovedListItems({ validated: validateManifestApprovedRows(value), metadata: value.metadata, qaDecisions: [{ stagingRouteId: "route-4", status: "VISUALLY_APPROVED", reviewerNote: null, reviewedAt: "now", reviewerUserId: "reviewer", version: 1 }] });
  assert.equal(createPreviewNavigation(routes, "route-3").nextPendingId, "route-5");
  assert.equal(createPreviewNavigation(routes, "route-46").nextPendingId, "route-1");
  assert.equal(createPreviewNavigation(routes, "route-5").previousPendingId, "route-3");
  assert.equal(createPreviewNavigation(routes, "route-1").previousPendingId, "route-46");
});

test("list routes, summits, and QA decisions use bounded queries without list geometry", async () => {
  const source = await readFile("Lib/osmStagingPreview/server.ts", "utf8");
  assert.equal((source.match(/loadChunkedInQuery\(\{/g) ?? []).length, 3);
  assert.equal((source.match(/\.from\("osm_staging_route_visual_qa"\)/g) ?? []).length, 1);
  const selection = source.match(/\.from\("osm_staging_route_visual_qa"\)[\s\S]*?\.in\("staging_route_id"/)?.[0] ?? "";
  assert.doesNotMatch(selection, /geometry|payload/);
  assert.match(source, /queryLabel: "Staging preview route query"/);
  assert.match(source, /queryLabel: "Staging preview summit query"/);
  assert.match(source, /queryLabel: "Staging preview QA query"/);
});

test("service-role secret remains absent from all Phase 9B client code", async () => {
  const source = await Promise.all([
    readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8"),
    readFile("components/internal/OsmStagingRouteList.tsx", "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(source, /SUPABASE_SECRET|SERVICE_ROLE|createAdminClient|process\.env/);
});

test("REJECTED requires a lightweight browser confirmation", async () => {
  const source = await readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8");
  assert.match(source, /status === "REJECTED" && !window\.confirm/);
});

test("SQL represents PENDING as absence while preserving reset history", async () => {
  const sql = await readFile("database/osm_staging_visual_qa.sql", "utf8");
  assert.match(sql, /if p_status = 'PENDING'/);
  assert.match(sql, /delete from public\.osm_staging_route_visual_qa/);
  assert.match(sql, /v_current\.status, 'PENDING'/);
  assert.match(sql.match(/create table public\.osm_staging_route_visual_qa \([\s\S]*?\n\);/)?.[0] ?? "", /check \(status <> 'PENDING'\)/);
});

type QaVersionTestState = {
  current: { status: PreviewQaStatus; version: number } | null;
  history: Array<{
    oldStatus: PreviewQaStatus;
    newStatus: PreviewQaStatus;
    decisionVersion: number;
  }>;
};

function applyQaVersionTransition(
  state: QaVersionTestState,
  status: PreviewQaStatus,
  expectedVersion: number | null,
): { changed: boolean; version: number | null } {
  if (
    (!state.current && expectedVersion !== null) ||
    (state.current && expectedVersion !== state.current.version)
  ) {
    throw new Error("QA_DECISION_CONFLICT");
  }
  const latestHistoryVersion = Math.max(
    0,
    ...state.history.map((event) => event.decisionVersion),
  );
  if (state.current && state.current.version !== latestHistoryVersion) {
    throw new Error("QA_HISTORY_CURRENT_VERSION_MISMATCH");
  }
  if (status === "PENDING" && !state.current) return { changed: false, version: null };
  const oldStatus = state.current?.status ?? "PENDING";
  const nextVersion = latestHistoryVersion + 1;
  state.history.push({ oldStatus, newStatus: status, decisionVersion: nextVersion });
  state.current = status === "PENDING" ? null : { status, version: nextVersion };
  return { changed: true, version: status === "PENDING" ? null : nextVersion };
}

function emptyQaVersionState(): QaVersionTestState {
  return { current: null, history: [] };
}

test("first QA decision receives persistent history version 1", () => {
  const state = emptyQaVersionState();
  assert.equal(applyQaVersionTransition(state, "NEEDS_REVIEW", null).version, 1);
  assert.deepEqual(state.history.map((event) => event.decisionVersion), [1]);
});

test("QA decision change increments the persistent version", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  assert.equal(applyQaVersionTransition(state, "REJECTED", 1).version, 2);
});

test("reset to PENDING preserves the incremented history version", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  const result = applyQaVersionTransition(state, "PENDING", 1);
  assert.deepEqual(result, { changed: true, version: null });
  assert.equal(state.current, null);
  assert.deepEqual(state.history.map((event) => event.decisionVersion), [1, 2]);
});

test("new decision after reset continues at version 3", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  applyQaVersionTransition(state, "PENDING", 1);
  assert.equal(applyQaVersionTransition(state, "VISUALLY_APPROVED", null).version, 3);
  assert.deepEqual(state.history.map((event) => event.decisionVersion), [1, 2, 3]);
});

test("repeated review and reset cycles remain monotonic", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  applyQaVersionTransition(state, "PENDING", 1);
  applyQaVersionTransition(state, "REJECTED", null);
  applyQaVersionTransition(state, "PENDING", 3);
  applyQaVersionTransition(state, "VISUALLY_APPROVED", null);
  assert.deepEqual(state.history.map((event) => event.decisionVersion), [1, 2, 3, 4, 5]);
});

test("stale expected version fails without changing history", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  assert.throws(
    () => applyQaVersionTransition(state, "REJECTED", null),
    /QA_DECISION_CONFLICT/,
  );
  assert.equal(state.history.length, 1);
});

test("a concurrent stale mutation cannot reuse a decision version", () => {
  const state = emptyQaVersionState();
  applyQaVersionTransition(state, "NEEDS_REVIEW", null);
  applyQaVersionTransition(state, "REJECTED", 1);
  assert.throws(
    () => applyQaVersionTransition(state, "VISUALLY_APPROVED", 1),
    /QA_DECISION_CONFLICT/,
  );
  assert.deepEqual(state.history.map((event) => event.decisionVersion), [1, 2]);
});

test("SQL derives every future version from persistent history", async () => {
  const sql = await readFile("database/osm_staging_visual_qa.sql", "utf8");
  assert.match(sql, /coalesce\(max\(history\.decision_version\), 0\)/);
  assert.doesNotMatch(sql, /v_next_version\s*:=\s*1\s*;/);
  assert.match(sql, /v_current\.version <> v_latest_history_version/);
  assert.match(sql, /QA_HISTORY_CURRENT_VERSION_MISMATCH/);
  assert.match(
    sql,
    /unique \(staging_route_id, decision_version\)/,
  );
});

test("Phase 10B.1 repair SQL is exact, fail-closed, and publication-isolated", async () => {
  const [repair, rollback, verify] = await Promise.all([
    readFile("database/osm_staging_visual_qa_history_repair_11192622.sql", "utf8"),
    readFile("database/osm_staging_visual_qa_history_repair_11192622_rollback.sql", "utf8"),
    readFile("database/osm_staging_visual_qa_history_verify_11192622.sql", "utf8"),
  ]);
  assert.match(repair, /history\.id = 5[\s\S]*?set decision_version = 3|set decision_version = 3[\s\S]*?history\.id = 5/);
  assert.match(repair, /set version = 3/);
  assert.match(repair, /63519eb0533a94a940081d39b27d8dfdc19ece570d35916bab64afa7293d7aa5/);
  assert.match(repair, /PHASE10B1_HISTORY_VALUES_GUARD_FAILED/);
  assert.doesNotMatch(repair, /mountain_routes|publication-candidates|gps_activities|ascents|journals/i);
  assert.match(rollback, /set decision_version = 1/);
  assert.match(rollback, /set version = 1/);
  assert.doesNotMatch(verify, /\b(?:insert|update|delete|upsert)\b/i);
});
