import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import { sha256Stable } from "./phase11-publication.ts";
import {
  STAGEABILITY_CONTRACT,
  type B2StageabilityArtifact,
} from "./phase11i-b2-stageability.ts";
import {
  PAYLOAD_CONTRACT,
  type B2StagingPayloadArtifact,
} from "./phase11i-b2-staging-payloads.ts";
import {
  B2_EXECUTION_CONTRACT_VERSION,
  type B2ExecutionContract,
} from "./phase11i-b2-execution-contract.ts";
import {
  B2_SOURCE_SNAPSHOT_CONTRACT,
  type B2SourceSnapshot,
} from "./generate-phase11i-b2-source-snapshot.ts";

const ROOT = "data/osm/alps/staging";
const QUEUE_SHA256 = "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const QUEUE_TOTAL = 45;
const STAGEABLE_TOTAL = 44;
const BLOCKED_RELATION = "19752996";
const BLOCKED_PEAK_OSM_ID = "14110138897";
interface QueueArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  sampleSize: number;
  sample: Array<{
    canonicalRelationId: string;
    candidateHash: string;
    qualificationHash: string;
    nameStatus: string;
    nameOrigin: string | null;
    resolvedDisplayName: string | null;
    startContext: string | null;
    qualityBand: string;
    selectionTier: string;
    humanDecisionStatus: string | null;
  }>;
  deterministicArtifactHash: string;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

interface OldContract {
  schemaVersion: number;
  artifactType: string;
  executed: boolean;
  databaseModeBefore: string;
  executionToken: string;
  queueHash: string;
  queueDeterministicArtifactHash: string;
  records: Array<{
    sourceRelationId: string;
    canonicalRelationId: string;
  }>;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function recomputeHash<T extends object>(artifact: T & { deterministicArtifactHash: string }): string {
  const content = Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "deterministicArtifactHash"),
  );
  return sha256Stable(content);
}

// ============================================================================
// FROZEN DATA TESTS (always pass, no artifacts required)
// ============================================================================

test("11I-B2: frozen calibration queue has exactly 45 members with no human decisions", async () => {
  const raw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const artifact = JSON.parse(raw) as QueueArtifact;
  assert.equal(artifact.artifactType, "PHASE11H_HUMAN_CALIBRATION_QUEUE");
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.publishable, false);
  assert.equal(artifact.qaDecisionWrites, 0);
  assert.equal(artifact.autoApprovalEnabled, false);
  assert.equal(artifact.sampleSize, QUEUE_TOTAL);
  assert.equal(artifact.sample.length, QUEUE_TOTAL);

  const ids = new Set(artifact.sample.map((m) => m.canonicalRelationId));
  assert.equal(ids.size, QUEUE_TOTAL);

  for (const member of artifact.sample) {
    assert.equal(member.humanDecisionStatus, null);
    assert.ok(/^[0-9a-f]{64}$/.test(member.qualificationHash));
    assert.ok(/^[0-9a-f]{64}$/.test(member.candidateHash));
  }

  const hashes = artifact.sample.map((m) => m.qualificationHash);
  assert.deepEqual(hashes, [...hashes].sort((a, b) => a.localeCompare(b)));
  assert.equal(artifact.writes.databaseWrites, 0);
  assert.equal(artifact.writes.qaWrites, 0);
  assert.equal(artifact.writes.publicationWrites, 0);
  assert.equal(artifact.deterministicArtifactHash, recomputeHash(artifact));
});

test("11I-B2: frozen queue file SHA-256 matches pinned value", async () => {
  const raw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const { createHash } = await import("node:crypto");
  const fileHash = createHash("sha256").update(raw).digest("hex");
  assert.equal(fileHash, QUEUE_SHA256);
});

