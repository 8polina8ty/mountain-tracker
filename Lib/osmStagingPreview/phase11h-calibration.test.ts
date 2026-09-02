import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createPhase11hCalibrationMemberRenderModel,
  formatPhase11hBadge,
  formatPhase11hOptionalMetadata,
} from "./phase11h-calibration-view.ts";
import { loadPhase11hCalibrationPreview } from "./phase11h-calibration.ts";

test("Phase 11H badge formatting supports normal and nullable values", () => {
  assert.equal(formatPhase11hBadge("NEEDS_REVIEW"), "NEEDS REVIEW");
  assert.equal(formatPhase11hBadge(null), "—");
  assert.equal(formatPhase11hBadge(undefined), "—");
  assert.equal(formatPhase11hOptionalMetadata(null), "—");
});

test("Phase 11H pending members render without synthesizing a decision", async () => {
  const preview = await loadPhase11hCalibrationPreview("phase11h");
  const member = preview.members.find(
    (candidate) => candidate.canonicalRelationId === "12836107",
  );
  assert.ok(member);
  assert.equal(member.nameOrigin, null);
  assert.equal(member.humanDecisionStatus, null);

  const view = createPhase11hCalibrationMemberRenderModel(member);
  assert.equal(view.nameOrigin, "—");
  assert.equal(view.humanDecisionLabel, "PENDING");
  assert.equal(member.humanDecisionStatus, null);
});

test("Phase 11H staged members with null decisions display PENDING", async () => {
  const preview = await loadPhase11hCalibrationPreview("phase11h");
  const member = preview.members.find(
    (candidate) => candidate.canonicalRelationId === "14450146",
  );
  assert.ok(member);
  assert.equal(member.stagingStatus, "STAGED");
  assert.equal(member.humanDecisionStatus, null);
  assert.equal(
    createPhase11hCalibrationMemberRenderModel(member).humanDecisionLabel,
    "PENDING",
  );
});

test("Phase 11H blocked member renders without staging-row-only fields", async () => {
  const preview = await loadPhase11hCalibrationPreview("phase11h");
  const member = preview.members.find(
    (candidate) => candidate.canonicalRelationId === "19752996",
  );
  assert.ok(member);
  assert.equal(member.stagingStatus, "BLOCKED");
  assert.equal(member.stagingEligible, false);
  assert.equal(member.resolvedMountainId, null);

  const view = createPhase11hCalibrationMemberRenderModel(member);
  assert.equal(view.stagingLabel, "BLOCKED / UNSTAGED");
  assert.equal(view.blockingReason, "MOUNTAIN IDENTITY MISSING");
  assert.equal(view.humanDecisionLabel, "PENDING");
});

test("the current 45-member Phase 11H contract is entirely renderable and read-only", async () => {
  const preview = await loadPhase11hCalibrationPreview("phase11h");
  assert.equal(preview.members.length, 45);
  assert.equal(preview.summary.total, 45);
  assert.equal(preview.summary.staged, 44);
  assert.equal(preview.summary.blocked, 1);
  assert.equal(preview.summary.pending, 45);
  assert.equal(preview.summary.decided, 0);
  assert.equal(preview.readOnly, true);
  assert.equal(preview.autoApprovalEnabled, false);
  assert.equal(preview.noPrefilledHumanDecision, true);

  const views = preview.members.map(createPhase11hCalibrationMemberRenderModel);
  assert.equal(views.length, 45);
  assert.ok(views.every((view) => view.humanDecisionLabel === "PENDING"));
  assert.ok(preview.members.every((member) => member.humanDecisionStatus === null));

  const componentSource = await readFile(
    "components/internal/Phase11hCalibrationQueue.tsx",
    "utf8",
  );
  assert.doesNotMatch(componentSource, /<form|<button|savePhase11h|VISUALLY_APPROVED/);
});
