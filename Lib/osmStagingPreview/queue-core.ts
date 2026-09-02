import type { PreviewManifest, PreviewMetadataDocument } from "./core.ts";

export const PREVIEW_QUEUE_IDS = [
  "phase11c4",
  "phase11d",
  "phase11e",
  "phase11f",
  "phase11h",
] as const;
export type PreviewQueueId = (typeof PREVIEW_QUEUE_IDS)[number];

export type PreviewQueueMode =
  | "MANIFEST_LOCKED"
  | "CALIBRATION_READONLY";

export interface PreviewQueueDefinition {
  id: PreviewQueueId;
  label: string;
  expectedTotal: number;
  expectedArtifactType: string;
  artifactPath: string;
  stagingManifestPath: string;
  previewMetadataPath: string;
  mode: PreviewQueueMode;
  queueFileSha256?: string;
}

export interface PreviewQueueArtifactRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
}

export interface PreviewQueueArtifact {
  artifactType: string;
  newRoutesQueued: number;
  queue: PreviewQueueArtifactRecord[];
}

export interface ResolvedPreviewQueueContract {
  definition: PreviewQueueDefinition;
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
}

const QUEUE_DEFINITIONS: Record<PreviewQueueId, PreviewQueueDefinition> = {
  phase11c4: {
    id: "phase11c4",
    label: "Phase 11C.4 QA queue",
    expectedTotal: 150,
    expectedArtifactType: "PHASE11C4_NEW_QA_QUEUE",
    artifactPath: "data/osm/alps/publication/phase11c4-new-qa-queue.json",
    stagingManifestPath: "data/osm/alps/staging/phase11c4-staging-manifest.json",
    previewMetadataPath: "data/osm/alps/staging/phase11c4-preview-metadata.json",
    mode: "MANIFEST_LOCKED",
  },
  phase11d: {
    id: "phase11d",
    label: "Phase 11D scale QA queue",
    expectedTotal: 600,
    expectedArtifactType: "PHASE11D_SCALE_QA_QUEUE",
    artifactPath: "data/osm/alps/publication/phase11d-qa-queue.json",
    stagingManifestPath: "data/osm/alps/staging/phase11d-staging-manifest.json",
    previewMetadataPath: "data/osm/alps/staging/phase11d-preview-metadata.json",
    mode: "MANIFEST_LOCKED",
  },
  phase11e: {
    id: "phase11e",
    label: "Phase 11E recovery QA queue",
    expectedTotal: 704,
    expectedArtifactType: "PHASE11E_SCALE_QA_QUEUE",
    artifactPath: "data/osm/alps/publication/phase11e-qa-queue.json",
    stagingManifestPath: "data/osm/alps/staging/phase11e-qa-manifest.json",
    previewMetadataPath: "data/osm/alps/staging/phase11e-preview-metadata.json",
    mode: "MANIFEST_LOCKED",
  },
  phase11f: {
    id: "phase11f",
    label: "Phase 11F GREEN calibration queue",
    expectedTotal: 298,
    expectedArtifactType: "PHASE11F_GREEN_CALIBRATION_QUEUE",
    artifactPath: "data/osm/alps/publication/phase11f-green-calibration-queue.json",
    stagingManifestPath: "data/osm/alps/staging/phase11f-green-calibration-manifest.json",
    previewMetadataPath: "data/osm/alps/staging/phase11f-green-calibration-preview-metadata.json",
    mode: "MANIFEST_LOCKED",
  },
  phase11h: {
    id: "phase11h",
    label: "Phase 11H human calibration queue",
    expectedTotal: 45,
    expectedArtifactType: "PHASE11H_HUMAN_CALIBRATION_QUEUE",
    artifactPath: "data/osm/alps/staging/phase11h-human-calibration-queue.json",
    stagingManifestPath: "data/osm/alps/staging/phase11h-human-calibration-queue.json",
    previewMetadataPath: "data/osm/alps/staging/phase11h-human-calibration-queue.json",
    mode: "CALIBRATION_READONLY",
    queueFileSha256:
      "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd",
  },
};

