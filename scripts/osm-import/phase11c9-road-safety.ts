import { resolve } from "node:path";

import { stableJson } from "./phase10-publication-gate.ts";
import { sha256Stable } from "./phase11-publication.ts";

export const PHASE11C9_ROAD_SAFETY_CONTRACT =
  "mountain-tracker-osm-road-safety/v1" as const;

export type RoadSafetyStatus = "SAFE" | "BLOCKED" | "MANUAL_REVIEW_REQUIRED";

export type RoadSafetyReasonCode =
  | "MOTORWAY_OVERLAP"
  | "MOTORWAY_LINK_OVERLAP"
  | "PEDESTRIAN_ACCESS_FORBIDDEN"
  | "ROAD_ACCESS_AMBIGUOUS"
  | "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"
  | "AMBIGUOUS_MOTORWAY_CROSSING"
  | "MAJOR_ROAD_CROSSING_REVIEW";

export type Coordinate = [number, number];

export interface RoadSafetyWayNode {
  nodeId: number;
  coordinate: Coordinate;
}

export interface RoadSafetyWay {
  id: number;
  tags: Record<string, string>;
  nodes: RoadSafetyWayNode[];
}

export interface RoadSafetySourceDatasetIdentity {
  pbfPath: string;
  pbfSizeBytes: number;
  pbfModifiedMilliseconds: number;
  pbfSha256: string;
  pipelineDatasetFingerprint: string;
  pipelineGeneratedAt: string;
  checkpointPath: string;
  checkpointManifestSha256: string;
  motorwayIndexContentHash: string;
}

export type MotorwayCrossingDecision =
  | "SAFE_GRADE_SEPARATED_CROSSING"
  | "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"
  | "AMBIGUOUS_MOTORWAY_CROSSING";

export interface MotorwayCrossingEvidence {
  routeWayId: number;
  roadWayId: number;
  roadHighwayType: "motorway" | "motorway_link";
  intersectionCoordinate: Coordinate;
  sharedNode: number | null;
  routeLayer: number | null;
  roadLayer: number | null;
  routeBridge: string | null;
  roadBridge: string | null;
  routeTunnel: string | null;
  roadTunnel: string | null;
  decision: MotorwayCrossingDecision;
}

export interface RoadSafetyRouteResult {
  canonicalRelationId: string;
  stagingRouteId: string;
  routeType: string;
  status: RoadSafetyStatus;
  reasonCodes: RoadSafetyReasonCode[];
  motorwayOverlapWayIds: number[];
  motorwayLinkOverlapWayIds: number[];
  forbiddenAccessWayIds: number[];
  ambiguousAccessWayIds: number[];
  motorwayCrossings: MotorwayCrossingEvidence[];
  ambiguousCrossings: MotorwayCrossingEvidence[];
  safeGradeSeparatedCrossings: MotorwayCrossingEvidence[];
  sourceDatasetIdentity: RoadSafetySourceDatasetIdentity;
  deterministicResultHash: string;
}

export interface RoadSafetyAnalysisMetrics {
  exactIntersectionChecks: number;
}

const FORBIDDEN_ACCESS_VALUES = new Set(["no", "private"]);
const ALLOWED_ACCESS_VALUES = new Set([
  "yes",
  "designated",
  "permissive",
  "official",
]);
const AMBIGUOUS_ACCESS_VALUES = new Set([
  "agricultural",
  "customers",
  "delivery",
  "destination",
  "discouraged",
  "forestry",
  "permit",
  "residents",
]);
const MAJOR_ROADS = new Set(["trunk", "primary", "secondary"]);
const REASON_ORDER: RoadSafetyReasonCode[] = [
  "MOTORWAY_OVERLAP",
  "MOTORWAY_LINK_OVERLAP",
  "PEDESTRIAN_ACCESS_FORBIDDEN",
  "ROAD_ACCESS_AMBIGUOUS",
  "UNSAFE_AT_GRADE_MOTORWAY_CROSSING",
  "AMBIGUOUS_MOTORWAY_CROSSING",
  "MAJOR_ROAD_CROSSING_REVIEW",
];

export type PedestrianAccessDecision =
  | "ALLOWED"
  | "FORBIDDEN"
  | "AMBIGUOUS"
  | "UNSPECIFIED";

function normalizedTag(tags: Record<string, string>, key: string): string | null {
  const value = tags[key]?.trim().toLowerCase();
  return value ? value : null;
}

function classifyAccessValue(value: string): PedestrianAccessDecision {
  if (FORBIDDEN_ACCESS_VALUES.has(value)) return "FORBIDDEN";
  if (ALLOWED_ACCESS_VALUES.has(value)) return "ALLOWED";
  if (AMBIGUOUS_ACCESS_VALUES.has(value)) return "AMBIGUOUS";
  return "AMBIGUOUS";
}

