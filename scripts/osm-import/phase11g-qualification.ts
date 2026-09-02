import { sha256Stable } from "./phase11-publication.ts";
import type { MountainRouteType } from "./route-activity-classifier.ts";
import type { RoadSafetyReasonCode, RoadSafetyStatus } from "./phase11c9-road-safety.ts";
import type { RouteTopologyClassification } from "../../Lib/osmStagingPreview/topology.ts";

export const PHASE11G_EXPANSION_CONTRACT = "mountain-tracker-osm-candidate-expansion/v1" as const;
export const PHASE11G_MIN_VERTICAL_GAIN_BASE_METERS = 500;
export const PHASE11G_MIN_VERTICAL_GAIN_HUT_METERS = 0;
export const PHASE11G_AUTO_APPROVAL_ENABLED = false as const;

export type Phase11gStatus = "GREEN" | "YELLOW" | "RED";
export type Phase11gNameClass = "NAMED" | "MISSING_NAME";
export type Phase11gHumanQaStatus =
  | "VISUALLY_APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED"
  | "PENDING"
  | null;

export type Phase11gReasonCode =
  | "ACTIVE_ROUTE_EXCLUDED"
  | "AMBIGUOUS_MOTORWAY_CROSSING"
  | "CLOSED_LOOP_REVIEW"
  | "COMPLEX_TOPOLOGY"
  | "DATA_INTEGRITY_FAILURE"
  | "DUPLICATE_RELATION_IDENTITY"
  | "DUPLICATE_SOURCE_URL"
  | "EXACT_MOUNTAIN_IDENTITY"
  | "GEOMETRY_VALID"
  | "HUMAN_QA_NEEDS_REVIEW"
  | "HUMAN_QA_REJECTED"
  | "INVALID_GEOMETRY"
  | "MAJOR_ROAD_CROSSING_REVIEW"
  | "MANUAL_ACTIVITY_REVIEW_REQUIRED"
  | "MOTORWAY_LINK_OVERLAP"
  | "MOTORWAY_OVERLAP"
  | "MULTIPLE_CONFIRMED_SUMMITS"
  | "NO_CONFIRMED_SUMMIT"
  | "NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY"
  | "NO_VALID_START_FINISH"
  | "NON_SIMPLE_TOPOLOGY"
  | "OLD_SCORE_CONFIRMED"
  | "OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES"
  | "PEDESTRIAN_ACCESS_FORBIDDEN"
  | "PUBLICATION_SOURCE_CONFLICT"
  | "QUALITY_BELOW_SUPPORTED_THRESHOLD"
  | "ROAD_ACCESS_AMBIGUOUS"
  | "ROAD_SAFETY_SAFE"
  | "ROUTE_MEMBER_DATA_INTEGRITY_FAILURE"
  | "SIMPLE_TOPOLOGY"
  | "SINGLE_CONFIRMED_SUMMIT"
  | "START_CONTEXT_AMBIGUOUS_START"
  | "START_CONTEXT_BASE_START"
  | "START_CONTEXT_HIGH_MOUNTAIN_START"
  | "START_CONTEXT_HUT_START"
  | "SUPPORTED_HIKING_ACTIVITY"
  | "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"
  | "UNSUPPORTED_ROUTE_TYPE"
  | "UNSUPPORTED_SEMANTIC_TYPE"
  | "VALID_ASCENT_MISSING_NAME"
  | "WARNING_EVIDENCE_PRESENT";

export interface Phase11gSummitIdentity {
  peakOsmId: string;
  finalAssociation: string;
  endpointDistanceMeters: number | null;
}

export interface Phase11gQualificationInput {
  canonicalRouteSourceId: string;
  sourceUrl: string;
  routeName: string | null;
  semanticType: string;
  routeType: MountainRouteType;
  activityManualReviewRequired: boolean;
  geometryValid: boolean;
  qualityScore: number;
  auditFlags: string[];
  warnings: string[];
  summits: Phase11gSummitIdentity[];
  topologyClassification: RouteTopologyClassification;
  connectedGroupCount: number;
  physicalEndpointCount: number;
  endpointSelectionAmbiguous: boolean;
  explicitlySupportedClosedLoop: boolean;
  active: boolean;
  duplicateRelationIdentity: boolean;
  duplicateSourceUrl: boolean;
  publicationSourceConflict: boolean;
  dataIntegrityFailure: boolean;
  routeMemberDataIntegrityFailure: boolean;
  roadSafetyStatus: RoadSafetyStatus;
  roadSafetyReasonCodes: RoadSafetyReasonCode[];
  humanQaStatus?: Phase11gHumanQaStatus;
  startContext?: "BASE_START" | "HUT_START" | "HIGH_MOUNTAIN_START" | "AMBIGUOUS_START";
  startElevationMeters?: number | null;
  startElevationSource?: string | null;
  summitElevationMeters?: number | null;
  verticalGainMeters?: number | null;
}

