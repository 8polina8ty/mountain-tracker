import { readFile } from "node:fs/promises";

import { readJsonLines, writeJsonAtomically } from "./jsonl.ts";
import {
  PHASE11F_SAMPLE_ALGORITHM_VERSION,
  buildCalibrationMetrics,
  verifyDeterministicArtifactHash,
  withDeterministicArtifactHash,
  type Phase11fAuditCategory,
  type Phase11fHumanQaStatus,
} from "./phase11f-controlled-staging.ts";
import {
  createPhase11fAdminClient,
  loadPhase11fQaState,
  preflightPhase11fExecution,
} from "./phase11f-live.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

const SAMPLE_PATH = "data/osm/alps/publication/phase11f-green-calibration-sample.json";
const EXECUTION_PLAN_PATH = "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl";
const METRICS_PATH = "data/osm/alps/publication/phase11f-green-calibration-metrics.json";

interface SampleArtifact {
  sampleAlgorithmVersion: string;
  sampleHash: string;
  records: Array<{
    canonicalRelationId: string;
    auditCategories: Phase11fAuditCategory[];
    reasonCodes: string[];
  }>;
  deterministicArtifactHash: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("Phase 11F calibration reporting accepts no paths or mutation flags.");
  const [sample, plans] = await Promise.all([
    readFile(SAMPLE_PATH, "utf8").then((value) => JSON.parse(value) as SampleArtifact),
    readJsonLines<ImportPlanRecord>(EXECUTION_PLAN_PATH),
  ]);
  verifyDeterministicArtifactHash(sample);
  if (sample.sampleAlgorithmVersion !== PHASE11F_SAMPLE_ALGORITHM_VERSION) {
    throw new Error("PHASE11F_SAMPLE_ALGORITHM_DRIFT");
  }
  const sampleIds = new Set(sample.records.map((record) => record.canonicalRelationId));
  const samplePlans = plans.filter((record) => sampleIds.has(record.canonicalRouteSourceId));
  if (samplePlans.length !== sample.records.length) throw new Error("PHASE11F_SAMPLE_PLAN_INCOMPLETE");
  const client = await createPhase11fAdminClient();
  const preflight = await preflightPhase11fExecution(client, samplePlans);
  if (preflight.blocked !== 0) throw new Error("PHASE11F_SAMPLE_PAYLOAD_DRIFT");
  const exactRows = preflight.records.filter((record) => record.action === "UNCHANGED" && record.stagingRouteId);
  const qa = await loadPhase11fQaState(client, exactRows.map((record) => record.stagingRouteId as string));
  const relationByStaging = new Map(exactRows.map((record) => [record.stagingRouteId as string, record.sourceRelationId]));
  const decisionsByRelation = new Map<string, Phase11fHumanQaStatus>();
  for (const decision of qa.decisions) {
    const relationId = relationByStaging.get(decision.staging_route_id);
    if (relationId) decisionsByRelation.set(relationId, decision.status);
  }
  const currentSnapshot = buildCalibrationMetrics({ sampleRecords: sample.records, decisionsByRelation });
  const artifact = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_GREEN_CALIBRATION_METRICS",
    readOnly: true,
    sampleAlgorithmVersion: PHASE11F_SAMPLE_ALGORITHM_VERSION,
    sampleHash: sample.sampleHash,
    stagedPayloadCompatible: exactRows.length,
    currentSnapshot,
    policyActivationAttempted: false,
    autoApprovalEnabled: false,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
  await writeJsonAtomically(METRICS_PATH, artifact);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    sampleSize: currentSnapshot.sampleSize,
    approved: currentSnapshot.approved,
    needsReview: currentSnapshot.needsReview,
    rejected: currentSnapshot.rejected,
    falseGreen: currentSnapshot.falseGreen,
    pending: currentSnapshot.pending,
    meaningfulNeedsReviewClusters: currentSnapshot.meaningfulNeedsReviewClusters,
    automaticPolicyActivationAllowed: currentSnapshot.automaticPolicyActivationAllowed,
    policyActivationAttempted: false,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
