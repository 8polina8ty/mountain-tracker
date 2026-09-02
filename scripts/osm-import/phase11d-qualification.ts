import { sha256Stable } from "./phase11-publication.ts";
import type { MountainRouteType } from "./route-activity-classifier.ts";
import type { RoadSafetyReasonCode, RoadSafetyStatus } from "./phase11c9-road-safety.ts";
import type { RouteTopologyClassification } from "../../Lib/osmStagingPreview/topology.ts";

export const PHASE11D_QUALIFICATION_CONTRACT =
  "mountain-tracker-osm-scale-qualification/v1" as const;
export const PHASE11D_GREEN_MINIMUM_QUALITY = 90;
export const PHASE11D_SUPPORTED_MINIMUM_QUALITY = 80;
export const PHASE11D_AUTO_APPROVAL_ENABLED = false as const;

export type Phase11dQualificationStatus = "GREEN" | "YELLOW" | "RED";
export type Phase11dHumanQaStatus =
  | "VISUALLY_APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED"
  | "PENDING"
  | null;

export type Phase11dQualificationReasonCode =
  | "ACTIVE_ROUTE_EXCLUDED"
  | "AMBIGUOUS_MOTORWAY_CROSSING"
  | "AUDIT_EVIDENCE_PRESENT"
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
  | "PEDESTRIAN_ACCESS_FORBIDDEN"
  | "PUBLICATION_SOURCE_CONFLICT"
  | "QUALITY_BELOW_GREEN_THRESHOLD"
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
  | "WARNING_EVIDENCE_PRESENT";

export interface Phase11dSummitIdentity {
  peakOsmId: string;
  mountainId: number | null;
  finalAssociation: string;
  mountainMatchClassification: string;
}

export interface Phase11dQualificationInput {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  sourceUrl: string;
  stagingIdempotencyKey: string;
  stagingPayloadHash: string;
  semanticType: string;
  routeType: MountainRouteType;
  activityManualReviewRequired: boolean;
  geometryValid: boolean;
  qualityScore: number;
  auditFlags: string[];
  warnings: string[];
  summits: Phase11dSummitIdentity[];
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
  humanQaStatus?: Phase11dHumanQaStatus;
  startContext?: "BASE_START" | "HUT_START" | "HIGH_MOUNTAIN_START" | "AMBIGUOUS_START";
}

export interface Phase11dQualificationResult {
  qualificationContractVersion: typeof PHASE11D_QUALIFICATION_CONTRACT;
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  sourceUrl: string;
  stagingIdempotencyKey: string;
  stagingPayloadHash: string;
  status: Phase11dQualificationStatus;
  reasonCodes: Phase11dQualificationReasonCode[];
  qualityScore: number;
  routeType: MountainRouteType;
  topologyClassification: RouteTopologyClassification;
  connectedGroupCount: number;
  physicalEndpointCount: number;
  endpointSelectionAmbiguous: boolean;
  roadSafetyStatus: RoadSafetyStatus;
  roadSafetyReasonCodes: RoadSafetyReasonCode[];
  summitIdentities: Phase11dSummitIdentity[];
  humanQaStatus: Phase11dHumanQaStatus;
  autoApprovalEnabled: false;
  qaWrites: 0;
  deterministicQualificationHash: string;
}

const REASON_ORDER: Phase11dQualificationReasonCode[] = [
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
  "AUDIT_EVIDENCE_PRESENT",
  "QUALITY_BELOW_GREEN_THRESHOLD",
  "START_CONTEXT_HIGH_MOUNTAIN_START",
  "START_CONTEXT_AMBIGUOUS_START",
  "SUPPORTED_HIKING_ACTIVITY",
  "GEOMETRY_VALID",
  "SINGLE_CONFIRMED_SUMMIT",
  "EXACT_MOUNTAIN_IDENTITY",
  "SIMPLE_TOPOLOGY",
  "ROAD_SAFETY_SAFE",
  "START_CONTEXT_BASE_START",
  "START_CONTEXT_HUT_START",
];

const RED_REASONS = new Set<Phase11dQualificationReasonCode>([
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
  "QUALITY_BELOW_SUPPORTED_THRESHOLD",
]);

