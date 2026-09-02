import { resolve } from "node:path";

import {
  stableJson,
  type Phase10QaHistoryRow,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
  type PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import {
  createActivityClassificationSnapshot,
  mapMountainRouteV2,
  PHASE11_PUBLICATION_CONTRACT_V2,
  type ActivityClassificationSnapshot,
  type LockedPublicationManifestV2,
} from "./phase11-publication-v2.ts";
import { sha256Stable } from "./phase11-publication.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import { phase11C2EligibilityFailures } from "./phase11c2-v2-batch.ts";

export const PHASE11C3_SCALE_READINESS_PATH = "data/osm/alps/publication/phase11c3-scale-readiness.json";
export const PHASE11C3_QA_EXPANSION_QUEUE_PATH = "data/osm/alps/publication/phase11c3-qa-expansion-queue.json";

export const PHASE11C3_TARGET_BATCH_SIZE = 100 as const;
export const PHASE11C3_QA_EXPANSION_POOL_SIZE = 125 as const;
export const PHASE11C4_QA_QUEUE_SIZE = 150 as const;
export const PHASE11C3_BASELINE_ACTIVE_RELATION_IDS = [
  "20916",
  "33528",
  "140270",
  "196164",
  "199145",
  "207900",
  "207913",
  "361148",
  "1877850",
  "2210870",
  "915266",
  "3973107",
  "2202791",
  "1796122",
  "2135331",
  "1165714",
  "961283",
  "2050305",
] as const;
export const PHASE11C3_V2_MANIFEST_PATH = "data/osm/alps/publication/phase11c3-v2-batch-100.json";

export const PHASE11C3_SELECTION_POLICY = [
  "unpublished-only-at-locked-eighteen-route-baseline",
  "routeType=hiking-only",
  "summit_route-role-only",
  "VISUALLY_APPROVED-only",
  "EXACT_MOUNTAIN_MATCH-only",
  "CONFIRMED-summit-only",
  "manualReviewRequired=false",
  "warning-reviewed-warning-audit-and-topology-warning-free-only",
  "no-conflicting-technical-activity-evidence",
  "SIMPLE-topology-first",
  "quality-desc",
  "ordinary-hiking-evidence-strength-desc",
  "source-evidence-surface-length-asc",
  "numeric-canonical-relation-id-asc",
] as const;

export interface Phase11C3CandidatePoolRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  stagingRouteId: string;
  mountainId: number;
  routeName: string;
  semanticType: string;
  routeType: "hiking";
  activityCanonicalJson: string;
  activityClassificationHash: string;
  sourceEvidenceHash: string;
  candidateContentHash: string;
  candidateManifestHash: string;
  stagingPayloadHash: string;
  targetPayloadHash: string;
  geometryHash: string;
  qaHistoryHash: string;
  qaDecisionVersion: number;
  publicationIdempotencyKey: string;
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
  topologyClassification: PublicationCandidateRecord["topology"]["classification"];
  quality: number;
}

export interface Phase11C3ScaleReadiness {
  schemaVersion: 1;
  artifactType: "PHASE11C3_SCALE_READINESS";
  generatedAt: string;
  baselineSnapshot: Phase11C3BaselineSnapshot;
  candidatePool: {
    totalStagingRoutes: number;
    totalReviewedRoutes: number;
    totalVisuallyApproved: number;
    totalCandidates: number;
    currentActive: number;
    eligibleNonActive: number;
    blockedCandidates: number;
    warningCandidates: number;
    manualReviewRequired: number;
    topologyDistribution: Record<string, number>;
    semanticTypeDistribution: Record<string, number>;
    routeTypeDistribution: Record<string, number>;
    exactMountainMatchCount: number;
    confirmedSummitCount: number;
    duplicateSourceUrlConflicts: number;
    existingPublicationConflicts: number;
    additionalApprovalsNeededForTarget: number;
    status: "SUFFICIENT_ELIGIBLE_CANDIDATES" | "INSUFFICIENT_ELIGIBLE_CANDIDATES";
  };
  qaExpansionQueue: Phase11C3QAExpansionRecord[];
  deterministicReadinessHash: string;
}

export interface Phase11C3BaselineSnapshot {
  baselineActiveCount: number;
  baselineV1Count: number;
  baselineV2Count: number;
  baselineRelationIds: string[];
  baselinePublicationIdempotencyKeys: string[];
  baselineHash: string;
}

