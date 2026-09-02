import { sha256Stable } from "./phase11-publication.ts";
import type { ImportPlanRecord, FirstWriteManifest } from "./phase8-staging.ts";
import type { PreviewMetadataDocument } from "../../Lib/osmStagingPreview/core.ts";

export const PHASE11F_SAMPLE_ALGORITHM_VERSION =
  "mountain-tracker-phase11f-green-calibration/v1";
export const PHASE11F_MACHINE_POLICY_VERSION =
  "mountain-tracker-machine-qualified-publication-policy/v1-proposal";
export const PHASE11F_EXCLUDED_RELATIONS = ["1144001", "2210868"] as const;
export const PHASE11F_EXPECTED_EXECUTABLE = {
  total: 702,
  wouldCreate: 636,
  unchanged: 66,
  blocked: 0,
  conflicts: 0,
} as const;

export type Phase11fAuditCategory = "RECOVERED" | "RANDOM" | "BOUNDARY";
export type Phase11fHumanQaStatus =
  | "PENDING"
  | "VISUALLY_APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED";

export interface Phase11fQualificationRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  sourceUrl: string;
  stagingIdempotencyKey: string;
  stagingPayloadHash: string;
  status: "GREEN" | "YELLOW" | "RED";
  reasonCodes: string[];
  qualityScore: number;
  roadSafetyStatus: string;
  roadSafetyReasonCodes: string[];
  summitIdentities: Array<{
    peakOsmId: string;
    mountainId: number;
    finalAssociation: string;
    mountainMatchClassification: string;
  }>;
  humanQaStatus: Exclude<Phase11fHumanQaStatus, "PENDING"> | null;
  recoveredByPhase11e: boolean;
  deterministicQualificationHash: string;
}

export interface Phase11fReadinessInput {
  checkpoint: {
    expectedActive: number;
    actualActive: number;
    uniqueActiveRelations: number;
  };
  sourceIdentity: {
    pipelineDatasetFingerprint: string;
    pbfSha256: string;
    motorwayIndexContentHash: string;
  };
  humanQaStrategy: {
    deterministicRandomStablePendingGreenAudit: {
      sampleSize: number;
      relationIds: string[];
    };
    targetedBoundaryStablePendingGreenAudit: {
      sampleSize: number;
      relationIds: string[];
    };
    allRecoveredPendingGreenAudit: {
      executableSampleSize: number;
      blockedUntilIdentityResolution: string[];
      relationIds: string[];
    };
    recommendedAdditionalExecutableGreenAudit: {
      sampleSize: number;
      relationIds: string[];
    };
    allYellowRequired: number;
    pendingYellowAudit: { sampleSize: number; relationIds: string[] };
  };
  deterministicArtifactHash: string;
}

export interface Phase11fFrozenRecord {
  canonicalRelationId: string;
  sourceUrl: string;
  mountainIdentity: Array<{ peakOsmId: string; mountainId: number }>;
  summitIdentity: Phase11fQualificationRecord["summitIdentities"];
  geometryCanonicalHash: string;
  stagingPayloadHash: string;
  idempotencyKey: string;
  qualificationStatus: "GREEN" | "YELLOW";
  qualificationHash: string;
  qualificationReasonCodes: string[];
  qualificationScore: number;
  roadSafetyStatus: string;
  roadSafetyReasonCodes: string[];
  roadSafetyIdentityHash: string;
  activeExcluded: true;
}

