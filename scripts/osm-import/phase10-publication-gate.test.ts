import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  PreviewManifest,
  PreviewMetadataDocument,
  PreviewQaStatus,
  StoredPreviewQaDecision,
} from "../../Lib/osmStagingPreview/core.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";
import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  renderPublicationReadinessReport,
  validateQaHistory,
  verifyPublicationCandidateDocuments,
  type Phase10StagingRouteRow,
  type Phase10StagingSummitRow,
  type PublicationGateInput,
} from "./phase10-publication-gate.ts";

const REVIEWER_ID = "10000000-0000-4000-8000-000000000001";

function routeUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

let cachedFixture: Promise<PublicationGateInput> | null = null;

async function loadBaseFixture(): Promise<PublicationGateInput> {
  if (!cachedFixture) {
    cachedFixture = Promise.all([
      readFile("data/osm/alps/staging/first-write-manifest.json", "utf8").then(
        (value) => JSON.parse(value) as PreviewManifest,
      ),
      readFile("data/osm/alps/staging/phase9-preview-metadata.json", "utf8").then(
        (value) => JSON.parse(value) as PreviewMetadataDocument,
      ),
      readFile("data/osm/alps/staging/import-plan.json", "utf8").then(
        (value) => JSON.parse(value) as { datasetFingerprint: string; records: ImportPlanRecord[] },
      ),
    ]).then(([manifest, metadata, plan]) => {
      const planByKey = new Map(plan.records.map((record) => [record.idempotencyKey, record]));
      const routes: Phase10StagingRouteRow[] = [];
      const summits: Phase10StagingSummitRow[] = [];
      for (const [index, manifestRecord] of manifest.records.entries()) {
        const record = planByKey.get(manifestRecord.idempotencyKey);
        if (!record) throw new Error("Missing fixture plan record.");
        const id = routeUuid(index);
        const exactMountainIds = record.contract.confirmedSummits
          .map((summit) => summit.mountainMatch.mountainId)
          .filter((value): value is number => value !== null)
          .sort((left, right) => left - right);
        routes.push({
          id,
          contract_version: record.contract.contractVersion,
          idempotency_key: record.idempotencyKey,
          provider: record.contract.provider,
          source_relation_id: record.sourceRelationId,
          canonical_source_id: record.canonicalRouteSourceId,
          dataset_version: record.contract.dataset.version,
          payload_hash: record.payloadHash,
          route_name: record.routeName,
          semantic_type: record.contract.route.semanticType,
          quality_score: record.contract.route.qualityScore,
          geometry_geojson: record.contract.route.geometry,
          distance_meters: record.contract.route.distanceMeters,
          matched_primary_mountain_id: exactMountainIds[0] ?? null,
          audit_flags: record.contract.auditFlags,
          import_eligibility: record.contract.importEligibility,
          payload: record.contract,
        });
        for (const summit of record.contract.confirmedSummits) {
          summits.push({
            staging_route_id: id,
            peak_osm_id: summit.peakOsmId,
            mountain_id: summit.mountainMatch.mountainId as number,
            mountain_match_classification: summit.mountainMatch.classification,
            final_association: summit.finalAssociation,
            final_confidence: summit.finalConfidence,
            minimum_geometry_distance_meters: summit.minimumGeometryDistanceMeters,
            endpoint_distance_meters: summit.endpointDistanceMeters,
            evidence: summit.evidence,
            payload: summit,
          });
        }
      }
      return {
        manifest,
        metadata,
        planDatasetFingerprint: plan.datasetFingerprint,
        planRecords: plan.records,
        routes,
        summits,
        qaDecisions: [],
        qaHistory: [],
      };
    });
  }
  return structuredClone(await cachedFixture);
}

function relationIndex(fixture: PublicationGateInput, sourceRelationId: string): number {
  const index = fixture.routes.findIndex(
    (route) => route.source_relation_id === sourceRelationId,
  );
  assert.ok(index >= 0, `Missing fixture relation ${sourceRelationId}.`);
  return index;
}