export interface Phase11C3QAExpansionRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  stagingRouteId: string;
  mountainId: number;
  routeName: string;
  quality: number;
  topologyClassification: string;
  semanticType: string;
  routeType: string;
  blockers: string[];
  warnings: string[];
  priorityScore: number;
  reasonForBlock: string | null;
}

function candidateWarnings(candidate: PublicationCandidateRecord): string[] {
  return [
    ...candidate.warningState.activeFlags,
    ...candidate.warningState.reviewedFlags,
    ...candidate.auditFlags,
    ...(candidate.topology.endpointSelectionWarning
      ? [candidate.topology.endpointSelectionWarning]
      : []),
  ];
}

function ordinaryHikingEvidenceStrength(route: ClassifiableRoute): number {
  const tags = route.metadata.tags ?? {};
  let score = 0;
  if (route.metadata.route === "hiking" || tags.route === "hiking") score += 8;
  if (route.metadata.route === "foot" || tags.route === "foot") score += 7;
  if (tags.sac_scale === "hiking") score += 6;
  if (tags.sac_scale === "mountain_hiking") score += 5;
  if (route.network === "lwn" || route.network === "rwn") score += 4;
  if (route.network === "nwn" || route.network === "iwn") score += 2;
  if (tags.highway === "path") score += 1;
  return score;
}

function sourceEvidenceSurfaceLength(
  route: ClassifiableRoute,
  activity: ActivityClassificationSnapshot,
): number {
  return stableJson({
    name: route.name,
    ref: route.ref,
    network: route.network,
    operator: route.operator,
    route: route.metadata.route,
    from: route.metadata.from,
    to: route.metadata.to,
    osmcSymbol: route.metadata.osmcSymbol,
    tags: route.metadata.tags ?? {},
    classifierEvidence: activity.evidence,
  }).length;
}

function computePriorityScore(input: {
  candidate: PublicationCandidateRecord;
  route: ClassifiableRoute;
  activity: ActivityClassificationSnapshot;
}): number {
  const { candidate, route, activity } = input;
  let score = 0;
  score += candidate.qualityScore * 10;
  score += (candidate.topology.classification === "SIMPLE" ? 1000 : 0);
  score += (candidate.warningState.activeFlags.length === 0 && candidate.warningState.reviewedFlags.length === 0 && candidate.auditFlags.length === 0 && candidate.topology.endpointSelectionWarning === null) ? 500 : 0;
  score += ordinaryHikingEvidenceStrength(route) * 5;
  score += (activity.confidence * 100);
  score -= sourceEvidenceSurfaceLength(route, activity) / 100;
  return Math.round(score);
}

