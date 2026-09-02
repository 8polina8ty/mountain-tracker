import { createHash } from "node:crypto";

import {
  classifyRouteActivity,
  type MountainRouteType,
} from "./route-activity-classifier.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

export interface Phase11c4RouteAnalysis {
  routeSourceId: string;
  routeSourceUrl: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  routeMetadata: {
    ref: string | null;
    network: string | null;
    operator: string | null;
    routeType: string | null;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
    distanceMeters: number;
    coordinatePoints: number;
    geometryType: "LineString" | "MultiLineString";
    componentCount: number;
    tags?: Record<string, string>;
  };
}

export interface Phase11c4QueueRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  routeName: string | null;
  mountainId: number;
  quality: number;
  topology: "SIMPLE";
  semanticType: "summit_route";
  activityRouteType: Exclude<MountainRouteType, "mixed" | "other">;
  auditFlags: string[];
  warnings: string[];
  summitPeakOsmId: string;
  summitName: string | null;
  summitElevationMeters: number | null;
  adminBoundaryStatus: "ASSIGNED" | "AMBIGUOUS" | "UNASSIGNED";
  sourceUrl: string;
  priorityScore: number;
  sourceOrder: number;
}

export interface Phase11c4QueueSelection {
  queue: Phase11c4QueueRecord[];
  deterministicQueueHash: string;
}

function activityClassification(analysis: Phase11c4RouteAnalysis) {
  return classifyRouteActivity({
    sourceId: analysis.routeSourceId,
    sourceUrl: analysis.routeSourceUrl,
    name: analysis.routeName,
    ref: analysis.routeMetadata.ref,
    network: analysis.routeMetadata.network,
    operator: analysis.routeMetadata.operator,
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    stats: {
      distanceMeters: analysis.routeMetadata.distanceMeters,
      coordinatePoints: analysis.routeMetadata.coordinatePoints,
      componentCount: analysis.routeMetadata.componentCount,
    },
    metadata: {
      route: analysis.routeMetadata.routeType ?? "",
      from: analysis.routeMetadata.from,
      to: analysis.routeMetadata.to,
      roundtrip: analysis.routeMetadata.roundtrip,
      osmcSymbol: analysis.routeMetadata.osmcSymbol,
      tags: analysis.routeMetadata.tags ?? {},
    },
  });
}

export function isPhase11c4StagingReady(record: ImportPlanRecord | undefined): record is ImportPlanRecord {
  if (!record || record.operation !== "READY_FOR_STAGING") return false;
  const contract = record.contract;
  return (
    record.sourceRelationId === record.canonicalRouteSourceId &&
    contract.source.sourceRelationId === record.sourceRelationId &&
    contract.source.canonicalSourceId === record.canonicalRouteSourceId &&
    contract.importEligibility === "AUTO_IMPORT_READY" &&
    contract.route.semanticType === "summit_route" &&
    contract.route.qualityScore >= 80 &&
    contract.route.geometryType === "LineString" &&
    contract.route.componentCount === 1 &&
    contract.auditFlags.length === 0 &&
    record.validationErrors.length === 0 &&
    contract.confirmedSummits.length === 1 &&
    contract.confirmedSummits.every(
      (summit) =>
        summit.finalAssociation === "CONFIRMED" &&
        summit.mountainMatch.classification === "EXACT_MOUNTAIN_MATCH" &&
        summit.mountainMatch.mountainId !== null,
    )
  );
}

export function buildPhase11c4QueueCandidate(input: {
  analysis: Phase11c4RouteAnalysis;
  planRecord: ImportPlanRecord | undefined;
  excludedCanonicalIds: ReadonlySet<string>;
  sourceOrder: number;
}): Phase11c4QueueRecord | null {
  const { analysis, planRecord, excludedCanonicalIds, sourceOrder } = input;
  if (!isPhase11c4StagingReady(planRecord)) return null;
  const activity = activityClassification(analysis);
  if (
    excludedCanonicalIds.has(planRecord.canonicalRouteSourceId) ||
    analysis.routeSourceId !== planRecord.sourceRelationId ||
    analysis.routeSourceUrl !== planRecord.contract.source.sourceUrl ||
    analysis.semanticType !== "summit_route" ||
    analysis.qualityScore !== planRecord.contract.route.qualityScore ||
    analysis.routeMetadata.geometryType !== "LineString" ||
    analysis.routeMetadata.componentCount !== 1 ||
    activity.manualReviewRequired ||
    activity.routeType === "mixed" ||
    activity.routeType === "other"
  ) {
    return null;
  }

  const summit = planRecord.contract.confirmedSummits[0];
  const mountainId = summit.mountainMatch.mountainId;
  if (mountainId === null) return null;
  return {
    sourceRelationId: planRecord.sourceRelationId,
    canonicalRouteSourceId: planRecord.canonicalRouteSourceId,
    routeName: planRecord.routeName,
    mountainId,
    quality: planRecord.contract.route.qualityScore,
    topology: "SIMPLE",
    semanticType: "summit_route",
    activityRouteType: activity.routeType,
    auditFlags: [...planRecord.contract.auditFlags],
    warnings: [...planRecord.warnings],
    summitPeakOsmId: summit.peakOsmId,
    summitName: summit.peakName,
    summitElevationMeters: summit.peakElevationMeters,
    adminBoundaryStatus: planRecord.contract.routeAdministration.status,
    sourceUrl: planRecord.contract.source.sourceUrl,
    priorityScore: Math.round(planRecord.contract.route.qualityScore * 10 + 1_500),
    sourceOrder,
  };
}

export function phase11c4QueueHash(records: readonly Phase11c4QueueRecord[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export function selectDeterministicPhase11c4Queue(
  candidates: readonly Phase11c4QueueRecord[],
  limit: number,
): Phase11c4QueueSelection {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Queue limit must be positive.");
  const ordered = [...candidates].sort(
    (left, right) =>
      right.priorityScore - left.priorityScore ||
      left.sourceOrder - right.sourceOrder ||
      left.sourceRelationId.localeCompare(right.sourceRelationId, "en", { numeric: true }),
  );
  const queue: Phase11c4QueueRecord[] = [];
  const relations = new Set<string>();
  const canonicals = new Set<string>();
  const sourceUrls = new Set<string>();
  for (const candidate of ordered) {
    if (
      relations.has(candidate.sourceRelationId) ||
      canonicals.has(candidate.canonicalRouteSourceId) ||
      sourceUrls.has(candidate.sourceUrl)
    ) {
      continue;
    }
    relations.add(candidate.sourceRelationId);
    canonicals.add(candidate.canonicalRouteSourceId);
    sourceUrls.add(candidate.sourceUrl);
    queue.push(candidate);
    if (queue.length === limit) break;
  }
  if (queue.length !== limit) {
    throw new Error(`Only ${queue.length} unique Phase 8-ready routes are available; expected ${limit}.`);
  }
  return { queue, deterministicQueueHash: phase11c4QueueHash(queue) };
}