test("11I-B2: frozen staging contract covers all 45 queue members and is not executed", async () => {
  const raw = await readFile(`${ROOT}/phase11i-human-calibration-staging-contract.json`, "utf8");
  const contract = JSON.parse(raw) as OldContract;
  assert.equal(contract.executed, false);
  assert.equal(contract.databaseModeBefore, "SELECT_ONLY");
  assert.equal(contract.records.length, QUEUE_TOTAL);
  assert.equal(contract.writes.databaseWrites, 0);
  assert.equal(contract.writes.qaWrites, 0);
  assert.equal(contract.writes.publicationWrites, 0);

  const queueRaw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const queue = JSON.parse(queueRaw) as QueueArtifact;
  const queueIds = new Set(queue.sample.map((m) => m.canonicalRelationId));
  const contractIds = new Set(contract.records.map((r) => r.canonicalRelationId));
  assert.deepEqual(queueIds, contractIds);
});

test("11I-B2: frozen contract execution token has valid format", async () => {
  const raw = await readFile(`${ROOT}/phase11i-human-calibration-staging-contract.json`, "utf8");
  const contract = JSON.parse(raw) as OldContract;
  const tokenParts = contract.executionToken.split(":");
  assert.equal(tokenParts.length, 3);
  assert.equal(tokenParts[0], "PHASE11I");
  assert.ok(/^[0-9a-f]{64}$/.test(tokenParts[1]));
  assert.equal(tokenParts[2], QUEUE_SHA256);
});

test("11I-B2: relation 19752996 is in the frozen queue with known properties", async () => {
  const raw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const queue = JSON.parse(raw) as QueueArtifact;
  const member = queue.sample.find((m) => m.canonicalRelationId === BLOCKED_RELATION);
  assert.ok(member, `Relation ${BLOCKED_RELATION} must be in the frozen queue`);
  assert.equal(member.nameStatus, "SOURCE_NAME");
  assert.equal(member.nameOrigin, "RELATION_NAME");
  assert.equal(member.startContext, "BASE_START");
  assert.equal(member.qualityBand, "Q90");
  assert.equal(member.selectionTier, "NAMED_STRATUM");
  assert.equal(member.humanDecisionStatus, null);
});

test("11I-B2: relation 19752996 has peakOsmId 14110138897 in canonical-confirmed-routes", async () => {
  const canonicalRaw = await readFile("data/osm/alps/audit/canonical-confirmed-routes.jsonl", "utf8");
  let found = false;
  for (const line of canonicalRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.canonicalRouteSourceId === BLOCKED_RELATION) {
      assert.equal(record.confirmedSummits.length, 1);
      assert.equal(record.confirmedSummits[0].peakSourceId, BLOCKED_PEAK_OSM_ID);
      assert.equal(record.semanticType, "summit_route");
      assert.ok(record.distanceMeters > 0);
      found = true;
      break;
    }
  }
  assert.ok(found, `Relation ${BLOCKED_RELATION} must be in canonical-confirmed-routes`);
});

test("11I-B2: relation 19752996 has EXACT_MOUNTAIN_IDENTITY reason code in green candidates", async () => {
  const greensRaw = await readFile(`${ROOT}/phase11g-expanded-green-candidates.json`, "utf8");
  const greens = JSON.parse(greensRaw) as {
    records: Array<{ canonicalRouteSourceId: string; reasonCodes: string[]; greenClass: string }>;
  };
  const candidate = greens.records.find((r) => r.canonicalRouteSourceId === BLOCKED_RELATION);
  assert.ok(candidate, `Relation ${BLOCKED_RELATION} must be in green candidates`);
  assert.ok(candidate.reasonCodes.includes("EXACT_MOUNTAIN_IDENTITY"));
  assert.equal(candidate.greenClass, "GREEN_NAMED");
});

test("11I-B2: frozen queue sample count matches controlled staging plan scope", async () => {
  const planRaw = await readFile(`${ROOT}/phase11h-controlled-staging-plan.json`, "utf8");
  const plan = JSON.parse(planRaw) as {
    scope: { sampleSize: number; relations: string[] };
    wouldCreate: number;
    executed: boolean;
  };
  assert.equal(plan.scope.sampleSize, QUEUE_TOTAL);
  assert.equal(plan.scope.relations.length, QUEUE_TOTAL);
  assert.equal(plan.wouldCreate, QUEUE_TOTAL);
  assert.equal(plan.executed, false);
});

test("11I-B2: 45 relation IDs are sorted numerically in the staging plan scope", async () => {
  const planRaw = await readFile(`${ROOT}/phase11h-controlled-staging-plan.json`, "utf8");
  const plan = JSON.parse(planRaw) as { scope: { relations: string[] } };
  const sorted = [...plan.scope.relations].sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(plan.scope.relations, sorted);
});