function addDecision(
  fixture: PublicationGateInput,
  index: number,
  status: Exclude<PreviewQaStatus, "PENDING">,
  version = 1,
): StoredPreviewQaDecision {
  const stagingRouteId = fixture.routes[index].id;
  const reviewedAt = `2026-08-25T12:00:0${Math.min(index, 9)}.000Z`;
  const decision: StoredPreviewQaDecision = {
    stagingRouteId,
    status,
    reviewerNote: `Reviewed ${status}`,
    reviewerUserId: REVIEWER_ID,
    reviewedAt,
    version,
  };
  fixture.qaDecisions.push(decision);
  fixture.qaHistory.push({
    id: fixture.qaHistory.length + 1,
    stagingRouteId,
    oldStatus: "PENDING",
    newStatus: status,
    reviewerNote: decision.reviewerNote,
    reviewerUserId: REVIEWER_ID,
    decisionVersion: version,
    occurredAt: reviewedAt,
  });
  return decision;
}

test("PENDING is excluded from publication candidacy", async () => {
  const artifact = buildPublicationCandidateArtifact(await loadBaseFixture());
  assert.equal(artifact.candidateCount, 0);
  assert.equal(artifact.blockedCountsByReason.PENDING, 46);
});

test("publication candidate requires VISUALLY_APPROVED", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.candidateCount, 1);
  assert.equal(artifact.candidates[0].qaDecision.status, "VISUALLY_APPROVED");
});

test("NEEDS_REVIEW is excluded from publication candidacy", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "NEEDS_REVIEW");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.candidateCount, 0);
  assert.equal(artifact.blockedCountsByReason.NEEDS_REVIEW, 1);
});

test("REJECTED is excluded from publication candidacy", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "REJECTED");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.candidateCount, 0);
  assert.equal(artifact.blockedCountsByReason.REJECTED, 1);
});

test("an approved warning route is allowed as a candidate", async () => {
  const fixture = await loadBaseFixture();
  const warningSourceId = fixture.metadata.records.find((record) => record.warnings.length > 0)?.sourceRelationId;
  const index = fixture.routes.findIndex((route) => route.source_relation_id === warningSourceId);
  assert.ok(index >= 0);
  addDecision(fixture, index, "VISUALLY_APPROVED");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.candidateCount, 1);
  assert.ok(artifact.candidates[0].warningState.activeFlags.length > 0);
});

test("candidate provenance retains staging, manifest, summit, and reviewer evidence", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  const candidate = buildPublicationCandidateArtifact(fixture).candidates[0];
  assert.equal(candidate.stagingRouteId, fixture.routes[0].id);
  assert.equal(candidate.payloadHash, fixture.manifest.records[0].payloadHash);
  assert.equal(candidate.summit.associationClassification, "CONFIRMED");
  assert.equal(candidate.qaDecision.reviewerUserId, REVIEWER_ID);
});

test("manifest drift fails closed", async () => {
  const fixture = await loadBaseFixture();
  fixture.manifest.records[0].payloadHash = "drift";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /MANIFEST_OR_DATASET_DRIFT/);
});

test("dataset fingerprint drift fails closed", async () => {
  const fixture = await loadBaseFixture();
  fixture.planDatasetFingerprint = "drift";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /MANIFEST_OR_DATASET_DRIFT/);
});

test("staging payload drift fails closed", async () => {
  const fixture = await loadBaseFixture();
  (fixture.routes[0].payload as ImportPlanRecord["contract"]).route.name = "Drifted name";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /STAGING_PAYLOAD_DRIFT/);
});

test("mountain-match drift fails closed", async () => {
  const fixture = await loadBaseFixture();
  fixture.summits[0].mountain_id += 1;
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /STAGING_INTEGRITY_FAILURE/);
});

test("summit association drift fails closed", async () => {
  const fixture = await loadBaseFixture();
  fixture.summits[0].final_association = "REVIEW";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /STAGING_INTEGRITY_FAILURE/);
});

test("invalid geometry fails closed", async () => {
  const fixture = await loadBaseFixture();
  fixture.routes[0].geometry_geojson = { type: "LineString", coordinates: [[10, 47]] };
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /INVALID_GEOMETRY/);
});