export interface Phase11gQualificationResult {
  expansionContractVersion: typeof PHASE11G_EXPANSION_CONTRACT;
  canonicalRouteSourceId: string;
  sourceUrl: string;
  routeName: string | null;
  nameClass: Phase11gNameClass;
  safeStatus: Phase11gStatus;
  greenClass: "GREEN_NAMED" | "GREEN_MISSING_NAME" | null;
  reasonCodes: Phase11gReasonCode[];
  safetyRed: boolean;
  safetyYellow: boolean;
  qualityScore: number;
  oldScoreSuperseded: boolean;
  roadSafetyStatus: RoadSafetyStatus;
  roadSafetyReasonCodes: RoadSafetyReasonCode[];
  summitIdentityCount: number;
  topologyClassification: RouteTopologyClassification;
  startContext: Phase11gQualificationInput["startContext"] | null;
  startElevationSource: string | null;
  verticalGainMeters: number | null;
  autoApprovalEnabled: false;
  qaWrites: 0;
  deterministicQualificationHash: string;
}

const REASON_ORDER: Phase11gReasonCode[] = [
  "ACTIVE_ROUTE_EXCLUDED",
  "DATA_INTEGRITY_FAILURE",
  "ROUTE_MEMBER_DATA_INTEGRITY_FAILURE",
  "DUPLICATE_RELATION_IDENTITY",
  "DUPLICATE_SOURCE_URL",
  "PUBLICATION_SOURCE_CONFLICT",
  "HUMAN_QA_REJECTED",
  "UNSUPPORTED_SEMANTIC_TYPE",
  "UNSUPPORTED_ROUTE_TYPE",
  "MANUAL_ACTIVITY_REVIEW_REQUIRED",
  "INVALID_GEOMETRY",
  "NO_CONFIRMED_SUMMIT",
  "NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY",
  "MOTORWAY_OVERLAP",
  "MOTORWAY_LINK_OVERLAP",
  "PEDESTRIAN_ACCESS_FORBIDDEN",
  "UNSAFE_AT_GRADE_MOTORWAY_CROSSING",
  "NO_VALID_START_FINISH",
  "COMPLEX_TOPOLOGY",
  "QUALITY_BELOW_SUPPORTED_THRESHOLD",
  "HUMAN_QA_NEEDS_REVIEW",
  "AMBIGUOUS_MOTORWAY_CROSSING",
  "ROAD_ACCESS_AMBIGUOUS",
  "MAJOR_ROAD_CROSSING_REVIEW",
  "MULTIPLE_CONFIRMED_SUMMITS",
  "NON_SIMPLE_TOPOLOGY",
  "CLOSED_LOOP_REVIEW",
  "WARNING_EVIDENCE_PRESENT",
  "START_CONTEXT_HIGH_MOUNTAIN_START",
  "START_CONTEXT_AMBIGUOUS_START",
  "VALID_ASCENT_MISSING_NAME",
  "OLD_SCORE_CONFIRMED",
  "OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES",
  "SUPPORTED_HIKING_ACTIVITY",
  "GEOMETRY_VALID",
  "SINGLE_CONFIRMED_SUMMIT",
  "EXACT_MOUNTAIN_IDENTITY",
  "SIMPLE_TOPOLOGY",
  "ROAD_SAFETY_SAFE",
  "START_CONTEXT_BASE_START",
  "START_CONTEXT_HUT_START",
];

