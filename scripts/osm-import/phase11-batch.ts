import {
  stableJson,
  type Phase10QaHistoryRow,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
  type PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import {
  createProvenancePayload,
  PHASE11_PUBLICATION_CONTRACT,
  sha256Stable,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";

export const MAX_BATCH_SIZE = 5;
export const FIRST_PUBLISHED_RELATION_ID = "196164";
export const PHASE11C1_SEMANTIC_RISK_RELATION_IDS = ["140270"] as const;
export const PHASE11C1_BATCH_MANIFEST_NAME = "phase11c1-first-batch.json";
export const PHASE11C1_SELECTION_ORDER = [
  "warning-free-only",
  "no-via-ferrata-indication",
  "SIMPLE-topology-first",
  "EXACT_MOUNTAIN_MATCH-only",
  "CONFIRMED-summit-only",
  "quality-desc",
  "numeric-canonical-relation-id-asc",
] as const;

export interface Phase11BatchManifestRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  stagingRouteId: string;
  mountainId: number;
  routeName: string;
  candidateContentHash: string;
  stagingPayloadHash: string;
  targetPayloadHash: string;
  geometryHash: string;
  qaDecisionVersion: number;
  publicationIdempotencyKey: string;
}

export interface Phase11BatchManifest {
  schemaVersion: 1;
  artifactType: "PHASE11C1_FIRST_BATCH_MANIFEST";
  publicationContractVersion: typeof PHASE11_PUBLICATION_CONTRACT;
  maxBatchSize: typeof MAX_BATCH_SIZE;
  candidateSetContentHash: string;
  candidateManifestHash: string;
  excludedActiveRelationId: typeof FIRST_PUBLISHED_RELATION_ID;
  excludedSemanticRiskRelationIds: typeof PHASE11C1_SEMANTIC_RISK_RELATION_IDS;
  selectionOrder: typeof PHASE11C1_SELECTION_ORDER;
  selectionReason: string;
  records: Phase11BatchManifestRecord[];
  deterministicBatchManifestHash: string;
}

function idempotencyKey(candidate: PublicationCandidateRecord): string {
  return `${candidate.idempotencyKey}:${PHASE11_PUBLICATION_CONTRACT}`;
}

function hasWarnings(candidate: PublicationCandidateRecord): boolean {
  return (
    candidate.warningState.activeFlags.length > 0 ||
    candidate.warningState.reviewedFlags.length > 0 ||
    candidate.auditFlags.length > 0 ||
    candidate.topology.endpointSelectionWarning !== null
  );
}

function hasViaFerrataIndication(candidate: PublicationCandidateRecord): boolean {
  return (
    candidate.semanticType === "via_ferrata" ||
    /\b(?:via\s+ferrata|ferrata|klettersteig)\b/i.test(candidate.routeName ?? "")
  );
}

export function selectPhase11C1Batch(input: {
  artifact: PublicationCandidateArtifact;
  existingPublications: Map<string, ExistingPublicationIdentity>;
}): PublicationCandidateRecord[] {
  const selected = input.artifact.candidates
    .filter(
      (candidate) =>
        candidate.canonicalRouteSourceId !== FIRST_PUBLISHED_RELATION_ID &&
        !PHASE11C1_SEMANTIC_RISK_RELATION_IDS.some(
          (relationId) => relationId === candidate.canonicalRouteSourceId,
        ) &&
        !input.existingPublications.has(idempotencyKey(candidate)) &&
        !hasWarnings(candidate) &&
        !hasViaFerrataIndication(candidate) &&
        candidate.semanticType === "summit_route" &&
        candidate.qaDecision.status === "VISUALLY_APPROVED" &&
        candidate.summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH" &&
        candidate.summit.associationClassification === "CONFIRMED" &&
        Boolean(candidate.routeName?.trim()),
    )
    .sort(
      (left, right) =>
        Number(right.topology.classification === "SIMPLE") -
          Number(left.topology.classification === "SIMPLE") ||
        right.qualityScore - left.qualityScore ||
        Number(left.canonicalRouteSourceId) - Number(right.canonicalRouteSourceId),
    )
    .slice(0, MAX_BATCH_SIZE);
  if (selected.length !== MAX_BATCH_SIZE) {
    throw new Error(`PHASE11C1_REQUIRES_EXACTLY_${MAX_BATCH_SIZE}_UNPUBLISHED_CANDIDATES`);
  }
  return selected;
}

export function createPhase11C1BatchManifest(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  qaHistory: Phase10QaHistoryRow[];
  existingPublications: Map<string, ExistingPublicationIdentity>;
}): Phase11BatchManifest {
  const records = selectPhase11C1Batch(input).map((candidate) => {
    const provenance = createProvenancePayload({ ...input, candidate });
    return {
      sourceRelationId: candidate.sourceRelationId,
      canonicalRouteSourceId: candidate.canonicalRouteSourceId,
      stagingRouteId: candidate.stagingRouteId,
      mountainId: candidate.summit.mountainId,
      routeName: candidate.routeName!.trim(),
      candidateContentHash: candidate.candidateContentHash,
      stagingPayloadHash: candidate.payloadHash,
      targetPayloadHash: provenance.target_payload_hash,
      geometryHash: provenance.geometry_hash,
      qaDecisionVersion: candidate.qaDecision.version,
      publicationIdempotencyKey: provenance.publication_idempotency_key,
    };
  });
  const content: Omit<Phase11BatchManifest, "deterministicBatchManifestHash"> = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C1_FIRST_BATCH_MANIFEST" as const,
    publicationContractVersion: PHASE11_PUBLICATION_CONTRACT,
    maxBatchSize: MAX_BATCH_SIZE,
    candidateSetContentHash: input.artifact.deterministicContentHash,
    candidateManifestHash: input.manifest.overallDeterministicManifestHash,
    excludedActiveRelationId: FIRST_PUBLISHED_RELATION_ID,
    excludedSemanticRiskRelationIds: PHASE11C1_SEMANTIC_RISK_RELATION_IDS,
    selectionOrder: PHASE11C1_SELECTION_ORDER,
    selectionReason:
      "First five unpublished warning-free candidates with ordinary summit-route semantics and no via-ferrata indication; SIMPLE topology first, then highest quality, then numeric canonical relation ID.",
    records,
  };
  return {
    ...content,
    deterministicBatchManifestHash: sha256Stable(content),
  };
}

export function verifyPhase11C1BatchManifest(input: {
  provided: Phase11BatchManifest;
  expected: Phase11BatchManifest;
}): void {
  const { deterministicBatchManifestHash, ...content } = input.provided;
  if (sha256Stable(content) !== deterministicBatchManifestHash) {
    throw new Error("PHASE11C1_BATCH_MANIFEST_HASH_DRIFT");
  }
  if (
    input.provided.maxBatchSize !== MAX_BATCH_SIZE ||
    input.provided.records.length !== MAX_BATCH_SIZE
  ) {
    throw new Error("PHASE11C1_BATCH_SIZE_NOT_EXACTLY_FIVE");
  }
  if (new Set(input.provided.records.map((record) => record.stagingRouteId)).size !== MAX_BATCH_SIZE) {
    throw new Error("PHASE11C1_BATCH_DUPLICATE_STAGING_ROUTE");
  }
  if (stableJson(input.provided) !== stableJson(input.expected)) {
    throw new Error("PHASE11C1_BATCH_MANIFEST_CONTENT_DRIFT");
  }
}