// ============================================================================
// SOURCE SNAPSHOT TESTS (require B2 source snapshot artifact)
// ============================================================================

test("11I-B2: source snapshot exists with 44 records and 1 exclusion for 19752996", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`);
  if (!exists) {
    console.log("  [SKIP] source snapshot not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`, "utf8");
  const snapshot = JSON.parse(raw) as B2SourceSnapshot;

  assert.equal(snapshot.artifactType, "PHASE11I_B2_SOURCE_SNAPSHOT");
  assert.equal(snapshot.contractVersion, B2_SOURCE_SNAPSHOT_CONTRACT);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.publishable, false);
  assert.equal(snapshot.records.length, STAGEABLE_TOTAL);
  assert.equal(snapshot.scope.relations, STAGEABLE_TOTAL);
  assert.equal(snapshot.scope.excluded, 1);

  const recordIds = new Set(snapshot.records.map((r) => r.canonicalRelationId));
  assert.equal(recordIds.size, STAGEABLE_TOTAL);
  assert.ok(!recordIds.has(BLOCKED_RELATION));

  assert.equal(snapshot.exclusions.length, 1);
  assert.equal(snapshot.exclusions[0].canonicalRelationId, BLOCKED_RELATION);
  assert.equal(snapshot.exclusions[0].peakOsmId, BLOCKED_PEAK_OSM_ID);
  assert.match(snapshot.exclusions[0].reason, /NO_EXACT_MOUNTAINS_OSM_ID_MATCH/);

  for (const record of snapshot.records) {
    assert.ok(record.mountain, `Record ${record.canonicalRelationId} must have mountain ID`);
    assert.equal(record.mountain.classification, "EXACT_MOUNTAIN_MATCH");
    assert.ok(record.mountain.mountainId > 0);
    assert.equal(record.summit.finalAssociation, "CONFIRMED");
    assert.ok(record.distanceMeters > 0);
    assert.equal(record.geometryType, "LineString");
    assert.ok(record.geometryHash.length > 0);
  }

  assert.equal(snapshot.integrity.allMountainIdsResolved, true);
  assert.equal(snapshot.integrity.uniqueRelationIds, true);
  assert.equal(snapshot.integrity.uniqueGeometryHashes, true);
  assert.equal(snapshot.integrity.allSingleConfirmedSummit, true);
  assert.equal(snapshot.integrity.allPositiveDistances, true);
  assert.equal(snapshot.writes.databaseWrites, 0);
  assert.equal(snapshot.writes.qaWrites, 0);
  assert.equal(snapshot.writes.publicationWrites, 0);
  assert.equal(snapshot.deterministicArtifactHash, recomputeHash(snapshot));
});

test("11I-B2: source snapshot has 44 mountain FK bindings (all present)", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`);
  if (!exists) {
    console.log("  [SKIP] source snapshot not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`, "utf8");
  const snapshot = JSON.parse(raw) as B2SourceSnapshot;

  const mountainIds = snapshot.records
    .filter((r) => r.mountain !== null)
    .map((r) => r.mountain!.mountainId);
  assert.equal(mountainIds.length, STAGEABLE_TOTAL);
  assert.equal(snapshot.integrity.allMountainIdsResolved, true);
  assert.ok(
    mountainIds.every((id) => id > 0),
    "Every stageable route must have a positive mountain FK",
  );
});

test("11I-B2: source snapshot has 44 unique geometry hashes", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`);
  if (!exists) {
    console.log("  [SKIP] source snapshot not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`, "utf8");
  const snapshot = JSON.parse(raw) as B2SourceSnapshot;

  const hashes = snapshot.records.map((r) => r.geometryHash);
  assert.equal(new Set(hashes).size, STAGEABLE_TOTAL);
});

// ============================================================================
// STAGEABILITY ARTIFACT TESTS
// ============================================================================

