import { createHash } from "node:crypto";

import {
  stableJson,
  type Phase10QaHistoryRow,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
  type PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";

export const PHASE11_PUBLICATION_CONTRACT =
  "mountain-tracker-osm-publication/v1" as const;

export type PublicationAction =
  | "WOULD_CREATE"
  | "WOULD_SKIP_UNCHANGED"
  | "BLOCKED";

export interface MountainRoutePayload {
  mountain_id: number;
  name: string;
  start_location: null;
  route_type: "hiking";
  difficulty_system: null;
  difficulty_value: null;
  distance_km: number;
  elevation_gain_m: null;
  duration_minutes: null;
  description: null;
  best_season: null;
  equipment: null;
  warnings: string | null;
  gpx_url: null;
  source_name: "OpenStreetMap";
  source_url: string;
  is_verified: true;
  created_by: null;
  geojson_url: string;
}

export interface PublicationProvenancePayload {
  publication_contract_version: typeof PHASE11_PUBLICATION_CONTRACT;
  publication_idempotency_key: string;
  staging_route_id: string;
  provider: "openstreetmap";
  canonical_relation_id: string;
  source_relation_ids: string[];
  staging_payload_hash: string;
  candidate_content_hash: string;
  candidate_set_content_hash: string;
  candidate_manifest_hash: string;
  dataset_fingerprint: string;
  geometry_hash: string;
  qa_status: "VISUALLY_APPROVED";
  qa_decision_version: number;
  qa_reviewer_user_id: string;
  qa_reviewed_at: string;
  qa_reviewer_note: string | null;
  qa_history_snapshot: Phase10QaHistoryRow[];
  qa_history_hash: string;
  source_url: string;
  source_license: string;
  source_attribution: string;
  topology: PublicationCandidateRecord["topology"];
  audit_evidence: {
    warningState: PublicationCandidateRecord["warningState"];
    auditFlags: string[];
    summit: PublicationCandidateRecord["summit"];
    administration: PublicationCandidateRecord["administration"];
    duplicateProvenance: PublicationCandidateRecord["duplicateProvenance"];
  };
  target_payload_hash: string;
}

export interface ExistingPublicationIdentity {
  publicationIdempotencyKey: string;
  stagingPayloadHash: string;
  candidateContentHash: string;
  candidateSetContentHash: string;
  candidateManifestHash: string;
  datasetFingerprint: string;
  geometryHash: string;
  qaDecisionVersion: number;
  qaHistoryHash: string;
  targetPayloadHash: string;
}

export interface DryRunEnvironment {
  mountainIds: Set<number>;
  legacySourceUrls: Set<string>;
  existingPublications: Map<string, ExistingPublicationIdentity>;
  provenanceSchemaAvailable: boolean;
}

export interface Phase11DryRunRecord {
  sourceRelationId: string;
  stagingRouteId: string;
  targetMountainId: number;
  action: PublicationAction;
  blockers: string[];
  warnings: string[];
  mountainRoutePayload: MountainRoutePayload;
  provenancePayload: PublicationProvenancePayload;
  geometryStrategy: {
    kind: "STAGING_BACKED_SAME_ORIGIN_ENDPOINT";
    rawGeometryPreserved: true;
    syntheticConnectors: false;
    endpointMode:
      | "EXPLICIT_PHYSICAL_ENDPOINTS"
      | "NO_GLOBAL_ENDPOINTS";
  };
}

export interface Phase11FirstRouteManifest {
  schemaVersion: 1;
  artifactType: "PHASE11_FIRST_PUBLICATION_MANIFEST";
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT;
  selectionPolicy: string;
  selectionReason: string;
  stagingRouteId: string;
  mountainId: number;
  canonicalRelationId: string;
  sourceRelationIds: string[];
  stagingPayloadHash: string;
  candidateContentHash: string;
  candidateSetContentHash: string;
  candidateManifestHash: string;
  datasetFingerprint: string;
  qaDecision: PublicationCandidateRecord["qaDecision"];
  geometryHash: string;
  expectedTargetPayloadHash: string;
  deterministicManifestHash: string;
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function warningText(candidate: PublicationCandidateRecord): string | null {
  const messages: string[] = [];
  if (candidate.topology.classification === "BRANCHING") {
    messages.push(
      "OpenStreetMap route topology is BRANCHING. Displayed Start and Finish are inferred physical endpoints; endpoint selection is ambiguous.",
    );
  } else if (candidate.topology.classification === "DISCONNECTED") {
    messages.push(
      "OpenStreetMap route geometry is DISCONNECTED. No artificial global Start or Finish is displayed.",
    );
  } else if (candidate.topology.classification === "AMBIGUOUS") {
    messages.push(
      "OpenStreetMap route topology is ambiguous. No artificial global Start or Finish is displayed.",
    );
  }
  return messages.length > 0 ? messages.join("\n") : null;
}

export function geometryUrl(candidate: PublicationCandidateRecord): string {
  return `/api/osm-route-publications/openstreetmap/relation/${candidate.canonicalRouteSourceId}/geojson`;
}

export function mapMountainRoute(
  candidate: PublicationCandidateRecord,
): MountainRoutePayload {
  const name = candidate.routeName?.trim();
  if (!name) throw new Error(`ROUTE_NAME_REQUIRED:${candidate.sourceRelationId}`);
  if (candidate.semanticType !== "summit_route") {
    throw new Error(`UNSUPPORTED_ROUTE_TYPE:${candidate.sourceRelationId}`);
  }
  return {
    mountain_id: candidate.summit.mountainId,
    name,
    start_location: null,
    route_type: "hiking",
    difficulty_system: null,
    difficulty_value: null,
    distance_km: Math.round(candidate.distanceMeters) / 1000,
    elevation_gain_m: null,
    duration_minutes: null,
    description: null,
    best_season: null,
    equipment: null,
    warnings: warningText(candidate),
    gpx_url: null,
    source_name: "OpenStreetMap",
    source_url: candidate.provenance.sourceUrl,
    is_verified: true,
    created_by: null,
    geojson_url: geometryUrl(candidate),
  };
}

export function createProvenancePayload(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  candidate: PublicationCandidateRecord;
  qaHistory: Phase10QaHistoryRow[];
}): PublicationProvenancePayload {
  const history = input.qaHistory
    .filter((event) => event.stagingRouteId === input.candidate.stagingRouteId)
    .sort((left, right) =>
      left.decisionVersion - right.decisionVersion || left.id - right.id,
    );
  const target = mapMountainRoute(input.candidate);
  return {
    publication_contract_version: PHASE11_PUBLICATION_CONTRACT,
    publication_idempotency_key: `${input.candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT}`,
    staging_route_id: input.candidate.stagingRouteId,
    provider: "openstreetmap",
    canonical_relation_id: input.candidate.canonicalRouteSourceId,
    source_relation_ids: [...input.candidate.duplicateProvenance.sourceRouteIds].sort(
      (left, right) => Number(left) - Number(right),
    ),
    staging_payload_hash: input.candidate.payloadHash,
    candidate_content_hash: input.candidate.candidateContentHash,
    candidate_set_content_hash: input.artifact.deterministicContentHash,
    candidate_manifest_hash: input.manifest.overallDeterministicManifestHash,
    dataset_fingerprint: input.artifact.datasetFingerprint,
    geometry_hash: sha256Stable(input.candidate.originalGeometry),
    qa_status: "VISUALLY_APPROVED",
    qa_decision_version: input.candidate.qaDecision.version,
    qa_reviewer_user_id: input.candidate.qaDecision.reviewerUserId,
    qa_reviewed_at: input.candidate.qaDecision.reviewedAt,
    qa_reviewer_note: input.candidate.qaDecision.reviewerNote,
    qa_history_snapshot: history,
    qa_history_hash: sha256Stable(history),
    source_url: input.candidate.provenance.sourceUrl,
    source_license: input.candidate.provenance.license,
    source_attribution: input.candidate.provenance.attribution,
    topology: input.candidate.topology,
    audit_evidence: {
      warningState: input.candidate.warningState,
      auditFlags: [...input.candidate.auditFlags],
      summit: input.candidate.summit,
      administration: input.candidate.administration,
      duplicateProvenance: input.candidate.duplicateProvenance,
    },
    target_payload_hash: sha256Stable(target),
  };
}

function validateManifestMembership(
  candidate: PublicationCandidateRecord,
  manifest: PublicationCandidateManifest,
): string[] {
  const record = manifest.records.find(
    (value) => value.stagingRouteId === candidate.stagingRouteId,
  );
  if (!record) return ["CANDIDATE_OUTSIDE_MANIFEST"];
  const blockers: string[] = [];
  if (record.sourceRelationId !== candidate.sourceRelationId) blockers.push("SOURCE_ID_DRIFT");
  if (record.canonicalRouteSourceId !== candidate.canonicalRouteSourceId) blockers.push("CANONICAL_ID_DRIFT");
  if (record.mountainId !== candidate.summit.mountainId) blockers.push("MOUNTAIN_DRIFT");
  if (record.payloadHash !== candidate.payloadHash) blockers.push("PAYLOAD_DRIFT");
  if (record.qaDecisionVersion !== candidate.qaDecision.version) blockers.push("QA_VERSION_DRIFT");
  if (record.candidateContentHash !== candidate.candidateContentHash) blockers.push("CANDIDATE_HASH_DRIFT");
  return blockers;
}

export function publicationIdentityMatches(
  existing: ExistingPublicationIdentity,
  provenance: PublicationProvenancePayload,
): boolean {
  return (
    existing.stagingPayloadHash === provenance.staging_payload_hash &&
    existing.candidateContentHash === provenance.candidate_content_hash &&
    existing.candidateSetContentHash === provenance.candidate_set_content_hash &&
    existing.candidateManifestHash === provenance.candidate_manifest_hash &&
    existing.datasetFingerprint === provenance.dataset_fingerprint &&
    existing.geometryHash === provenance.geometry_hash &&
    existing.qaDecisionVersion === provenance.qa_decision_version &&
    existing.qaHistoryHash === provenance.qa_history_hash &&
    existing.targetPayloadHash === provenance.target_payload_hash
  );
}

export function dryRunCandidate(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  candidate: PublicationCandidateRecord;
  qaHistory: Phase10QaHistoryRow[];
  environment: DryRunEnvironment;
}): Phase11DryRunRecord {
  const target = mapMountainRoute(input.candidate);
  const provenance = createProvenancePayload(input);
  const blockers = validateManifestMembership(input.candidate, input.manifest);
  if (!input.environment.mountainIds.has(target.mountain_id)) blockers.push("TARGET_MOUNTAIN_MISSING");
  if (input.environment.legacySourceUrls.has(target.source_url)) blockers.push("LEGACY_SOURCE_DUPLICATE");
  if (input.candidate.qaDecision.status !== "VISUALLY_APPROVED") blockers.push("QA_NOT_APPROVED");
  if (input.candidate.summit.mountainMatchClassification !== "EXACT_MOUNTAIN_MATCH") blockers.push("MOUNTAIN_MATCH_NOT_EXACT");
  if (input.candidate.summit.associationClassification !== "CONFIRMED") blockers.push("SUMMIT_NOT_CONFIRMED");
  const existing = input.environment.existingPublications.get(
    provenance.publication_idempotency_key,
  );
  let action: PublicationAction = "WOULD_CREATE";
  if (blockers.length > 0) action = "BLOCKED";
  else if (existing && publicationIdentityMatches(existing, provenance)) action = "WOULD_SKIP_UNCHANGED";
  else if (existing) {
    blockers.push("EXISTING_PUBLICATION_DRIFT");
    action = "BLOCKED";
  }
  const warnings = [
    ...input.candidate.warningState.activeFlags,
    ...input.candidate.warningState.reviewedFlags,
  ];
  if (input.candidate.topology.endpointSelectionWarning) {
    warnings.push(input.candidate.topology.endpointSelectionWarning);
  }
  if (!input.environment.provenanceSchemaAvailable) {
    warnings.push("REVIEW_ONLY_PROVENANCE_SCHEMA_NOT_DEPLOYED");
  }
  return {
    sourceRelationId: input.candidate.sourceRelationId,
    stagingRouteId: input.candidate.stagingRouteId,
    targetMountainId: target.mountain_id,
    action,
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(warnings)].sort(),
    mountainRoutePayload: target,
    provenancePayload: provenance,
    geometryStrategy: {
      kind: "STAGING_BACKED_SAME_ORIGIN_ENDPOINT",
      rawGeometryPreserved: true,
      syntheticConnectors: false,
      endpointMode:
        input.candidate.topology.startCoordinate && input.candidate.topology.endCoordinate
          ? "EXPLICIT_PHYSICAL_ENDPOINTS"
          : "NO_GLOBAL_ENDPOINTS",
    },
  };
}