export async function buildPhase11C3ScaleReadiness(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  qaHistory: Phase10QaHistoryRow[];
  routes: Map<string, ClassifiableRoute>;
  activeRows: Array<{ canonical_relation_id: string; publication_contract_version: string; publication_idempotency_key: string }>;
}): Promise<Phase11C3ScaleReadiness> {
  const generatedAt = new Date().toISOString();

  const baselineV1 = input.activeRows.filter(r => r.publication_contract_version === "mountain-tracker-osm-publication/v1");
  const baselineV2 = input.activeRows.filter(r => r.publication_contract_version === "mountain-tracker-osm-publication/v2");
  const baselineRelationIds = input.activeRows.map(r => r.canonical_relation_id).sort((a, b) => Number(a) - Number(b));
  const baselinePublicationIdempotencyKeys = input.activeRows.map(r => r.publication_idempotency_key).sort();

  const baselineSnapshot: Phase11C3BaselineSnapshot = {
    baselineActiveCount: input.activeRows.length,
    baselineV1Count: baselineV1.length,
    baselineV2Count: baselineV2.length,
    baselineRelationIds,
    baselinePublicationIdempotencyKeys,
    baselineHash: sha256Stable({
      activeCount: input.activeRows.length,
      v1Count: baselineV1.length,
      v2Count: baselineV2.length,
      relationIds: baselineRelationIds,
      idempotencyKeys: baselinePublicationIdempotencyKeys,
    }),
  };

  const activeRelationIds = new Set(input.activeRows.map(r => r.canonical_relation_id));
  const allCandidates = input.artifact.candidates;
  const routes = input.routes;

  const topologyDist: Record<string, number> = {};
  const semanticTypeDist: Record<string, number> = {};
  const routeTypeDist: Record<string, number> = {};
  let exactMountainMatchCount = 0;
  let confirmedSummitCount = 0;
  let duplicateSourceUrlConflicts = 0;
  let existingPublicationConflicts = 0;
  let manualReviewRequired = 0;
  let warningCandidates = 0;
  let blockedCandidates = 0;
  let eligibleNonActive = 0;

  const qaExpansionRecords: Phase11C3QAExpansionRecord[] = [];
  const candidatePoolRecords: Phase11C3CandidatePoolRecord[] = [];

  for (const candidate of allCandidates) {
    const route = routes.get(candidate.sourceRelationId);
    if (!route) continue;

    const activity = createActivityClassificationSnapshot({ candidate, route });
    const failures = phase11C2EligibilityFailures({ candidate, route, activeRelationIds });
    const warnings = candidateWarnings(candidate);

    const topology = candidate.topology.classification;
    topologyDist[topology] = (topologyDist[topology] || 0) + 1;
    semanticTypeDist[candidate.semanticType] = (semanticTypeDist[candidate.semanticType] || 0) + 1;
    routeTypeDist[activity.routeType] = (routeTypeDist[activity.routeType] || 0) + 1;

    if (candidate.summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH") exactMountainMatchCount++;
    if (candidate.summit.associationClassification === "CONFIRMED") confirmedSummitCount++;
    if (candidate.provenance.sourceUrl && input.artifact.candidates.some(c => c !== candidate && c.provenance.sourceUrl === candidate.provenance.sourceUrl)) {
      duplicateSourceUrlConflicts++;
    }
    if (activeRelationIds.has(candidate.canonicalRouteSourceId)) {
      existingPublicationConflicts++;
    }
    if (activity.manualReviewRequired) manualReviewRequired++;
    if (warnings.length > 0) warningCandidates++;

    const priorityScore = computePriorityScore({ candidate, route, activity });

    let reasonForBlock: string | null = null;

    if (failures.length > 0) {
      blockedCandidates++;
      reasonForBlock = failures.join("; ");
    } else if (activeRelationIds.has(candidate.canonicalRouteSourceId)) {
      reasonForBlock = "ALREADY_ACTIVE";
    } else {
      eligibleNonActive++;
      candidatePoolRecords.push({
        sourceRelationId: candidate.sourceRelationId,
        canonicalRouteSourceId: candidate.canonicalRouteSourceId,
        stagingRouteId: candidate.stagingRouteId,
        mountainId: candidate.summit.mountainId,
        routeName: candidate.routeName!.trim(),
        semanticType: candidate.semanticType,
        routeType: "hiking",
        activityCanonicalJson: stableJson(activity),
        activityClassificationHash: sha256Stable(activity),
        sourceEvidenceHash: activity.sourceEvidenceHash,
        candidateContentHash: candidate.candidateContentHash,
        candidateManifestHash: input.candidateManifest.overallDeterministicManifestHash,
        stagingPayloadHash: candidate.payloadHash,
        targetPayloadHash: sha256Stable(mapMountainRouteV2(candidate, activity)),
        geometryHash: sha256Stable(candidate.originalGeometry),
        qaHistoryHash: (() => {
          const snapshot = input.qaHistory
            .filter((event) => event.stagingRouteId === candidate.stagingRouteId)
            .sort((left, right) => left.decisionVersion - right.decisionVersion || left.id - right.id);
          return sha256Stable(snapshot);
        })(),
        qaDecisionVersion: candidate.qaDecision.version,
        publicationIdempotencyKey: `${candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT_V2}`,
        publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
        topologyClassification: candidate.topology.classification,
        quality: candidate.qualityScore,
      });
    }

    qaExpansionRecords.push({
      sourceRelationId: candidate.sourceRelationId,
      canonicalRouteSourceId: candidate.canonicalRouteSourceId,
      stagingRouteId: candidate.stagingRouteId,
      mountainId: candidate.summit.mountainId,
      routeName: candidate.routeName ?? "",
      quality: candidate.qualityScore,
      topologyClassification: candidate.topology.classification,
      semanticType: candidate.semanticType,
      routeType: activity.routeType,
      blockers: failures,
      warnings,
      priorityScore,
      reasonForBlock,
    });
  }

  qaExpansionRecords.sort((a, b) => b.priorityScore - a.priorityScore);

  const additionalApprovalsNeededForTarget = Math.max(0, PHASE11C3_TARGET_BATCH_SIZE - eligibleNonActive);

  const candidatePoolStatus = (eligibleNonActive >= PHASE11C3_TARGET_BATCH_SIZE
    ? "SUFFICIENT_ELIGIBLE_CANDIDATES"
    : "INSUFFICIENT_ELIGIBLE_CANDIDATES") as "SUFFICIENT_ELIGIBLE_CANDIDATES" | "INSUFFICIENT_ELIGIBLE_CANDIDATES";

  const candidatePool = {
    totalStagingRoutes: allCandidates.length,
    totalReviewedRoutes: input.artifact.totalReviewedRoutes,
    totalVisuallyApproved: input.artifact.qaProgress.visuallyApproved,
    totalCandidates: input.artifact.candidateCount,
    currentActive: input.activeRows.length,
    eligibleNonActive,
    blockedCandidates,
    warningCandidates,
    manualReviewRequired,
    topologyDistribution: topologyDist,
    semanticTypeDistribution: semanticTypeDist,
    routeTypeDistribution: routeTypeDist,
    exactMountainMatchCount,
    confirmedSummitCount,
    duplicateSourceUrlConflicts,
    existingPublicationConflicts,
    additionalApprovalsNeededForTarget,
    status: candidatePoolStatus,
  };

  const qaExpansionQueue = qaExpansionRecords.slice(0, PHASE11C3_QA_EXPANSION_POOL_SIZE);

  const readinessContent = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C3_SCALE_READINESS" as const,
    generatedAt,
    baselineSnapshot,
    candidatePool,
    qaExpansionQueue,
  };

  const deterministicReadinessHash = sha256Stable(readinessContent);

  return {
    ...readinessContent,
    deterministicReadinessHash,
  };
}