const RED_REASONS = new Set<Phase11gReasonCode>([
  "ACTIVE_ROUTE_EXCLUDED",
  "DATA_INTEGRITY_FAILURE",
  "ROUTE_MEMBER_DATA_INTEGRITY_FAILURE",
  "DUPLICATE_RELATION_IDENTITY",
  "DUPLICATE_SOURCE_URL",
  "PUBLICATION_SOURCE_CONFLICT",
  "HUMAN_QA_REJECTED",
  "UNSUPPORTED_SEMANTIC_TYPE",
  "UNSUPPORTED_ROUTE_TYPE",
  "INVALID_GEOMETRY",
  "NO_CONFIRMED_SUMMIT",
  "NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY",
  "MOTORWAY_OVERLAP",
  "MOTORWAY_LINK_OVERLAP",
  "PEDESTRIAN_ACCESS_FORBIDDEN",
  "UNSAFE_AT_GRADE_MOTORWAY_CROSSING",
  "NO_VALID_START_FINISH",
  "COMPLEX_TOPOLOGY",
]);

const YELLOW_REASONS = new Set<Phase11gReasonCode>([
  "MANUAL_ACTIVITY_REVIEW_REQUIRED",
  "AMBIGUOUS_MOTORWAY_CROSSING",
  "ROAD_ACCESS_AMBIGUOUS",
  "MAJOR_ROAD_CROSSING_REVIEW",
  "MULTIPLE_CONFIRMED_SUMMITS",
  "NON_SIMPLE_TOPOLOGY",
  "CLOSED_LOOP_REVIEW",
  "WARNING_EVIDENCE_PRESENT",
  "HUMAN_QA_NEEDS_REVIEW",
  "START_CONTEXT_HIGH_MOUNTAIN_START",
  "START_CONTEXT_AMBIGUOUS_START",
]);

