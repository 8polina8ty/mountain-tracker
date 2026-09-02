import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Stable } from "./phase11-publication.ts";
import {
  RESULT_CONTRACT,
  RESULT_PATH,
  type HumanCalibrationResult,
} from "./reconcile-phase11i-human-calibration.ts";

async function loadResult(): Promise<HumanCalibrationResult> {
  return JSON.parse(await readFile(RESULT_PATH, "utf8")) as HumanCalibrationResult;
}

function countTotal(counts: {
  VISUALLY_APPROVED: number;
  NEEDS_REVIEW: number;
  REJECTED: number;
}): number {
  return counts.VISUALLY_APPROVED + counts.NEEDS_REVIEW + counts.REJECTED;
}

test("11I-E result reconciles exactly 44 reviewed routes and one blocked member", async () => {
  const result = await loadResult();
  assert.equal(result.artifactType, "PHASE11I_HUMAN_CALIBRATION_RESULT");
  assert.equal(result.contractVersion, RESULT_CONTRACT);
  assert.equal(result.queue.totalCalibrationMembers, 45);
  assert.equal(result.queue.stagedAndReviewed, 44);
  assert.equal(result.queue.blocked, 1);
  assert.equal(result.queue.blockedRelation, "19752996");
  assert.equal(result.records.length, 44);
  assert.equal(new Set(result.records.map((record) => record.canonicalRelationId)).size, 44);
  assert.equal(new Set(result.records.map((record) => record.stagingRouteId)).size, 44);
  assert.equal(
    result.records.some((record) => record.canonicalRelationId === "19752996"),
    false,
  );
});

test("11I-E persisted decision distribution is complete and contains no PENDING", async () => {
  const result = await loadResult();
  assert.deepEqual(result.decisionDistribution, {
    VISUALLY_APPROVED: 44,
    NEEDS_REVIEW: 0,
    REJECTED: 0,
    PENDING: 0,
    total: 44,
    approvalRate: 1,
    needsReviewRate: 0,
    rejectionRate: 0,
  });
  assert.ok(
    result.records.every(
      (record) =>
        record.humanDecision === "VISUALLY_APPROVED" &&
        record.payloadCompatible === true &&
        record.payloadHash.length === 64 &&
        Number.isFinite(Date.parse(record.decisionTimestamp)) &&
        record.historyCount >= 1,
    ),
  );
});

test("11I-E cross-tabs each reconcile back to the 44-route result", async () => {
  const result = await loadResult();
  assert.equal(
    Object.values(result.matrices.startContext).reduce(
      (sum, counts) => sum + countTotal(counts),
      0,
    ),
    44,
  );
  assert.equal(
    Object.values(result.matrices.qualityBand).reduce(
      (sum, counts) => sum + countTotal(counts),
      0,
    ),
    44,
  );
  assert.equal(
    Object.values(result.matrices.nameStatus).reduce(
      (sum, counts) => sum + countTotal(counts),
      0,
    ),
    44,
  );
  assert.equal(
    Object.values(result.matrices.selectionTier).reduce(
      (sum, counts) => sum + countTotal(counts),
      0,
    ),
    44,
  );
});

test("11I-E current/history and blocked-relation integrity pass", async () => {
  const result = await loadResult();
  assert.equal(result.integrity.historyIntegrityPass, true);
  assert.equal(result.integrity.payloadCompatibilityPass, true);
  assert.deepEqual(result.integrity.mismatchRelationIds, []);
  assert.equal(result.integrity.currentDecisionRows, 44);
  assert.equal(result.integrity.historyRows, 45);
  assert.equal(result.integrity.duplicateCurrentDecisionRows, 0);
  assert.equal(result.integrity.orphanHistoryRows, 0);
  assert.deepEqual(result.blockedRelation, {
    canonicalRelationId: "19752996",
    machineStatus: "GREEN",
    blockingReason: "MOUNTAIN_IDENTITY_MISSING",
    staging: 0,
    decision: 0,
    history: 0,
    includedInPersistedCalibrationResult: false,
  });
});

test("11I-E calibration result is PASS with no machine false-GREEN examples", async () => {
  const result = await loadResult();
  assert.equal(result.calibrationResult, "PASS");
  assert.deepEqual(result.machineFalseGreen.humanRejectedMachineGreen, []);
  assert.deepEqual(result.machineFalseGreen.humanNeedsReviewMachineGreen, []);
  assert.ok(Object.values(result.failureClusters).every((ids) => ids.length === 0));
});

test("11I-E artifact is hash-bound and attests zero writes", async () => {
  const result = await loadResult();
  const { deterministicArtifactHash, ...content } = result;
  assert.equal(sha256Stable(content), deterministicArtifactHash);
  assert.equal(result.readOnly, true);
  assert.equal(result.publishable, false);
  assert.deepEqual(result.zeroWriteAttestation, {
    databaseWrites: 0,
    qaWrites: 0,
    qaHistoryWrites: 0,
    stagingWrites: 0,
    publicationWrites: 0,
    activeChanges: 0,
  });

  const source = await readFile(
    "scripts/osm-import/reconcile-phase11i-human-calibration.ts",
    "utf8",
  );
  assert.doesNotMatch(source, /\.rpc\(/);
  assert.doesNotMatch(
    source,
    /\.from\([^)]*\)[\s\S]{0,400}?\.(?:insert|upsert|update|delete)\(/,
  );
  assert.match(source, /\.from\("osm_staging_route_visual_qa"\)[\s\S]*?\.select\(/);
  assert.match(
    source,
    /\.from\("osm_staging_route_visual_qa_history"\)[\s\S]*?\.select\(/,
  );
});
