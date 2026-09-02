import type {
  Phase10QaHistoryRow,
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
  PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import { stableJson } from "./phase10-publication-gate.ts";
import {
  classifyRouteActivity,
  type MountainRouteType,
  type RouteActivityClassification,
} from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import {
  createProvenancePayload,
  mapMountainRoute,
  PHASE11_PUBLICATION_CONTRACT,
  sha256Stable,
  type MountainRoutePayload,
  type PublicationProvenancePayload,
} from "./phase11-publication.ts";

export const PHASE11_PUBLICATION_CONTRACT_V2 =
  "mountain-tracker-osm-publication/v2" as const;

export interface ActivityClassificationSnapshot extends RouteActivityClassification {
  schemaVersion: 1;
  semanticType: string;
  sourceEvidenceHash: string;
}

export type MountainRoutePayloadV2 = Omit<MountainRoutePayload, "route_type"> & {
  route_type: MountainRouteType;
};

export type PublicationProvenancePayloadV2 = Omit<
  PublicationProvenancePayload,
  "publication_contract_version" | "publication_idempotency_key" | "target_payload_hash"
> & {
  publication_contract_version: typeof PHASE11_PUBLICATION_CONTRACT_V2;
  publication_idempotency_key: string;
  activity_classification: ActivityClassificationSnapshot;
  activity_classification_hash: string;
  target_payload_hash: string;
};

export interface Phase11PublicationRequestV2 {
  candidateCanonicalJson: string;
  candidateContentHash: string;
  manifestCanonicalJson: string;
  candidateManifestHash: string;
  mountainRouteCanonicalJson: string;
  geometryCanonicalJson: string;
  qaHistoryCanonicalJson: string;
  activityClassificationCanonicalJson: string;
  activityClassificationHash: string;
  mountainRoutePayload: MountainRoutePayloadV2;
  provenancePayload: PublicationProvenancePayloadV2;
}

export interface LockedPublicationManifestV2Record {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  stagingRouteId: string;
  mountainId: number;
  semanticType: string;
  routeType: MountainRouteType;
  activityCanonicalJson: string;
  activityClassificationHash: string;
  sourceEvidenceHash: string;
  stagingPayloadHash: string;
  candidateContentHash: string;
  targetPayloadHash: string;
  geometryHash: string;
  qaDecisionVersion: number;
  publicationIdempotencyKey: string;
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT_V2;
}

export interface LockedPublicationManifestV2 {
  deterministicV2ManifestHash: string;
  records: LockedPublicationManifestV2Record[];
}

function activityEvidencePayload(route: ClassifiableRoute): object {
  return {
    sourceId: route.sourceId,
    sourceUrl: route.sourceUrl,
    name: route.name,
    ref: route.ref,
    network: route.network,
    operator: route.operator,
    route: route.metadata.route,
    from: route.metadata.from,
    to: route.metadata.to,
    osmcSymbol: route.metadata.osmcSymbol,
    tags: route.metadata.tags ?? {},
  };
}

export function createActivityClassificationSnapshot(input: {
  candidate: PublicationCandidateRecord;
  route: ClassifiableRoute;
}): ActivityClassificationSnapshot {
  if (input.route.sourceId !== input.candidate.sourceRelationId) {
    throw new Error(`ACTIVITY_SOURCE_ID_DRIFT:${input.candidate.sourceRelationId}`);
  }
  const classification = classifyRouteActivity(input.route);
  return {
    schemaVersion: 1,
    semanticType: input.candidate.semanticType,
    ...classification,
    sourceEvidenceHash: sha256Stable(activityEvidencePayload(input.route)),
  };
}

export function mapMountainRouteV2(
  candidate: PublicationCandidateRecord,
  activity: ActivityClassificationSnapshot,
): MountainRoutePayloadV2 {
  if (activity.semanticType !== candidate.semanticType) {
    throw new Error(`ACTIVITY_ROLE_DRIFT:${candidate.sourceRelationId}`);
  }
  if (activity.manualReviewRequired) {
    throw new Error(`ACTIVITY_MANUAL_REVIEW_REQUIRED:${candidate.sourceRelationId}`);
  }
  return { ...mapMountainRoute(candidate), route_type: activity.routeType };
}

export function createProvenancePayloadV2(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  lockedManifest: LockedPublicationManifestV2;
  candidate: PublicationCandidateRecord;
  qaHistory: Phase10QaHistoryRow[];
  route: ClassifiableRoute;
}): PublicationProvenancePayloadV2 {
  const legacy = createProvenancePayload({ ...input, manifest: input.candidateManifest });
  if (legacy.publication_contract_version !== PHASE11_PUBLICATION_CONTRACT) {
    throw new Error("PHASE11_V1_BASE_CONTRACT_DRIFT");
  }
  const activity = createActivityClassificationSnapshot(input);
  const target = mapMountainRouteV2(input.candidate, activity);
  return {
    ...legacy,
    publication_contract_version: PHASE11_PUBLICATION_CONTRACT_V2,
    publication_idempotency_key: `${input.candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT_V2}`,
    candidate_manifest_hash: input.lockedManifest.deterministicV2ManifestHash,
    activity_classification: activity,
    activity_classification_hash: sha256Stable(activity),
    target_payload_hash: sha256Stable(target),
  };
}

