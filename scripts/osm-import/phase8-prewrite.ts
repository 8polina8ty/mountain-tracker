import {
  createFirstWriteManifest,
  createRouteIdempotencyKey,
  validateStagingContract,
  type FirstWriteManifest,
  type ImportPlanRecord,
  type MountainCatalogRecord,
} from "./phase8-staging.ts";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
  topologyCoordinateDistanceMeters,
  type EndpointOrientationReason,
  type RouteTopologyClassification,
} from "../../Lib/osmStagingPreview/topology.ts";
import { calculateCoordinateDistanceMeters, type Coordinate } from "./peak-matcher.ts";

export type PrewriteDisposition = "READY" | "WARNING" | "BLOCKED";

export interface GeometrySanityReview {
  routeDistanceMeters: number;
  startToSummitDistanceMeters: number | null;
  sourceFirstToSummitDistanceMeters: number | null;
  straightLineDistanceMeters: number | null;
  routeToStraightLineRatio: number | null;
  routeToStraightLineStatus:
    | "AVAILABLE"
    | "TOPOLOGY_UNAVAILABLE"
    | "ENDPOINT_DISTANCE_TOO_SMALL";
  topologyClassification: RouteTopologyClassification;
  connectedGroupCount: number;
  physicalEndpointCount: number;
  endpointOrientationReason: EndpointOrientationReason;
  boundingBoxWidthMeters: number;
  boundingBoxHeightMeters: number;
  boundingBoxDiagonalMeters: number;
  componentCount: number;
  endpointDistanceMeters: number | null;
}

export interface MountainSafetyReview {
  peakOsmId: string;
  mountainId: number | null;
  osmCoordinates: Coordinate | null;
  mountainCoordinates: Coordinate | null;
  coordinateDifferenceMeters: number | null;
  osmElevationMeters: number | null;
  mountainElevationMeters: number | null;
  elevationDifferenceMeters: number | null;
  normalizedPeakName: string;
  normalizedMountainNames: string[];
  evidence: string[];
}

export interface FirstWriteRecordReview {
  sourceRelationId: string;
  routeName: string | null;
  operation: ImportPlanRecord["operation"];
  disposition: PrewriteDisposition;
  approvedForFirstWrite: boolean;
  hardFailures: string[];
  warnings: string[];
  geometry: GeometrySanityReview;
  mountainSafety: MountainSafetyReview[];
  idempotencyKey: string;
  payloadHash: string;
}

export interface FirstWriteReviewResult {
  reviews: FirstWriteRecordReview[];
  approvedRecords: ImportPlanRecord[];
  manifest: FirstWriteManifest;
  summary: {
    reviewed: number;
    ready: number;
    warning: number;
    blocked: number;
    approved: number;
    expectedRouteRows: number;
    expectedSummitRows: number;
  };
}

function round(value: number, places = 1): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

