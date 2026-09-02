import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  Phase10QaHistoryRow,
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
  PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import {
  createPhase11C1BatchManifest,
  MAX_BATCH_SIZE,
  selectPhase11C1Batch,
  verifyPhase11C1BatchManifest,
} from "./phase11-batch.ts";
import {
  createProvenancePayload,
  sha256Stable,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";

const artifact = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidates.json", "utf8"),
) as PublicationCandidateArtifact;
const manifest = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8"),
) as PublicationCandidateManifest;
const qaHistory: Phase10QaHistoryRow[] = artifact.candidates.map((candidate, index) => ({
  id: index + 1,
  stagingRouteId: candidate.stagingRouteId,
  oldStatus: "PENDING",
  newStatus: "VISUALLY_APPROVED",
  reviewerNote: candidate.qaDecision.reviewerNote,
  reviewerUserId: candidate.qaDecision.reviewerUserId,
  decisionVersion: candidate.qaDecision.version,
  occurredAt: candidate.qaDecision.reviewedAt,
}));

function candidate(relationId: string): PublicationCandidateRecord {
  const value = artifact.candidates.find((record) => record.sourceRelationId === relationId);
  assert.ok(value, `missing candidate ${relationId}`);
  return value;
}

function identity(relationId: string): ExistingPublicationIdentity {
  const value = candidate(relationId);
  const provenance = createProvenancePayload({
    artifact,
    manifest,
    candidate: value,
    qaHistory,
  });
  return {
    publicationIdempotencyKey: provenance.publication_idempotency_key,
    stagingPayloadHash: provenance.staging_payload_hash,
    candidateContentHash: provenance.candidate_content_hash,
    candidateSetContentHash: provenance.candidate_set_content_hash,
    candidateManifestHash: provenance.candidate_manifest_hash,
    datasetFingerprint: provenance.dataset_fingerprint,
    geometryHash: provenance.geometry_hash,
    qaDecisionVersion: provenance.qa_decision_version,
    qaHistoryHash: provenance.qa_history_hash,
    targetPayloadHash: provenance.target_payload_hash,
  };
}

function active(...relationIds: string[]): Map<string, ExistingPublicationIdentity> {
  return new Map(
    relationIds.map((relationId) => {
      const value = identity(relationId);
      return [value.publicationIdempotencyKey, value];
    }),
  );
}

test("Phase 11C.1 hard-limits the first unpublished batch to five", () => {
  assert.equal(MAX_BATCH_SIZE, 5);
  const selected = selectPhase11C1Batch({
    artifact,
    existingPublications: active("196164"),
  });
  assert.deepEqual(
    selected.map((value) => value.sourceRelationId),
    ["20916", "33528", "199145", "207900", "207913"],
  );
  assert.ok(selected.every((value) => value.sourceRelationId !== "140270"));
  assert.ok(selected.every((value) => value.topology.classification === "SIMPLE"));
  assert.ok(selected.every((value) => value.qualityScore === 100));
});

test("selection excludes every ACTIVE candidate, not only relation 196164", () => {
  const selected = selectPhase11C1Batch({
    artifact,
    existingPublications: active("196164", "20916"),
  });
  assert.deepEqual(
    selected.map((value) => value.sourceRelationId),
    ["33528", "199145", "207900", "207913", "361148"],
  );
});

test("locked batch manifest has exact record fields and deterministic hash", () => {
  const batch = createPhase11C1BatchManifest({
    artifact,
    manifest,
    qaHistory,
    existingPublications: active("196164"),
  });
  assert.equal(batch.records.length, 5);
  assert.deepEqual(Object.keys(batch.records[0]).sort(), [
    "candidateContentHash",
    "canonicalRouteSourceId",
    "geometryHash",
    "mountainId",
    "publicationIdempotencyKey",
    "qaDecisionVersion",
    "routeName",
    "sourceRelationId",
    "stagingPayloadHash",
    "stagingRouteId",
    "targetPayloadHash",
  ]);
  assert.equal(
    batch.deterministicBatchManifestHash,
    sha256Stable(withoutBatchHash(batch)),
  );
  verifyPhase11C1BatchManifest({ provided: batch, expected: structuredClone(batch) });
});

test("batch manifest hash or content drift fails closed", () => {
  const expected = createPhase11C1BatchManifest({
    artifact,
    manifest,
    qaHistory,
    existingPublications: active("196164"),
  });
  const hashDrift = structuredClone(expected);
  hashDrift.deterministicBatchManifestHash = "0".repeat(64);
  assert.throws(
    () => verifyPhase11C1BatchManifest({ provided: hashDrift, expected }),
    /BATCH_MANIFEST_HASH_DRIFT/,
  );
  const contentDrift = structuredClone(expected);
  contentDrift.records[0].routeName = "drift";
  contentDrift.deterministicBatchManifestHash = sha256Stable(
    withoutBatchHash(contentDrift),
  );
  assert.throws(
    () => verifyPhase11C1BatchManifest({ provided: contentDrift, expected }),
    /BATCH_MANIFEST_CONTENT_DRIFT/,
  );
});

function withoutBatchHash(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "deterministicBatchManifestHash"),
  );
}
