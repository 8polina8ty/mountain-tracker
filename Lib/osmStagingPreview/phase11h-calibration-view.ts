import type {
  Phase11hCalibrationPreviewMember,
} from "./queue-core.ts";

const UNAVAILABLE = "—";

export function formatPhase11hBadge(
  value: string | null | undefined,
): string {
  if (value === null || value === undefined || value.length === 0) {
    return UNAVAILABLE;
  }
  return value.replace(/_/g, " ");
}

export function formatPhase11hOptionalMetadata(
  value: string | null | undefined,
): string {
  if (value === null || value === undefined || value.length === 0) {
    return UNAVAILABLE;
  }
  return value;
}

export interface Phase11hCalibrationMemberRenderModel {
  displayName: string;
  qualityBand: string;
  selectionTier: string;
  startContext: string;
  nameStatus: string;
  nameOrigin: string;
  selectionReason: string;
  humanDecisionLabel: string;
  stagingLabel: string;
  blockingReason: string;
  summitOsmId: string;
  mountainResolutionStatus: string;
  resolutionEvidence: string[];
}

export function createPhase11hCalibrationMemberRenderModel(
  member: Phase11hCalibrationPreviewMember,
): Phase11hCalibrationMemberRenderModel {
  return {
    displayName:
      member.resolvedDisplayName ??
      `OSM relation ${member.canonicalRelationId}`,
    qualityBand: formatPhase11hBadge(member.qualityBand),
    selectionTier: formatPhase11hBadge(member.selectionTier),
    startContext: formatPhase11hBadge(member.startContext),
    nameStatus: formatPhase11hBadge(member.nameStatus),
    nameOrigin: formatPhase11hBadge(member.nameOrigin),
    selectionReason: formatPhase11hOptionalMetadata(member.selectionReason),
    humanDecisionLabel:
      member.humanDecisionStatus === null
        ? "PENDING"
        : formatPhase11hBadge(member.humanDecisionStatus),
    stagingLabel: member.stagingStatus === "BLOCKED" ? "BLOCKED / UNSTAGED" : "STAGED",
    blockingReason: formatPhase11hBadge(member.blockingReason),
    summitOsmId: formatPhase11hOptionalMetadata(member.summitOsmId),
    mountainResolutionStatus: formatPhase11hBadge(
      member.mountainResolutionStatus,
    ),
    resolutionEvidence: member.resolutionEvidence ?? [],
  };
}