export function selectFirstPublicationCandidate(
  artifact: PublicationCandidateArtifact,
): PublicationCandidateRecord {
  const candidates = artifact.candidates
    .filter((candidate) =>
      candidate.qaDecision.status === "VISUALLY_APPROVED" &&
      candidate.qualityScore >= 90 &&
      candidate.originalGeometry.type === "LineString" &&
      candidate.topology.classification === "SIMPLE" &&
      candidate.warningState.activeFlags.length === 0 &&
      candidate.warningState.reviewedFlags.length === 0 &&
      candidate.auditFlags.length === 0 &&
      candidate.administration.status === "ASSIGNED" &&
      candidate.summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH" &&
      candidate.summit.associationClassification === "CONFIRMED" &&
      candidate.duplicateProvenance.duplicateGroupId === null &&
      candidate.distanceMeters >= 2_000 &&
      candidate.distanceMeters <= 30_000,
    )
    .sort((left, right) =>
      right.qualityScore - left.qualityScore ||
      Math.abs(left.distanceMeters - 10_000) - Math.abs(right.distanceMeters - 10_000) ||
      Number(left.sourceRelationId) - Number(right.sourceRelationId),
    );
  if (!candidates[0]) throw new Error("NO_SAFE_FIRST_PUBLICATION_CANDIDATE");
  return candidates[0];
}