export interface Phase11C3EligibleCandidate {
  candidate: PublicationCandidateRecord;
  route: ClassifiableRoute;
  activity: ActivityClassificationSnapshot;
  ordinaryHikingEvidenceStrength: number;
  sourceEvidenceSurfaceLength: number;
}

export function selectPhase11C3EligibleCandidates(input: {
  artifact: PublicationCandidateArtifact;
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
}): Phase11C3EligibleCandidate[] {
  return input.artifact.candidates.flatMap((candidate) => {
    const route = input.routes.get(candidate.sourceRelationId);
    if (!route) return [];
    const failures = phase11C2EligibilityFailures({ candidate, route, activeRelationIds: input.activeRelationIds });
    if (failures.length > 0) return [];
    const activity = createActivityClassificationSnapshot({ candidate, route });
    if (activity.routeType !== "hiking") return [];
    return [{
      candidate,
      route,
      activity,
      ordinaryHikingEvidenceStrength: ordinaryHikingEvidenceStrength(route),
      sourceEvidenceSurfaceLength: sourceEvidenceSurfaceLength(route, activity),
    }];
  }).sort((left, right) =>
    Number(right.candidate.topology.classification === "SIMPLE") -
      Number(left.candidate.topology.classification === "SIMPLE") ||
    right.candidate.qualityScore - left.candidate.qualityScore ||
    right.ordinaryHikingEvidenceStrength - left.ordinaryHikingEvidenceStrength ||
    left.sourceEvidenceSurfaceLength - right.sourceEvidenceSurfaceLength ||
    Number(left.candidate.canonicalRouteSourceId) -
      Number(right.candidate.canonicalRouteSourceId)
  );
}

