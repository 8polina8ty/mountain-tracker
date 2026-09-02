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

export const PHASE11C2_V2_BATCH_SIZE = 10 as const;
export const PHASE11C2_V2_MANIFEST_NAME = "phase11c2-v2-batch-10.json";
export const PHASE11C2_V2_MANIFEST_PATH =
  `data/osm/alps/publication/${PHASE11C2_V2_MANIFEST_NAME}`;
export const PHASE11C2_BASELINE_ACTIVE_RELATION_IDS = [
  "20916",
  "33528",
  "140270",
  "196164",
  "199145",
  "207900",
  "207913",
  "361148",
] as const;
export const PHASE11C2_V2_SELECTION_POLICY = [
  "unpublished-only-at-locked-eight-route-baseline",
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

export interface Phase11C2V2BatchRecord {
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

export interface Phase11C2V2BatchManifest extends LockedPublicationManifestV2 {
  schemaVersion: 1;
  artifactType: "PHASE11C2_V2_BATCH_10_MANIFEST";
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
  exactCandidateCount: typeof PHASE11C2_V2_BATCH_SIZE;
  phase10CandidateSetContentHash: string;
  phase10CandidateManifestHash: string;
  baselineActiveRelationIds: string[];
  selectionPolicy: typeof PHASE11C2_V2_SELECTION_POLICY;
  records: Phase11C2V2BatchRecord[];
}

export interface Phase11C2SelectedCandidate {
  candidate: PublicationCandidateRecord;
  route: ClassifiableRoute;
  activity: ActivityClassificationSnapshot;
  ordinaryHikingEvidenceStrength: number;
  sourceEvidenceSurfaceLength: number;
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

export function ordinaryHikingEvidenceStrength(route: ClassifiableRoute): number {
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

export function phase11C2EligibilityFailures(input: {
  candidate: PublicationCandidateRecord;
  route: ClassifiableRoute;
  activeRelationIds: Set<string>;
}): string[] {
  const { candidate, route } = input;
  const failures: string[] = [];
  if (input.activeRelationIds.has(candidate.canonicalRouteSourceId)) failures.push("ALREADY_ACTIVE");
  if (candidate.qaDecision.status !== "VISUALLY_APPROVED") failures.push("QA_NOT_APPROVED");
  if (candidate.semanticType !== "summit_route") failures.push("UNSUPPORTED_SEMANTIC_TYPE");
  if (candidate.summit.mountainMatchClassification !== "EXACT_MOUNTAIN_MATCH") failures.push("MOUNTAIN_MATCH_NOT_EXACT");
  if (candidate.summit.associationClassification !== "CONFIRMED") failures.push("SUMMIT_NOT_CONFIRMED");
  if (!candidate.routeName?.trim()) failures.push("ROUTE_NAME_MISSING");
  if (candidateWarnings(candidate).length > 0) failures.push("WARNING_OR_AUDIT_EVIDENCE");
  if (route.sourceId !== candidate.sourceRelationId) failures.push("SOURCE_ID_DRIFT");

  const activity = createActivityClassificationSnapshot({ candidate, route });
  if (activity.routeType !== "hiking") failures.push(`ROUTE_TYPE_${activity.routeType.toUpperCase()}`);
  if (activity.manualReviewRequired) failures.push("ACTIVITY_MANUAL_REVIEW_REQUIRED");
  if (activity.conflictingTypes.length > 0) failures.push("ACTIVITY_CONFLICT");
  if (activity.evidence.length === 0 || activity.confidence <= 0) failures.push("ACTIVITY_EVIDENCE_INVALID");
  if (!/^[0-9a-f]{64}$/.test(activity.sourceEvidenceHash)) failures.push("SOURCE_EVIDENCE_HASH_INVALID");
  if (failures.length === 0 && mapMountainRouteV2(candidate, activity).route_type !== "hiking") {
    failures.push("TARGET_ROUTE_TYPE_NOT_HIKING");
  }
  return failures;
}

export function selectPhase11C2V2Batch(input: {
  artifact: PublicationCandidateArtifact;
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
}): Phase11C2SelectedCandidate[] {
  const eligible = input.artifact.candidates.flatMap((candidate) => {
    const route = input.routes.get(candidate.sourceRelationId);
    if (!route) throw new Error(`RAW_ROUTE_MISSING:${candidate.sourceRelationId}`);
    if (phase11C2EligibilityFailures({ candidate, route, activeRelationIds: input.activeRelationIds }).length > 0) {
      return [];
    }
    const activity = createActivityClassificationSnapshot({ candidate, route });
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
  if (eligible.length < PHASE11C2_V2_BATCH_SIZE) {
    throw new Error(`PHASE11C2_REQUIRES_TEN_ELIGIBLE_HIKING_ROUTES:${eligible.length}`);
  }
  const selected = eligible.slice(0, PHASE11C2_V2_BATCH_SIZE);
  if (selected.some((value) => value.candidate.topology.classification !== "SIMPLE")) {
    throw new Error("PHASE11C2_NON_SIMPLE_ROUTE_SELECTED");
  }
  return selected;
}

function qaHistoryHash(
  candidate: PublicationCandidateRecord,
  qaHistory: Phase10QaHistoryRow[],
): string {
  const snapshot = qaHistory
    .filter((event) => event.stagingRouteId === candidate.stagingRouteId)
    .sort((left, right) =>
      left.decisionVersion - right.decisionVersion || left.id - right.id,
    );
  return sha256Stable(snapshot);
}

export function createPhase11C2V2BatchManifest(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  qaHistory: Phase10QaHistoryRow[];
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
}): Phase11C2V2BatchManifest {
  const records = selectPhase11C2V2Batch(input).map(({ candidate, activity }) => {
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
      qaHistoryHash: qaHistoryHash(candidate, input.qaHistory),
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
    artifactType: "PHASE11C2_V2_BATCH_10_MANIFEST" as const,
    publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
    exactCandidateCount: PHASE11C2_V2_BATCH_SIZE,
    phase10CandidateSetContentHash: input.artifact.deterministicContentHash,
    phase10CandidateManifestHash:
      input.candidateManifest.overallDeterministicManifestHash,
    baselineActiveRelationIds: [...input.activeRelationIds].sort(
      (left, right) => Number(left) - Number(right),
    ),
    selectionPolicy: PHASE11C2_V2_SELECTION_POLICY,
    records,
  };
  return { ...content, deterministicV2ManifestHash: sha256Stable(content) };
}

export function verifyPhase11C2V2BatchManifest(input: {
  provided: Phase11C2V2BatchManifest;
  expected: Phase11C2V2BatchManifest;
}): void {
  const { deterministicV2ManifestHash, ...content } = input.provided;
  if (sha256Stable(content) !== deterministicV2ManifestHash) {
    throw new Error("PHASE11C2_V2_MANIFEST_HASH_DRIFT");
  }
  const records = input.provided.records;
  if (
    records.length !== PHASE11C2_V2_BATCH_SIZE ||
    input.provided.exactCandidateCount !== PHASE11C2_V2_BATCH_SIZE ||
    new Set(records.map((record) => record.stagingRouteId)).size !== PHASE11C2_V2_BATCH_SIZE ||
    new Set(records.map((record) => record.canonicalRouteSourceId)).size !== PHASE11C2_V2_BATCH_SIZE ||
    records.some((record) =>
      record.publicationContractVersion !== PHASE11_PUBLICATION_CONTRACT_V2 ||
      record.routeType !== "hiking" ||
      record.topologyClassification !== "SIMPLE" ||
      record.candidateManifestHash !== input.provided.phase10CandidateManifestHash
    )
  ) {
    throw new Error("PHASE11C2_REQUIRES_EXACTLY_TEN_UNIQUE_SIMPLE_HIKING_CANDIDATES");
  }
  if (stableJson(input.provided) !== stableJson(input.expected)) {
    throw new Error("PHASE11C2_V2_MANIFEST_CONTENT_DRIFT");
  }
}

export type Phase11C2CliArguments = {
  execute: boolean;
  manifestPath: string;
  confirmation: string | null;
};

export function parsePhase11C2CliArguments(argv: string[]): Phase11C2CliArguments {
  let execute = false;
  let manifestPath = resolve(PHASE11C2_V2_MANIFEST_PATH);
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

export function requirePhase11C2ExecutionAuthorization(input: {
  cli: Phase11C2CliArguments;
  manifest: Phase11C2V2BatchManifest;
}): void {
  if (!input.cli.execute) return;
  if (input.cli.manifestPath !== resolve(PHASE11C2_V2_MANIFEST_PATH)) {
    throw new Error("EXECUTE_REQUIRES_LOCKED_PHASE11C2_MANIFEST");
  }
  const expectedConfirmation = input.manifest.records
    .map((record) => record.canonicalRouteSourceId)
    .join(",");
  if (input.cli.confirmation !== expectedConfirmation) {
    throw new Error(`EXECUTE_REQUIRES_CONFIRM_RELATIONS:${expectedConfirmation}`);
  }
}

export function decidePhase11C2ExistingPublicationAction(input: {
  relatedActiveCount: number;
  exactV2IdentityMatch: boolean;
}): "WOULD_CREATE" | "UNCHANGED" | "BLOCKED" {
  if (input.relatedActiveCount === 0) return "WOULD_CREATE";
  if (input.relatedActiveCount === 1 && input.exactV2IdentityMatch) {
    return "UNCHANGED";
  }
  return "BLOCKED";
}
