import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Stable } from "./phase11-publication.ts";
import {
  PHASE11H_CONTRACT,
  PHASE11H_NAME_RESOLUTION_CONTRACT,
  PHASE11H_QA_QUESTION_CONTRACT,
  PHASE11H_QA_QUESTIONS,
  PHASE11H_QA_STATUS_VOCABULARY,
  PHASE11H_SAMPLE_TARGET,
  PHASE11H_STAGING_CONTRACT,
} from "./phase11h-naming.ts";

const ROOT = "data/osm/alps/staging";

interface Hashable {
  deterministicArtifactHash: string;
}

async function loadArtifact<T>(name: string): Promise<T> {
  const timer = `phase11h-artifacts-test:read:${name}`;
  console.time(timer);
  const parsed = JSON.parse(await readFile(`${ROOT}/${name}`, "utf8")) as T;
  console.timeEnd(timer);
  return parsed;
}

function recomputeHash<T extends object>(artifact: T & Hashable): string {
  const content = Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "deterministicArtifactHash"),
  );
  return sha256Stable(content);
}

interface QueueArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  queueVersion: string;
  deterministicOrdering: string;
  selectionTargetSize: number;
  qaQuestionContractVersion: string;
  qaStatusVocabulary: string[];
  questions: Array<{ id: string; prompt: string }>;
  sampleSize: number;
  sample: Array<{
    canonicalRelationId: string;
    candidateHash: string;
    qualificationHash: string;
    nameStatus: string;
    nameOrigin: string | null;
    resolvedDisplayName: string | null;
    startContext: string | null;
    selectionTier: string;
    humanDecisionStatus: string | null;
  }>;
  deterministicArtifactHash: string;
}

interface NameAuditArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  recordCount: number;
  counts: Record<string, number>;
  nameReady: number;
  nameUnresolved: number;
  refPartition: Record<string, number>;
  hutNameResolved: number;
  baseNameResolved: number;
  records: Array<{
    canonicalRelationId: string;
    nameStatus: string;
    nameOrigin: string | null;
    derivedDisplayName: string | null;
    sourceName: string | null;
    sourceNamePreservedAsNull: boolean;
  }>;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

interface ReadinessArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  autoApprovalEnabled: boolean;
  existingValidatedGreen: number;
  phase11gNewGreen: number;
  combinedMachineGreen: number;
  nameResolution: {
    counts: Record<string, number>;
    nameReadyTotal: number;
    nameUnresolvedTotal: number;
    hutNameResolved: number;
    baseNameResolved: number;
    refPartition: Record<string, number>;
  };
  calibration: {
    sampleSize: number;
    sampleBase: number;
    sampleHut: number;
    sampleNamed: number;
    sampleMissingName: number;
    sampleDerivedName: number;
    sampleUnresolvedName: number;
    sampleLowQuality: number;
    sampleRandomControl: number;
    qualityBands: { Q65_74: number; Q75_89: number; Q90: number };
    humanCalibrationReady: boolean;
  };
  publicationPartition: Record<string, number>;
  finalPartition: Record<string, number>;
  humanGuards: {
    rejectedMachineEligible: number;
    needsReviewMachineEligible: number;
    existingApprovedCount: number;
    reconciledArtifactHits: number;
    artifactsScanned: number;
    derivedNameRequiresHumanConfirmation: boolean;
    visuallyApprovedIsNotNameApproval: boolean;
  };
  stagingForReview: {
    requiredForInteractiveUi: boolean;
    artifactOnlyQueueSupported: boolean;
    planExecuted: boolean;
    planPath: string;
    wouldCreate: number;
    unchanged: number;
    conflicts: number;
    blocked: number;
  };
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

interface StagingPlanArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  executed: boolean;
  stagedStateOracle: string;
  stagingContractVersion: string;
  scope: { sampleSize: number; relations: string[] };
  wouldCreate: number;
  unchanged: number;
  conflicts: number;
  blocked: number;
  rows: Array<{
    canonicalRelationId: string;
    stagingContractVersion: string;
    previouslyStaged: boolean;
    wouldCreateEntry: boolean;
    unchanged: boolean;
    conflict: null;
    conflictReason: null;
    blocked: boolean;
    blockedReason: null;
  }>;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