test("missing or extra staging rows cannot escape exact manifest confinement", async () => {
  const missing = await loadBaseFixture();
  missing.routes.pop();
  assert.throws(() => buildPublicationCandidateArtifact(missing), /STAGING_INTEGRITY_FAILURE/);
  const extra = await loadBaseFixture();
  extra.routes.push(structuredClone(extra.routes[0]));
  assert.throws(() => buildPublicationCandidateArtifact(extra), /STAGING_INTEGRITY_FAILURE/);
});

test("QA row outside the reviewed manifest fails closed", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  fixture.qaDecisions[0].stagingRouteId = "99999999-0000-4000-8000-000000000001";
  fixture.qaHistory[0].stagingRouteId = fixture.qaDecisions[0].stagingRouteId;
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /QA_ROW_OUTSIDE_REVIEWED_MANIFEST/);
});

test("QA history versions must be monotonic and contiguous", async () => {
  const fixture = await loadBaseFixture();
  const decision = addDecision(fixture, 0, "VISUALLY_APPROVED", 2);
  decision.version = 2;
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /NON_MONOTONIC_QA_VERSION/);
});

test("stale current decision and latest history mismatch fails closed", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  fixture.qaDecisions[0].version = 2;
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /STALE_QA_CURRENT_HISTORY_MISMATCH/);
});

test("reset-to-PENDING is valid only with absent current state and preserved history", async () => {
  const fixture = await loadBaseFixture();
  const stagingRouteId = fixture.routes[0].id;
  fixture.qaHistory = [
    { id: 1, stagingRouteId, oldStatus: "PENDING", newStatus: "NEEDS_REVIEW", reviewerNote: "test", reviewerUserId: REVIEWER_ID, decisionVersion: 1, occurredAt: "2026-08-25T12:00:00Z" },
    { id: 2, stagingRouteId, oldStatus: "NEEDS_REVIEW", newStatus: "PENDING", reviewerNote: "reset", reviewerUserId: REVIEWER_ID, decisionVersion: 2, occurredAt: "2026-08-25T12:01:00Z" },
  ];
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.qaHistoryIntegrity.routesResetToPending, 1);
  assert.equal(artifact.qaProgress.pending, 46);
});

test("a new decision after reset must continue with version 3", async () => {
  const fixture = await loadBaseFixture();
  const stagingRouteId = fixture.routes[0].id;
  const reviewerNote = "approved after reset";
  fixture.qaHistory = [
    { id: 1, stagingRouteId, oldStatus: "PENDING", newStatus: "NEEDS_REVIEW", reviewerNote: "review", reviewerUserId: REVIEWER_ID, decisionVersion: 1, occurredAt: "2026-08-25T12:00:00Z" },
    { id: 2, stagingRouteId, oldStatus: "NEEDS_REVIEW", newStatus: "PENDING", reviewerNote: "reset", reviewerUserId: REVIEWER_ID, decisionVersion: 2, occurredAt: "2026-08-25T12:01:00Z" },
    { id: 3, stagingRouteId, oldStatus: "PENDING", newStatus: "VISUALLY_APPROVED", reviewerNote, reviewerUserId: REVIEWER_ID, decisionVersion: 3, occurredAt: "2026-08-25T12:02:00Z" },
  ];
  fixture.qaDecisions = [{
    stagingRouteId,
    status: "VISUALLY_APPROVED",
    reviewerNote,
    reviewerUserId: REVIEWER_ID,
    reviewedAt: "2026-08-25T12:02:00Z",
    version: 3,
  }];
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.qaHistoryIntegrity.status, "PASS");
  assert.equal(artifact.candidateCount, 1);
  assert.equal(artifact.candidates[0].qaDecision.version, 3);
});

test("history event requires reviewer UUID", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  fixture.qaHistory[0].reviewerUserId = "";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /INVALID_QA_HISTORY_EVENT/);
});

test("impossible QA history transition fails closed", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  fixture.qaHistory[0].oldStatus = "REJECTED";
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /IMPOSSIBLE_QA_TRANSITION/);
});

test("candidate output is deterministic across database row order", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  addDecision(fixture, 4, "NEEDS_REVIEW");
  const first = buildPublicationCandidateArtifact(fixture);
  fixture.routes.reverse();
  fixture.summits.reverse();
  fixture.qaDecisions.reverse();
  fixture.qaHistory.reverse();
  const second = buildPublicationCandidateArtifact(fixture);
  assert.deepEqual(second, first);
});