const YELLOW_REASONS = new Set<Phase11dQualificationReasonCode>([
  "MANUAL_ACTIVITY_REVIEW_REQUIRED",
  "AMBIGUOUS_MOTORWAY_CROSSING",
  "ROAD_ACCESS_AMBIGUOUS",
  "MAJOR_ROAD_CROSSING_REVIEW",
  "MULTIPLE_CONFIRMED_SUMMITS",
  "NON_SIMPLE_TOPOLOGY",
  "CLOSED_LOOP_REVIEW",
  "WARNING_EVIDENCE_PRESENT",
  "AUDIT_EVIDENCE_PRESENT",
  "QUALITY_BELOW_GREEN_THRESHOLD",
  "HUMAN_QA_NEEDS_REVIEW",
  "START_CONTEXT_HIGH_MOUNTAIN_START",
  "START_CONTEXT_AMBIGUOUS_START",
]);

function sortedSummits(values: Phase11dSummitIdentity[]): Phase11dSummitIdentity[] {
  return [...values].sort((left, right) =>
    left.peakOsmId.localeCompare(right.peakOsmId, "en", { numeric: true }) ||
    (left.mountainId ?? -1) - (right.mountainId ?? -1));
}

export function qualifyPhase11dRoute(
  input: Phase11dQualificationInput,
): Phase11dQualificationResult {
  const reasons = new Set<Phase11dQualificationReasonCode>();
  if (input.active) reasons.add("ACTIVE_ROUTE_EXCLUDED");
  if (input.dataIntegrityFailure) reasons.add("DATA_INTEGRITY_FAILURE");
  if (input.routeMemberDataIntegrityFailure) {
    reasons.add("ROUTE_MEMBER_DATA_INTEGRITY_FAILURE");
  }
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

  const confirmed = input.summits.filter(
    (summit) => summit.finalAssociation === "CONFIRMED",
  );
  if (confirmed.length === 0) reasons.add("NO_CONFIRMED_SUMMIT");
  else if (confirmed.length === 1) reasons.add("SINGLE_CONFIRMED_SUMMIT");
  else reasons.add("MULTIPLE_CONFIRMED_SUMMITS");
  if (
    confirmed.length === 0 ||
    confirmed.some(
      (summit) =>
        summit.mountainMatchClassification !== "EXACT_MOUNTAIN_MATCH" ||
        summit.mountainId === null,
    )
  ) reasons.add("NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY");
  else reasons.add("EXACT_MOUNTAIN_IDENTITY");

  const supportedClosedLoop =
    input.explicitlySupportedClosedLoop &&
    input.topologyClassification === "AMBIGUOUS" &&
    input.connectedGroupCount === 1 &&
    input.physicalEndpointCount === 0;
  const validStartFinish =
    input.physicalEndpointCount === 2 && !input.endpointSelectionAmbiguous;
  if (supportedClosedLoop) {
    reasons.add("CLOSED_LOOP_REVIEW");
  } else if (!validStartFinish) {
    reasons.add("NO_VALID_START_FINISH");
  }
  if (input.topologyClassification === "SIMPLE" && validStartFinish) {
    reasons.add("SIMPLE_TOPOLOGY");
  } else if (supportedClosedLoop) {
    // Explicit loops are retained for human review, never silently discarded.
  } else if (
    input.topologyClassification === "DISCONNECTED" ||
    input.topologyClassification === "BRANCHING" ||
    input.topologyClassification === "AMBIGUOUS"
  ) {
    reasons.add("COMPLEX_TOPOLOGY");
  } else {
    reasons.add("NON_SIMPLE_TOPOLOGY");
  }

  if (input.qualityScore < PHASE11D_SUPPORTED_MINIMUM_QUALITY) {
    reasons.add("QUALITY_BELOW_SUPPORTED_THRESHOLD");
  } else if (input.qualityScore < PHASE11D_GREEN_MINIMUM_QUALITY) {
    reasons.add("QUALITY_BELOW_GREEN_THRESHOLD");
  }
  if (input.auditFlags.length > 0) reasons.add("AUDIT_EVIDENCE_PRESENT");
  if (input.warnings.length > 0) reasons.add("WARNING_EVIDENCE_PRESENT");

  for (const roadReason of input.roadSafetyReasonCodes) {
    if (REASON_ORDER.includes(roadReason as Phase11dQualificationReasonCode)) {
      reasons.add(roadReason as Phase11dQualificationReasonCode);
    }
  }
  if (input.roadSafetyStatus === "SAFE") reasons.add("ROAD_SAFETY_SAFE");
  if (
    input.roadSafetyStatus === "BLOCKED" &&
    !input.roadSafetyReasonCodes.some((reason) =>
      [
        "MOTORWAY_OVERLAP",
        "MOTORWAY_LINK_OVERLAP",
        "PEDESTRIAN_ACCESS_FORBIDDEN",
        "UNSAFE_AT_GRADE_MOTORWAY_CROSSING",
      ].includes(reason))
  ) reasons.add("DATA_INTEGRITY_FAILURE");
  if (
    input.roadSafetyStatus === "MANUAL_REVIEW_REQUIRED" &&
    !input.roadSafetyReasonCodes.some((reason) =>
      ["AMBIGUOUS_MOTORWAY_CROSSING", "ROAD_ACCESS_AMBIGUOUS"].includes(reason))
  ) reasons.add("WARNING_EVIDENCE_PRESENT");

  // Start context completeness gate (Phase 11F.1)
  if (input.startContext) {
    switch (input.startContext) {
      case "HUT_START":
        reasons.add("START_CONTEXT_HUT_START");
        break;
      case "BASE_START":
        reasons.add("START_CONTEXT_BASE_START");
        break;
      case "HIGH_MOUNTAIN_START":
        reasons.add("START_CONTEXT_HIGH_MOUNTAIN_START");
        break;
      case "AMBIGUOUS_START":
        reasons.add("START_CONTEXT_AMBIGUOUS_START");
        break;
    }
  } else {
    // No start context evidence available - fail closed for GREEN
    reasons.add("START_CONTEXT_AMBIGUOUS_START");
  }

  const reasonCodes = REASON_ORDER.filter((reason) => reasons.has(reason));
  const status: Phase11dQualificationStatus = reasonCodes.some((reason) => RED_REASONS.has(reason))
    ? "RED"
    : reasonCodes.some((reason) => YELLOW_REASONS.has(reason))
      ? "YELLOW"
      : "GREEN";
  const content = {
    qualificationContractVersion: PHASE11D_QUALIFICATION_CONTRACT,
    sourceRelationId: input.sourceRelationId,
    canonicalRouteSourceId: input.canonicalRouteSourceId,
    sourceUrl: input.sourceUrl,
    stagingIdempotencyKey: input.stagingIdempotencyKey,
    stagingPayloadHash: input.stagingPayloadHash,
    status,
    reasonCodes,
    qualityScore: input.qualityScore,
    routeType: input.routeType,
    topologyClassification: input.topologyClassification,
    connectedGroupCount: input.connectedGroupCount,
    physicalEndpointCount: input.physicalEndpointCount,
    endpointSelectionAmbiguous: input.endpointSelectionAmbiguous,
    roadSafetyStatus: input.roadSafetyStatus,
    roadSafetyReasonCodes: [...input.roadSafetyReasonCodes].sort(),
    summitIdentities: sortedSummits(input.summits),
    humanQaStatus: input.humanQaStatus ?? null,
    autoApprovalEnabled: PHASE11D_AUTO_APPROVAL_ENABLED,
    qaWrites: 0 as const,
  };
  return { ...content, deterministicQualificationHash: sha256Stable(content) };
}