test("11H: name resolution audit covers exactly the 121 Phase 11G GREEN candidates", async () => {
  const audit = await loadArtifact<NameAuditArtifact>("phase11h-name-resolution-audit.json");
  assert.equal(audit.artifactType, "PHASE11H_NAME_RESOLUTION_AUDIT");
  assert.equal(audit.contractVersion, PHASE11H_NAME_RESOLUTION_CONTRACT);
  assert.equal(audit.recordCount, 121);
  assert.equal(audit.records.length, 121);
  const countSum = Object.values(audit.counts).reduce((sum, value) => sum + value, 0);
  assert.equal(countSum, 121);
  assert.equal(audit.nameReady + audit.nameUnresolved, 121);
  for (const record of audit.records) {
    assert.equal(typeof record.canonicalRelationId, "string");
    assert.ok(record.canonicalRelationId.length > 0);
  }
  const ids = new Set(audit.records.map((record) => record.canonicalRelationId));
  assert.equal(ids.size, 121);
  assert.equal(audit.writes.databaseWrites, 0);
  assert.equal(audit.writes.qaWrites, 0);
  assert.equal(audit.writes.publicationWrites, 0);
  assert.equal(audit.deterministicArtifactHash, recomputeHash(audit));
});

test("11H: name audit is deterministic (idempotent rerun reproduces the same hash)", async () => {
  const first = await loadArtifact<NameAuditArtifact>("phase11h-name-resolution-audit.json");
  const second = await loadArtifact<NameAuditArtifact>("phase11h-name-resolution-audit.json");
  assert.equal(first.deterministicArtifactHash, second.deterministicArtifactHash);
});

test("11H: calibration queue contains 45 members and NO human decisions are pre-filled", async () => {
  const queue = await loadArtifact<QueueArtifact>("phase11h-human-calibration-queue.json");
  assert.equal(queue.artifactType, "PHASE11H_HUMAN_CALIBRATION_QUEUE");
  assert.equal(queue.contractVersion, PHASE11H_CONTRACT);
  assert.equal(queue.sampleSize, queue.sample.length);
  assert.equal(queue.sampleSize, 45);
  assert.equal(queue.sampleSize, PHASE11H_SAMPLE_TARGET);
  assert.equal(queue.qaDecisionWrites, 0);
  assert.equal(queue.autoApprovalEnabled, false);
  assert.equal(queue.readOnly, true);
  assert.equal(queue.publishable, false);
  assert.equal(queue.qaQuestionContractVersion, PHASE11H_QA_QUESTION_CONTRACT);
  assert.equal(queue.qaStatusVocabulary.length, PHASE11H_QA_STATUS_VOCABULARY.length);
  assert.deepEqual(queue.qaStatusVocabulary, [...PHASE11H_QA_STATUS_VOCABULARY]);
  assert.equal(queue.qaStatusVocabulary.length, 4);
  const sampleIds = new Set(queue.sample.map((member) => member.canonicalRelationId));
  assert.equal(sampleIds.size, 45);
  for (const member of queue.sample) {
    assert.equal(member.humanDecisionStatus, null);
  }
  const hashes = queue.sample.map((member) => member.qualificationHash);
  assert.deepEqual(hashes, [...hashes].sort((a, b) => a.localeCompare(b)));
  assert.match(queue.deterministicOrdering, /deterministicQualificationHash/);
  assert.ok(queue.deterministicOrdering.includes("HUT_FULL_COVERAGE"));
});

test("11H: queue sample is a stratified subset of the name audit", async () => {
  const audit = await loadArtifact<NameAuditArtifact>("phase11h-name-resolution-audit.json");
  const queue = await loadArtifact<QueueArtifact>("phase11h-human-calibration-queue.json");
  const auditIds = new Set(audit.records.map((record) => record.canonicalRelationId));
  for (const member of queue.sample) {
    assert.ok(auditIds.has(member.canonicalRelationId));
  }
  assert.equal(queue.deterministicArtifactHash, recomputeHash(queue));
});

test("11H: readiness asserts the frozen Phase 11G combined population", async () => {
  const readiness = await loadArtifact<ReadinessArtifact>("phase11h-readiness.json");
  assert.equal(readiness.artifactType, "PHASE11H_READINESS");
  assert.equal(readiness.contractVersion, PHASE11H_CONTRACT);
  assert.equal(readiness.existingValidatedGreen, 124);
  assert.equal(readiness.phase11gNewGreen, 121);
  assert.equal(readiness.combinedMachineGreen, 245);
  assert.equal(readiness.autoApprovalEnabled, false);
  assert.equal(readiness.readOnly, true);
  assert.equal(readiness.publishable, false);
  assert.equal(readiness.nameResolution.nameReadyTotal + readiness.nameResolution.nameUnresolvedTotal, 121);
  assert.equal(readiness.deterministicArtifactHash, recomputeHash(readiness));
  assert.equal(readiness.writes.databaseWrites, 0);
  assert.equal(readiness.writes.qaWrites, 0);
  assert.equal(readiness.writes.publicationWrites, 0);
});