export function parsePreviewQueueId(
  value: string | string[] | undefined,
): PreviewQueueId | null {
  if (value === undefined) return null;
  if (Array.isArray(value) || !PREVIEW_QUEUE_IDS.includes(value as PreviewQueueId)) {
    throw new Error("Unknown OSM staging preview queue.");
  }
  return value as PreviewQueueId;
}

export function getPreviewQueueDefinition(queueId: PreviewQueueId): PreviewQueueDefinition {
  return QUEUE_DEFINITIONS[queueId];
}

export function previewQueueQuery(queueId: PreviewQueueId | null): string {
  return queueId ? `?queue=${queueId}` : "";
}

export function previewQueueHref(pathname: string, queueId: PreviewQueueId | null): string {
  return `${pathname}${previewQueueQuery(queueId)}`;
}

export function validatePreviewQueueContract(input: {
  definition: PreviewQueueDefinition;
  artifact: PreviewQueueArtifact;
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
}): ResolvedPreviewQueueContract {
  const { definition, artifact, manifest, metadata } = input;
  if (
    artifact.artifactType !== definition.expectedArtifactType ||
    artifact.newRoutesQueued !== definition.expectedTotal ||
    artifact.queue.length !== definition.expectedTotal
  ) {
    throw new Error(`${definition.label} artifact count or type is invalid.`);
  }
  const relationIds = artifact.queue.map((record) => record.sourceRelationId);
  const canonicalIds = artifact.queue.map((record) => record.canonicalRouteSourceId);
  if (
    relationIds.some((value) => !/^\d+$/.test(value)) ||
    canonicalIds.some((value) => !/^\d+$/.test(value)) ||
    new Set(relationIds).size !== relationIds.length ||
    new Set(canonicalIds).size !== canonicalIds.length
  ) {
    throw new Error(`${definition.label} contains invalid or duplicate route identities.`);
  }
  if (
    manifest.recordCount !== definition.expectedTotal ||
    manifest.records.length !== definition.expectedTotal ||
    metadata.recordCount !== definition.expectedTotal ||
    metadata.records.length !== definition.expectedTotal
  ) {
    throw new Error(`${definition.label} staging contract is incomplete.`);
  }

  const manifestByRelation = new Map(
    manifest.records.map((record) => [record.sourceRelationId, record]),
  );
  const metadataByRelation = new Map(
    metadata.records.map((record) => [record.sourceRelationId, record]),
  );
  if (
    manifestByRelation.size !== definition.expectedTotal ||
    metadataByRelation.size !== definition.expectedTotal
  ) {
    throw new Error(`${definition.label} staging contract contains duplicate relations.`);
  }

  const orderedManifestRecords = artifact.queue.map((queueRecord) => {
    const record = manifestByRelation.get(queueRecord.sourceRelationId);
    if (!record) throw new Error(`Unresolved queue relation ${queueRecord.sourceRelationId}.`);
    if (record.canonicalRouteSourceId !== queueRecord.canonicalRouteSourceId) {
      throw new Error(`Queue identity drift for relation ${queueRecord.sourceRelationId}.`);
    }
    return record;
  });
  const orderedMetadataRecords = artifact.queue.map((queueRecord) => {
    const record = metadataByRelation.get(queueRecord.sourceRelationId);
    if (!record) throw new Error(`Missing queue metadata for relation ${queueRecord.sourceRelationId}.`);
    const manifestRecord = manifestByRelation.get(queueRecord.sourceRelationId);
    if (
      !manifestRecord ||
      record.canonicalRouteSourceId !== queueRecord.canonicalRouteSourceId ||
      record.idempotencyKey !== manifestRecord.idempotencyKey ||
      record.payloadHash !== manifestRecord.payloadHash
    ) {
      throw new Error(`Queue metadata drift for relation ${queueRecord.sourceRelationId}.`);
    }
    return record;
  });
  if (
    manifest.records.some((record) => !relationIds.includes(record.sourceRelationId)) ||
    metadata.records.some((record) => !relationIds.includes(record.sourceRelationId))
  ) {
    throw new Error(`${definition.label} staging contract contains an unexpected relation.`);
  }

  return {
    definition,
    manifest: { ...manifest, records: orderedManifestRecords },
    metadata: { ...metadata, records: orderedMetadataRecords },
  };
}

