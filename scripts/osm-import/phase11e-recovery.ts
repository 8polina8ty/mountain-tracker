import type { PreviewRouteGeometry } from "../../Lib/osmStagingPreview/core.ts";
import type { RouteTopologyAnalysis } from "../../Lib/osmStagingPreview/topology.ts";
import type { OplRelation, OplWay } from "./opl-parser.ts";
import {
  hashImportContract,
  type ImportPlanRecord,
  type MountainCatalogRecord,
  type Phase7CanonicalRouteRecord,
  type Phase7EligibilityRecord,
} from "./phase8-staging.ts";
import { sha256Stable } from "./phase11-publication.ts";
import {
  qualifyPhase11dRoute,
  type Phase11dQualificationInput,
  type Phase11dQualificationResult,
} from "./phase11d-qualification.ts";
import {
  calculateRouteQuality,
  type ClassifiableRoute,
  type RouteQualityResult,
} from "./route-classifier.ts";

export const PHASE11E_RECOVERY_CONTRACT =
  "mountain-tracker-osm-candidate-recovery/v1" as const;
export const PHASE11E_GREEN_MINIMUM_QUALITY = 90;
export const PHASE11E_AUTO_APPROVAL_ENABLED = false as const;

export type Phase11eExclusionReason =
  | "DUPLICATE_RELATION_REPRESENTATION"
  | "MISSING_CANONICAL_AUDIT_RECORD"
  | "MISSING_PHASE7_ELIGIBILITY"
  | "PHASE7_QUALITY_BELOW_AUTO_THRESHOLD"
  | "PHASE7_MULTIPLE_SUMMITS"
  | "PHASE7_HIGH_FRAGMENTATION"
  | "PHASE7_SUSPICIOUS_SHORT"
  | "PHASE7_SUSPICIOUS_LONG"
  | "PHASE7_MISSING_ROUTE_NAME"
  | "PHASE7_MANUAL_REVIEW_OTHER"
  | "PHASE7_EXCLUDED"
  | "UNSUPPORTED_PHASE7_DISPOSITION";

export type Phase11eTopologyCause =
  | "GENUINELY_INVALID_OR_INCOMPLETE_RELATION"
  | "VALID_CLOSED_LOOP"
  | "SIMPLE_MAIN_ROUTE_WITH_EXPLICIT_SPUR"
  | "RELATION_CONTAINS_EXPLICIT_ALTERNATIVES"
  | "ROUTE_ORDERING_RECONSTRUCTION_ARTIFACT"
  | "DISCONNECTED_RELATION_DATA"
  | "ENDPOINT_AMBIGUITY"
  | "DUPLICATE_OR_REVERSED_MEMBER_ARTIFACT";

export type Phase11eMemberChainFailure =
  | "RELATION_MISSING"
  | "RELATION_HAS_NO_WAY_MEMBERS"
  | "NESTED_RELATION_REQUIRES_REVIEW"
  | "EXPLICIT_ALTERNATIVE_OR_SPUR_ROLE"
  | "DUPLICATE_WAY_MEMBER"
  | "WAY_MISSING"
  | "WAY_GEOMETRY_INVALID"
  | "CLOSED_WAY_MEMBER_REQUIRES_REVIEW"
  | "MEMBER_GRAPH_NOT_SINGLE_PATH"
  | "MEMBER_GRAPH_DISCONNECTED"
  | "DIRECTION_ROLE_CONFLICT";

export interface Phase11eMemberStore {
  getRelation(id: number): OplRelation | null;
  getWay(id: number): OplWay | null;
}

export interface Phase11eMemberChainRecovery {
  status: "RECOVERED";
  reasonCode: "TOPOLOGY_RECOVERED_PRIMARY_PATH";
  geometry: Extract<PreviewRouteGeometry, { type: "LineString" }>;
  memberWayIds: number[];
  orderedWayIds: number[];
  reversedWayIds: number[];
  discardedWayIds: [];
  originalComponentCount: number;
  recoveredComponentCount: 1;
  proof: string;
  deterministicRecoveryHash: string;
}

export interface Phase11eMemberChainBlocked {
  status: "BLOCKED";
  reasonCode: Phase11eMemberChainFailure;
  memberWayIds: number[];
  memberRoles: string[];
}