test("11H: human calibration readiness requires base, hut, missing-name, and band coverage", async () => {
  const readiness = await loadArtifact<ReadinessArtifact>("phase11h-readiness.json");
  const calibration = readiness.calibration;
  assert.equal(calibration.humanCalibrationReady, true);
  assert.ok(calibration.sampleSize > 0);
  assert.ok(calibration.sampleBase > 0);
  assert.ok(calibration.sampleHut > 0);
  assert.ok(calibration.sampleMissingName > 0);
  assert.ok(calibration.qualityBands.Q65_74 > 0);
  assert.ok(calibration.qualityBands.Q75_89 > 0);
  assert.ok(calibration.qualityBands.Q90 > 0);
  assert.equal(calibration.sampleNamed, 1);
  assert.equal(
    calibration.sampleDerivedName + calibration.sampleUnresolvedName,
    calibration.sampleMissingName,
  );
});

test("11H: no machine route is auto-approved and QA reconciliation found no conflicts", async () => {
  const readiness = await loadArtifact<ReadinessArtifact>("phase11h-readiness.json");
  assert.equal(readiness.humanGuards.rejectedMachineEligible, 0);
  assert.equal(readiness.humanGuards.needsReviewMachineEligible, 0);
  assert.equal(readiness.humanGuards.existingApprovedCount, 0);
  assert.equal(readiness.humanGuards.reconciledArtifactHits, 0);
  assert.ok(readiness.humanGuards.artifactsScanned > 0);
  assert.equal(readiness.humanGuards.derivedNameRequiresHumanConfirmation, true);
  assert.equal(readiness.humanGuards.visuallyApprovedIsNotNameApproval, true);
  assert.equal(readiness.humanGuards.rejectedMachineEligible + readiness.humanGuards.needsReviewMachineEligible, 0);
});

test("11H: controlled staging plan is NOT executed and covers every sample relation", async () => {
  const plan = await loadArtifact<StagingPlanArtifact>("phase11h-controlled-staging-plan.json");
  const queue = await loadArtifact<QueueArtifact>("phase11h-human-calibration-queue.json");
  assert.equal(plan.artifactType, "PHASE11H_CONTROLLED_STAGING_PLAN");
  assert.equal(plan.contractVersion, PHASE11H_CONTRACT);
  assert.equal(plan.executed, false);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.stagingContractVersion, PHASE11H_STAGING_CONTRACT);
  assert.equal(plan.scope.sampleSize, 45);
  assert.equal(plan.rows.length, 45);
  assert.equal(plan.wouldCreate, 45);
  assert.equal(plan.unchanged, 0);
  assert.equal(plan.conflicts, 0);
  assert.equal(plan.blocked, 0);
  assert.ok(plan.stagedStateOracle.length > 0);
  for (const row of plan.rows) {
    assert.equal(row.previouslyStaged, false);
    assert.equal(row.wouldCreateEntry, true);
    assert.equal(row.unchanged, false);
    assert.equal(row.conflict, null);
    assert.equal(row.conflictReason, null);
    assert.equal(row.blocked, false);
    assert.equal(row.blockedReason, null);
  }
  const planIds = new Set(plan.rows.map((row) => row.canonicalRelationId));
  assert.equal(planIds.size, 45);
  for (const member of queue.sample) {
    assert.ok(planIds.has(member.canonicalRelationId));
  }
  assert.deepEqual(plan.scope.relations, [...plan.scope.relations].sort((a, b) => Number(a) - Number(b)));
  assert.equal(plan.writes.databaseWrites, 0);
  assert.equal(plan.writes.qaWrites, 0);
  assert.equal(plan.writes.publicationWrites, 0);
  assert.equal(plan.deterministicArtifactHash, recomputeHash(plan));
});

test("11H: readiness's staging review section is consistent with the staging plan", async () => {
  const readiness = await loadArtifact<ReadinessArtifact>("phase11h-readiness.json");
  const plan = await loadArtifact<StagingPlanArtifact>("phase11h-controlled-staging-plan.json");
  assert.equal(readiness.stagingForReview.requiredForInteractiveUi, true);
  assert.equal(readiness.stagingForReview.artifactOnlyQueueSupported, false);
  assert.equal(readiness.stagingForReview.planExecuted, false);
  assert.equal(readiness.stagingForReview.wouldCreate, plan.wouldCreate);
  assert.equal(readiness.stagingForReview.unchanged, plan.unchanged);
  assert.equal(readiness.stagingForReview.conflicts, plan.conflicts);
  assert.equal(readiness.stagingForReview.blocked, plan.blocked);
});

test("11H: QA questions contract matches the exported question set", async () => {
  const queue = await loadArtifact<QueueArtifact>("phase11h-human-calibration-queue.json");
  assert.deepEqual(
    queue.questions.map((question) => question.prompt),
    PHASE11H_QA_QUESTIONS.map((question) => question.prompt),
  );
  assert.equal(queue.questions.length, 7);
});