export function createPhase11C3LockedBatchManifest(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  qaHistory: Phase10QaHistoryRow[];
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
  targetBatchSize: number;
  baselineSnapshot: Phase11C3BaselineSnapshot;
}): { manifest: Phase11C3LockedBatchManifest; poolSize: number } {
  const eligible = selectPhase11C3EligibleCandidates(input);

  if (eligible.length < input.targetBatchSize) {
    throw new Error(`PHASE11C3_REQUIRES_${input.targetBatchSize}_ELIGIBLE_HIKING_ROUTES:${eligible.length}`);
  }

  const selected = eligible.slice(0, input.targetBatchSize);
  if (selected.some((value) => value.candidate.topology.classification !== "SIMPLE")) {
    throw new Error("PHASE11C3_NON_SIMPLE_ROUTE_SELECTED");
  }

  const records = selected.map(({ candidate, activity }) => {
    const target = mapMountainRouteV2(candidate, activity);
    return {
      sourceRelationId: candidate.sourceRelationId,
      canonicalRouteSourceId: candidate.canonicalRouteSourceId,
      stagingRouteId: candidate.stagingRouteId,
      mountainId: candidate.summit.mountainId,
      routeName: candidate.routeName!.trim(),
      semanticType: candidate.semanticType,
      routeType: "hiking" as const,
      activityCanonicalJson: stableJson(activity),
      activityClassificationHash: sha256Stable(activity),
      sourceEvidenceHash: activity.sourceEvidenceHash,
      candidateContentHash: candidate.candidateContentHash,
      candidateManifestHash: input.candidateManifest.overallDeterministicManifestHash,
      stagingPayloadHash: candidate.payloadHash,
      targetPayloadHash: sha256Stable(target),
      geometryHash: sha256Stable(candidate.originalGeometry),
      qaHistoryHash: (() => {
        const snapshot = input.qaHistory
          .filter((event) => event.stagingRouteId === candidate.stagingRouteId)
          .sort((left, right) => left.decisionVersion - right.decisionVersion || left.id - right.id);
        return sha256Stable(snapshot);
      })(),
      qaDecisionVersion: candidate.qaDecision.version,
      publicationIdempotencyKey:
        `${candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT_V2}`,
      publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
      topologyClassification: candidate.topology.classification,
      quality: candidate.qualityScore,
    };
  });

  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C3_V2_BATCH_100_MANIFEST" as const,
    publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
    exactCandidateCount: PHASE11C3_TARGET_BATCH_SIZE,
    phase10CandidateSetContentHash: input.artifact.deterministicContentHash,
    phase10CandidateManifestHash: input.candidateManifest.overallDeterministicManifestHash,
    baselineSnapshot: input.baselineSnapshot,
    selectionPolicy: PHASE11C3_SELECTION_POLICY,
    records,
  };

  const manifest = { ...content, deterministicV2ManifestHash: sha256Stable(content) };

  return { manifest, poolSize: eligible.length };
}

export interface Phase11C3LockedBatchManifest extends LockedPublicationManifestV2 {
  schemaVersion: 1;
  artifactType: "PHASE11C3_V2_BATCH_100_MANIFEST";
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
  exactCandidateCount: typeof PHASE11C3_TARGET_BATCH_SIZE;
  phase10CandidateSetContentHash: string;
  phase10CandidateManifestHash: string;
  baselineSnapshot: Phase11C3BaselineSnapshot;
  selectionPolicy: typeof PHASE11C3_SELECTION_POLICY;
  records: Phase11C3CandidatePoolRecord[];
}

export function verifyPhase11C3LockedBatchManifest(input: {
  provided: Phase11C3LockedBatchManifest;
  expected: Phase11C3LockedBatchManifest;
}): void {
  const { deterministicV2ManifestHash, ...content } = input.provided;
  if (sha256Stable(content) !== deterministicV2ManifestHash) {
    throw new Error("PHASE11C3_V2_MANIFEST_HASH_DRIFT");
  }
  const records = input.provided.records;
  if (
    records.length !== PHASE11C3_TARGET_BATCH_SIZE ||
    input.provided.exactCandidateCount !== PHASE11C3_TARGET_BATCH_SIZE ||
    new Set(records.map((record) => record.stagingRouteId)).size !== PHASE11C3_TARGET_BATCH_SIZE ||
    new Set(records.map((record) => record.canonicalRouteSourceId)).size !== PHASE11C3_TARGET_BATCH_SIZE ||
    records.some((record) =>
      record.publicationContractVersion !== PHASE11_PUBLICATION_CONTRACT_V2 ||
      record.routeType !== "hiking" ||
      record.topologyClassification !== "SIMPLE" ||
      record.candidateManifestHash !== input.provided.phase10CandidateManifestHash
    )
  ) {
    throw new Error("PHASE11C3_REQUIRES_EXACTLY_HUNDRED_UNIQUE_SIMPLE_HIKING_CANDIDATES");
  }
  if (stableJson(input.provided) !== stableJson(input.expected)) {
    throw new Error("PHASE11C3_V2_MANIFEST_CONTENT_DRIFT");
  }
}

