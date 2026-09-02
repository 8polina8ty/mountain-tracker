import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getPreviewQueueDefinition, parsePreviewQueueId } from "../../Lib/osmStagingPreview/queue-core.ts";
import { sha256Stable } from "./phase11-publication.ts";
import {
  PHASE11F_EXCLUDED_RELATIONS,
  buildGreenCalibrationSample,
  verifyDeterministicArtifactHash,
  type Phase11fQualificationRecord,
  type Phase11fFrozenRecord,
  type Phase11fReadinessInput,
} from "./phase11f-controlled-staging.ts";

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

interface HashedArtifact {
  deterministicArtifactHash: string;
  [key: string]: unknown;
}

interface SampleArtifact extends HashedArtifact {
  sampleHash: string;
  counts: { unique: number; recovered: number; random: number; boundary: number; overlaps: number };
  relationIds: string[];
  records: Array<{
    canonicalRelationId: string;
    auditCategories: string[];
    qualificationStatus: string;
  }>;
}

interface YellowPolicyArtifact extends HashedArtifact {
  totalYellow: number;
  pendingYellow: number;
  autoPromotionEnabled: boolean;
  pendingRelationIds: string[];
}

interface UnchangedArtifact extends HashedArtifact {
  exactUnchanged: number;
  drift: number;
  qaDecisionsCompatibleWithCurrentPayload: boolean;
  qaHistoryCompatibleWithCurrentPayload: boolean;
}

