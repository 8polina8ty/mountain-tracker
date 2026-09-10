import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionRun,
  canTransitionTrack,
  transitionRun,
  transitionTrack,
  VALID_RUN_STATES,
  VALID_TRACK_STATES,
} from "./stateMachine.ts";

test("run state supports pause, resume, and finite completion", () => {
  assert.equal(canTransitionRun("PLANNED", "RUNNING"), true);
  assert.equal(canTransitionRun("RUNNING", "PAUSED"), true);
  assert.equal(canTransitionRun("PAUSED", "RUNNING"), true);
  assert.equal(canTransitionRun("RUNNING", "COMPLETED"), true);
});

test("idempotent checkpoint replay may retain the same state", () => {
  assert.equal(canTransitionRun("RUNNING", "RUNNING"), true);
  assert.equal(canTransitionTrack("NORMALIZED", "NORMALIZED"), true);
});

test("track state follows each resumable stage", () => {
  const path = [
    "DISCOVERED",
    "DOWNLOADED",
    "PARSED",
    "NORMALIZED",
    "MATCHED",
    "DEDUPLICATED",
    "QUALIFIED",
    "APPROVED",
    "PUBLISHED",
    "WITHDRAWN",
  ] as const;
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransitionTrack(path[index - 1], path[index]), true);
  }
});

test("review and rejection paths fail closed", () => {
  assert.equal(canTransitionTrack("MATCHED", "REVIEW_REQUIRED"), true);
  assert.equal(canTransitionTrack("REVIEW_REQUIRED", "APPROVED"), true);
  assert.equal(canTransitionTrack("REVIEW_REQUIRED", "REJECTED"), true);
  assert.equal(canTransitionTrack("REJECTED", "PUBLISHED"), false);
  assert.equal(canTransitionTrack("APPROVED", "NORMALIZED"), false);
});

test("illegal transitions throw", () => {
  assert.throws(() => transitionRun("PLANNED", "COMPLETED"), /Illegal/);
  assert.throws(() => transitionTrack("DISCOVERED", "PUBLISHED"), /Illegal/);
});

test("state enumerations contain terminal operational states", () => {
  assert.ok(VALID_RUN_STATES.includes("CANCELLED"));
  assert.ok(VALID_TRACK_STATES.includes("PROCESSING_FAILED"));
  assert.ok(VALID_TRACK_STATES.includes("WITHDRAWN"));
});