export type Phase11eMemberChainResult =
  | Phase11eMemberChainRecovery
  | Phase11eMemberChainBlocked;

export interface Phase11eQualificationResult
  extends Omit<
    Phase11dQualificationResult,
    "qualificationContractVersion" | "reasonCodes" | "deterministicQualificationHash"
  > {
  qualificationContractVersion: typeof PHASE11E_RECOVERY_CONTRACT;
  reasonCodes: string[];
  recoveredByPhase11e: boolean;
  recoveryReasonCodes: string[];
  basePhase11dQualificationHash: string;
  deterministicQualificationHash: string;
}

const ALLOWED_DIRECTION_ROLES = new Set(["", "forward", "backward"]);
const ALTERNATIVE_ROLES = new Set([
  "alternative",
  "alternate",
  "variant",
  "excursion",
  "spur",
  "link",
  "approach",
]);

function compareNumericIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function normalizedRole(value: string): string {
  return value.trim().toLowerCase();
}

function blocked(
  reasonCode: Phase11eMemberChainFailure,
  members: Array<{ ref: number; role: string }>,
): Phase11eMemberChainBlocked {
  return {
    status: "BLOCKED",
    reasonCode,
    memberWayIds: members.map((member) => member.ref),
    memberRoles: [...new Set(members.map((member) => normalizedRole(member.role)))].sort(),
  };
}

interface Traversal {
  orderedWays: OplWay[];
  reversedWayIds: number[];
  coordinates: [number, number][];
}

function attemptTraversal(
  startNodeId: number,
  ways: OplWay[],
  roles: ReadonlyMap<number, string>,
  adjacency: ReadonlyMap<number, number[]>,
): Traversal | null {
  const byId = new Map(ways.map((way) => [way.id, way]));
  const unused = new Set(ways.map((way) => way.id));
  const orderedWays: OplWay[] = [];
  const reversedWayIds: number[] = [];
  const coordinates: [number, number][] = [];
  let currentNodeId = startNodeId;

  while (unused.size > 0) {
    const candidates = (adjacency.get(currentNodeId) ?? []).filter((id) => unused.has(id));
    if (candidates.length !== 1) return null;
    const way = byId.get(candidates[0]);
    if (!way) return null;
    const startsAtCurrent = way.nodes[0].nodeId === currentNodeId;
    const endsAtCurrent = way.nodes.at(-1)?.nodeId === currentNodeId;
    if (!startsAtCurrent && !endsAtCurrent) return null;
    const reversed = !startsAtCurrent;
    const role = roles.get(way.id) ?? "";
    if ((role === "forward" && reversed) || (role === "backward" && !reversed)) {
      return null;
    }
    const nodes = reversed ? [...way.nodes].reverse() : way.nodes;
    const wayCoordinates = nodes.map((node) => node.coordinate as [number, number]);
    coordinates.push(...(coordinates.length === 0 ? wayCoordinates : wayCoordinates.slice(1)));
    orderedWays.push(way);
    if (reversed) reversedWayIds.push(way.id);
    unused.delete(way.id);
    currentNodeId = nodes.at(-1)?.nodeId as number;
  }
  return { orderedWays, reversedWayIds, coordinates };
}

