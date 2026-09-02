import {
  parseQaDecisionInput,
  type PreviewManifestRecord,
  type PreviewMetadataRecord,
  type PreviewQaDecisionInput,
  type PreviewQaStatus,
} from "./core.ts";

export interface QaMutationTarget {
  stagingRouteId: string;
  contractVersion: string;
  importEligibility: "AUTO_IMPORT_READY";
  metadata: PreviewMetadataRecord;
  manifest: PreviewManifestRecord;
}

export interface QaMutationWriteInput extends PreviewQaDecisionInput {
  reviewerUserId: string;
  target: QaMutationTarget;
}

export interface QaMutationResult {
  status: PreviewQaStatus;
  reviewerNote: string | null;
  reviewedAt: string | null;
  version: number | null;
  changed: boolean;
}

export interface QaMutationDependencies {
  authorize: () => Promise<{ userId: string }>;
  validateTarget: (input: PreviewQaDecisionInput) => Promise<QaMutationTarget>;
  writeDecision: (input: QaMutationWriteInput) => Promise<QaMutationResult>;
}

export async function executeQaDecisionMutation(
  rawInput: unknown,
  dependencies: QaMutationDependencies,
): Promise<QaMutationResult> {
  const { userId } = await dependencies.authorize();
  const input = parseQaDecisionInput(rawInput);
  const target = await dependencies.validateTarget(input);
  if (
    target.stagingRouteId !== input.stagingRouteId ||
    target.contractVersion !== "mountain-tracker-osm-route/v1" ||
    target.importEligibility !== "AUTO_IMPORT_READY" ||
    target.metadata.idempotencyKey !== target.manifest.idempotencyKey ||
    target.metadata.payloadHash !== target.manifest.payloadHash ||
    target.metadata.sourceRelationId !== target.manifest.sourceRelationId ||
    target.metadata.canonicalRouteSourceId !== target.manifest.canonicalRouteSourceId ||
    target.manifest.expectedSummitAssociationCount !== 1 ||
    target.metadata.summit.finalAssociation !== "CONFIRMED" ||
    target.metadata.summit.matchClassification !== "EXACT_MOUNTAIN_MATCH"
  ) {
    throw new Error("QA mutation target failed reviewed-manifest validation.");
  }
  return dependencies.writeDecision({
    ...input,
    reviewerUserId: userId,
    target,
  });
}