test("11I-B2: stageability artifact exists with 45 records (44 EXACT + 1 MISSING)", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-stageability.json`);
  if (!exists) {
    console.log("  [SKIP] stageability artifact not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-stageability.json`, "utf8");
  const artifact = JSON.parse(raw) as B2StageabilityArtifact;

  assert.equal(artifact.artifactType, "PHASE11I_B2_STAGEABILITY");
  assert.equal(artifact.contractVersion, STAGEABILITY_CONTRACT);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.publishable, false);
  assert.equal(artifact.originalQueueCount, QUEUE_TOTAL);
  assert.equal(artifact.stageableCount, STAGEABLE_TOTAL);
  assert.equal(artifact.blockedCount, 1);
  assert.equal(artifact.exactCount, STAGEABLE_TOTAL);
  assert.equal(artifact.missingCount, 1);
  assert.equal(artifact.ambiguousCount, 0);
  assert.equal(artifact.records.length, QUEUE_TOTAL);

  assert.ok(artifact.blockedRelation);
  assert.equal(artifact.blockedRelation.canonicalRelationId, BLOCKED_RELATION);
  assert.equal(artifact.blockedRelation.summitOsmId, BLOCKED_PEAK_OSM_ID);
  assert.equal(artifact.blockedRelation.blockingReason, "MOUNTAIN_IDENTITY_MISSING");

  const blocked = artifact.records.find((r) => r.canonicalRelationId === BLOCKED_RELATION);
  assert.ok(blocked);
  assert.equal(blocked.mountainResolutionStatus, "MISSING");
  assert.equal(blocked.resolvedMountainId, null);
  assert.equal(blocked.stagingEligible, false);
  assert.equal(blocked.blockingReason, "MOUNTAIN_IDENTITY_MISSING");

  const exactRecords = artifact.records.filter((r) => r.mountainResolutionStatus === "EXACT");
  assert.equal(exactRecords.length, STAGEABLE_TOTAL);
  for (const record of exactRecords) {
    assert.equal(record.stagingEligible, true);
    assert.equal(record.blockingReason, null);
    assert.ok(record.resolvedMountainId !== null);
    assert.ok(record.resolvedMountainId! > 0);
  }

  assert.equal(artifact.writes.databaseWrites, 0);
  assert.equal(artifact.writes.qaWrites, 0);
  assert.equal(artifact.writes.publicationWrites, 0);
  assert.equal(artifact.deterministicArtifactHash, recomputeHash(artifact));
});

test("11I-B2: stageability 19752996 is NOT fuzzily resolved", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-stageability.json`);
  if (!exists) {
    console.log("  [SKIP] stageability artifact not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-stageability.json`, "utf8");
  const artifact = JSON.parse(raw) as B2StageabilityArtifact;
  const blocked = artifact.records.find((r) => r.canonicalRelationId === BLOCKED_RELATION);
  assert.ok(blocked);
  assert.equal(blocked.mountainResolutionStatus, "MISSING");
  assert.equal(blocked.resolvedMountainId, null);
  assert.ok(
    blocked.resolutionEvidence.some((e) => e.includes("zero rows")),
    "Evidence must indicate zero rows returned",
  );
});

// ============================================================================
// STAGING PAYLOAD ARTIFACT TESTS
// ============================================================================

test("11I-B2: staging payloads exist with 44 main payloads and 44 summit payloads", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`);
  if (!exists) {
    console.log("  [SKIP] payload artifact not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`, "utf8");
  const artifact = JSON.parse(raw) as B2StagingPayloadArtifact;

  assert.equal(artifact.artifactType, "PHASE11I_B2_STAGING_PAYLOADS");
  assert.equal(artifact.contractVersion, PAYLOAD_CONTRACT);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.mainPayloadCount, STAGEABLE_TOTAL);
  assert.equal(artifact.summitPayloadCount, STAGEABLE_TOTAL);
  assert.equal(artifact.records.length, STAGEABLE_TOTAL);

  assert.ok(!artifact.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION));

  const ids = artifact.records.map((r) => r.canonicalRelationId);
  assert.equal(new Set(ids).size, STAGEABLE_TOTAL);

  assert.equal(artifact.integrity.uniqueRelationIds, true);
  assert.equal(artifact.integrity.allMountainIdsPresent, true);
  assert.equal(artifact.integrity.allPayloadHashesValid, true);
  assert.equal(artifact.integrity.allIdempotencyKeysUnique, true);

  assert.equal(artifact.writes.databaseWrites, 0);
  assert.equal(artifact.writes.qaWrites, 0);
  assert.equal(artifact.writes.publicationWrites, 0);
  assert.equal(artifact.deterministicArtifactHash, recomputeHash(artifact));
});