export function selectPhase11dQueue(
  records: readonly Phase11dQualificationResult[],
  limit: number,
): Phase11dQualificationResult[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Queue limit must be positive.");
  const priority: Record<Phase11dQualificationStatus, number> = {
    GREEN: 0,
    YELLOW: 1,
    RED: 2,
  };
  const selected = [...records]
    .filter((record) => record.status !== "RED")
    .sort((left, right) =>
      priority[left.status] - priority[right.status] ||
      right.qualityScore - left.qualityScore ||
      left.sourceRelationId.localeCompare(right.sourceRelationId, "en", { numeric: true }))
    .slice(0, limit);
  const relationIds = selected.map((record) => record.sourceRelationId);
  const sourceUrls = selected.map((record) => record.sourceUrl);
  if (
    new Set(relationIds).size !== relationIds.length ||
    new Set(sourceUrls).size !== sourceUrls.length
  ) throw new Error("Phase 11D queue contains duplicate route identity.");
  return selected;
}

export function assertMachineGreenCannotPublish(input: {
  qualification: Phase11dQualificationResult;
  humanQaStatus: Phase11dHumanQaStatus;
}): void {
  if (
    input.qualification.status === "GREEN" &&
    input.humanQaStatus !== "VISUALLY_APPROVED"
  ) throw new Error("PHASE11D_HUMAN_QA_REQUIRED_FOR_PUBLICATION");
}