function compareNumeric(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

export function withDeterministicArtifactHash<T extends object>(content: T): T & {
  deterministicArtifactHash: string;
} {
  return { ...content, deterministicArtifactHash: sha256Stable(content) };
}

export function verifyDeterministicArtifactHash(
  value: { deterministicArtifactHash: string } & Record<string, unknown>,
): void {
  const { deterministicArtifactHash, ...content } = value;
  if (sha256Stable(content) !== deterministicArtifactHash) {
    throw new Error("PHASE11F_SOURCE_ARTIFACT_HASH_MISMATCH");
  }
}

export function buildFrozenExecutionContract(input: {
  executionPlans: ImportPlanRecord[];
  manifest: FirstWriteManifest;
  green: Phase11fQualificationRecord[];
  yellow: Phase11fQualificationRecord[];
  readiness: Phase11fReadinessInput;
  activeRelationIds: Set<string>;
}) {
  const { executionPlans, manifest, readiness } = input;
  if (executionPlans.length !== PHASE11F_EXPECTED_EXECUTABLE.total) {
    throw new Error(`PHASE11F_EXECUTION_PLAN_COUNT:${executionPlans.length}`);
  }
  if (
    manifest.recordCount !== PHASE11F_EXPECTED_EXECUTABLE.total ||
    manifest.records.length !== PHASE11F_EXPECTED_EXECUTABLE.total
  ) {
    throw new Error("PHASE11F_EXECUTABLE_MANIFEST_COUNT");
  }
  const excluded = new Set<string>(PHASE11F_EXCLUDED_RELATIONS);
  if (executionPlans.some((record) => excluded.has(record.canonicalRouteSourceId))) {
    throw new Error("PHASE11F_DRIFT_RELATION_IN_EXECUTION_PLAN");
  }
  const manifestByRelation = new Map(
    manifest.records.map((record) => [record.canonicalRouteSourceId, record]),
  );
  const qualificationByRelation = new Map(
    [...input.green, ...input.yellow].map((record) => [record.canonicalRouteSourceId, record]),
  );
  const records: Phase11fFrozenRecord[] = [...executionPlans]
    .sort((left, right) => compareNumeric(left.canonicalRouteSourceId, right.canonicalRouteSourceId))
    .map((plan) => {
      const locked = manifestByRelation.get(plan.canonicalRouteSourceId);
      const qualification = qualificationByRelation.get(plan.canonicalRouteSourceId);
      if (!locked?.lockedEvidence || !qualification) {
        throw new Error(`PHASE11F_UNRESOLVED_EXECUTION_IDENTITY:${plan.canonicalRouteSourceId}`);
      }
      if (
        locked.payloadHash !== plan.payloadHash ||
        locked.idempotencyKey !== plan.idempotencyKey ||
        locked.lockedEvidence.sourceUrl !== plan.contract.source.sourceUrl ||
        qualification.stagingPayloadHash !== plan.payloadHash ||
        qualification.stagingIdempotencyKey !== plan.idempotencyKey ||
        qualification.sourceUrl !== plan.contract.source.sourceUrl ||
        qualification.status === "RED" ||
        qualification.roadSafetyStatus !== "SAFE" ||
        input.activeRelationIds.has(plan.canonicalRouteSourceId)
      ) {
        throw new Error(`PHASE11F_EXECUTION_IDENTITY_DRIFT:${plan.canonicalRouteSourceId}`);
      }
      const mountainIdentity = locked.mountainMatches.map((match) => ({
        peakOsmId: match.peakOsmId,
        mountainId: match.mountainId,
      }));
      const roadSafetyIdentityHash = sha256Stable({
        status: qualification.roadSafetyStatus,
        reasonCodes: qualification.roadSafetyReasonCodes,
        pbfSha256: readiness.sourceIdentity.pbfSha256,
        motorwayIndexContentHash: readiness.sourceIdentity.motorwayIndexContentHash,
        geometryCanonicalHash: locked.lockedEvidence.geometryHash,
      });
      return {
        canonicalRelationId: plan.canonicalRouteSourceId,
        sourceUrl: plan.contract.source.sourceUrl,
        mountainIdentity,
        summitIdentity: qualification.summitIdentities,
        geometryCanonicalHash: locked.lockedEvidence.geometryHash,
        stagingPayloadHash: plan.payloadHash,
        idempotencyKey: plan.idempotencyKey,
        qualificationStatus: qualification.status,
        qualificationHash: qualification.deterministicQualificationHash,
        qualificationReasonCodes: qualification.reasonCodes,
        qualificationScore: qualification.qualityScore,
        roadSafetyStatus: qualification.roadSafetyStatus,
        roadSafetyReasonCodes: qualification.roadSafetyReasonCodes,
        roadSafetyIdentityHash,
        activeExcluded: true as const,
      };
    });
  const content = {
    schemaVersion: 1,
    artifactType: "PHASE11F_FROZEN_EXECUTABLE_STAGING_CONTRACT",
    readOnly: true,
    contractVersion: "mountain-tracker-phase11f-controlled-staging/v1",
    sourcePhase11eReadinessHash: readiness.deterministicArtifactHash,
    datasetFingerprint: readiness.sourceIdentity.pipelineDatasetFingerprint,
    executableManifestPath: "data/osm/alps/staging/phase11e-staging-manifest.json",
    executableManifestHash: manifest.manifestHash,
    executionPlanPath: "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl",
    executionPlanHash: sha256Stable(executionPlans),
    total: records.length,
    expectedPreflight: PHASE11F_EXPECTED_EXECUTABLE,
    excludedDriftRelations: [...PHASE11F_EXCLUDED_RELATIONS],
    records,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };
  return withDeterministicArtifactHash(content);
}

export function buildGreenCalibrationSample(input: {
  green: Phase11fQualificationRecord[];
  frozenRecords: Phase11fFrozenRecord[];
  readiness: Phase11fReadinessInput;
}) {
  const { green, readiness } = input;
  const seed = readiness.sourceIdentity.pipelineDatasetFingerprint;
  const executableIds = new Set(input.frozenRecords.map((record) => record.canonicalRelationId));
  const pendingStable = green.filter((record) => !record.recoveredByPhase11e && record.humanQaStatus === null);
  const recovered = green
    .filter((record) => record.recoveredByPhase11e && record.humanQaStatus === null && executableIds.has(record.canonicalRouteSourceId))
    .map((record) => record.canonicalRouteSourceId)
    .sort(compareNumeric);
  const random = [...pendingStable]
    .sort((left, right) => sha256Stable(`${seed}:${left.sourceRelationId}`)
      .localeCompare(sha256Stable(`${seed}:${right.sourceRelationId}`)))
    .slice(0, Math.ceil(green.filter((record) => !record.recoveredByPhase11e).length * 0.1))
    .map((record) => record.canonicalRouteSourceId);
  const boundary = pendingStable
    .filter((record) => record.qualityScore === 90)
    .sort((left, right) => sha256Stable(`${seed}:boundary:${left.sourceRelationId}`)
      .localeCompare(sha256Stable(`${seed}:boundary:${right.sourceRelationId}`)))
    .slice(0, 50)
    .map((record) => record.canonicalRouteSourceId);
  const proposed = readiness.humanQaStrategy;
  if (
    sha256Stable(random) !== sha256Stable(proposed.deterministicRandomStablePendingGreenAudit.relationIds) ||
    sha256Stable(boundary) !== sha256Stable(proposed.targetedBoundaryStablePendingGreenAudit.relationIds) ||
    recovered.length !== proposed.allRecoveredPendingGreenAudit.executableSampleSize ||
    sha256Stable([...new Set([...recovered, ...random, ...boundary])].sort(compareNumeric)) !==
      sha256Stable(proposed.recommendedAdditionalExecutableGreenAudit.relationIds)
  ) {
    throw new Error("PHASE11F_PROPOSED_SAMPLE_DRIFT");
  }
  const categoriesByRelation = new Map<string, Phase11fAuditCategory[]>();
  for (const [category, ids] of [
    ["RECOVERED", recovered],
    ["RANDOM", random],
    ["BOUNDARY", boundary],
  ] as const) {
    for (const relationId of ids) {
      categoriesByRelation.set(relationId, [...(categoriesByRelation.get(relationId) ?? []), category]);
    }
  }
  const greenByRelation = new Map(green.map((record) => [record.canonicalRouteSourceId, record]));
  const frozenByRelation = new Map(input.frozenRecords.map((record) => [record.canonicalRelationId, record]));
  const records = [...categoriesByRelation]
    .sort(([left], [right]) => compareNumeric(left, right))
    .map(([relationId, auditCategories]) => {
      const qualification = greenByRelation.get(relationId);
      const frozen = frozenByRelation.get(relationId);
      if (!qualification || !frozen) throw new Error(`PHASE11F_SAMPLE_IDENTITY_MISSING:${relationId}`);
      return {
        canonicalRelationId: relationId,
        sourceUrl: qualification.sourceUrl,
        auditCategories,
        primaryAuditCategory: auditCategories[0],
        qualificationStatus: "GREEN" as const,
        qualificationScore: qualification.qualityScore,
        reasonCodes: qualification.reasonCodes,
        qualificationHash: qualification.deterministicQualificationHash,
        geometryCanonicalHash: frozen.geometryCanonicalHash,
        roadSafetyStatus: qualification.roadSafetyStatus,
        roadSafetyReasonCodes: qualification.roadSafetyReasonCodes,
        roadSafetyIdentityHash: frozen.roadSafetyIdentityHash,
        recoveredByPhase11e: qualification.recoveredByPhase11e,
        stagingPayloadHash: qualification.stagingPayloadHash,
        stagingIdempotencyKey: qualification.stagingIdempotencyKey,
      };
    });
  return withDeterministicArtifactHash({
    schemaVersion: 1,
    artifactType: "PHASE11F_GREEN_CALIBRATION_SAMPLE",
    readOnly: true,
    sampleAlgorithmVersion: PHASE11F_SAMPLE_ALGORITHM_VERSION,
    seed,
    qualificationArtifactHash: sha256Stable(green),
    counts: {
      unique: records.length,
      recovered: recovered.length,
      random: random.length,
      boundary: boundary.length,
      overlaps: recovered.length + random.length + boundary.length - records.length,
    },
    records,
    relationIds: records.map((record) => record.canonicalRelationId),
    sampleHash: sha256Stable(records),
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
}

export function buildCalibrationMetrics(input: {
  sampleRecords: Array<{
    canonicalRelationId: string;
    auditCategories: Phase11fAuditCategory[];
    reasonCodes: string[];
  }>;
  decisionsByRelation: Map<string, Phase11fHumanQaStatus>;
}) {
  const statuses: Phase11fHumanQaStatus[] = ["PENDING", "VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"];
  const categoryBreakdown = Object.fromEntries((["RECOVERED", "RANDOM", "BOUNDARY"] as const).map((category) => [
    category,
    Object.fromEntries(statuses.map((status) => [status, 0])),
  ])) as Record<Phase11fAuditCategory, Record<Phase11fHumanQaStatus, number>>;
  const reasonCodeBreakdown: Record<string, Record<Phase11fHumanQaStatus, number>> = {};
  const totals = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<Phase11fHumanQaStatus, number>;
  const needsReviewRelations: string[] = [];
  const rejectedRelations: string[] = [];
  for (const record of input.sampleRecords) {
    const status = input.decisionsByRelation.get(record.canonicalRelationId) ?? "PENDING";
    totals[status] += 1;
    if (status === "NEEDS_REVIEW") needsReviewRelations.push(record.canonicalRelationId);
    if (status === "REJECTED") rejectedRelations.push(record.canonicalRelationId);
    for (const category of record.auditCategories) categoryBreakdown[category][status] += 1;
    for (const reasonCode of record.reasonCodes) {
      reasonCodeBreakdown[reasonCode] ??= Object.fromEntries(statuses.map((value) => [value, 0])) as Record<Phase11fHumanQaStatus, number>;
      reasonCodeBreakdown[reasonCode][status] += 1;
    }
  }
  const meaningfulNeedsReviewClusters = [
    ...Object.entries(categoryBreakdown)
      .filter(([, counts]) => counts.NEEDS_REVIEW >= 2)
      .map(([key, counts]) => ({ dimension: "CATEGORY", key, count: counts.NEEDS_REVIEW })),
    ...Object.entries(reasonCodeBreakdown)
      .filter(([, counts]) => counts.NEEDS_REVIEW >= 2)
      .map(([key, counts]) => ({ dimension: "REASON_CODE", key, count: counts.NEEDS_REVIEW })),
  ];
  const falseGreen = totals.NEEDS_REVIEW + totals.REJECTED;
  return {
    sampleSize: input.sampleRecords.length,
    approved: totals.VISUALLY_APPROVED,
    needsReview: totals.NEEDS_REVIEW,
    rejected: totals.REJECTED,
    pending: totals.PENDING,
    falseGreen,
    categoryBreakdown,
    reasonCodeBreakdown,
    needsReviewRelations,
    rejectedRelations,
    meaningfulNeedsReviewClusterRule: "At least two NEEDS_REVIEW decisions sharing an audit category or reason code.",
    meaningfulNeedsReviewClusters,
    automaticPolicyActivationAllowed:
      totals.PENDING === 0 && totals.REJECTED === 0 && meaningfulNeedsReviewClusters.length === 0,
  };
}

export interface MachineQualifiedEvidenceInput {
  qualificationAlgorithmVersion: string;
  qualificationArtifactHash: string;
  geometryHash: string;
  roadSafetyHash: string;
  mountainIdentity: Array<{ peakOsmId: string; mountainId: number }>;
  summitIdentity: Phase11fQualificationRecord["summitIdentities"];
  sourceRelationIdentity: { canonicalRelationId: string; sourceUrl: string };
  stagingPayloadHash: string;
  calibrationPolicyVersion: string;
  calibrationSampleHash: string;
}

export function createMachineQualifiedV1Evidence(input: MachineQualifiedEvidenceInput) {
  const boundEvidence = {
    attestationType: "MACHINE_QUALIFIED_V1" as const,
    ...input,
  };
  return { ...boundEvidence, immutableEvidenceHash: sha256Stable(boundEvidence) };
}

export function validateMachineQualifiedV1Evidence(
  evidence: ReturnType<typeof createMachineQualifiedV1Evidence>,
  current: MachineQualifiedEvidenceInput,
): boolean {
  return evidence.immutableEvidenceHash === createMachineQualifiedV1Evidence(current).immutableEvidenceHash;
}

export function createPhase11fPreviewMetadata(input: {
  source: PreviewMetadataDocument;
  sample: ReturnType<typeof buildGreenCalibrationSample>;
  manifest: FirstWriteManifest;
}): PreviewMetadataDocument {
  const sourceByRelation = new Map(input.source.records.map((record) => [record.canonicalRouteSourceId, record]));
  return {
    schemaVersion: 1,
    contractVersion: input.manifest.contractVersion,
    datasetFingerprint: input.manifest.datasetFingerprint,
    manifestHash: input.manifest.manifestHash,
    recordCount: input.sample.records.length,
    records: input.sample.records.map((sample) => {
      const metadata = sourceByRelation.get(sample.canonicalRelationId);
      if (!metadata) throw new Error(`PHASE11F_PREVIEW_METADATA_MISSING:${sample.canonicalRelationId}`);
      return {
        ...metadata,
        auditCategories: sample.auditCategories,
        qualificationScore: sample.qualificationScore,
        qualificationReasonCodes: sample.reasonCodes,
        qualificationHash: sample.qualificationHash,
        recoveredByPhase11e: sample.recoveredByPhase11e,
        roadSafetyStatus: sample.roadSafetyStatus,
        roadSafetyReasonCodes: sample.roadSafetyReasonCodes,
        roadSafetyIdentityHash: sample.roadSafetyIdentityHash,
      };
    }),
  };
}

export function phase11fExecutionToken(contractHash: string, manifestHash: string): string {
  return `PHASE11F:${contractHash}:${manifestHash}`;
}