test("11I-B2: staging payloads match deployed RPC contract shape", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`);
  if (!exists) {
    console.log("  [SKIP] payload artifact not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`, "utf8");
  const artifact = JSON.parse(raw) as B2StagingPayloadArtifact;

  for (const record of artifact.records) {
    const route = record.mainPayload;
    assert.equal(typeof route.contract_version, "string");
    assert.ok(route.idempotency_key.startsWith("openstreetmap:relation:"));
    assert.ok(route.idempotency_key.endsWith(":mountain-tracker-osm-route/v1"));
    assert.equal(route.provider, "openstreetmap");
    assert.equal(typeof route.source_relation_id, "string");
    assert.equal(route.source_relation_id, route.canonical_source_id);
    assert.equal(typeof route.dataset_version, "string");
    assert.ok(route.dataset_version.length > 0);
    assert.equal(typeof route.payload_hash, "string");
    assert.ok(/^[0-9a-f]{64}$/.test(route.payload_hash));
    assert.equal(route.semantic_type, "summit_route");
    assert.ok(route.quality_score >= 0 && route.quality_score <= 100);
    assert.equal(route.geometry_geojson.type, "LineString");
    assert.ok(Array.isArray(route.geometry_geojson.coordinates));
    assert.ok(route.geometry_geojson.coordinates.length >= 2);
    assert.ok(route.distance_meters > 0);
    assert.ok(route.matched_primary_mountain_id > 0);
    assert.ok(Array.isArray(route.audit_flags));
    assert.equal(route.import_eligibility, "AUTO_IMPORT_READY");
    assert.equal(typeof route.payload, "object");

    assert.equal(record.summitPayloads.length, 1);
    const summit = record.summitPayloads[0];
    assert.equal(typeof summit.peak_osm_id, "string");
    assert.ok(summit.peak_osm_id.length > 0);
    assert.ok(summit.mountain_id > 0);
    assert.equal(summit.mountain_match_classification, "EXACT_MOUNTAIN_MATCH");
    assert.equal(summit.final_association, "CONFIRMED");
    assert.ok(summit.final_confidence >= 0 && summit.final_confidence <= 1);
    assert.ok(summit.minimum_geometry_distance_meters >= 0);
    assert.ok(summit.endpoint_distance_meters >= 0);
    assert.ok(Array.isArray(summit.evidence));
  }
});

test("11I-B2: relation 19752996 is NOT included in staging payloads", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`);
  if (!exists) {
    console.log("  [SKIP] payload artifact not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`, "utf8");
  const artifact = JSON.parse(raw) as B2StagingPayloadArtifact;

  const blocked = artifact.records.find((r) => r.canonicalRelationId === BLOCKED_RELATION);
  assert.equal(blocked, undefined, "Relation 19752996 must not be in staging payloads");
});

test("11I-B2: payload artifact source snapshot hash matches actual snapshot", async () => {
  const payloadExists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`);
  const snapshotExists = await fileExists(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`);
  if (!payloadExists || !snapshotExists) {
    console.log("  [SKIP] payload or snapshot artifact not yet generated");
    return;
  }
  const payloadRaw = await readFile(`${ROOT}/phase11i-b2-human-calibration-staging-payloads.json`, "utf8");
  const payload = JSON.parse(payloadRaw) as B2StagingPayloadArtifact;
  const snapshotRaw = await readFile(`${ROOT}/phase11i-b2-human-calibration-source-snapshot.json`, "utf8");
  const snapshot = JSON.parse(snapshotRaw) as B2SourceSnapshot;
  assert.equal(payload.sourceSnapshotHash, snapshot.deterministicArtifactHash);
});

// ============================================================================
// EXECUTION CONTRACT TESTS
// ============================================================================

