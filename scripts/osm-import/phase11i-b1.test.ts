import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PREVIEW_QUEUE_IDS,
  getPreviewQueueDefinition,
  isCalibrationQueue,
  parsePreviewQueueId,
  validatePhase11hCalibrationArtifact,
  type Phase11hCalibrationArtifact,
} from "../../Lib/osmStagingPreview/queue-core.ts";
import {
  loadPhase11hCalibrationContract,
  loadPhase11hCalibrationPreview,
} from "../../Lib/osmStagingPreview/phase11h-calibration.ts";
import {
  buildPhase11iB1DryRunReport,
  verifyPhase11hArtifacts,
  type Phase11iB1ArtifactVerification,
} from "./execute-phase11h-controlled-staging.ts";

const ROOT = "data/osm/alps/staging";
const QUEUE_SHA256 =
  "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const CONTRACT_SHA256 =
  "183706634754b14bbae0e79c16bd43708140b338690200f210cd9d3b5f7cc1a1";
const QUEUE_TOTAL = 45;

test("11I-B1: phase11h is a registered calibration queue that parses and duries closed", () => {
  assert.ok(PREVIEW_QUEUE_IDS.includes("phase11h"));
  assert.equal(parsePreviewQueueId("phase11h"), "phase11h");
  assert.equal(isCalibrationQueue("phase11h"), true);
  assert.equal(isCalibrationQueue("phase11f"), false);
  assert.equal(isCalibrationQueue(null), false);
  assert.throws(() => parsePreviewQueueId("phase11i"), /Unknown/);
});

test("11I-B1: phase11h preview definition is fixed-path and read-only", () => {
  const definition = getPreviewQueueDefinition("phase11h");
  assert.equal(definition.expectedTotal, QUEUE_TOTAL);
  assert.equal(definition.expectedArtifactType, "PHASE11H_HUMAN_CALIBRATION_QUEUE");
  assert.equal(definition.mode, "CALIBRATION_READONLY");
  assert.equal(definition.queueFileSha256, QUEUE_SHA256);
  assert.doesNotMatch(definition.artifactPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.stagingManifestPath, /\.\.|[?&]path=/);
  assert.doesNotMatch(definition.previewMetadataPath, /\.\.|[?&]path=/);
});

test("11I-B1: frozen phase11h calibration artifact validates and hashes to the pinned queue", async () => {
  const definition = getPreviewQueueDefinition("phase11h");
  const raw = await readFile(`${ROOT}/phase11h-human-calibration-queue.json`, "utf8");
  const artifact = JSON.parse(raw) as Phase11hCalibrationArtifact;
  assert.equal(artifact.artifactType, "PHASE11H_HUMAN_CALIBRATION_QUEUE");
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.publishable, false);
  assert.equal(artifact.qaDecisionWrites, 0);
  assert.equal(artifact.autoApprovalEnabled, false);
  assert.equal(artifact.noPrefilledHumanDecision, true);
  assert.equal(artifact.sampleSize, QUEUE_TOTAL);
  assert.ok(artifact.sample.length === QUEUE_TOTAL);
  assert.ok(validatePhase11hCalibrationArtifact({ definition, artifact }) === artifact);
});

test("11I-B1: frozen phase11h queue file SHA-256 matches the pinned registry contract", async () => {
  const definition = getPreviewQueueDefinition("phase11h");
  const contract = await loadPhase11hCalibrationContract("phase11h");
  assert.equal(contract.queueFileSha256, QUEUE_SHA256);
  assert.equal(definition.queueFileSha256, QUEUE_SHA256);
  assert.equal(contract.artifact.sample.length, QUEUE_TOTAL);
});

test("11I-B1: read-only calibration preview resolves without database access", async () => {
  const result = await loadPhase11hCalibrationPreview("phase11h");
  assert.equal(result.members.length, QUEUE_TOTAL);
  assert.equal(result.summary.total, QUEUE_TOTAL);
  assert.equal(result.summary.decided, 0);
  assert.equal(result.summary.pending, QUEUE_TOTAL);
  assert.equal(result.readOnly, true);
  assert.equal(result.autoApprovalEnabled, false);
  assert.equal(result.noPrefilledHumanDecision, true);
  assert.equal(result.queueFileSha256, QUEUE_SHA256);
  assert.equal(result.questions.length, 7);
  assert.deepEqual(
    result.members.map((member) => member.queuePosition).sort((a, b) => a - b),
    [...Array.from({ length: QUEUE_TOTAL }, (_, index) => index + 1)],
  );
});

test("11I-B1: executor artifact verification returns the frozen contract file SHA-256", async () => {
  const verification = await verifyPhase11hArtifacts();
  assert.equal(verification.contractFileSha256, CONTRACT_SHA256);
  assert.equal(verification.queueArtifact.sampleSize, QUEUE_TOTAL);
  assert.equal(verification.frozenContract.executed, false);
  assert.equal(verification.frozenContract.databaseModeBefore, "SELECT_ONLY");
});

test("11I-B1: executor dry-run report is DRY-RUN ONLY with zero writes", async () => {
  const verification: Phase11iB1ArtifactVerification = await verifyPhase11hArtifacts();
  const report = buildPhase11iB1DryRunReport(verification);
  assert.equal(report.status, "PASS");
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.executeFlagPresent, false);
  assert.equal(report.planned, QUEUE_TOTAL);
  assert.equal(report.wouldCreate, QUEUE_TOTAL);
  assert.equal(report.unchanged, 0);
  assert.equal(report.conflicts, 0);
  assert.equal(report.blocked, 0);
  assert.equal(report.databaseWrites, 0);
  assert.equal(report.qaWrites, 0);
  assert.equal(report.publicationWrites, 0);
  assert.equal(report.activeChanges, 0);
  assert.equal(report.executionTokenVerified, false);
  assert.equal(report.payloadContractPresent, false);
});

test("11I-B1: executor source refuses a non-allowlisted contract path and requires --execute for token checks", async () => {
  const source = await readFile(
    "scripts/osm-import/execute-phase11h-controlled-staging.ts",
    "utf8",
  );
  assert.match(source, /PHASE11H_EXECUTION_TOKEN_REQUIRED/);
  assert.match(source, /PHASE11H_CONTRACT_PATH_NOT_ALLOWLISTED/);
  assert.match(source, /PHASE11H_EXECUTE_MODE_DISABLED_IN_THIS_RELEASE/);
  assert.match(source, /DRY_RUN/);
  assert.doesNotMatch(source, /--execute[\s\S]*stage_osm_route_import/);
});