export type Phase11C3CliArguments = {
  execute: boolean;
  manifestPath: string;
  confirmation: string | null;
};

export function parsePhase11C3CliArguments(argv: string[]): Phase11C3CliArguments {
  let execute = false;
  let manifestPath = "data/osm/alps/publication/phase11c3-v2-batch-100.json";
  let confirmation: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") execute = true;
    else if (value === "--manifest") manifestPath = resolve(argv[++index] ?? "");
    else if (value === "--confirm-relations") confirmation = argv[++index] ?? null;
    else throw new Error(`UNKNOWN_ARGUMENT:${value}`);
  }
  return { execute, manifestPath, confirmation };
}

export function requirePhase11C3ExecutionAuthorization(input: {
  cli: Phase11C3CliArguments;
  manifest: Phase11C3LockedBatchManifest;
}): void {
  if (!input.cli.execute) return;
  if (input.cli.manifestPath !== resolve("data/osm/alps/publication/phase11c3-v2-batch-100.json")) {
    throw new Error("EXECUTE_REQUIRES_LOCKED_PHASE11C3_MANIFEST");
  }
  const expectedConfirmation = input.manifest.records
    .map((record) => record.canonicalRouteSourceId)
    .join(",");
  if (input.cli.confirmation !== expectedConfirmation) {
    throw new Error(`EXECUTE_REQUIRES_CONFIRM_RELATIONS:${expectedConfirmation}`);
  }
}

export function decidePhase11C3ExistingPublicationAction(input: {
  relatedActiveCount: number;
  exactV2IdentityMatch: boolean;
}): "WOULD_CREATE" | "RESUME_MATCH" | "BLOCKED" {
  if (input.relatedActiveCount === 0) return "WOULD_CREATE";
  if (input.relatedActiveCount === 1 && input.exactV2IdentityMatch) {
    return "RESUME_MATCH";
  }
  return "BLOCKED";
}

type ActiveRowFull = {
  publication_contract_version: string;
  publication_status: string;
  publication_idempotency_key: string;
  staging_payload_hash: string;
  candidate_content_hash: string;
  candidate_set_content_hash: string;
  candidate_manifest_hash: string;
  dataset_fingerprint: string;
  geometry_hash: string;
  qa_decision_version: number;
  qa_history_hash: string;
  target_payload_hash: string;
  activity_classification_hash: string | null;
  activity_classification: unknown | null;
};

type RequestWithProvenance = {
  provenancePayload: {
    publication_idempotency_key: string;
    staging_payload_hash: string;
    candidate_content_hash: string;
    candidate_set_content_hash: string;
    candidate_manifest_hash: string;
    dataset_fingerprint: string;
    geometry_hash: string;
    qa_decision_version: number;
    qa_history_hash: string;
    target_payload_hash: string;
    activity_classification_hash: string;
    activity_classification: unknown;
  };
};

export function v2IdentityMatchesFull(row: ActiveRowFull, request: RequestWithProvenance): boolean {
  const expected = request.provenancePayload;
  return row.publication_contract_version === PHASE11_PUBLICATION_CONTRACT_V2 &&
    row.publication_status === "ACTIVE" &&
    row.publication_idempotency_key === expected.publication_idempotency_key &&
    row.staging_payload_hash === expected.staging_payload_hash &&
    row.candidate_content_hash === expected.candidate_content_hash &&
    row.candidate_set_content_hash === expected.candidate_set_content_hash &&
    row.candidate_manifest_hash === expected.candidate_manifest_hash &&
    row.dataset_fingerprint === expected.dataset_fingerprint &&
    row.geometry_hash === expected.geometry_hash &&
    row.qa_decision_version === expected.qa_decision_version &&
    row.qa_history_hash === expected.qa_history_hash &&
    row.target_payload_hash === expected.target_payload_hash &&
    row.activity_classification_hash === expected.activity_classification_hash &&
    stableJson(row.activity_classification) === stableJson(expected.activity_classification);
}