test("11I-B2: execution contract exists with 44 records and valid structure", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-execution-contract.json`);
  if (!exists) {
    console.log("  [SKIP] execution contract not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-execution-contract.json`, "utf8");
  const contract = JSON.parse(raw) as B2ExecutionContract;

  assert.equal(contract.artifactType, "PHASE11I_B2_EXECUTION_CONTRACT");
  assert.equal(contract.contractVersion, B2_EXECUTION_CONTRACT_VERSION);
  assert.equal(contract.readOnly, true);
  assert.equal(contract.executed, false);
  assert.equal(contract.databaseModeBefore, "SELECT_ONLY");
  assert.equal(contract.originalQueueCount, QUEUE_TOTAL);
  assert.equal(contract.stageableCount, STAGEABLE_TOTAL);
  assert.equal(contract.blockedCount, 1);
  assert.equal(contract.records.length, STAGEABLE_TOTAL);

  assert.equal(contract.blockedRecords.length, 1);
  assert.equal(contract.blockedRecords[0].canonicalRelationId, BLOCKED_RELATION);
  assert.equal(contract.blockedRecords[0].blockingReason, "MOUNTAIN_IDENTITY_MISSING");

  const recordIds = contract.records.map((r) => r.canonicalRelationId);
  assert.equal(new Set(recordIds).size, STAGEABLE_TOTAL);
  assert.ok(!recordIds.includes(BLOCKED_RELATION));

  for (const record of contract.records) {
    assert.ok(record.mountainId > 0);
    assert.ok(record.geometryHash.length === 64);
    assert.ok(/^[0-9a-f]{64}$/.test(record.qualificationHash));
    assert.ok(/^[0-9a-f]{64}$/.test(record.mainPayloadHash));
    assert.ok(/^[0-9a-f]{64}$/.test(record.summitPayloadHash));
  }

  assert.equal(contract.writes.databaseWrites, 0);
  assert.equal(contract.writes.qaWrites, 0);
  assert.equal(contract.writes.publicationWrites, 0);
  assert.equal(contract.deterministicArtifactHash, recomputeHash(contract));
});

test("11I-B2: execution contract new token is different from old token", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-execution-contract.json`);
  if (!exists) {
    console.log("  [SKIP] execution contract not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-execution-contract.json`, "utf8");
  const contract = JSON.parse(raw) as B2ExecutionContract;

  assert.notEqual(contract.executionToken, contract.oldExecutionToken);
  assert.match(contract.executionToken, /^PHASE11I-B2:[0-9a-f]{64}:.+$/);
  assert.match(contract.oldExecutionToken, /^PHASE11I:[0-9a-f]{64}:.+$/);
});

test("11I-B2: execution contract expected before/after states are correct", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-execution-contract.json`);
  if (!exists) {
    console.log("  [SKIP] execution contract not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-execution-contract.json`, "utf8");
  const contract = JSON.parse(raw) as B2ExecutionContract;

  assert.equal(contract.expectedBeforeState.stagingRowsForRelations, 0);
  assert.equal(contract.expectedBeforeState.summitAssociationRowsForRelations, 0);
  assert.equal(contract.expectedBeforeState.qaDecisionRows, 0);
  assert.equal(contract.expectedBeforeState.qaHistoryRows, 0);
  assert.equal(contract.expectedBeforeState.publishedRoutesForRelations, 0);

  assert.equal(contract.expectedAfterState.stagingRowsForRelations, 44);
  assert.equal(contract.expectedAfterState.summitAssociationRowsForRelations, 44);
  assert.equal(contract.expectedAfterState.qaDecisionRows, 0);
  assert.equal(contract.expectedAfterState.qaHistoryRows, 0);
  assert.equal(contract.expectedAfterState.publishedRoutesForRelations, 0);
});

test("11I-B2: execution contract blocks 19752996 explicitly", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-execution-contract.json`);
  if (!exists) {
    console.log("  [SKIP] execution contract not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-execution-contract.json`, "utf8");
  const contract = JSON.parse(raw) as B2ExecutionContract;

  assert.equal(contract.blockedRecords[0].canonicalRelationId, BLOCKED_RELATION);
  assert.equal(contract.blockedRecords[0].summitOsmId, BLOCKED_PEAK_OSM_ID);
  assert.equal(contract.blockedRecords[0].blockingReason, "MOUNTAIN_IDENTITY_MISSING");
});

