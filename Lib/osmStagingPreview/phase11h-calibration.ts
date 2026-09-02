import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validatePreviewManifest, type PreviewManifest, type PreviewMetadataDocument } from "./core.ts";
import {
  getPreviewQueueDefinition,
  isCalibrationQueue,
  validatePhase11hCalibrationArtifact,
  validatePreviewQueueContract,
  type Phase11hCalibrationArtifact,
  type Phase11hCalibrationMember,
  type Phase11hCalibrationPreviewMember,
  type PreviewQueueArtifact,
  type PreviewQueueId,
  type PreviewQueueDefinition,
  type ResolvedPreviewQueueContract,
} from "./queue-core.ts";

function manifestContentHash(manifest: PreviewManifest): string {
  const { manifestHash: ignored, ...content } = manifest;
  void ignored;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function loadPreviewQueueContract(
  queueId: PreviewQueueId,
): Promise<ResolvedPreviewQueueContract> {
  const definition = getPreviewQueueDefinition(queueId);
  const [artifact, manifest, metadata] = await Promise.all([
    readFile(resolve(definition.artifactPath), "utf8").then(
      (value) => JSON.parse(value) as PreviewQueueArtifact,
    ),
    readFile(resolve(definition.stagingManifestPath), "utf8").then(
      (value) => JSON.parse(value) as PreviewManifest,
    ),
    readFile(resolve(definition.previewMetadataPath), "utf8").then(
      (value) => JSON.parse(value) as PreviewMetadataDocument,
    ),
  ]);
  validatePreviewManifest(manifest, definition.expectedTotal);
  if (manifestContentHash(manifest) !== manifest.manifestHash) {
    throw new Error(`${definition.label} manifest content hash mismatch.`);
  }
  if (
    metadata.contractVersion !== manifest.contractVersion ||
    metadata.datasetFingerprint !== manifest.datasetFingerprint ||
    metadata.manifestHash !== manifest.manifestHash
  ) {
    throw new Error(`${definition.label} preview metadata does not match its manifest.`);
  }
  return validatePreviewQueueContract({ definition, artifact, manifest, metadata });
}

function fileSha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface ResolvedPhase11hCalibrationContract {
  definition: PreviewQueueDefinition;
  artifact: Phase11hCalibrationArtifact;
  queueFileSha256: string;
}

export interface Phase11hCalibrationPreviewResult {
  artifactType: string;
  contractVersion: string;
  queueVersion: string;
  qaQuestionContractVersion: string;
  qaStatusVocabulary: string[];
  questions: Phase11hCalibrationArtifact["questions"];
  readOnly: boolean;
  autoApprovalEnabled: boolean;
  noPrefilledHumanDecision: boolean;
  deterministicArtifactHash: string;
  queueFileSha256: string;
  members: Phase11hCalibrationPreviewMember[];
  summary: {
    total: number;
    decided: number;
    pending: number;
    staged: number;
    blocked: number;
    qualityBands: Record<string, number>;
    selectionTiers: Record<string, number>;
    startContexts: Record<string, number>;
    nameStatuses: Record<string, number>;
  };
  performance: {
    serverQueryMilliseconds: number;
    serializedPayloadBytes: number;
  };
}

interface Phase11iB2StageabilityRecord {
  canonicalRelationId: string;
  summitOsmId: string;
  mountainResolutionStatus: string;
  resolvedMountainId: number | null;
  resolutionEvidence: string[];
  stagingEligible: boolean;
  blockingReason: string | null;
}

interface Phase11iB2StageabilityArtifact {
  artifactType: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  originalQueueCount: number;
  stageableCount: number;
  blockedCount: number;
  records: Phase11iB2StageabilityRecord[];
}

interface Phase11iB2ExecutionReceipt {
  artifactType: string;
  authorizedCount: number;
  blockedCount: number;
  blockedRelation: string;
  relationIds: string[];
  qaWrites: number;
  publicationWrites: number;
  activeChanges: number;
  afterState: {
    stagingRowsForAuthorized: number;
    exactPayloadMatches: number;
    summitStagingForAuthorized: number;
    blockedRelationStagingRows: number;
  };
}

const PHASE11I_B2_STAGEABILITY_PATH = resolve(
  "data/osm/alps/staging/phase11i-b2-human-calibration-stageability.json",
);
const PHASE11I_B2_EXECUTION_RECEIPT_PATH = resolve(
  "data/osm/alps/staging/phase11i-b2-controlled-staging-execution.json",
);

function assertPhase11iB2PreviewContracts(input: {
  queueMembers: Phase11hCalibrationMember[];
  stageability: Phase11iB2StageabilityArtifact;
  receipt: Phase11iB2ExecutionReceipt;
}): void {
  const { queueMembers, stageability, receipt } = input;
  const queueIds = new Set(queueMembers.map((member) => member.canonicalRelationId));
  const stageabilityIds = new Set(
    stageability.records.map((record) => record.canonicalRelationId),
  );
  const stagedIds = new Set(receipt.relationIds);
  const blockedRecords = stageability.records.filter(
    (record) => !record.stagingEligible,
  );
  if (
    stageability.artifactType !== "PHASE11I_B2_STAGEABILITY" ||
    stageability.readOnly !== true ||
    stageability.publishable !== false ||
    stageability.qaDecisionWrites !== 0 ||
    stageability.autoApprovalEnabled !== false ||
    stageability.originalQueueCount !== queueMembers.length ||
    stageability.stageableCount !== 44 ||
    stageability.blockedCount !== 1 ||
    stageability.records.length !== queueMembers.length ||
    stageabilityIds.size !== queueIds.size ||
    [...queueIds].some((id) => !stageabilityIds.has(id)) ||
    blockedRecords.length !== 1 ||
    blockedRecords[0].canonicalRelationId !== "19752996" ||
    blockedRecords[0].blockingReason !== "MOUNTAIN_IDENTITY_MISSING"
  ) {
    throw new Error("Phase 11I-B2 stageability preview contract is invalid.");
  }
  if (
    receipt.artifactType !== "PHASE11I_B2_CONTROLLED_STAGING_EXECUTION_RECEIPT" ||
    receipt.authorizedCount !== 44 ||
    receipt.blockedCount !== 1 ||
    receipt.blockedRelation !== "19752996" ||
    receipt.relationIds.length !== 44 ||
    stagedIds.size !== 44 ||
    receipt.qaWrites !== 0 ||
    receipt.publicationWrites !== 0 ||
    receipt.activeChanges !== 0 ||
    receipt.afterState.stagingRowsForAuthorized !== 44 ||
    receipt.afterState.exactPayloadMatches !== 44 ||
    receipt.afterState.summitStagingForAuthorized !== 44 ||
    receipt.afterState.blockedRelationStagingRows !== 0 ||
    stageability.records.some(
      (record) => record.stagingEligible !== stagedIds.has(record.canonicalRelationId),
    )
  ) {
    throw new Error("Phase 11I-B2 execution receipt preview contract is invalid.");
  }
}

export async function loadPhase11hCalibrationPreview(
  queueId: "phase11h",
): Promise<Phase11hCalibrationPreviewResult> {
  const startedAt = performance.now();
  const [contract, stageabilityRaw, receiptRaw] = await Promise.all([
    loadPhase11hCalibrationContract(queueId),
    readFile(PHASE11I_B2_STAGEABILITY_PATH, "utf8"),
    readFile(PHASE11I_B2_EXECUTION_RECEIPT_PATH, "utf8"),
  ]);
  const { definition, artifact, queueFileSha256 } = contract;
  void definition;
  const stageability = JSON.parse(stageabilityRaw) as Phase11iB2StageabilityArtifact;
  const receipt = JSON.parse(receiptRaw) as Phase11iB2ExecutionReceipt;
  assertPhase11iB2PreviewContracts({
    queueMembers: artifact.sample,
    stageability,
    receipt,
  });
  const stageabilityByRelation = new Map(
    stageability.records.map((record) => [record.canonicalRelationId, record]),
  );
  const members: Phase11hCalibrationPreviewMember[] = artifact.sample.map(
    (member, index) => {
      const staging = stageabilityByRelation.get(member.canonicalRelationId);
      if (!staging) {
        throw new Error(
          `Missing Phase 11I-B2 stageability record for ${member.canonicalRelationId}.`,
        );
      }
      return {
        ...member,
        queuePosition: index + 1,
        stagingStatus: staging.stagingEligible ? "STAGED" : "BLOCKED",
        stagingEligible: staging.stagingEligible,
        blockingReason: staging.blockingReason,
        summitOsmId: staging.summitOsmId,
        mountainResolutionStatus: staging.mountainResolutionStatus,
        resolvedMountainId: staging.resolvedMountainId,
        resolutionEvidence: staging.resolutionEvidence,
      };
    },
  );
  const countBy = (values: Array<string | null>) =>
    values.reduce<Record<string, number>>((acc, value) => {
      const key = value ?? "—";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  const summary = {
    total: members.length,
    decided: members.filter((member) => member.humanDecisionStatus !== null).length,
    pending: members.filter((member) => member.humanDecisionStatus === null).length,
    staged: members.filter((member) => member.stagingStatus === "STAGED").length,
    blocked: members.filter((member) => member.stagingStatus === "BLOCKED").length,
    qualityBands: countBy(members.map((member) => member.qualityBand)),
    selectionTiers: countBy(members.map((member) => member.selectionTier)),
    startContexts: countBy(members.map((member) => member.startContext)),
    nameStatuses: countBy(members.map((member) => member.nameStatus)),
  };
  const result: Phase11hCalibrationPreviewResult = {
    artifactType: artifact.artifactType,
    contractVersion: artifact.contractVersion,
    queueVersion: artifact.queueVersion,
    qaQuestionContractVersion: artifact.qaQuestionContractVersion,
    qaStatusVocabulary: artifact.qaStatusVocabulary,
    questions: artifact.questions,
    readOnly: artifact.readOnly,
    autoApprovalEnabled: artifact.autoApprovalEnabled,
    noPrefilledHumanDecision: artifact.noPrefilledHumanDecision,
    deterministicArtifactHash: artifact.deterministicArtifactHash,
    queueFileSha256,
    members,
    summary,
    performance: {
      serverQueryMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
      serializedPayloadBytes: 0,
    },
  };
  result.performance.serializedPayloadBytes = Buffer.byteLength(
    JSON.stringify(result),
    "utf8",
  );
  return result;
}

export async function loadPhase11hCalibrationContract(
  queueId: "phase11h",
): Promise<ResolvedPhase11hCalibrationContract> {
  const definition = getPreviewQueueDefinition(queueId);
  const raw = await readFile(resolve(definition.artifactPath), "utf8");
  const queueFileSha256 = fileSha256(raw);
  if (definition.queueFileSha256 && queueFileSha256 !== definition.queueFileSha256) {
    throw new Error(`${definition.label} queue file SHA-256 mismatch.`);
  }
  const artifact = JSON.parse(raw) as Phase11hCalibrationArtifact;
  validatePhase11hCalibrationArtifact({ definition, artifact });
  return { definition, artifact, queueFileSha256 };
}

export async function loadPreviewQueueContractFor(
  queueId: PreviewQueueId,
): Promise<ResolvedPreviewQueueContract | ResolvedPhase11hCalibrationContract> {
  if (isCalibrationQueue(queueId)) {
    return loadPhase11hCalibrationContract(queueId);
  }
  return loadPreviewQueueContract(queueId);
}