export function normalizeReviewName(value: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstCoordinate(record: ImportPlanRecord): Coordinate | null {
  const geometry = record.contract.route.geometry;
  const coordinate =
    geometry.type === "LineString" ? geometry.coordinates[0] : geometry.coordinates[0]?.[0];
  return coordinate ?? null;
}

function administrationHasProvenance(
  resolution: ImportPlanRecord["contract"]["routeAdministration"],
): boolean {
  if (resolution.status !== "ASSIGNED") return true;
  return Boolean(
    resolution.countryCode &&
      resolution.admin1Code &&
      resolution.source &&
      resolution.sourceUrl &&
      resolution.license &&
      resolution.version &&
      resolution.boundaryProvenance.provider &&
      resolution.boundaryProvenance.version,
  );
}

export function createGeometrySanityReview(
  record: ImportPlanRecord,
): GeometrySanityReview {
  const { route, confirmedSummits } = record.contract;
  const sourceFirst = firstCoordinate(record);
  const summitCoordinates = confirmedSummits
    .map((summit) => summit.peakCoordinates)
    .filter((coordinate): coordinate is Coordinate => coordinate !== null);
  const sourceFirstToSummit =
    sourceFirst && summitCoordinates.length > 0
      ? Math.min(
          ...summitCoordinates.map((coordinate) =>
            calculateCoordinateDistanceMeters(sourceFirst, coordinate),
          ),
        )
      : null;
  const topology = analyzeRouteTopology(route.geometry);
  const endpointSelection = selectRouteEndpoints(topology, summitCoordinates);
  const startToSummit =
    endpointSelection.startCoordinate && summitCoordinates.length > 0
      ? Math.min(
          ...summitCoordinates.map((coordinate) =>
            topologyCoordinateDistanceMeters(
              endpointSelection.startCoordinate as Coordinate,
              coordinate,
            ),
          ),
        )
      : null;
  const straightLineDistance = endpointSelection.straightLineDistanceMeters;
  const routeToStraightLineStatus =
    straightLineDistance === null
      ? "TOPOLOGY_UNAVAILABLE"
      : straightLineDistance < 1
        ? "ENDPOINT_DISTANCE_TOO_SMALL"
        : "AVAILABLE";
  const { bounds } = route;
  const middleLatitude = (bounds.minimumLatitude + bounds.maximumLatitude) / 2;
  const width = calculateCoordinateDistanceMeters(
    [bounds.minimumLongitude, middleLatitude],
    [bounds.maximumLongitude, middleLatitude],
  );
  const height = calculateCoordinateDistanceMeters(
    [bounds.minimumLongitude, bounds.minimumLatitude],
    [bounds.minimumLongitude, bounds.maximumLatitude],
  );
  const diagonal = calculateCoordinateDistanceMeters(
    [bounds.minimumLongitude, bounds.minimumLatitude],
    [bounds.maximumLongitude, bounds.maximumLatitude],
  );
  return {
    routeDistanceMeters: route.distanceMeters,
    startToSummitDistanceMeters: startToSummit === null ? null : round(startToSummit),
    sourceFirstToSummitDistanceMeters:
      sourceFirstToSummit === null ? null : round(sourceFirstToSummit),
    straightLineDistanceMeters: straightLineDistance,
    routeToStraightLineRatio:
      routeToStraightLineStatus !== "AVAILABLE" || straightLineDistance === null
        ? null
        : round(route.distanceMeters / straightLineDistance, 2),
    routeToStraightLineStatus,
    topologyClassification: topology.classification,
    connectedGroupCount: topology.connectedGroupCount,
    physicalEndpointCount: topology.physicalEndpointCount,
    endpointOrientationReason: endpointSelection.orientationReason,
    boundingBoxWidthMeters: round(width),
    boundingBoxHeightMeters: round(height),
    boundingBoxDiagonalMeters: round(diagonal),
    componentCount: route.componentCount,
    endpointDistanceMeters:
      confirmedSummits.length === 0
        ? null
        : round(
            Math.min(
              ...confirmedSummits.map((summit) => summit.endpointDistanceMeters),
            ),
          ),
  };
}

export function createGeometryWarnings(
  record: ImportPlanRecord,
  geometry: GeometrySanityReview,
): string[] {
  const warnings: string[] = [];
  if (
    geometry.sourceFirstToSummitDistanceMeters !== null &&
    geometry.sourceFirstToSummitDistanceMeters <= 10 &&
    geometry.routeDistanceMeters >= 500
  ) {
    warnings.push("ROUTE_ORIENTATION_STARTS_AT_SUMMIT");
  }
  if (
    geometry.routeToStraightLineRatio !== null &&
    geometry.routeToStraightLineRatio > 10 &&
    (geometry.startToSummitDistanceMeters ?? 0) > 10
  ) {
    warnings.push("HIGH_ROUTE_TO_STRAIGHT_LINE_RATIO");
  }
  if (geometry.componentCount >= 5) warnings.push("HIGH_COMPONENT_COUNT");
  if (geometry.routeDistanceMeters >= 50_000) warnings.push("VERY_LONG_ROUTE");
  if ((geometry.endpointDistanceMeters ?? 0) > 15) warnings.push("SUMMIT_NOT_NEAR_ENDPOINT");
  const highestSummit = Math.max(
    ...record.contract.confirmedSummits.map(
      (summit) => summit.peakElevationMeters ?? Number.NEGATIVE_INFINITY,
    ),
  );
  if (geometry.routeDistanceMeters < 1_500 && highestSummit >= 2_500) {
    warnings.push("SHORT_HIGH_SUMMIT_SEGMENT");
  }
  return warnings;
}

function mountainReview(
  record: ImportPlanRecord,
  mountains: ReadonlyMap<number, MountainCatalogRecord>,
): { reviews: MountainSafetyReview[]; failures: string[]; warnings: string[] } {
  const reviews: MountainSafetyReview[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const summit of record.contract.confirmedSummits) {
    const mountainId = summit.mountainMatch.mountainId;
    const mountain = mountainId === null ? null : mountains.get(mountainId) ?? null;
    const coordinateDifference =
      summit.peakCoordinates && mountain?.coordinates
        ? calculateCoordinateDistanceMeters(summit.peakCoordinates, mountain.coordinates)
        : null;
    const elevationDifference =
      summit.peakElevationMeters !== null && mountain?.heightMeters !== null && mountain
        ? Math.abs(summit.peakElevationMeters - mountain.heightMeters)
        : null;
    const normalizedMountainNames = mountain
      ? [...new Set([mountain.name, mountain.nameDe].map(normalizeReviewName).filter(Boolean))]
      : [];
    reviews.push({
      peakOsmId: summit.peakOsmId,
      mountainId,
      osmCoordinates: summit.peakCoordinates,
      mountainCoordinates: mountain?.coordinates ?? null,
      coordinateDifferenceMeters:
        coordinateDifference === null ? null : round(coordinateDifference),
      osmElevationMeters: summit.peakElevationMeters,
      mountainElevationMeters: mountain?.heightMeters ?? null,
      elevationDifferenceMeters: elevationDifference,
      normalizedPeakName: normalizeReviewName(summit.peakName),
      normalizedMountainNames,
      evidence: [
        ...summit.mountainMatch.reasons,
        ...summit.evidence,
      ],
    });
    if (mountainId === null || !mountain) {
      failures.push(`MISSING_CURRENT_MOUNTAIN:${summit.peakOsmId}`);
      continue;
    }
    if (mountain.osmId !== summit.peakOsmId) {
      failures.push(`MOUNTAIN_OSM_ID_CHANGED:${summit.peakOsmId}`);
    }
    if (coordinateDifference !== null && coordinateDifference > 1_000) {
      failures.push(`EXTREME_MOUNTAIN_COORDINATE_DIFFERENCE:${summit.peakOsmId}`);
    } else if (coordinateDifference !== null && coordinateDifference > 25) {
      warnings.push(`MOUNTAIN_COORDINATE_DIFFERENCE:${summit.peakOsmId}`);
    }
    if (elevationDifference !== null && elevationDifference > 500) {
      failures.push(`EXTREME_MOUNTAIN_ELEVATION_DIFFERENCE:${summit.peakOsmId}`);
    } else if (elevationDifference !== null && elevationDifference > 100) {
      warnings.push(`MOUNTAIN_ELEVATION_DIFFERENCE:${summit.peakOsmId}`);
    }
    const normalizedPeak = normalizeReviewName(summit.peakName);
    if (
      normalizedPeak &&
      normalizedMountainNames.length > 0 &&
      !normalizedMountainNames.some(
        (name) =>
          name === normalizedPeak || name.includes(normalizedPeak) || normalizedPeak.includes(name),
      )
    ) {
      warnings.push(`MOUNTAIN_NAME_DIFFERS:${summit.peakOsmId}`);
    }
  }
  return { reviews, failures, warnings };
}

export function auditFirstWriteRecord(
  record: ImportPlanRecord,
  mountains: ReadonlyMap<number, MountainCatalogRecord>,
): FirstWriteRecordReview {
  const hardFailures = [...validateStagingContract(record.contract)];
  if (record.sourceRelationId !== record.canonicalRouteSourceId) {
    hardFailures.push("SOURCE_IS_NOT_CANONICAL");
  }
  if (record.contract.importEligibility !== "AUTO_IMPORT_READY") {
    hardFailures.push("NOT_AUTO_IMPORT_READY");
  }
  if (record.contract.route.qualityScore < 70) hardFailures.push("QUALITY_BELOW_70");
  if (record.idempotencyKey !== createRouteIdempotencyKey(record.canonicalRouteSourceId)) {
    hardFailures.push("UNSTABLE_IDEMPOTENCY_KEY");
  }
  if (!administrationHasProvenance(record.contract.routeAdministration)) {
    hardFailures.push("INCOMPLETE_ROUTE_BOUNDARY_PROVENANCE");
  }
  for (const summit of record.contract.confirmedSummits) {
    if (!administrationHasProvenance(summit.administration)) {
      hardFailures.push(`INCOMPLETE_PEAK_BOUNDARY_PROVENANCE:${summit.peakOsmId}`);
    }
  }
  const criticalFlags = record.contract.auditFlags.filter((flag) =>
    /INVALID|CRITICAL|CORRUPT|MISSING_CONFIRMED_SUMMIT/.test(flag),
  );
  hardFailures.push(...criticalFlags.map((flag) => `CRITICAL_AUDIT_FLAG:${flag}`));
  if (record.operation !== "READY_FOR_STAGING") {
    hardFailures.push(`CURRENT_OPERATION:${record.operation}`);
  }

  const geometry = createGeometrySanityReview(record);
  const mountain = mountainReview(record, mountains);
  hardFailures.push(...mountain.failures);
  const warnings = [
    ...record.warnings,
    ...createGeometryWarnings(record, geometry),
    ...mountain.warnings,
  ];
  const uniqueFailures = [...new Set(hardFailures)].sort();
  const uniqueWarnings = [...new Set(warnings)].sort();
  const disposition: PrewriteDisposition =
    uniqueFailures.length > 0 ? "BLOCKED" : uniqueWarnings.length > 0 ? "WARNING" : "READY";
  return {
    sourceRelationId: record.sourceRelationId,
    routeName: record.routeName,
    operation: record.operation,
    disposition,
    approvedForFirstWrite: disposition !== "BLOCKED",
    hardFailures: uniqueFailures,
    warnings: uniqueWarnings,
    geometry,
    mountainSafety: mountain.reviews,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
  };
}

export function buildFirstWriteReview(input: {
  planRecords: ImportPlanRecord[];
  reviewedSourceIds: string[];
  mountains: MountainCatalogRecord[];
  datasetFingerprint: string;
}): FirstWriteReviewResult {
  const recordBySourceId = new Map(
    input.planRecords.map((record) => [record.sourceRelationId, record]),
  );
  if (new Set(input.reviewedSourceIds).size !== input.reviewedSourceIds.length) {
    throw new Error("First-50 selection contains duplicate source IDs.");
  }
  const records = input.reviewedSourceIds.map((sourceId) => {
    const record = recordBySourceId.get(sourceId);
    if (!record) throw new Error(`First-50 source is missing from the current plan: ${sourceId}`);
    return record;
  });
  const mountainMap = new Map(input.mountains.map((mountain) => [mountain.id, mountain]));
  const reviews = records.map((record) => auditFirstWriteRecord(record, mountainMap));
  const approvedSources = new Set(
    reviews.filter((review) => review.approvedForFirstWrite).map((review) => review.sourceRelationId),
  );
  const approvedRecords = records.filter((record) => approvedSources.has(record.sourceRelationId));
  const manifest = createFirstWriteManifest(approvedRecords, input.datasetFingerprint);
  return {
    reviews,
    approvedRecords,
    manifest,
    summary: {
      reviewed: reviews.length,
      ready: reviews.filter((review) => review.disposition === "READY").length,
      warning: reviews.filter((review) => review.disposition === "WARNING").length,
      blocked: reviews.filter((review) => review.disposition === "BLOCKED").length,
      approved: approvedRecords.length,
      expectedRouteRows: approvedRecords.length,
      expectedSummitRows: approvedRecords.reduce(
        (sum, record) => sum + record.contract.confirmedSummits.length,
        0,
      ),
    },
  };
}