test("11I-B2: execution contract binds all B2 artifact hashes", async () => {
  const exists = await fileExists(`${ROOT}/phase11i-b2-execution-contract.json`);
  if (!exists) {
    console.log("  [SKIP] execution contract not yet generated");
    return;
  }
  const raw = await readFile(`${ROOT}/phase11i-b2-execution-contract.json`, "utf8");
  const contract = JSON.parse(raw) as B2ExecutionContract;

  assert.equal(contract.originalQueueHash, QUEUE_SHA256);
  assert.ok(contract.sourceSnapshotHash.length === 64);
  assert.ok(contract.stageabilityHash.length === 64);
  assert.ok(contract.payloadArtifactHash.length === 64);
});

// ============================================================================
// CROSS-ARTIFACT CONSISTENCY TESTS
// ============================================================================

test("11I-B2: all B2 artifacts report zero writes", async () => {
  const paths = [
    "phase11i-b2-human-calibration-source-snapshot.json",
    "phase11i-b2-human-calibration-stageability.json",
    "phase11i-b2-human-calibration-staging-payloads.json",
    "phase11i-b2-execution-contract.json",
  ];
  for (const path of paths) {
    const exists = await fileExists(`${ROOT}/${path}`);
    if (!exists) continue;
    const raw = await readFile(`${ROOT}/${path}`, "utf8");
    const artifact = JSON.parse(raw) as {
      writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
    };
    assert.equal(artifact.writes.databaseWrites, 0, `${path}: databaseWrites must be 0`);
    assert.equal(artifact.writes.qaWrites, 0, `${path}: qaWrites must be 0`);
    assert.equal(artifact.writes.publicationWrites, 0, `${path}: publicationWrites must be 0`);
  }
});

test("11I-B2: all frozen and B2 artifacts have readOnly=true", async () => {
  const paths = [
    "phase11h-human-calibration-queue.json",
    "phase11h-controlled-staging-plan.json",
    "phase11i-human-calibration-staging-contract.json",
    "phase11i-human-calibration-preflight.json",
    "phase11i-b2-human-calibration-source-snapshot.json",
    "phase11i-b2-human-calibration-stageability.json",
    "phase11i-b2-human-calibration-staging-payloads.json",
    "phase11i-b2-execution-contract.json",
  ];
  for (const path of paths) {
    const exists = await fileExists(`${ROOT}/${path}`);
    if (!exists) continue;
    const raw = await readFile(`${ROOT}/${path}`, "utf8");
    const artifact = JSON.parse(raw) as { readOnly: boolean; publishable: boolean };
    if ("readOnly" in artifact) {
      assert.equal(artifact.readOnly, true, `${path}: readOnly must be true`);
    }
    if ("publishable" in artifact) {
      assert.equal(artifact.publishable, false, `${path}: publishable must be false`);
    }
  }
});

test("11I-B2: 19752996 remains machine GREEN (in frozen queue, not blocked by machine)", async () => {
  const queueRaw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const queue = JSON.parse(queueRaw) as QueueArtifact;
  const member = queue.sample.find((m) => m.canonicalRelationId === BLOCKED_RELATION);
  assert.ok(member);
  assert.equal(member.humanDecisionStatus, null);

  const greensRaw = await readFile(`${ROOT}/phase11g-expanded-green-candidates.json`, "utf8");
  const greens = JSON.parse(greensRaw) as {
    records: Array<{ canonicalRouteSourceId: string; safeStatus: string }>;
  };
  const green = greens.records.find((r) => r.canonicalRouteSourceId === BLOCKED_RELATION);
  assert.ok(green);
  assert.equal(green.safeStatus, "GREEN");
});

test("11I-B2: relation 19752996 machine qualification unchanged", async () => {
  const queueRaw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const queue = JSON.parse(queueRaw) as QueueArtifact;
  const member = queue.sample.find((m) => m.canonicalRelationId === BLOCKED_RELATION);
  assert.ok(member);
  assert.equal(member.selectionTier, "NAMED_STRATUM");
  assert.equal(member.qualityBand, "Q90");
});
