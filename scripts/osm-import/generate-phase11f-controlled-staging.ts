import { readFile } from "node:fs/promises";

import type { PreviewMetadataDocument } from "../../Lib/osmStagingPreview/core.ts";
import { readJsonLines, writeJsonAtomically } from "./jsonl.ts";
import {
  createLockedFirstWriteManifest,
  validateFirstWriteManifest,
  type FirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";
import { sha256Stable } from "./phase11-publication.ts";
import {
  PHASE11F_EXCLUDED_RELATIONS,
  PHASE11F_EXPECTED_EXECUTABLE,
  PHASE11F_MACHINE_POLICY_VERSION,
  PHASE11F_SAMPLE_ALGORITHM_VERSION,
  buildCalibrationMetrics,
  buildFrozenExecutionContract,
  buildGreenCalibrationSample,
  createPhase11fPreviewMetadata,
  phase11fExecutionToken,
  verifyDeterministicArtifactHash,
  withDeterministicArtifactHash,
  type Phase11fHumanQaStatus,
  type Phase11fQualificationRecord,
  type Phase11fReadinessInput,
} from "./phase11f-controlled-staging.ts";
import {
  createPhase11fAdminClient,
  loadPhase11fActivePublications,
  loadPhase11fQaState,
  preflightPhase11fExecution,
} from "./phase11f-live.ts";

const PATHS = {
  executionPlan: "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl",
  executableManifest: "data/osm/alps/staging/phase11e-staging-manifest.json",
  phase11ePreviewMetadata: "data/osm/alps/staging/phase11e-preview-metadata.json",
  phase11eReadiness: "data/osm/alps/publication/phase11e-scale-readiness.json",
  phase11eGreen: "data/osm/alps/publication/phase11e-qualified-safe-candidates.json",
  phase11eYellow: "data/osm/alps/publication/phase11e-yellow-review-candidates.json",
  phase11eConflicts: "data/osm/alps/staging/phase11e-staging-conflicts.json",
  frozenContract: "data/osm/alps/staging/phase11f-executable-staging-contract.json",
  unchangedVerification: "data/osm/alps/staging/phase11f-unchanged-staging-verification.json",
  sample: "data/osm/alps/publication/phase11f-green-calibration-sample.json",
  queue: "data/osm/alps/publication/phase11f-green-calibration-queue.json",
  queueManifest: "data/osm/alps/staging/phase11f-green-calibration-manifest.json",
  queueMetadata: "data/osm/alps/staging/phase11f-green-calibration-preview-metadata.json",
  yellowPolicy: "data/osm/alps/publication/phase11f-yellow-policy.json",
  metrics: "data/osm/alps/publication/phase11f-green-calibration-metrics.json",
  machinePolicy: "data/osm/alps/publication/phase11f-machine-publication-policy.json",
  preflight: "data/osm/alps/staging/phase11f-staging-preflight.json",
  authorization: "data/osm/alps/staging/phase11f-staging-execution-authorization.json",
  readiness: "data/osm/alps/publication/phase11f-controlled-staging-readiness.json",
} as const;

interface QualificationArtifact {
  recordCount: number;
  records: Phase11fQualificationRecord[];
  deterministicArtifactHash: string;
  [key: string]: unknown;
}

interface ConflictArtifact {
  conflictCount: number;
  excludedFromExecutableManifest: boolean;
  records: Array<{ canonicalRelationId: string; classification: string }>;
  deterministicArtifactHash: string;
  [key: string]: unknown;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertExpectedPreflight(result: {
  wouldCreate: number;
  unchanged: number;
  blocked: number;
}): void {
  if (
    result.wouldCreate !== PHASE11F_EXPECTED_EXECUTABLE.wouldCreate ||
    result.unchanged !== PHASE11F_EXPECTED_EXECUTABLE.unchanged ||
    result.blocked !== PHASE11F_EXPECTED_EXECUTABLE.blocked
  ) {
    throw new Error(
      `PHASE11F_PREFLIGHT_DRIFT:${result.wouldCreate}:${result.unchanged}:${result.blocked}`,
    );
  }
}

function verifyUnchangedQa(input: {
  unchanged: Array<{ sourceRelationId: string; stagingRouteId: string | null }>;
  decisions: Awaited<ReturnType<typeof loadPhase11fQaState>>["decisions"];
  history: Awaited<ReturnType<typeof loadPhase11fQaState>>["history"];
}) {
  const decisionByRoute = new Map(input.decisions.map((row) => [row.staging_route_id, row]));
  const historyByRoute = new Map<string, typeof input.history>();
  for (const row of input.history) {
    const values = historyByRoute.get(row.staging_route_id) ?? [];
    values.push(row);
    historyByRoute.set(row.staging_route_id, values);
  }
  const records = input.unchanged.map((record) => {
    if (!record.stagingRouteId) throw new Error(`PHASE11F_UNCHANGED_WITHOUT_STAGING_ID:${record.sourceRelationId}`);
    const decision = decisionByRoute.get(record.stagingRouteId) ?? null;
    const history = [...(historyByRoute.get(record.stagingRouteId) ?? [])]
      .sort((left, right) => left.decision_version - right.decision_version || left.id - right.id);
    const versionsAreContinuous = history.every((row, index) => row.decision_version === index + 1);
    const latest = history.at(-1) ?? null;
    const currentMatchesHistory = decision === null
      ? latest === null || latest.new_status === "PENDING"
      : latest !== null && latest.new_status === decision.status && latest.decision_version === decision.version;
    return {
      canonicalRelationId: record.sourceRelationId,
      stagingRouteId: record.stagingRouteId,
      currentQaStatus: decision?.status ?? "PENDING",
      currentQaVersion: decision?.version ?? null,
      historyEntries: history.length,
      latestHistoryStatus: latest?.new_status ?? null,
      latestHistoryVersion: latest?.decision_version ?? null,
      payloadCompatible: true,
      historyCompatible: versionsAreContinuous && currentMatchesHistory,
    };
  });
  if (records.some((record) => !record.payloadCompatible || !record.historyCompatible)) {
    throw new Error("PHASE11F_UNCHANGED_QA_HISTORY_DRIFT");
  }
  return records;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error("Phase 11F preparation accepts no execution arguments and never writes to the database.");
  }
  const [
    executionPlans,
    manifest,
    previewMetadata,
    readiness,
    greenArtifact,
    yellowArtifact,
    conflicts,
  ] = await Promise.all([
    readJsonLines<ImportPlanRecord>(PATHS.executionPlan),
    json<FirstWriteManifest>(PATHS.executableManifest),
    json<PreviewMetadataDocument>(PATHS.phase11ePreviewMetadata),
    json<Phase11fReadinessInput>(PATHS.phase11eReadiness),
    json<QualificationArtifact>(PATHS.phase11eGreen),
    json<QualificationArtifact>(PATHS.phase11eYellow),
    json<ConflictArtifact>(PATHS.phase11eConflicts),
  ]);
  for (const artifact of [readiness, greenArtifact, yellowArtifact, conflicts]) {
    verifyDeterministicArtifactHash(artifact as { deterministicArtifactHash: string } & Record<string, unknown>);
  }
  if (
    greenArtifact.recordCount !== 641 ||
    yellowArtifact.recordCount !== 63 ||
    conflicts.conflictCount !== 2 ||
    !conflicts.excludedFromExecutableManifest ||
    sha256Stable(conflicts.records.map((record) => record.canonicalRelationId)) !==
      sha256Stable([...PHASE11F_EXCLUDED_RELATIONS]) ||
    conflicts.records.some((record) => record.classification !== "F_ACTUAL_DATA_DRIFT")
  ) {
    throw new Error("PHASE11F_PHASE11E_CHECKPOINT_DRIFT");
  }
  validateFirstWriteManifest(executionPlans, manifest, manifest.datasetFingerprint);

  const client = await createPhase11fAdminClient();
  const [activeRows, preflight] = await Promise.all([
    loadPhase11fActivePublications(client),
    preflightPhase11fExecution(client, executionPlans),
  ]);
  const activeRelationIds = new Set(activeRows.map((row) => String(row.canonical_relation_id)));
  if (
    activeRows.length !== 118 ||
    activeRelationIds.size !== 118 ||
    readiness.checkpoint.actualActive !== 118 ||
    readiness.checkpoint.uniqueActiveRelations !== 118
  ) {
    throw new Error("PHASE11F_ACTIVE_CHECKPOINT_DRIFT");
  }
  assertExpectedPreflight(preflight);
  const frozenContract = buildFrozenExecutionContract({
    executionPlans,
    manifest,
    green: greenArtifact.records,
    yellow: yellowArtifact.records,
    readiness,
    activeRelationIds,
  });
  const unchanged = preflight.records.filter((record) => record.action === "UNCHANGED");
  const unchangedQa = await loadPhase11fQaState(
    client,
    unchanged.flatMap((record) => record.stagingRouteId ? [record.stagingRouteId] : []),
  );
  const unchangedRecords = verifyUnchangedQa({ unchanged, ...unchangedQa });
  const unchangedVerification = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_UNCHANGED_STAGING_VERIFICATION",
    readOnly: true,
    frozenContractHash: frozenContract.deterministicArtifactHash,
    exactUnchanged: unchangedRecords.length,
    drift: 0,
    payloadCompatibleQaDecisionRoutes: unchangedRecords.filter((record) => record.currentQaStatus !== "PENDING").length,
    payloadCompatibleQaHistoryEntries: unchangedRecords.reduce((sum, record) => sum + record.historyEntries, 0),
    qaDecisionsCompatibleWithCurrentPayload: unchangedRecords.every((record) => record.payloadCompatible),
    qaHistoryCompatibleWithCurrentPayload: unchangedRecords.every((record) => record.historyCompatible),
    records: unchangedRecords,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const sample = buildGreenCalibrationSample({
    green: greenArtifact.records,
    frozenRecords: frozenContract.records,
    readiness,
  });
  if (
    sample.counts.unique !== 298 ||
    sample.counts.recovered !== 232 ||
    sample.counts.random !== 41 ||
    sample.counts.boundary !== 26
  ) throw new Error("PHASE11F_SAMPLE_COUNT_DRIFT");
  const executionByRelation = new Map(executionPlans.map((record) => [record.canonicalRouteSourceId, record]));
  const samplePlans = sample.records.map((record) => {
    const plan = executionByRelation.get(record.canonicalRelationId);
    if (!plan) throw new Error(`PHASE11F_SAMPLE_PLAN_MISSING:${record.canonicalRelationId}`);
    return plan;
  });
  const queueManifest = createLockedFirstWriteManifest(samplePlans, manifest.datasetFingerprint);
  const queueMetadata = createPhase11fPreviewMetadata({
    source: previewMetadata,
    sample,
    manifest: queueManifest,
  });
  const queueRecords = sample.records.map((record, index) => ({
    sourceRelationId: record.canonicalRelationId,
    canonicalRouteSourceId: record.canonicalRelationId,
    sourceUrl: record.sourceUrl,
    stagingIdempotencyKey: record.stagingIdempotencyKey,
    stagingPayloadHash: record.stagingPayloadHash,
    qualificationStatus: record.qualificationStatus,
    qualificationScore: record.qualificationScore,
    qualificationHash: record.qualificationHash,
    reasonCodes: record.reasonCodes,
    roadSafetyStatus: record.roadSafetyStatus,
    roadSafetyIdentityHash: record.roadSafetyIdentityHash,
    recoveredByPhase11e: record.recoveredByPhase11e,
    auditCategories: record.auditCategories,
    priority: index + 1,
  }));
  const queue = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_GREEN_CALIBRATION_QUEUE",
    queueId: "phase11f",
    readOnly: true,
    stagingRequiredBeforeRuntimeUse: true,
    autoApprovalEnabled: false,
    newRoutesQueued: queueRecords.length,
    qualificationCounts: { GREEN: queueRecords.length, YELLOW: 0 },
    sampleHash: sample.sampleHash,
    deterministicQueueHash: sha256Stable(queueRecords),
    queue: queueRecords,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const relationByStagingId = new Map(
    preflight.records.flatMap((record) => record.stagingRouteId
      ? [[record.stagingRouteId, record.sourceRelationId] as const]
      : []),
  );
  const decisionsByRelation = new Map<string, Phase11fHumanQaStatus>();
  for (const decision of unchangedQa.decisions) {
    const relationId = relationByStagingId.get(decision.staging_route_id);
    if (relationId) decisionsByRelation.set(relationId, decision.status);
  }
  const metricsContract = buildCalibrationMetrics({
    sampleRecords: sample.records,
    decisionsByRelation,
  });
  const metrics = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_GREEN_CALIBRATION_METRICS",
    readOnly: true,
    sampleAlgorithmVersion: PHASE11F_SAMPLE_ALGORITHM_VERSION,
    sampleHash: sample.sampleHash,
    currentSnapshot: metricsContract,
    policyActivationAttempted: false,
    autoApprovalEnabled: false,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const yellowPending = yellowArtifact.records.filter((record) => record.humanQaStatus === null);
  const yellowPolicy = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_YELLOW_POLICY",
    readOnly: true,
    totalYellow: yellowArtifact.records.length,
    payloadCompatibleExistingDecisions: yellowArtifact.records.length - yellowPending.length,
    pendingYellow: yellowPending.length,
    pendingRelationIds: yellowPending.map((record) => record.canonicalRouteSourceId),
    policy: "YELLOW always requires human review and is excluded from GREEN calibration statistics.",
    autoPromotionEnabled: false,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const machinePolicy = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_MACHINE_PUBLICATION_POLICY_PROPOSAL",
    readOnly: true,
    policyVersion: PHASE11F_MACHINE_POLICY_VERSION,
    status: "PROPOSAL_ONLY",
    activated: false,
    attestationType: "MACHINE_QUALIFIED_V1",
    existingHumanQaSemanticsUnchanged: true,
    humanQaRequiredUnderCurrentContract: "VISUALLY_APPROVED",
    immutableEvidence: [
      "qualificationAlgorithmVersion",
      "qualificationArtifactHash",
      "geometryHash",
      "roadSafetyHash",
      "mountainIdentity",
      "summitIdentity",
      "sourceRelationIdentity",
      "stagingPayloadHash",
      "calibrationPolicyVersion",
      "calibrationSampleHash",
    ],
    validityRules: [
      "Attestation type must remain distinct from VISUALLY_APPROVED.",
      "Every evidence field is included in one immutable evidence hash.",
      "Any payload, geometry, road-safety, mountain, summit, source, qualification, or calibration identity change invalidates the attestation.",
      "Calibration must be complete and automaticPolicyActivationAllowed must be true before a later separately approved activation.",
      "No current RPC or publication path accepts MACHINE_QUALIFIED_V1.",
    ],
    securityReview: [
      { risk: "Unauthorized machine publication", control: "Server-only entry point; require an administrator authorization gate and service-role credentials unavailable to clients." },
      { risk: "RLS bypass through service role", control: "Keep the service role in a narrow server module; validate the frozen allowlist before every privileged call and never expose a client-callable generic publisher." },
      { risk: "IDOR or arbitrary relation selection", control: "Accept only the fixed queue ID and frozen relation identities; reject filesystem paths, URLs, caller-supplied mountain IDs, and routes outside the contract." },
      { risk: "Payload substitution", control: "Bind attestation and publication to source, summit, mountain, staging payload, geometry, qualification, road-safety, and calibration hashes." },
      { risk: "Replay or duplicate publication", control: "Use an idempotency key plus a consumed attestation identity and fail closed on an existing publication or changed staging state." },
      { risk: "Qualification artifact tampering", control: "Verify deterministic artifact and per-route qualification hashes against an allowlisted algorithm version." },
      { risk: "Stale geometry or road safety", control: "Recompute all bound hashes immediately before publication; any mismatch invalidates MACHINE_QUALIFIED_V1." },
      { risk: "QA history corruption", control: "Machine attestation is append-only and separate from immutable human QA history; it must never insert or rewrite VISUALLY_APPROVED decisions." },
      { risk: "Concurrent staging overwrite", control: "Use an exclusive controlled execution window, recheck every route before its RPC, abort on any changed identity, and require a future compare-and-set RPC before adversarial concurrent execution." },
    ],
    databaseOrRpcChangesImplemented: false,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const preflightArtifact = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_FINAL_STAGING_PREFLIGHT",
    readOnly: true,
    frozenContractHash: frozenContract.deterministicArtifactHash,
    total: executionPlans.length,
    wouldCreate: preflight.wouldCreate,
    unchanged: preflight.unchanged,
    blocked: preflight.blocked,
    conflicts: preflight.records.filter((record) => record.action === "BLOCKED").length,
    activePublications: activeRows.length,
    excludedDriftRelations: [...PHASE11F_EXCLUDED_RELATIONS],
    records: preflight.records.map((record) => ({
      canonicalRelationId: record.sourceRelationId,
      action: record.action,
      stagingRouteId: record.stagingRouteId,
      plannedPayloadHash: record.plannedIdentity.payloadHash,
      plannedGeometryHash: record.plannedIdentity.geometryHash,
      existingPayloadHash: record.existingIdentity?.payloadHash ?? null,
      existingGeometryHash: record.existingIdentity?.geometryHash ?? null,
    })),
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
  const token = phase11fExecutionToken(frozenContract.deterministicArtifactHash, manifest.manifestHash);
  const command = `node --experimental-strip-types scripts/osm-import/stage-phase11f-routes.ts --execute --contract ${PATHS.frozenContract} --token ${token}`;
  const authorization = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_STAGING_EXECUTION_AUTHORIZATION",
    readOnly: true,
    approvalRequired: true,
    executionWasRun: false,
    frozenContractHash: frozenContract.deterministicArtifactHash,
    executableManifestHash: manifest.manifestHash,
    token,
    exactCommand: command,
    expectedExecution: {
      newStagingRows: 636,
      exactUnchanged: 66,
      overwrite: 0,
      qaWrites: 0,
      publicationWrites: 0,
      activeChanges: 0,
      excludedRelations: [...PHASE11F_EXCLUDED_RELATIONS],
      resultingStagingReadyQueue: 702,
    },
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
  const phase11fReadiness = withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_CONTROLLED_STAGING_READINESS",
    readOnly: true,
    checkpoint: {
      active: activeRows.length,
      green: greenArtifact.recordCount,
      yellow: yellowArtifact.recordCount,
      recoveredGreen: readiness.humanQaStrategy.allRecoveredPendingGreenAudit.relationIds.length,
      excludedDriftRelations: [...PHASE11F_EXCLUDED_RELATIONS],
    },
    executableContract: {
      total: frozenContract.total,
      hash: frozenContract.deterministicArtifactHash,
      manifestHash: manifest.manifestHash,
    },
    unchangedVerification: {
      exact: unchangedVerification.exactUnchanged,
      drift: unchangedVerification.drift,
      hash: unchangedVerification.deterministicArtifactHash,
    },
    greenCalibration: {
      unique: sample.counts.unique,
      recovered: sample.counts.recovered,
      random: sample.counts.random,
      boundary: sample.counts.boundary,
      hash: sample.sampleHash,
      artifactHash: sample.deterministicArtifactHash,
    },
    yellow: {
      total: yellowPolicy.totalYellow,
      payloadCompatibleExistingDecisions: yellowPolicy.payloadCompatibleExistingDecisions,
      pending: yellowPolicy.pendingYellow,
    },
    runtimeQueue: {
      id: "phase11f",
      path: "/internal/osm-staging?queue=phase11f",
      size: queueRecords.length,
      hash: queue.deterministicQueueHash,
      artifactHash: queue.deterministicArtifactHash,
    },
    stagingPreflight: {
      total: preflightArtifact.total,
      wouldCreate: preflightArtifact.wouldCreate,
      unchanged: preflightArtifact.unchanged,
      blocked: preflightArtifact.blocked,
      conflicts: preflightArtifact.conflicts,
      hash: preflightArtifact.deterministicArtifactHash,
    },
    executionAuthorization: {
      command,
      token,
      executed: false,
      explicitUserApprovalRequired: true,
    },
    artifactHashes: {
      frozenContract: frozenContract.deterministicArtifactHash,
      unchangedVerification: unchangedVerification.deterministicArtifactHash,
      sample: sample.deterministicArtifactHash,
      queue: queue.deterministicArtifactHash,
      queueManifest: queueManifest.manifestHash,
      queueMetadata: sha256Stable(queueMetadata),
      yellowPolicy: yellowPolicy.deterministicArtifactHash,
      metrics: metrics.deterministicArtifactHash,
      machinePolicy: machinePolicy.deterministicArtifactHash,
      preflight: preflightArtifact.deterministicArtifactHash,
      authorization: authorization.deterministicArtifactHash,
    },
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  await Promise.all([
    writeJsonAtomically(PATHS.frozenContract, frozenContract),
    writeJsonAtomically(PATHS.unchangedVerification, unchangedVerification),
    writeJsonAtomically(PATHS.sample, sample),
    writeJsonAtomically(PATHS.queue, queue),
    writeJsonAtomically(PATHS.queueManifest, queueManifest),
    writeJsonAtomically(PATHS.queueMetadata, queueMetadata),
    writeJsonAtomically(PATHS.yellowPolicy, yellowPolicy),
    writeJsonAtomically(PATHS.metrics, metrics),
    writeJsonAtomically(PATHS.machinePolicy, machinePolicy),
    writeJsonAtomically(PATHS.preflight, preflightArtifact),
    writeJsonAtomically(PATHS.authorization, authorization),
    writeJsonAtomically(PATHS.readiness, phase11fReadiness),
  ]);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    executableContract: { total: frozenContract.total, hash: frozenContract.deterministicArtifactHash },
    unchanged: { exact: unchangedVerification.exactUnchanged, drift: unchangedVerification.drift },
    sample: sample.counts,
    sampleHash: sample.sampleHash,
    yellow: { total: yellowPolicy.totalYellow, pending: yellowPolicy.pendingYellow },
    queue: { path: "/internal/osm-staging?queue=phase11f", size: queueRecords.length, hash: queue.deterministicQueueHash },
    preflight: { total: preflightArtifact.total, wouldCreate: preflightArtifact.wouldCreate, unchanged: preflightArtifact.unchanged, blocked: preflightArtifact.blocked, conflicts: preflightArtifact.conflicts },
    controlledStagingCommand: command,
    executionWasRun: false,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
