import {
  stableJson,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
  type PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import {
  createActivityClassificationSnapshot,
  mapMountainRouteV2,
  PHASE11_PUBLICATION_CONTRACT_V2,
  type LockedPublicationManifestV2,
} from "./phase11-publication-v2.ts";
import { sha256Stable } from "./phase11-publication.ts";
import type { MountainRouteType } from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

export const PHASE11C2A_CANARY_SIZE = 2 as const;
export const PHASE11C2A_MANIFEST_NAME = "phase11c2a-v2-canary.json";
export const PHASE11C2A_FERRATA_ALLOWLIST = ["140270", "1138510", "1864752"] as const;
export const PHASE11C2A_SELECTION_POLICY = [
  "unpublished-only",
  "VISUALLY_APPROVED-only",
  "EXACT_MOUNTAIN_MATCH-only",
  "CONFIRMED-summit-only",
  "warning-and-audit-free-only",
  "manualReviewRequired=false",
  "one-hiking-and-one-via_ferrata",
  "SIMPLE-topology-first",
  "quality-desc",
  "numeric-canonical-relation-id-asc",
] as const;

export interface Phase11C2ACanaryRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  stagingRouteId: string;
  mountainId: number;
  routeName: string;
  semanticType: string;
  routeType: MountainRouteType;
  activityCanonicalJson: string;
  activityClassificationHash: string;
  sourceEvidenceHash: string;
  candidateContentHash: string;
  stagingPayloadHash: string;
  targetPayloadHash: string;
  geometryHash: string;
  qaDecisionVersion: number;
  publicationIdempotencyKey: string;
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
}

export interface Phase11C2ACanaryManifest extends LockedPublicationManifestV2 {
  schemaVersion: 1;
  artifactType: "PHASE11C2A_V2_CANARY_MANIFEST";
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
  exactCandidateCount: typeof PHASE11C2A_CANARY_SIZE;
  phase10CandidateSetContentHash: string;
  phase10CandidateManifestHash: string;
  excludedActiveRelationIds: string[];
  selectionPolicy: typeof PHASE11C2A_SELECTION_POLICY;
  records: Phase11C2ACanaryRecord[];
}

function hasNoWarnings(candidate: PublicationCandidateRecord): boolean {
  return candidate.warningState.activeFlags.length === 0 &&
    candidate.warningState.reviewedFlags.length === 0 &&
    candidate.auditFlags.length === 0 &&
    candidate.topology.endpointSelectionWarning === null;
}

function baseEligible(candidate: PublicationCandidateRecord, active: Set<string>): boolean {
  return !active.has(candidate.canonicalRouteSourceId) &&
    candidate.qaDecision.status === "VISUALLY_APPROVED" &&
    candidate.semanticType === "summit_route" &&
    candidate.summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH" &&
    candidate.summit.associationClassification === "CONFIRMED" &&
    Boolean(candidate.routeName?.trim()) &&
    hasNoWarnings(candidate);
}

function riskOrder(left: PublicationCandidateRecord, right: PublicationCandidateRecord): number {
  return Number(right.topology.classification === "SIMPLE") -
      Number(left.topology.classification === "SIMPLE") ||
    right.qualityScore - left.qualityScore ||
    Number(left.canonicalRouteSourceId) - Number(right.canonicalRouteSourceId);
}

export function selectPhase11C2ACanary(input: {
  artifact: PublicationCandidateArtifact;
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
}): Array<{ candidate: PublicationCandidateRecord; route: ClassifiableRoute }> {
  const eligible = input.artifact.candidates.flatMap((candidate) => {
    if (!baseEligible(candidate, input.activeRelationIds)) return [];
    const route = input.routes.get(candidate.sourceRelationId);
    if (!route) throw new Error(`RAW_ROUTE_MISSING:${candidate.sourceRelationId}`);
    const activity = createActivityClassificationSnapshot({ candidate, route });
    if (activity.manualReviewRequired) return [];
    return [{ candidate, route, activity }];
  });
  const hiking = eligible
    .filter((value) => value.activity.routeType === "hiking")
    .sort((left, right) => riskOrder(left.candidate, right.candidate))[0];
  const ferrata = eligible
    .filter((value) =>
      value.activity.routeType === "via_ferrata" &&
      PHASE11C2A_FERRATA_ALLOWLIST.some((id) => id === value.candidate.canonicalRouteSourceId),
    )
    .sort((left, right) => riskOrder(left.candidate, right.candidate))[0];
  if (!hiking || !ferrata) throw new Error("PHASE11C2A_EXACT_CANARY_PAIR_UNAVAILABLE");
  return [hiking, ferrata];
}

export function createPhase11C2ACanaryManifest(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  routes: Map<string, ClassifiableRoute>;
  activeRelationIds: Set<string>;
}): Phase11C2ACanaryManifest {
  const records = selectPhase11C2ACanary(input).map(({ candidate, route }) => {
    const activity = createActivityClassificationSnapshot({ candidate, route });
    const target = mapMountainRouteV2(candidate, activity);
    return {
      sourceRelationId: candidate.sourceRelationId,
      canonicalRouteSourceId: candidate.canonicalRouteSourceId,
      stagingRouteId: candidate.stagingRouteId,
      mountainId: candidate.summit.mountainId,
      routeName: candidate.routeName!.trim(),
      semanticType: candidate.semanticType,
      routeType: activity.routeType,
      activityCanonicalJson: stableJson(activity),
      activityClassificationHash: sha256Stable(activity),
      sourceEvidenceHash: activity.sourceEvidenceHash,
      candidateContentHash: candidate.candidateContentHash,
      stagingPayloadHash: candidate.payloadHash,
      targetPayloadHash: sha256Stable(target),
      geometryHash: sha256Stable(candidate.originalGeometry),
      qaDecisionVersion: candidate.qaDecision.version,
      publicationIdempotencyKey:
        `${candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT_V2}`,
      publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
    };
  });
  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C2A_V2_CANARY_MANIFEST" as const,
    publicationContractVersion: PHASE11_PUBLICATION_CONTRACT_V2,
    exactCandidateCount: PHASE11C2A_CANARY_SIZE,
    phase10CandidateSetContentHash: input.artifact.deterministicContentHash,
    phase10CandidateManifestHash:
      input.candidateManifest.overallDeterministicManifestHash,
    excludedActiveRelationIds: [...input.activeRelationIds].sort(
      (left, right) => Number(left) - Number(right),
    ),
    selectionPolicy: PHASE11C2A_SELECTION_POLICY,
    records,
  };
  return { ...content, deterministicV2ManifestHash: sha256Stable(content) };
}

export function verifyPhase11C2ACanaryManifest(input: {
  provided: Phase11C2ACanaryManifest;
  expected: Phase11C2ACanaryManifest;
}): void {
  const { deterministicV2ManifestHash, ...content } = input.provided;
  if (sha256Stable(content) !== deterministicV2ManifestHash) {
    throw new Error("PHASE11C2A_MANIFEST_HASH_DRIFT");
  }
  if (
    input.provided.records.length !== PHASE11C2A_CANARY_SIZE ||
    input.provided.exactCandidateCount !== PHASE11C2A_CANARY_SIZE ||
    new Set(input.provided.records.map((record) => record.stagingRouteId)).size !==
      PHASE11C2A_CANARY_SIZE
  ) {
    throw new Error("PHASE11C2A_REQUIRES_EXACTLY_TWO_UNIQUE_CANDIDATES");
  }
  if (stableJson(input.provided) !== stableJson(input.expected)) {
    throw new Error("PHASE11C2A_MANIFEST_CONTENT_DRIFT");
  }
}