export function createFirstRouteManifest(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  qaHistory: Phase10QaHistoryRow[];
}): Phase11FirstRouteManifest {
  const candidate = selectFirstPublicationCandidate(input.artifact);
  const provenance = createProvenancePayload({ ...input, candidate });
  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11_FIRST_PUBLICATION_MANIFEST" as const,
    publicationContractVersion: PHASE11_PUBLICATION_CONTRACT,
    selectionPolicy: "quality-desc,abs(distanceMeters-10000)-asc,numeric-sourceRelationId-asc",
    selectionReason: "Highest-quality eligible non-warning SIMPLE LineString; ordinary length nearest 10 km under the deterministic tie-break.",
    stagingRouteId: candidate.stagingRouteId,
    mountainId: candidate.summit.mountainId,
    canonicalRelationId: candidate.canonicalRouteSourceId,
    sourceRelationIds: provenance.source_relation_ids,
    stagingPayloadHash: candidate.payloadHash,
    candidateContentHash: candidate.candidateContentHash,
    candidateSetContentHash: input.artifact.deterministicContentHash,
    candidateManifestHash: input.manifest.overallDeterministicManifestHash,
    datasetFingerprint: input.artifact.datasetFingerprint,
    qaDecision: candidate.qaDecision,
    geometryHash: provenance.geometry_hash,
    expectedTargetPayloadHash: provenance.target_payload_hash,
  };
  return { ...content, deterministicManifestHash: sha256Stable(content) };
}
