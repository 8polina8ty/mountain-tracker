import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalibrationMetrics,
  createMachineQualifiedV1Evidence,
  phase11fExecutionToken,
  validateMachineQualifiedV1Evidence,
  type MachineQualifiedEvidenceInput,
} from "./phase11f-controlled-staging.ts";

const evidenceInput: MachineQualifiedEvidenceInput = {
  qualificationAlgorithmVersion: "qualification/v1",
  qualificationArtifactHash: "qualification-hash",
  geometryHash: "geometry-hash",
  roadSafetyHash: "road-hash",
  mountainIdentity: [{ peakOsmId: "peak-1", mountainId: 1 }],
  summitIdentity: [{
    peakOsmId: "peak-1",
    mountainId: 1,
    finalAssociation: "CONFIRMED",
    mountainMatchClassification: "EXACT_MOUNTAIN_MATCH",
  }],
  sourceRelationIdentity: { canonicalRelationId: "123", sourceUrl: "https://www.openstreetmap.org/relation/123" },
  stagingPayloadHash: "payload-hash",
  calibrationPolicyVersion: "calibration/v1",
  calibrationSampleHash: "sample-hash",
};

test("machine qualification evidence is invalidated by payload or geometry drift", () => {
  const evidence = createMachineQualifiedV1Evidence(evidenceInput);
  assert.equal(validateMachineQualifiedV1Evidence(evidence, evidenceInput), true);
  assert.equal(validateMachineQualifiedV1Evidence(evidence, { ...evidenceInput, geometryHash: "changed" }), false);
  assert.equal(validateMachineQualifiedV1Evidence(evidence, { ...evidenceInput, stagingPayloadHash: "changed" }), false);
  assert.equal(validateMachineQualifiedV1Evidence(evidence, { ...evidenceInput, roadSafetyHash: "changed" }), false);
});

test("GREEN calibration metrics preserve category overlap and expose failures", () => {
  const sampleRecords = [
    { canonicalRelationId: "1", auditCategories: ["RANDOM", "BOUNDARY"] as const, reasonCodes: ["B"] },
    { canonicalRelationId: "2", auditCategories: ["RECOVERED"] as const, reasonCodes: ["A"] },
    { canonicalRelationId: "3", auditCategories: ["RECOVERED"] as const, reasonCodes: ["A"] },
  ];
  const metrics = buildCalibrationMetrics({
    sampleRecords: sampleRecords.map((record) => ({ ...record, auditCategories: [...record.auditCategories] })),
    decisionsByRelation: new Map([
      ["1", "REJECTED"],
      ["2", "NEEDS_REVIEW"],
      ["3", "NEEDS_REVIEW"],
    ]),
  });
  assert.equal(metrics.falseGreen, 3);
  assert.equal(metrics.categoryBreakdown.RANDOM.REJECTED, 1);
  assert.equal(metrics.categoryBreakdown.BOUNDARY.REJECTED, 1);
  assert.equal(metrics.categoryBreakdown.RECOVERED.NEEDS_REVIEW, 2);
  assert.ok(metrics.meaningfulNeedsReviewClusters.some((cluster) => cluster.key === "RECOVERED"));
  assert.ok(metrics.meaningfulNeedsReviewClusters.some((cluster) => cluster.key === "A"));
  assert.equal(metrics.automaticPolicyActivationAllowed, false);
});

test("controlled execution token is bound to both frozen hashes", () => {
  const token = phase11fExecutionToken("contract", "manifest");
  assert.equal(token, "PHASE11F:contract:manifest");
  assert.notEqual(token, phase11fExecutionToken("contract-changed", "manifest"));
  assert.notEqual(token, phase11fExecutionToken("contract", "manifest-changed"));
});