export function isCalibrationQueue(
  queueId: PreviewQueueId | null,
): queueId is "phase11h" {
  return queueId === "phase11h";
}

export interface Phase11hCalibrationMember {
  canonicalRelationId: string;
  candidateHash: string;
  qualificationHash: string;
  nameStatus: string;
  nameOrigin: string | null;
  resolvedDisplayName: string | null;
  startContext: string | null;
  qualityBand: string;
  selectionTier: string;
  selectionReason: string | null;
  humanDecisionStatus: string | null;
  humanDecisionReviewerId: string | null;
  humanDecisionReviewedAt: string | null;
  humanDecisionNote: string | null;
}

export interface Phase11hCalibrationPreviewMember
  extends Phase11hCalibrationMember {
  queuePosition: number;
  stagingStatus: "STAGED" | "BLOCKED";
  stagingEligible: boolean;
  blockingReason: string | null;
  summitOsmId?: string | null;
  mountainResolutionStatus?: string | null;
  resolvedMountainId?: number | null;
  resolutionEvidence?: string[];
}

export interface Phase11hCalibrationQuestion {
  id: string;
  prompt: string;
}

export interface Phase11hCalibrationArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: boolean | 0;
  autoApprovalEnabled: boolean;
  queueVersion: string;
  selectionTargetSize: number;
  qaQuestionContractVersion: string;
  qaStatusVocabulary: string[];
  questions: Phase11hCalibrationQuestion[];
  sampleSize: number;
  sample: Phase11hCalibrationMember[];
  noPrefilledHumanDecision: boolean;
  deterministicArtifactHash: string;
}

export function validatePhase11hCalibrationArtifact(
  input: { definition: PreviewQueueDefinition; artifact: Phase11hCalibrationArtifact },
): Phase11hCalibrationArtifact {
  const { definition, artifact } = input;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.artifactType !== definition.expectedArtifactType ||
    artifact.readOnly !== true ||
    artifact.publishable !== false ||
    artifact.qaDecisionWrites !== 0 ||
    artifact.autoApprovalEnabled !== false ||
    artifact.noPrefilledHumanDecision !== true ||
    artifact.sampleSize !== definition.expectedTotal ||
    artifact.sample.length !== definition.expectedTotal
  ) {
    throw new Error(`${definition.label} calibration artifact is invalid.`);
  }
  const memberIds = artifact.sample.map((member) => member.canonicalRelationId);
  if (
    memberIds.some((value) => !/^\d+$/.test(value)) ||
    new Set(memberIds).size !== memberIds.length
  ) {
    throw new Error(`${definition.label} contains invalid or duplicate calibration members.`);
  }
  if (
    artifact.sample.some(
      (member) =>
        member.humanDecisionStatus !== null ||
        member.humanDecisionReviewerId !== null ||
        member.humanDecisionReviewedAt !== null ||
        member.humanDecisionNote !== null ||
        (member.nameOrigin !== null && typeof member.nameOrigin !== "string") ||
        (member.resolvedDisplayName !== null && typeof member.resolvedDisplayName !== "string") ||
        (member.startContext !== null && typeof member.startContext !== "string") ||
        (member.selectionReason !== null && typeof member.selectionReason !== "string") ||
        !/^[0-9a-f]{64}$/.test(member.candidateHash) ||
        !/^[0-9a-f]{64}$/.test(member.qualificationHash),
    )
  ) {
    throw new Error(`${definition.label} contains pre-decided or malformed calibration members.`);
  }
  if (new Set(artifact.questions.map((question) => question.id)).size !== artifact.questions.length) {
    throw new Error(`${definition.label} calibration questions are not uniquely identified.`);
  }
  return artifact;
}