export function recoverDeterministicMemberChain(input: {
  relationId: string;
  originalComponentCount: number;
  store: Phase11eMemberStore;
}): Phase11eMemberChainResult {
  const relation = input.store.getRelation(Number(input.relationId));
  if (!relation) return blocked("RELATION_MISSING", []);
  const members = relation.members.filter((member) => member.type === "way");
  if (members.length === 0) return blocked("RELATION_HAS_NO_WAY_MEMBERS", []);
  if (relation.members.some((member) => member.type === "relation")) {
    return blocked("NESTED_RELATION_REQUIRES_REVIEW", members);
  }
  const roles = members.map((member) => normalizedRole(member.role));
  if (roles.some((role) => !ALLOWED_DIRECTION_ROLES.has(role))) {
    return blocked("EXPLICIT_ALTERNATIVE_OR_SPUR_ROLE", members);
  }
  if (new Set(members.map((member) => member.ref)).size !== members.length) {
    return blocked("DUPLICATE_WAY_MEMBER", members);
  }

  const ways: OplWay[] = [];
  for (const member of members) {
    const way = input.store.getWay(member.ref);
    if (!way) return blocked("WAY_MISSING", members);
    if (way.nodes.length < 2 || way.nodes.some((node) => node.coordinate === null)) {
      return blocked("WAY_GEOMETRY_INVALID", members);
    }
    if (way.nodes[0].nodeId === way.nodes.at(-1)?.nodeId) {
      return blocked("CLOSED_WAY_MEMBER_REQUIRES_REVIEW", members);
    }
    ways.push(way);
  }

  const adjacency = new Map<number, number[]>();
  for (const way of ways) {
    for (const nodeId of [way.nodes[0].nodeId, way.nodes.at(-1)?.nodeId as number]) {
      adjacency.set(nodeId, [...(adjacency.get(nodeId) ?? []), way.id]);
    }
  }
  const endpoints = [...adjacency.entries()]
    .filter(([, wayIds]) => wayIds.length === 1)
    .map(([nodeId]) => nodeId)
    .sort((left, right) => left - right);
  if (endpoints.length !== 2 || [...adjacency.values()].some((wayIds) => wayIds.length > 2)) {
    return blocked("MEMBER_GRAPH_NOT_SINGLE_PATH", members);
  }

  const visited = new Set<number>();
  const stack = [ways[0].id];
  const waysById = new Map(ways.map((way) => [way.id, way]));
  while (stack.length > 0) {
    const wayId = stack.pop() as number;
    if (visited.has(wayId)) continue;
    visited.add(wayId);
    const way = waysById.get(wayId) as OplWay;
    for (const nodeId of [way.nodes[0].nodeId, way.nodes.at(-1)?.nodeId as number]) {
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
  }
  if (visited.size !== ways.length) return blocked("MEMBER_GRAPH_DISCONNECTED", members);

  const roleByWay = new Map(members.map((member) => [member.ref, normalizedRole(member.role)]));
  const traversals = endpoints
    .map((endpoint) => attemptTraversal(endpoint, ways, roleByWay, adjacency))
    .filter((value): value is Traversal => value !== null)
    .sort((left, right) =>
      JSON.stringify({
        ways: left.orderedWays.map((way) => way.id),
        reversed: left.reversedWayIds,
      }).localeCompare(JSON.stringify({
        ways: right.orderedWays.map((way) => way.id),
        reversed: right.reversedWayIds,
      })),
    );
  if (traversals.length === 0) return blocked("DIRECTION_ROLE_CONFLICT", members);
  const traversal = traversals[0];
  const content = {
    status: "RECOVERED" as const,
    reasonCode: "TOPOLOGY_RECOVERED_PRIMARY_PATH" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: traversal.coordinates,
    },
    memberWayIds: [...members.map((member) => member.ref)].sort((left, right) => left - right),
    orderedWayIds: traversal.orderedWays.map((way) => way.id),
    reversedWayIds: [...traversal.reversedWayIds].sort((left, right) => left - right),
    discardedWayIds: [] as [],
    originalComponentCount: input.originalComponentCount,
    recoveredComponentCount: 1 as const,
    proof: "Every direct OSM way member forms one node-ID-connected path and is used exactly once; only member ordering/orientation changes.",
  };
  return { ...content, deterministicRecoveryHash: sha256Stable(content) };
}

function routeDistanceMeters(coordinates: [number, number][]): number {
  const radians = Math.PI / 180;
  const earthRadiusMeters = 6_371_008.8;
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const latitudeDelta = (right[1] - left[1]) * radians;
    const longitudeDelta = (right[0] - left[0]) * radians;
    const leftLatitude = left[1] * radians;
    const rightLatitude = right[1] * radians;
    const value =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(leftLatitude) * Math.cos(rightLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;
    total += 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(value)));
  }
  return Math.round(total);
}

export function recoveredRouteQuality(
  route: ClassifiableRoute,
  recovery: Phase11eMemberChainRecovery,
): RouteQualityResult {
  return calculateRouteQuality({
    ...route,
    geometry: recovery.geometry,
    stats: {
      distanceMeters: routeDistanceMeters(recovery.geometry.coordinates),
      coordinatePoints: recovery.geometry.coordinates.length,
      componentCount: 1,
    },
  });
}