export function qualifyPhase11gRoute(
  input: Phase11gQualificationInput,
): Phase11gQualificationResult {
  const reasons = new Set<Phase11gReasonCode>();

  if (input.active) reasons.add("ACTIVE_ROUTE_EXCLUDED");
  if (input.dataIntegrityFailure) reasons.add("DATA_INTEGRITY_FAILURE");
  if (input.routeMemberDataIntegrityFailure) reasons.add("ROUTE_MEMBER_DATA_INTEGRITY_FAILURE");
  if (input.duplicateRelationIdentity) reasons.add("DUPLICATE_RELATION_IDENTITY");
  if (input.duplicateSourceUrl) reasons.add("DUPLICATE_SOURCE_URL");
  if (input.publicationSourceConflict) reasons.add("PUBLICATION_SOURCE_CONFLICT");
  if (input.humanQaStatus === "REJECTED") reasons.add("HUMAN_QA_REJECTED");
  if (input.humanQaStatus === "NEEDS_REVIEW") reasons.add("HUMAN_QA_NEEDS_REVIEW");
  if (input.semanticType !== "summit_route") reasons.add("UNSUPPORTED_SEMANTIC_TYPE");
  if (input.routeType !== "hiking") reasons.add("UNSUPPORTED_ROUTE_TYPE");
  else reasons.add("SUPPORTED_HIKING_ACTIVITY");
  if (input.activityManualReviewRequired) reasons.add("MANUAL_ACTIVITY_REVIEW_REQUIRED");
  if (!input.geometryValid) reasons.add("INVALID_GEOMETRY");
  else reasons.add("GEOMETRY_VALID");

  const confirmed = input.summits.filter((summit) => summit.finalAssociation === "CONFIRMED");
  if (confirmed.length === 0) reasons.add("NO_CONFIRMED_SUMMIT");
  else if (confirmed.length === 1) reasons.add("SINGLE_CONFIRMED_SUMMIT");
  else reasons.add("MULTIPLE_CONFIRMED_SUMMITS");

  const exactTerminalSingle =
    confirmed.length === 1 &&
    confirmed[0].endpointDistanceMeters != null &&
    confirmed[0].endpointDistanceMeters <= 10;
  if (!exactTerminalSingle) reasons.add("NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY");
  else reasons.add("EXACT_MOUNTAIN_IDENTITY");

  // Topology / start-finish (Phase 11G keeps Phase 11D topology contract exactly).
  const supportedClosedLoop =
    input.explicitlySupportedClosedLoop &&
    input.topologyClassification === "AMBIGUOUS" &&
    input.connectedGroupCount === 1 &&
    input.physicalEndpointCount === 0;
  const validStartFinish = input.physicalEndpointCount === 2 && !input.endpointSelectionAmbiguous;
  if (supportedClosedLoop) {
    reasons.add("CLOSED_LOOP_REVIEW");
  } else if (!validStartFinish) {
    reasons.add("NO_VALID_START_FINISH");
  }
  if (input.topologyClassification === "SIMPLE" && validStartFinish) {
    reasons.add("SIMPLE_TOPOLOGY");
  } else if (supportedClosedLoop) {
    // retained for review, never silently discarded
  } else if (
    input.topologyClassification === "DISCONNECTED" ||
    input.topologyClassification === "BRANCHING" ||
    input.topologyClassification === "AMBIGUOUS"
  ) {
    reasons.add("COMPLEX_TOPOLOGY");
  } else {
    reasons.add("NON_SIMPLE_TOPOLOGY");
  }

  // Road safety (Phase 11G keeps the frozen motorway/access contract).
  for (const roadReason of input.roadSafetyReasonCodes) {
    if (REASON_ORDER.includes(roadReason as Phase11gReasonCode)) {
      reasons.add(roadReason as Phase11gReasonCode);
    }
  }
  if (input.roadSafetyStatus === "SAFE") reasons.add("ROAD_SAFETY_SAFE");
  if (
    input.roadSafetyStatus === "BLOCKED" &&
    !input.roadSafetyReasonCodes.some((reason) =>
      ["MOTORWAY_OVERLAP", "MOTORWAY_LINK_OVERLAP", "PEDESTRIAN_ACCESS_FORBIDDEN", "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"].includes(reason),
    )
  ) reasons.add("DATA_INTEGRITY_FAILURE");

  // Start context: BASE/HUT required for GREEN; HIGH/AMBIGUOUS never GREEN.
  if (input.startContext === "HUT_START") reasons.add("START_CONTEXT_HUT_START");
  else if (input.startContext === "BASE_START") reasons.add("START_CONTEXT_BASE_START");
  else if (input.startContext === "HIGH_MOUNTAIN_START") reasons.add("START_CONTEXT_HIGH_MOUNTAIN_START");
  else reasons.add("START_CONTEXT_AMBIGUOUS_START");

  // Name handling: missing name is a presentation/metadata flag, never a safety gate.
  const nameClass: Phase11gNameClass = input.routeName ? "NAMED" : "MISSING_NAME";
  if (nameClass === "MISSING_NAME") reasons.add("VALID_ASCENT_MISSING_NAME");

  // Old aggregate quality score is superseded by the explicit evidence model.
  const belowSupported = input.qualityScore < 80;
  if (belowSupported) {
    reasons.add("QUALITY_BELOW_SUPPORTED_THRESHOLD");
    reasons.add("OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES");
  } else if (input.qualityScore < 90) {
    reasons.add("OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES");
  } else {
    reasons.add("OLD_SCORE_CONFIRMED");
  }

  const reasonCodes = REASON_ORDER.filter((reason) => reasons.has(reason));
  const safetyRed = reasonCodes.some((reason) => RED_REASONS.has(reason));
  const safetyYellow = !safetyRed && reasonCodes.some((reason) => YELLOW_REASONS.has(reason));
  const safeStatus: Phase11gStatus = safetyRed ? "RED" : safetyYellow ? "YELLOW" : "GREEN";

  // A candidate is only a produced GREEN ascents when all explicit safety gates are clean,
  // regardless of name or old score.
  const greenClass: Phase11gQualificationResult["greenClass"] =
    safeStatus === "GREEN"
      ? nameClass === "MISSING_NAME"
        ? "GREEN_MISSING_NAME"
        : "GREEN_NAMED"
      : null;

  const oldScoreSuperseded = reasons.has("OLD_SCORE_SUPERSEDED_BY_EXPLICIT_GATES");
  const content = {
    expansionContractVersion: PHASE11G_EXPANSION_CONTRACT,
    canonicalRouteSourceId: input.canonicalRouteSourceId,
    sourceUrl: input.sourceUrl,
    routeName: input.routeName,
    nameClass,
    safeStatus,
    greenClass,
    reasonCodes,
    safetyRed,
    safetyYellow,
    qualityScore: input.qualityScore,
    oldScoreSuperseded,
    roadSafetyStatus: input.roadSafetyStatus,
    roadSafetyReasonCodes: [...input.roadSafetyReasonCodes].sort(),
    summitIdentityCount: confirmed.length,
    topologyClassification: input.topologyClassification,
    startContext: input.startContext ?? null,
    startElevationSource: input.startElevationSource ?? null,
    verticalGainMeters: input.verticalGainMeters ?? null,
    autoApprovalEnabled: PHASE11G_AUTO_APPROVAL_ENABLED,
    qaWrites: 0 as const,
  };
  return { ...content, deterministicQualificationHash: sha256Stable(content) };
}