test("human report separates approval, candidacy, and publication", async () => {
  const report = renderPublicationReadinessReport(
    buildPublicationCandidateArtifact(await loadBaseFixture()),
  );
  assert.match(report, /Visual approval, publication candidacy, and actual publication are three separate states/);
  assert.match(report, /performs no publication/);
});

test("Phase 10 generator is read-only and contains no publication mutation", async () => {
  const source = await Promise.all([
    readFile("scripts/osm-import/generate-phase10-publication-gate.ts", "utf8"),
    readFile("scripts/osm-import/phase10-live-data.ts", "utf8"),
    readFile("scripts/osm-import/verify-publication-candidates.ts", "utf8"),
  ]).then((values) => values.join("\n"));
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  assert.doesNotMatch(source, /mountain_routes|gps_activities|ascents|journals|community_routes/i);
});

test("direct history validator accepts an untouched all-PENDING manifest", async () => {
  const fixture = await loadBaseFixture();
  assert.deepEqual(validateQaHistory({
    reviewedStagingRouteIds: fixture.routes.map((route) => route.id),
    currentDecisions: [],
    history: [],
  }), {
    status: "PASS",
    historyEventCount: 0,
    routesWithHistory: 0,
    routesResetToPending: 0,
  });
});

test("warning plus PENDING remains explicitly blocked", async () => {
  const fixture = await loadBaseFixture();
  const sourceRelationId = fixture.metadata.records.find(
    (record) => record.warnings.length > 0,
  )?.sourceRelationId;
  assert.ok(sourceRelationId);
  const artifact = buildPublicationCandidateArtifact(fixture);
  const blocked = artifact.excludedRecords.find(
    (record) => record.sourceRelationId === sourceRelationId,
  );
  assert.equal(blocked?.reason, "PENDING");
});

test("valid geometry that drifts from the staged payload aborts", async () => {
  const fixture = await loadBaseFixture();
  const route = fixture.routes[0];
  const geometry = structuredClone(route.geometry_geojson) as
    | { type: "LineString"; coordinates: number[][] }
    | { type: "MultiLineString"; coordinates: number[][][] };
  if (geometry.type === "LineString") geometry.coordinates[0][0] += 0.0001;
  else geometry.coordinates[0][0][0] += 0.0001;
  route.geometry_geojson = geometry;
  assert.throws(() => buildPublicationCandidateArtifact(fixture), /STAGING_PAYLOAD_DRIFT/);
});

test("candidate topology metadata is deterministic", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, relationIndex(fixture, "1144001"), "VISUALLY_APPROVED");
  const first = buildPublicationCandidateArtifact(fixture).candidates[0].topology;
  const second = buildPublicationCandidateArtifact(fixture).candidates[0].topology;
  assert.deepEqual(second, first);
});

test("Loffa candidate uses connected physical endpoints and resolves legacy ratio warning", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, relationIndex(fixture, "1144001"), "VISUALLY_APPROVED");
  const candidate = buildPublicationCandidateArtifact(fixture).candidates[0];
  assert.equal(candidate.topology.classification, "CONNECTED_TWO_ENDPOINTS");
  assert.equal(candidate.topology.physicalEndpointCount, 2);
  assert.deepEqual(candidate.topology.startCoordinate, [11.1696067, 45.7495493]);
  assert.deepEqual(candidate.topology.endCoordinate, [11.1761777, 45.7469932]);
  assert.equal(candidate.topology.routeToStraightLineRatio, 1.92);
  assert.equal(candidate.warningState.legacyRouteToStraightLineRatio, 14.35);
  assert.deepEqual(candidate.warningState.activeFlags, []);
  assert.deepEqual(candidate.warningState.resolvedRepresentationalFlags, [
    "HIGH_ROUTE_TO_STRAIGHT_LINE_RATIO",
  ]);
});