export function applyMemberChainRecoveryToPlan(input: {
  record: ImportPlanRecord;
  recovery: Phase11eMemberChainRecovery;
  qualityScore: number;
}): ImportPlanRecord {
  const coordinates = input.recovery.geometry.coordinates;
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  const contract = {
    ...input.record.contract,
    route: {
      ...input.record.contract.route,
      qualityScore: input.qualityScore,
      geometry: input.recovery.geometry,
      geometryType: "LineString" as const,
      distanceMeters: routeDistanceMeters(coordinates),
      componentCount: 1,
      bounds: {
        minimumLongitude: Math.min(...longitudes),
        minimumLatitude: Math.min(...latitudes),
        maximumLongitude: Math.max(...longitudes),
        maximumLatitude: Math.max(...latitudes),
      },
    },
  };
  return {
    ...input.record,
    reasons: [
      ...input.record.reasons,
      "Phase 11E deterministically restored the complete OSM member chain without discarding geometry.",
    ],
    payloadHash: hashImportContract(contract),
    contract,
  };
}

export function qualifyPhase11eRoute(input: {
  qualificationInput: Phase11dQualificationInput;
  recovery: Phase11eMemberChainRecovery | null;
}): Phase11eQualificationResult {
  const base = qualifyPhase11dRoute(input.qualificationInput);
  const basePhase11dQualificationHash = base.deterministicQualificationHash;
  const baseContent = Object.fromEntries(
    Object.entries(base).filter(([key]) => key !== "deterministicQualificationHash"),
  ) as Omit<Phase11dQualificationResult, "deterministicQualificationHash">;
  const recoveryReasonCodes = input.recovery
    ? [
        "TOPOLOGY_RECOVERED_PRIMARY_PATH",
        "QUALITY_RECALCULATED_FROM_RECOVERED_GEOMETRY",
      ]
    : [];
  const content = {
    ...baseContent,
    qualificationContractVersion: PHASE11E_RECOVERY_CONTRACT,
    reasonCodes: [...recoveryReasonCodes, ...base.reasonCodes],
    recoveredByPhase11e: input.recovery !== null,
    recoveryReasonCodes,
    basePhase11dQualificationHash,
  };
  return {
    ...content,
    deterministicQualificationHash: sha256Stable(content),
  };
}

export function selectPhase11eQueue(
  records: readonly Phase11eQualificationResult[],
  limit: number,
): Phase11eQualificationResult[] {
  const selected = [...records]
    .filter((record) => record.status !== "RED")
    .sort((left, right) =>
      (left.status === "GREEN" ? 0 : 2) - (right.status === "GREEN" ? 0 : 2) ||
      Number(right.recoveredByPhase11e) - Number(left.recoveredByPhase11e) ||
      right.qualityScore - left.qualityScore ||
      compareNumericIds(left.sourceRelationId, right.sourceRelationId),
    )
    .slice(0, limit);
  if (new Set(selected.map((record) => record.sourceRelationId)).size !== selected.length) {
    throw new Error("Phase 11E queue contains duplicate relation identity.");
  }
  return selected;
}

export function resolveExactMountainIdentity(
  peakOsmId: string,
  mountains: readonly Pick<MountainCatalogRecord, "id" | "osmId">[],
): { status: "EXACT"; mountainId: number } | { status: "MISSING" | "AMBIGUOUS"; mountainIds: number[] } {
  const ids = mountains
    .filter((mountain) => mountain.osmId === peakOsmId)
    .map((mountain) => mountain.id)
    .sort((left, right) => left - right);
  if (ids.length === 1) return { status: "EXACT", mountainId: ids[0] };
  return { status: ids.length === 0 ? "MISSING" : "AMBIGUOUS", mountainIds: ids };
}

function primaryManualReason(record: Phase7EligibilityRecord): Phase11eExclusionReason {
  if (record.eligibility === "EXCLUDE") return "PHASE7_EXCLUDED";
  if (record.eligibility !== "MANUAL_REVIEW_REQUIRED") {
    return "UNSUPPORTED_PHASE7_DISPOSITION";
  }
  if (record.qualityScore < 70) return "PHASE7_QUALITY_BELOW_AUTO_THRESHOLD";
  if (record.auditFlags.includes("MULTIPLE_SUMMITS")) return "PHASE7_MULTIPLE_SUMMITS";
  if (record.auditFlags.includes("HIGH_FRAGMENTATION")) return "PHASE7_HIGH_FRAGMENTATION";
  if (record.auditFlags.includes("SUSPICIOUS_SHORT")) return "PHASE7_SUSPICIOUS_SHORT";
  if (record.auditFlags.includes("SUSPICIOUS_LONG")) return "PHASE7_SUSPICIOUS_LONG";
  if (record.auditFlags.includes("MISSING_NAME")) return "PHASE7_MISSING_ROUTE_NAME";
  return "PHASE7_MANUAL_REVIEW_OTHER";
}