export function evaluatePedestrianAccess(
  tags: Record<string, string>,
): PedestrianAccessDecision {
  if (normalizedTag(tags, "foot:conditional") !== null) return "AMBIGUOUS";
  const foot = normalizedTag(tags, "foot");
  if (foot !== null) return classifyAccessValue(foot);
  if (normalizedTag(tags, "access:conditional") !== null) return "AMBIGUOUS";
  const access = normalizedTag(tags, "access");
  return access === null ? "UNSPECIFIED" : classifyAccessValue(access);
}

function numericLayer(tags: Record<string, string>): number | null {
  const value = normalizedTag(tags, "layer");
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function structureTag(tags: Record<string, string>, key: "bridge" | "tunnel"): string | null {
  const value = normalizedTag(tags, key);
  return value === null || ["no", "false", "0"].includes(value) ? null : value;
}

function crossingDecision(input: {
  sharedNode: number | null;
  routeTags: Record<string, string>;
  roadTags: Record<string, string>;
}): MotorwayCrossingDecision {
  const routeLayer = numericLayer(input.routeTags);
  const roadLayer = numericLayer(input.roadTags);
  const routeBridge = structureTag(input.routeTags, "bridge");
  const roadBridge = structureTag(input.roadTags, "bridge");
  const routeTunnel = structureTag(input.routeTags, "tunnel");
  const roadTunnel = structureTag(input.roadTags, "tunnel");
  const differentLayers =
    routeLayer !== null && roadLayer !== null && routeLayer !== roadLayer;
  const equalLayers =
    routeLayer !== null && roadLayer !== null && routeLayer === roadLayer;
  const routeStructured = routeBridge !== null || routeTunnel !== null;
  const roadStructured = roadBridge !== null || roadTunnel !== null;
  const exactlyOneStructured = routeStructured !== roadStructured;

  if (input.sharedNode !== null) {
    if (differentLayers || exactlyOneStructured) {
      return "AMBIGUOUS_MOTORWAY_CROSSING";
    }
    return "UNSAFE_AT_GRADE_MOTORWAY_CROSSING";
  }
  if (differentLayers) return "SAFE_GRADE_SEPARATED_CROSSING";
  if (exactlyOneStructured) return "SAFE_GRADE_SEPARATED_CROSSING";
  if (equalLayers) return "UNSAFE_AT_GRADE_MOTORWAY_CROSSING";
  return "AMBIGUOUS_MOTORWAY_CROSSING";
}

function cross(a: Coordinate, b: Coordinate, c: Coordinate): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function within(value: number, left: number, right: number): boolean {
  return value >= Math.min(left, right) - 1e-12 && value <= Math.max(left, right) + 1e-12;
}

function pointOnSegment(point: Coordinate, start: Coordinate, end: Coordinate): boolean {
  return Math.abs(cross(start, end, point)) <= 1e-12 &&
    within(point[0], start[0], end[0]) && within(point[1], start[1], end[1]);
}

function segmentIntersection(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
): Coordinate | null {
  const denominator =
    (firstStart[0] - firstEnd[0]) * (secondStart[1] - secondEnd[1]) -
    (firstStart[1] - firstEnd[1]) * (secondStart[0] - secondEnd[0]);
  if (Math.abs(denominator) <= 1e-15) {
    for (const point of [firstStart, firstEnd, secondStart, secondEnd]) {
      if (pointOnSegment(point, firstStart, firstEnd) &&
          pointOnSegment(point, secondStart, secondEnd)) return [...point] as Coordinate;
    }
    return null;
  }
  const firstDeterminant = firstStart[0] * firstEnd[1] - firstStart[1] * firstEnd[0];
  const secondDeterminant = secondStart[0] * secondEnd[1] - secondStart[1] * secondEnd[0];
  const point: Coordinate = [
    (firstDeterminant * (secondStart[0] - secondEnd[0]) -
      (firstStart[0] - firstEnd[0]) * secondDeterminant) / denominator,
    (firstDeterminant * (secondStart[1] - secondEnd[1]) -
      (firstStart[1] - firstEnd[1]) * secondDeterminant) / denominator,
  ];
  return pointOnSegment(point, firstStart, firstEnd) &&
    pointOnSegment(point, secondStart, secondEnd) ? point : null;
}

function commonSegmentNode(
  routeStart: RoadSafetyWayNode,
  routeEnd: RoadSafetyWayNode,
  roadStart: RoadSafetyWayNode,
  roadEnd: RoadSafetyWayNode,
): number | null {
  const routeIds = new Set([routeStart.nodeId, routeEnd.nodeId]);
  return [roadStart.nodeId, roadEnd.nodeId].find((id) => routeIds.has(id)) ?? null;
}

function crossingKey(value: MotorwayCrossingEvidence): string {
  return [
    value.routeWayId,
    value.roadWayId,
    value.sharedNode ?? "none",
    value.intersectionCoordinate.map((coordinate) => coordinate.toFixed(9)).join(","),
    value.decision,
  ].join(":");
}

function findMotorwayCrossings(
  routeWays: RoadSafetyWay[],
  motorwayWays: RoadSafetyWay[],
  metrics?: RoadSafetyAnalysisMetrics,
): MotorwayCrossingEvidence[] {
  const routeWayIds = new Set(routeWays.map((way) => way.id));
  const crossings = new Map<string, MotorwayCrossingEvidence>();
  for (const routeWay of routeWays) {
    for (const roadWay of motorwayWays) {
      if (routeWayIds.has(roadWay.id)) continue;
      const highway = normalizedTag(roadWay.tags, "highway");
      if (highway !== "motorway" && highway !== "motorway_link") continue;
      for (let routeIndex = 1; routeIndex < routeWay.nodes.length; routeIndex += 1) {
        const routeStart = routeWay.nodes[routeIndex - 1];
        const routeEnd = routeWay.nodes[routeIndex];
        for (let roadIndex = 1; roadIndex < roadWay.nodes.length; roadIndex += 1) {
          if (metrics) metrics.exactIntersectionChecks += 1;
          const roadStart = roadWay.nodes[roadIndex - 1];
          const roadEnd = roadWay.nodes[roadIndex];
          const coordinate = segmentIntersection(
            routeStart.coordinate,
            routeEnd.coordinate,
            roadStart.coordinate,
            roadEnd.coordinate,
          );
          if (!coordinate) continue;
          const sharedNode = commonSegmentNode(routeStart, routeEnd, roadStart, roadEnd);
          const evidence: MotorwayCrossingEvidence = {
            routeWayId: routeWay.id,
            roadWayId: roadWay.id,
            roadHighwayType: highway,
            intersectionCoordinate: coordinate.map((value) => Number(value.toFixed(9))) as Coordinate,
            sharedNode,
            routeLayer: numericLayer(routeWay.tags),
            roadLayer: numericLayer(roadWay.tags),
            routeBridge: structureTag(routeWay.tags, "bridge"),
            roadBridge: structureTag(roadWay.tags, "bridge"),
            routeTunnel: structureTag(routeWay.tags, "tunnel"),
            roadTunnel: structureTag(roadWay.tags, "tunnel"),
            decision: crossingDecision({
              sharedNode,
              routeTags: routeWay.tags,
              roadTags: roadWay.tags,
            }),
          };
          crossings.set(crossingKey(evidence), evidence);
        }
      }
    }
  }
  return [...crossings.values()].sort((left, right) =>
    left.routeWayId - right.routeWayId ||
    left.roadWayId - right.roadWayId ||
    (left.sharedNode ?? -1) - (right.sharedNode ?? -1) ||
    left.intersectionCoordinate[0] - right.intersectionCoordinate[0] ||
    left.intersectionCoordinate[1] - right.intersectionCoordinate[1]);
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function analyzeRouteRoadSafety(input: {
  canonicalRelationId: string;
  stagingRouteId: string;
  routeType: string;
  routeWays: RoadSafetyWay[];
  nearbyMotorwayWays: RoadSafetyWay[];
  sourceDatasetIdentity: RoadSafetySourceDatasetIdentity;
  metrics?: RoadSafetyAnalysisMetrics;
}): RoadSafetyRouteResult {
  const motorwayOverlapWayIds: number[] = [];
  const motorwayLinkOverlapWayIds: number[] = [];
  const forbiddenAccessWayIds: number[] = [];
  const ambiguousAccessWayIds: number[] = [];
  const reasonCodes = new Set<RoadSafetyReasonCode>();

  for (const way of input.routeWays) {
    const highway = normalizedTag(way.tags, "highway");
    if (highway === "motorway") {
      motorwayOverlapWayIds.push(way.id);
      reasonCodes.add("MOTORWAY_OVERLAP");
    } else if (highway === "motorway_link") {
      motorwayLinkOverlapWayIds.push(way.id);
      reasonCodes.add("MOTORWAY_LINK_OVERLAP");
    }
    const access = evaluatePedestrianAccess(way.tags);
    if (access === "FORBIDDEN") {
      forbiddenAccessWayIds.push(way.id);
      reasonCodes.add("PEDESTRIAN_ACCESS_FORBIDDEN");
    } else if (access === "AMBIGUOUS") {
      ambiguousAccessWayIds.push(way.id);
      reasonCodes.add("ROAD_ACCESS_AMBIGUOUS");
    }
    if (highway !== null && MAJOR_ROADS.has(highway) && access !== "FORBIDDEN") {
      reasonCodes.add("MAJOR_ROAD_CROSSING_REVIEW");
    }
  }

  const motorwayCrossings = findMotorwayCrossings(
    input.routeWays,
    input.nearbyMotorwayWays,
    input.metrics,
  );
  const ambiguousCrossings = motorwayCrossings.filter(
    (crossing) => crossing.decision === "AMBIGUOUS_MOTORWAY_CROSSING",
  );
  const safeGradeSeparatedCrossings = motorwayCrossings.filter(
    (crossing) => crossing.decision === "SAFE_GRADE_SEPARATED_CROSSING",
  );
  if (motorwayCrossings.some(
    (crossing) => crossing.decision === "UNSAFE_AT_GRADE_MOTORWAY_CROSSING")) {
    reasonCodes.add("UNSAFE_AT_GRADE_MOTORWAY_CROSSING");
  }
  if (ambiguousCrossings.length > 0) reasonCodes.add("AMBIGUOUS_MOTORWAY_CROSSING");

  const hardBlock = [
    "MOTORWAY_OVERLAP",
    "MOTORWAY_LINK_OVERLAP",
    "PEDESTRIAN_ACCESS_FORBIDDEN",
    "UNSAFE_AT_GRADE_MOTORWAY_CROSSING",
  ].some((reason) => reasonCodes.has(reason as RoadSafetyReasonCode));
  const manualReview = ["ROAD_ACCESS_AMBIGUOUS", "AMBIGUOUS_MOTORWAY_CROSSING"]
    .some((reason) => reasonCodes.has(reason as RoadSafetyReasonCode));
  const status: RoadSafetyStatus = hardBlock
    ? "BLOCKED"
    : manualReview
      ? "MANUAL_REVIEW_REQUIRED"
      : "SAFE";
  const content = {
    canonicalRelationId: input.canonicalRelationId,
    stagingRouteId: input.stagingRouteId,
    routeType: input.routeType,
    status,
    reasonCodes: REASON_ORDER.filter((reason) => reasonCodes.has(reason)),
    motorwayOverlapWayIds: sortedUnique(motorwayOverlapWayIds),
    motorwayLinkOverlapWayIds: sortedUnique(motorwayLinkOverlapWayIds),
    forbiddenAccessWayIds: sortedUnique(forbiddenAccessWayIds),
    ambiguousAccessWayIds: sortedUnique(ambiguousAccessWayIds),
    motorwayCrossings,
    ambiguousCrossings,
    safeGradeSeparatedCrossings,
    sourceDatasetIdentity: input.sourceDatasetIdentity,
  };
  return { ...content, deterministicResultHash: sha256Stable(content) };
}

export interface Phase11C9RoadSafetyReport {
  schemaVersion: 1;
  artifactType: "PHASE11C9_ROAD_SAFETY_BATCH_100";
  roadSafetyContractVersion: typeof PHASE11C9_ROAD_SAFETY_CONTRACT;
  readOnly: true;
  lockedManifestPath: string;
  lockedManifestHash: string;
  sourceDatasetIdentity: RoadSafetySourceDatasetIdentity;
  summary: {
    total: number;
    safe: number;
    blocked: number;
    manualReviewRequired: number;
    safeGradeSeparatedCrossings: number;
    reasonCodeDistribution: Partial<Record<RoadSafetyReasonCode, number>>;
  };
  records: RoadSafetyRouteResult[];
  writes: { rpcCalls: 0; databaseWrites: 0; qaWrites: 0; publicationWrites: 0 };
  deterministicReportHash: string;
}

export function createPhase11C9RoadSafetyReport(input: {
  lockedManifestPath: string;
  lockedManifestHash: string;
  sourceDatasetIdentity: RoadSafetySourceDatasetIdentity;
  records: RoadSafetyRouteResult[];
}): Phase11C9RoadSafetyReport {
  const records = [...input.records];
  const reasonCodeDistribution: Partial<Record<RoadSafetyReasonCode, number>> = {};
  for (const record of records) {
    for (const reason of record.reasonCodes) {
      reasonCodeDistribution[reason] = (reasonCodeDistribution[reason] ?? 0) + 1;
    }
  }
  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C9_ROAD_SAFETY_BATCH_100" as const,
    roadSafetyContractVersion: PHASE11C9_ROAD_SAFETY_CONTRACT,
    readOnly: true as const,
    lockedManifestPath: input.lockedManifestPath,
    lockedManifestHash: input.lockedManifestHash,
    sourceDatasetIdentity: input.sourceDatasetIdentity,
    summary: {
      total: records.length,
      safe: records.filter((record) => record.status === "SAFE").length,
      blocked: records.filter((record) => record.status === "BLOCKED").length,
      manualReviewRequired: records.filter(
        (record) => record.status === "MANUAL_REVIEW_REQUIRED").length,
      safeGradeSeparatedCrossings: records.reduce(
        (total, record) => total + record.safeGradeSeparatedCrossings.length,
        0,
      ),
      reasonCodeDistribution,
    },
    records,
    writes: {
      rpcCalls: 0 as const,
      databaseWrites: 0 as const,
      qaWrites: 0 as const,
      publicationWrites: 0 as const,
    },
  };
  return { ...content, deterministicReportHash: sha256Stable(content) };
}

export function verifyPhase11C9RoadSafetyReport(
  report: Phase11C9RoadSafetyReport,
): void {
  const { deterministicReportHash, ...content } = report;
  if (
    report.roadSafetyContractVersion !== PHASE11C9_ROAD_SAFETY_CONTRACT ||
    report.readOnly !== true ||
    report.writes.rpcCalls !== 0 ||
    report.writes.databaseWrites !== 0 ||
    report.writes.qaWrites !== 0 ||
    report.writes.publicationWrites !== 0 ||
    sha256Stable(content) !== deterministicReportHash ||
    report.records.some((record) => {
      const { deterministicResultHash, ...recordContent } = record;
      return sha256Stable(recordContent) !== deterministicResultHash;
    })
  ) {
    throw new Error("PHASE11C9_ROAD_SAFETY_REPORT_DRIFT");
  }
  const expected = createPhase11C9RoadSafetyReport({
    lockedManifestPath: report.lockedManifestPath,
    lockedManifestHash: report.lockedManifestHash,
    sourceDatasetIdentity: report.sourceDatasetIdentity,
    records: report.records,
  });
  if (stableJson(expected) !== stableJson(report)) {
    throw new Error("PHASE11C9_ROAD_SAFETY_REPORT_CONTENT_DRIFT");
  }
}

export function verifyPhase11C9RoadSafetyPublicationGate(input: {
  report: Phase11C9RoadSafetyReport;
  manifestPath: string;
  manifestHash: string;
  manifestRecords: Array<{
    canonicalRouteSourceId: string;
    stagingRouteId: string;
  }>;
  pipelineDatasetFingerprint: string;
}): void {
  verifyPhase11C9RoadSafetyReport(input.report);
  if (
    resolve(input.report.lockedManifestPath) !== resolve(input.manifestPath) ||
    input.report.lockedManifestHash !== input.manifestHash ||
    input.report.sourceDatasetIdentity.pipelineDatasetFingerprint !==
      input.pipelineDatasetFingerprint ||
    input.manifestRecords.length !== 100 ||
    input.report.records.length !== input.manifestRecords.length
  ) {
    throw new Error("PHASE11C9_ROAD_SAFETY_PUBLICATION_IDENTITY_DRIFT");
  }
  for (let index = 0; index < input.manifestRecords.length; index += 1) {
    const manifestRecord = input.manifestRecords[index];
    const safetyRecord = input.report.records[index];
    if (
      safetyRecord.canonicalRelationId !== manifestRecord.canonicalRouteSourceId ||
      safetyRecord.stagingRouteId !== manifestRecord.stagingRouteId
    ) {
      throw new Error("PHASE11C9_ROAD_SAFETY_RECORD_SET_DRIFT");
    }
  }
  if (
    input.report.summary.safe !== input.manifestRecords.length ||
    input.report.summary.blocked !== 0 ||
    input.report.summary.manualReviewRequired !== 0 ||
    input.report.records.some((record) => record.status !== "SAFE")
  ) {
    throw new Error("PHASE11C9_ROAD_SAFETY_NOT_SAFE");
  }
}

export function requireSafeRoadSafetyRecords<T extends { canonicalRouteSourceId: string }>(
  records: T[],
  safetyRecords: RoadSafetyRouteResult[],
): T[] {
  const safetyByRelation = new Map(
    safetyRecords.map((record) => [record.canonicalRelationId, record]),
  );
  return records.filter((record) =>
    safetyByRelation.get(record.canonicalRouteSourceId)?.status === "SAFE");
}