test("relation 2210868 candidate endpoints are both physical", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, relationIndex(fixture, "2210868"), "VISUALLY_APPROVED");
  const candidate = buildPublicationCandidateArtifact(fixture).candidates[0];
  const coordinates = candidate.topology.physicalEndpoints.map(
    (endpoint) => endpoint.coordinate,
  );
  assert.ok(coordinates.some((value) =>
    JSON.stringify(value) === JSON.stringify(candidate.topology.startCoordinate)));
  assert.ok(coordinates.some((value) =>
    JSON.stringify(value) === JSON.stringify(candidate.topology.endCoordinate)));
});

test("branching candidate preserves topology and records ambiguous inferred physical endpoints", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, relationIndex(fixture, "4103375"), "VISUALLY_APPROVED");
  const candidate = buildPublicationCandidateArtifact(fixture).candidates[0];
  assert.equal(candidate.topology.classification, "BRANCHING");
  assert.equal(candidate.topology.physicalEndpointCount, 4);
  assert.deepEqual(candidate.topology.startCoordinate, [11.6686224, 46.7979373]);
  assert.deepEqual(candidate.topology.endCoordinate, [11.686882, 46.8595389]);
  assert.equal(candidate.topology.endpointSelectionAmbiguous, true);
  assert.equal(
    candidate.topology.endpointSelectionWarning,
    "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS",
  );
});

test("disconnected candidate preserves four groups and nine endpoints without globals", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, relationIndex(fixture, "11192622"), "VISUALLY_APPROVED");
  const candidate = buildPublicationCandidateArtifact(fixture).candidates[0];
  assert.equal(candidate.topology.classification, "DISCONNECTED");
  assert.equal(candidate.topology.connectedGroupCount, 4);
  assert.equal(candidate.topology.physicalEndpointCount, 9);
  assert.equal(candidate.topology.startCoordinate, null);
  assert.equal(candidate.topology.endCoordinate, null);
  assert.equal(
    candidate.topology.endpointSelectionWarning,
    "DISCONNECTED_GLOBAL_ENDPOINTS_UNAVAILABLE",
  );
});

test("candidate manifest is deterministic", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.deepEqual(
    buildPublicationCandidateManifest(artifact),
    buildPublicationCandidateManifest(artifact),
  );
});

test("duplicate candidate staging ID is rejected", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  addDecision(fixture, 1, "VISUALLY_APPROVED");
  const artifact = buildPublicationCandidateArtifact(fixture);
  artifact.candidates[1].stagingRouteId = artifact.candidates[0].stagingRouteId;
  assert.throws(
    () => buildPublicationCandidateManifest(artifact),
    /DUPLICATE_CANDIDATE_STAGING_ID/,
  );
});

test("candidate plus blocked count is always the exact 46-route manifest", async () => {
  const fixture = await loadBaseFixture();
  addDecision(fixture, 0, "VISUALLY_APPROVED");
  addDecision(fixture, 1, "NEEDS_REVIEW");
  const artifact = buildPublicationCandidateArtifact(fixture);
  assert.equal(artifact.candidateCount + artifact.blockedCandidateCount, 46);
  assert.equal(artifact.candidates.length + artifact.excludedRecords.length, 46);
});

test("verifier detects candidate-set drift against a fresh valid live snapshot", async () => {
  const expectedFixture = await loadBaseFixture();
  addDecision(expectedFixture, 0, "VISUALLY_APPROVED");
  const expectedArtifact = buildPublicationCandidateArtifact(expectedFixture);
  const expectedManifest = buildPublicationCandidateManifest(expectedArtifact);
  const liveArtifact = buildPublicationCandidateArtifact(await loadBaseFixture());
  const liveManifest = buildPublicationCandidateManifest(liveArtifact);
  assert.throws(
    () => verifyPublicationCandidateDocuments({
      expectedArtifact,
      expectedManifest,
      liveArtifact,
      liveManifest,
    }),
    /LIVE_CANDIDATE_ARTIFACT_DRIFT/,
  );
});

test("verifier accepts byte-equivalent candidate documents", async () => {
  const artifact = buildPublicationCandidateArtifact(await loadBaseFixture());
  const manifest = buildPublicationCandidateManifest(artifact);
  assert.equal(verifyPublicationCandidateDocuments({
    expectedArtifact: artifact,
    expectedManifest: manifest,
    liveArtifact: structuredClone(artifact),
    liveManifest: structuredClone(manifest),
  }).status, "PASS");
});