export function createSummitRouteExclusionLedger(input: {
  summitRouteRelationIds: readonly string[];
  canonicalRoutes: readonly Phase7CanonicalRouteRecord[];
  eligibilityRecords: readonly Phase7EligibilityRecord[];
  candidateRelationIds: ReadonlySet<string>;
}): {
  includedRelationIds: string[];
  excludedRelationIdsByPrimaryReason: Record<string, string[]>;
  exclusionDistribution: Record<string, number>;
} {
  const canonicalBySource = new Map<string, string>();
  for (const route of input.canonicalRoutes) {
    for (const sourceId of route.sourceRouteIds) {
      canonicalBySource.set(sourceId, route.canonicalRouteSourceId);
    }
  }
  const eligibilityById = new Map(
    input.eligibilityRecords.map((record) => [record.canonicalRouteSourceId, record]),
  );
  const groups = new Map<Phase11eExclusionReason, string[]>();
  const included: string[] = [];
  for (const relationId of [...input.summitRouteRelationIds].sort(compareNumericIds)) {
    const canonicalId = canonicalBySource.get(relationId);
    let reason: Phase11eExclusionReason | null = null;
    if (!canonicalId) reason = "MISSING_CANONICAL_AUDIT_RECORD";
    else if (canonicalId !== relationId) reason = "DUPLICATE_RELATION_REPRESENTATION";
    else if (input.candidateRelationIds.has(canonicalId)) included.push(relationId);
    else {
      const eligibility = eligibilityById.get(canonicalId);
      reason = eligibility ? primaryManualReason(eligibility) : "MISSING_PHASE7_ELIGIBILITY";
    }
    if (reason) groups.set(reason, [...(groups.get(reason) ?? []), relationId]);
  }
  const excludedRelationIdsByPrimaryReason = Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    includedRelationIds: included,
    excludedRelationIdsByPrimaryReason,
    exclusionDistribution: Object.fromEntries(
      Object.entries(excludedRelationIdsByPrimaryReason).map(([reason, ids]) => [reason, ids.length]),
    ),
  };
}

export function classifyTopologyCause(input: {
  topology: RouteTopologyAnalysis;
  explicitlySupportedClosedLoop: boolean;
  recovery: Phase11eMemberChainResult;
}): Phase11eTopologyCause {
  if (input.recovery.status === "RECOVERED") {
    return "ROUTE_ORDERING_RECONSTRUCTION_ARTIFACT";
  }
  if (
    input.explicitlySupportedClosedLoop &&
    input.topology.connectedGroupCount === 1 &&
    input.topology.physicalEndpointCount === 0
  ) return "VALID_CLOSED_LOOP";
  if (input.recovery.reasonCode === "DUPLICATE_WAY_MEMBER") {
    return "DUPLICATE_OR_REVERSED_MEMBER_ARTIFACT";
  }
  if (input.recovery.reasonCode === "EXPLICIT_ALTERNATIVE_OR_SPUR_ROLE") {
    return input.recovery.memberRoles.some((role) => ALTERNATIVE_ROLES.has(role) && role === "spur")
      ? "SIMPLE_MAIN_ROUTE_WITH_EXPLICIT_SPUR"
      : "RELATION_CONTAINS_EXPLICIT_ALTERNATIVES";
  }
  if (input.topology.classification === "DISCONNECTED") {
    return "DISCONNECTED_RELATION_DATA";
  }
  if (
    input.recovery.reasonCode === "RELATION_MISSING" ||
    input.recovery.reasonCode === "WAY_MISSING" ||
    input.recovery.reasonCode === "WAY_GEOMETRY_INVALID"
  ) return "GENUINELY_INVALID_OR_INCOMPLETE_RELATION";
  return "ENDPOINT_AMBIGUITY";
}