export function buildPublicationRequestV2(input: {
  artifact: PublicationCandidateArtifact;
  candidateManifest: PublicationCandidateManifest;
  lockedManifest: LockedPublicationManifestV2;
  candidate: PublicationCandidateRecord;
  qaHistory: Phase10QaHistoryRow[];
  route: ClassifiableRoute;
}): Phase11PublicationRequestV2 {
  const { candidateContentHash, ...candidateContent } = input.candidate;
  const { deterministicV2ManifestHash, ...manifestContent } = input.lockedManifest;
  const provenancePayload = createProvenancePayloadV2(input);
  const mountainRoutePayload = mapMountainRouteV2(
    input.candidate,
    provenancePayload.activity_classification,
  );
  const record = input.lockedManifest.records.find(
    (value) => value.stagingRouteId === input.candidate.stagingRouteId,
  );
  if (
    !record ||
    record.activityCanonicalJson === undefined ||
    record.sourceRelationId !== input.candidate.sourceRelationId ||
    record.canonicalRouteSourceId !== input.candidate.canonicalRouteSourceId ||
    record.mountainId !== input.candidate.summit.mountainId ||
    record.semanticType !== input.candidate.semanticType ||
    record.routeType !== provenancePayload.activity_classification.routeType ||
    record.activityCanonicalJson !== stableJson(provenancePayload.activity_classification) ||
    record.activityClassificationHash !== provenancePayload.activity_classification_hash ||
    record.sourceEvidenceHash !== provenancePayload.activity_classification.sourceEvidenceHash ||
    record.stagingPayloadHash !== input.candidate.payloadHash ||
    record.candidateContentHash !== candidateContentHash ||
    record.targetPayloadHash !== provenancePayload.target_payload_hash ||
    record.geometryHash !== provenancePayload.geometry_hash ||
    record.qaDecisionVersion !== input.candidate.qaDecision.version ||
    record.publicationIdempotencyKey !== provenancePayload.publication_idempotency_key ||
    record.publicationContractVersion !== PHASE11_PUBLICATION_CONTRACT_V2
  ) {
    throw new Error(`V2_LOCKED_MANIFEST_MEMBERSHIP_FAILED:${input.candidate.sourceRelationId}`);
  }
  return {
    candidateCanonicalJson: stableJson(candidateContent),
    candidateContentHash,
    manifestCanonicalJson: stableJson(manifestContent),
    candidateManifestHash: deterministicV2ManifestHash,
    mountainRouteCanonicalJson: stableJson(mountainRoutePayload),
    geometryCanonicalJson: stableJson(input.candidate.originalGeometry),
    qaHistoryCanonicalJson: stableJson(provenancePayload.qa_history_snapshot),
    activityClassificationCanonicalJson: stableJson(
      provenancePayload.activity_classification,
    ),
    activityClassificationHash: provenancePayload.activity_classification_hash,
    mountainRoutePayload,
    provenancePayload,
  };
}