interface PreflightArtifact extends HashedArtifact {
  total: number;
  wouldCreate: number;
  unchanged: number;
  blocked: number;
  conflicts: number;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

interface MachinePolicyArtifact extends HashedArtifact {
  activated: boolean;
  databaseOrRpcChangesImplemented: boolean;
}

interface AuthorizationArtifact extends HashedArtifact {
  approvalRequired: boolean;
  executionWasRun: boolean;
  exactCommand: string;
  frozenContractHash: string;
  expectedExecution: { excludedRelations: string[] };
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

test("Phase 11F frozen execution contract excludes drift and binds all route identities", async () => {
  const contract = await json<{
    total: number;
    expectedPreflight: { wouldCreate: number; unchanged: number; blocked: number; conflicts: number };
    excludedDriftRelations: string[];
    records: Array<{
      canonicalRelationId: string;
      sourceUrl: string;
      mountainIdentity: unknown[];
      summitIdentity: unknown[];
      geometryCanonicalHash: string;
      stagingPayloadHash: string;
      idempotencyKey: string;
      qualificationStatus: string;
      roadSafetyStatus: string;
      activeExcluded: boolean;
    }>;
    writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
    deterministicArtifactHash: string;
    [key: string]: unknown;
  }>("data/osm/alps/staging/phase11f-executable-staging-contract.json");
  verifyDeterministicArtifactHash(contract);
  assert.equal(contract.total, 702);
  assert.deepEqual(contract.expectedPreflight, { total: 702, wouldCreate: 636, unchanged: 66, blocked: 0, conflicts: 0 });
  assert.deepEqual(contract.excludedDriftRelations, [...PHASE11F_EXCLUDED_RELATIONS]);
  assert.ok(contract.records.every((record) => !PHASE11F_EXCLUDED_RELATIONS.includes(record.canonicalRelationId as never)));
  assert.ok(contract.records.every((record) =>
    /^\d+$/.test(record.canonicalRelationId) &&
    record.sourceUrl.endsWith(`/relation/${record.canonicalRelationId}`) &&
    record.mountainIdentity.length > 0 && record.summitIdentity.length > 0 &&
    /^[a-f0-9]{64}$/.test(record.geometryCanonicalHash) &&
    /^[a-f0-9]{64}$/.test(record.stagingPayloadHash) &&
    record.idempotencyKey.includes(record.canonicalRelationId) &&
    ["GREEN", "YELLOW"].includes(record.qualificationStatus) &&
    record.roadSafetyStatus === "SAFE" && record.activeExcluded));
  assert.deepEqual(contract.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});

test("Phase 11F sample is deterministic with fixed recovered/random/boundary categories", async () => {
  const [sample, green, readiness, contract] = await Promise.all([
    json<SampleArtifact>("data/osm/alps/publication/phase11f-green-calibration-sample.json"),
    json<{ records: Phase11fQualificationRecord[] }>("data/osm/alps/publication/phase11e-qualified-safe-candidates.json"),
    json<Phase11fReadinessInput>("data/osm/alps/publication/phase11e-scale-readiness.json"),
    json<{ records: Phase11fFrozenRecord[] }>("data/osm/alps/staging/phase11f-executable-staging-contract.json"),
  ]);
  verifyDeterministicArtifactHash(sample);
  const rebuilt = buildGreenCalibrationSample({ green: green.records, frozenRecords: contract.records, readiness });
  assert.equal(sample.sampleHash, rebuilt.sampleHash);
  assert.deepEqual(sample.counts, { unique: 298, recovered: 232, random: 41, boundary: 26, overlaps: 1 });
  assert.equal(new Set(sample.relationIds).size, 298);
  assert.equal(sample.records.filter((record) => record.auditCategories.includes("RECOVERED")).length, 232);
  assert.equal(sample.records.filter((record) => record.auditCategories.includes("RANDOM")).length, 41);
  assert.equal(sample.records.filter((record) => record.auditCategories.includes("BOUNDARY")).length, 26);
  assert.ok(sample.records.every((record) => record.qualificationStatus === "GREEN"));
});

test("YELLOW is excluded from GREEN calibration and remains human-review-only", async () => {
  const [sample, yellow] = await Promise.all([
    json<SampleArtifact>("data/osm/alps/publication/phase11f-green-calibration-sample.json"),
    json<YellowPolicyArtifact>("data/osm/alps/publication/phase11f-yellow-policy.json"),
  ]);
  verifyDeterministicArtifactHash(yellow);
  assert.equal(yellow.totalYellow, 63);
  assert.equal(yellow.pendingYellow, 52);
  assert.equal(yellow.autoPromotionEnabled, false);
  assert.equal(sample.records.some((record) => yellow.pendingRelationIds.includes(record.canonicalRelationId)), false);
});

test("unchanged verification and final preflight are exact and zero-write", async () => {
  const [unchanged, preflight] = await Promise.all([
    json<UnchangedArtifact>("data/osm/alps/staging/phase11f-unchanged-staging-verification.json"),
    json<PreflightArtifact>("data/osm/alps/staging/phase11f-staging-preflight.json"),
  ]);
  verifyDeterministicArtifactHash(unchanged);
  verifyDeterministicArtifactHash(preflight);
  assert.equal(unchanged.exactUnchanged, 66);
  assert.equal(unchanged.drift, 0);
  assert.equal(unchanged.qaDecisionsCompatibleWithCurrentPayload, true);
  assert.equal(unchanged.qaHistoryCompatibleWithCurrentPayload, true);
  assert.deepEqual(
    { total: preflight.total, wouldCreate: preflight.wouldCreate, unchanged: preflight.unchanged, blocked: preflight.blocked, conflicts: preflight.conflicts },
    { total: 702, wouldCreate: 636, unchanged: 66, blocked: 0, conflicts: 0 },
  );
  assert.deepEqual(preflight.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});

test("Phase 11F runtime queue is a fixed allowlisted path", () => {
  const definition = getPreviewQueueDefinition("phase11f");
  assert.equal(parsePreviewQueueId("phase11f"), "phase11f");
  assert.equal(definition.expectedTotal, 298);
  assert.equal(definition.expectedArtifactType, "PHASE11F_GREEN_CALIBRATION_QUEUE");
  for (const path of [definition.artifactPath, definition.stagingManifestPath, definition.previewMetadataPath]) {
    assert.doesNotMatch(path, /\.\.|[?&]path=/);
  }
  assert.throws(() => parsePreviewQueueId("phase11f/../../secret"), /Unknown/);
});

test("current publication contract still requires human VISUALLY_APPROVED", async () => {
  const [publicationSource, policy] = await Promise.all([
    readFile("scripts/osm-import/phase11-publication.ts", "utf8"),
    json<MachinePolicyArtifact>("data/osm/alps/publication/phase11f-machine-publication-policy.json"),
  ]);
  verifyDeterministicArtifactHash(policy);
  assert.match(publicationSource, /qaDecision\.status !== "VISUALLY_APPROVED"/);
  assert.doesNotMatch(publicationSource, /MACHINE_QUALIFIED_V1/);
  assert.equal(policy.activated, false);
  assert.equal(policy.databaseOrRpcChangesImplemented, false);
});

test("execution authorization is hash-bound but remains unexecuted", async () => {
  const authorization = await json<AuthorizationArtifact>("data/osm/alps/staging/phase11f-staging-execution-authorization.json");
  verifyDeterministicArtifactHash(authorization);
  assert.equal(authorization.approvalRequired, true);
  assert.equal(authorization.executionWasRun, false);
  assert.match(authorization.exactCommand, /--execute/);
  assert.match(authorization.exactCommand, new RegExp(authorization.frozenContractHash));
  assert.equal(sha256Stable(authorization.expectedExecution.excludedRelations), sha256Stable([...PHASE11F_EXCLUDED_RELATIONS]));
  assert.deepEqual(authorization.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});
