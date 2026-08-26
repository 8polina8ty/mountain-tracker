import {
  analyzeRouteTopology,
  selectRouteEndpoints,
  type EndpointOrientationReason,
  type EndpointSelectionWarning,
  type RouteTopologyClassification,
} from "./topology.ts";

export const PHASE9_CONTRACT_VERSION = "mountain-tracker-osm-route/v1";
export const PHASE9_REVIEWED_ROUTE_COUNT = 46;
export const QA_REVIEWER_NOTE_MAX_LENGTH = 1000;

export type PreviewQaStatus =
  | "PENDING"
  | "VISUALLY_APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED";

export type PreviewCoordinate = [number, number];
export type PreviewRouteGeometry =
  | { type: "LineString"; coordinates: PreviewCoordinate[] }
  | { type: "MultiLineString"; coordinates: PreviewCoordinate[][] };

export interface PreviewManifestRecord {
  idempotencyKey: string;
  payloadHash: string;
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  expectedSummitAssociationCount: number;
  mountainMatches: Array<{
    peakOsmId: string;
    mountainId: number;
    classification: "EXACT_MOUNTAIN_MATCH";
  }>;
}

export interface PreviewManifest {
  schemaVersion: 1;
  contractVersion: string;
  datasetFingerprint: string;
  recordCount: number;
  expectedSummitAssociationCount: number;
  records: PreviewManifestRecord[];
  manifestHash: string;
}

export interface PreviewStagingRouteRow {
  id: string;
  contract_version: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  route_name: string | null;
  semantic_type: string;
  quality_score: number;
  distance_meters: number;
  matched_primary_mountain_id: number | null;
  audit_flags: unknown;
  import_eligibility: string;
}

export interface PreviewStagingSummitRow {
  staging_route_id: string;
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: string;
  final_association: string;
  final_confidence: number;
  minimum_geometry_distance_meters: number;
  endpoint_distance_meters: number;
}

export interface PreviewMetadataRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  idempotencyKey: string;
  payloadHash: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  distanceMeters: number;
  componentCount: number;
  auditFlags: string[];
  warnings: string[];
  countryCode: string | null;
  countryName: string | null;
  admin1Code: string | null;
  admin1Name: string | null;
  administrationStatus: "ASSIGNED" | "AMBIGUOUS" | "UNASSIGNED";
  summit: {
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: PreviewCoordinate;
    mountainId: number;
    mountainName: string | null;
    mountainElevationMeters: number | null;
    matchClassification: "EXACT_MOUNTAIN_MATCH";
    finalAssociation: "CONFIRMED";
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
  };
  diagnostics: RouteDiagnostics;
}

export interface PreviewMetadataDocument {
  schemaVersion: 1;
  contractVersion: string;
  datasetFingerprint: string;
  manifestHash: string;
  recordCount: number;
  records: PreviewMetadataRecord[];
}

export interface ApprovedStagingRouteListItem extends PreviewMetadataRecord {
  stagingRouteId: string;
  qaStatus: PreviewQaStatus;
  qaDecision: PreviewQaDecision | null;
}

export interface PreviewQaDecision {
  status: Exclude<PreviewQaStatus, "PENDING">;
  reviewerNote: string | null;
  reviewedAt: string;
  version: number;
}

export interface StoredPreviewQaDecision extends PreviewQaDecision {
  stagingRouteId: string;
  reviewerUserId: string;
}

export interface PreviewQaDecisionInput {
  stagingRouteId: string;
  status: PreviewQaStatus;
  reviewerNote: string | null;
  expectedVersion: number | null;
}

export interface PreviewQaProgress {
  total: number;
  decided: number;
  pending: number;
  visuallyApproved: number;
  needsReview: number;
  rejected: number;
  warnings: number;
  warningsPending: number;
}

export interface PreviewRouteFilters {
  country: string;
  quality: string;
  warning: "ALL" | "WITH" | "WITHOUT" | "WARNINGS_PENDING";
  status: PreviewQaStatus | "ALL";
}

export interface PreviewMountainRecord {
  id: number;
  osmId: string | null;
  name: string | null;
  nameDe: string | null;
  elevationMeters: number | null;
  coordinates: PreviewCoordinate | null;
}

export interface RouteDiagnostics {
  totalDistanceMeters: number;
  componentLengthsMeters: number[];
  boundingBox: {
    minimumLongitude: number;
    minimumLatitude: number;
    maximumLongitude: number;
    maximumLatitude: number;
  };
  startCoordinate: PreviewCoordinate | null;
  endCoordinate: PreviewCoordinate | null;
  summitCoordinate: PreviewCoordinate;
  endpointDistanceMeters: number;
  startToSummitDistanceMeters: number | null;
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
  endpointSelectionAmbiguous: boolean;
  endpointSelectionWarning: EndpointSelectionWarning | null;
  geometryPointCount: number;
}

export interface ApprovedStagingRouteDetail extends ApprovedStagingRouteListItem {
  geometry: PreviewRouteGeometry;
  mountain: PreviewMountainRecord;
  mountainComparison: {
    coordinateDifferenceMeters: number | null;
    elevationDifferenceMeters: number | null;
    normalizedPeakName: string;
    normalizedMountainNames: string[];
    classification: "EXACT_MOUNTAIN_MATCH";
  };
  provenance: {
    provider: "openstreetmap";
    sourceUrl: string;
    attribution: string;
    license: string;
    datasetFingerprint: string;
    contractVersion: string;
    boundary: unknown;
  };
  evidence: string[];
  performance: {
    serverQueryMilliseconds: number;
    serializedPayloadBytes: number;
    mapInputBytes: number;
    geometryPointCount: number;
    unusuallyLarge: boolean;
  };
}

export interface ValidatedStagingRecord {
  manifest: PreviewManifestRecord;
  route: PreviewStagingRouteRow;
  summits: PreviewStagingSummitRow[];
}

export function isQaStatus(value: unknown): value is PreviewQaStatus {
  return (
    typeof value === "string" &&
    ["PENDING", "VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"].includes(value)
  );
}

export function parseQaDecisionInput(value: unknown): PreviewQaDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid QA decision input.");
  }
  const input = value as Record<string, unknown>;
  const stagingRouteId = String(input.stagingRouteId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stagingRouteId)) {
    throw new Error("Invalid staging route ID.");
  }
  if (!isQaStatus(input.status)) throw new Error("Invalid QA decision status.");
  const expectedVersion = input.expectedVersion;
  if (
    expectedVersion !== null &&
    (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)
  ) {
    throw new Error("Invalid QA decision version.");
  }
  if (input.reviewerNote != null && typeof input.reviewerNote !== "string") {
    throw new Error("Invalid QA reviewer note.");
  }
  const reviewerNote = (input.reviewerNote ?? "")
    .replace(/\r\n?/g, "\n")
    .trim() || null;
  if (reviewerNote && reviewerNote.length > QA_REVIEWER_NOTE_MAX_LENGTH) {
    throw new Error(`QA reviewer note must be at most ${QA_REVIEWER_NOTE_MAX_LENGTH} characters.`);
  }
  if (reviewerNote && (/[^\x09\x0A\x20-\x7E\xA0-\u{10FFFF}]/u.test(reviewerNote) || /<\/?[a-z][^>]*>/i.test(reviewerNote))) {
    throw new Error("QA reviewer note must be plain text.");
  }
  return {
    stagingRouteId,
    status: input.status,
    reviewerNote,
    expectedVersion: expectedVersion === null ? null : Number(expectedVersion),
  };
}

export function osmRelationUrl(sourceRelationId: string): string {
  if (!/^\d+$/.test(sourceRelationId)) throw new Error("Invalid OSM relation ID.");
  return `https://www.openstreetmap.org/relation/${sourceRelationId}`;
}

export function normalizePreviewName(value: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compareNumericIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

export function validatePhase9Manifest(manifest: PreviewManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported preview manifest schema.");
  if (manifest.contractVersion !== PHASE9_CONTRACT_VERSION) {
    throw new Error("Preview manifest contract version mismatch.");
  }
  if (manifest.recordCount !== PHASE9_REVIEWED_ROUTE_COUNT) {
    throw new Error(`Preview manifest must contain exactly ${PHASE9_REVIEWED_ROUTE_COUNT} routes.`);
  }
  if (manifest.records.length !== manifest.recordCount) {
    throw new Error("Preview manifest record count mismatch.");
  }
  const keys = manifest.records.map((record) => record.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error("Preview manifest has duplicate keys.");
  const associations = manifest.records.reduce(
    (sum, record) => sum + record.expectedSummitAssociationCount,
    0,
  );
  if (associations !== manifest.expectedSummitAssociationCount) {
    throw new Error("Preview manifest summit count mismatch.");
  }
}

export function validateManifestApprovedRows(input: {
  manifest: PreviewManifest;
  routes: PreviewStagingRouteRow[];
  summits: PreviewStagingSummitRow[];
}): ValidatedStagingRecord[] {
  validatePhase9Manifest(input.manifest);
  if (input.routes.length !== input.manifest.recordCount) {
    throw new Error("Staging route set does not exactly match the reviewed manifest.");
  }
  const routeByKey = new Map<string, PreviewStagingRouteRow>();
  for (const route of input.routes) {
    if (routeByKey.has(route.idempotency_key)) throw new Error("Duplicate staging route key.");
    routeByKey.set(route.idempotency_key, route);
  }
  const summitsByRoute = new Map<string, PreviewStagingSummitRow[]>();
  for (const summit of input.summits) {
    const values = summitsByRoute.get(summit.staging_route_id) ?? [];
    values.push(summit);
    summitsByRoute.set(summit.staging_route_id, values);
  }
  const validated = input.manifest.records.map((manifestRecord) => {
    const route = routeByKey.get(manifestRecord.idempotencyKey);
    if (!route) throw new Error(`Reviewed staging route is missing: ${manifestRecord.idempotencyKey}`);
    if (route.contract_version !== input.manifest.contractVersion) {
      throw new Error(`Wrong contract version: ${manifestRecord.idempotencyKey}`);
    }
    if (route.payload_hash !== manifestRecord.payloadHash) {
      throw new Error(`Payload hash mismatch: ${manifestRecord.idempotencyKey}`);
    }
    if (
      route.source_relation_id !== manifestRecord.sourceRelationId ||
      route.canonical_source_id !== manifestRecord.canonicalRouteSourceId
    ) {
      throw new Error(`Source identity mismatch: ${manifestRecord.idempotencyKey}`);
    }
    if (route.import_eligibility !== "AUTO_IMPORT_READY") {
      throw new Error(`Route is no longer staging eligible: ${manifestRecord.idempotencyKey}`);
    }
    const summits = summitsByRoute.get(route.id) ?? [];
    if (summits.length !== manifestRecord.expectedSummitAssociationCount) {
      throw new Error(`Summit count mismatch: ${manifestRecord.idempotencyKey}`);
    }
    const expectedAssociations = new Set(
      manifestRecord.mountainMatches.map(
        (match) => `${match.peakOsmId}|${match.mountainId}|${match.classification}`,
      ),
    );
    for (const summit of summits) {
      if (summit.final_association !== "CONFIRMED") {
        throw new Error(`Non-CONFIRMED summit: ${manifestRecord.idempotencyKey}`);
      }
      if (summit.mountain_match_classification !== "EXACT_MOUNTAIN_MATCH") {
        throw new Error(`Non-exact mountain match: ${manifestRecord.idempotencyKey}`);
      }
      const key = `${summit.peak_osm_id}|${summit.mountain_id}|${summit.mountain_match_classification}`;
      if (!expectedAssociations.delete(key)) {
        throw new Error(`Unexpected summit association: ${manifestRecord.idempotencyKey}`);
      }
    }
    if (expectedAssociations.size > 0) {
      throw new Error(`Missing reviewed summit association: ${manifestRecord.idempotencyKey}`);
    }
    return { manifest: manifestRecord, route, summits };
  });
  if (input.summits.length !== input.manifest.expectedSummitAssociationCount) {
    throw new Error("Staging summit set does not exactly match the reviewed manifest.");
  }
  return validated.sort((left, right) =>
    compareNumericIds(left.route.source_relation_id, right.route.source_relation_id),
  );
}

export function createApprovedListItems(input: {
  validated: ValidatedStagingRecord[];
  metadata: PreviewMetadataDocument;
  qaDecisions?: StoredPreviewQaDecision[];
}): ApprovedStagingRouteListItem[] {
  if (
    input.metadata.contractVersion !== PHASE9_CONTRACT_VERSION ||
    input.metadata.recordCount !== PHASE9_REVIEWED_ROUTE_COUNT
  ) {
    throw new Error("Preview metadata contract or count mismatch.");
  }
  const metadataByKey = new Map(
    input.metadata.records.map((record) => [record.idempotencyKey, record]),
  );
  const approvedRouteIds = new Set(input.validated.map(({ route }) => route.id));
  const decisionByRouteId = new Map<string, StoredPreviewQaDecision>();
  for (const decision of input.qaDecisions ?? []) {
    if (!approvedRouteIds.has(decision.stagingRouteId)) {
      throw new Error("QA decision is outside the reviewed manifest.");
    }
    if (
      decisionByRouteId.has(decision.stagingRouteId) ||
      decision.status === ("PENDING" as PreviewQaStatus) ||
      !Number.isSafeInteger(decision.version) ||
      decision.version < 1 ||
      !decision.reviewedAt
    ) {
      throw new Error("Stored QA decision is invalid.");
    }
    decisionByRouteId.set(decision.stagingRouteId, decision);
  }
  return input.validated.map(({ route, manifest, summits }) => {
    const metadata = metadataByKey.get(manifest.idempotencyKey);
    if (!metadata || metadata.payloadHash !== manifest.payloadHash) {
      throw new Error(`Preview metadata mismatch: ${manifest.idempotencyKey}`);
    }
    const summit = summits[0];
    if (
      route.route_name !== metadata.routeName ||
      route.semantic_type !== metadata.semanticType ||
      route.quality_score !== metadata.qualityScore ||
      route.distance_meters !== metadata.distanceMeters ||
      route.matched_primary_mountain_id !== metadata.summit.mountainId ||
      JSON.stringify(route.audit_flags) !== JSON.stringify(metadata.auditFlags) ||
      summit.peak_osm_id !== metadata.summit.peakOsmId ||
      summit.mountain_id !== metadata.summit.mountainId ||
      summit.final_confidence !== metadata.summit.finalConfidence ||
      summit.minimum_geometry_distance_meters !==
        metadata.summit.minimumGeometryDistanceMeters ||
      summit.endpoint_distance_meters !== metadata.summit.endpointDistanceMeters
    ) {
      throw new Error(`Live staging metadata changed: ${manifest.idempotencyKey}`);
    }
    const stored = decisionByRouteId.get(route.id);
    const qaDecision = stored
      ? {
          status: stored.status,
          reviewerNote: stored.reviewerNote,
          reviewedAt: stored.reviewedAt,
          version: stored.version,
        }
      : null;
    return {
      ...metadata,
      stagingRouteId: route.id,
      qaStatus: qaDecision?.status ?? "PENDING",
      qaDecision,
    };
  });
}

export function summarizeQaProgress(
  routes: ApprovedStagingRouteListItem[],
): PreviewQaProgress {
  const summary: PreviewQaProgress = {
    total: routes.length,
    decided: 0,
    pending: 0,
    visuallyApproved: 0,
    needsReview: 0,
    rejected: 0,
    warnings: 0,
    warningsPending: 0,
  };
  for (const route of routes) {
    if (route.qaStatus === "PENDING") summary.pending += 1;
    if (route.qaStatus === "VISUALLY_APPROVED") summary.visuallyApproved += 1;
    if (route.qaStatus === "NEEDS_REVIEW") summary.needsReview += 1;
    if (route.qaStatus === "REJECTED") summary.rejected += 1;
    if (route.warnings.length > 0) summary.warnings += 1;
    if (route.warnings.length > 0 && route.qaStatus === "PENDING") {
      summary.warningsPending += 1;
    }
  }
  summary.decided = summary.total - summary.pending;
  return summary;
}

export function filterPreviewRoutes(
  routes: ApprovedStagingRouteListItem[],
  filters: PreviewRouteFilters,
): ApprovedStagingRouteListItem[] {
  return routes.filter((route) => {
    const country = route.countryCode ?? route.administrationStatus;
    if (filters.country !== "ALL" && country !== filters.country) return false;
    if (filters.quality !== "ALL") {
      const minimum = Number(filters.quality);
      const maximum = minimum === 90 ? 100 : minimum + 9;
      if (!Number.isFinite(minimum) || route.qualityScore < minimum || route.qualityScore > maximum) {
        return false;
      }
    }
    if (filters.warning === "WITH" && route.warnings.length === 0) return false;
    if (filters.warning === "WITHOUT" && route.warnings.length > 0) return false;
    if (
      filters.warning === "WARNINGS_PENDING" &&
      (route.warnings.length === 0 || route.qaStatus !== "PENDING")
    ) return false;
    return filters.status === "ALL" || route.qaStatus === filters.status;
  });
}

export function isPublicationCandidate(status: PreviewQaStatus): boolean {
  return status === "VISUALLY_APPROVED";
}

const EARTH_RADIUS_METERS = 6_371_008.8;

export function coordinateDistanceMeters(
  left: PreviewCoordinate,
  right: PreviewCoordinate,
): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (right[1] - left[1]) * radians;
  const longitudeDelta = (right[0] - left[0]) * radians;
  const leftLatitude = left[1] * radians;
  const rightLatitude = right[1] * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function geometryComponents(geometry: PreviewRouteGeometry): PreviewCoordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates as PreviewCoordinate[]]
    : (geometry.coordinates as PreviewCoordinate[][]);
}

export function calculateRouteDiagnostics(input: {
  geometry: PreviewRouteGeometry;
  summitCoordinate: PreviewCoordinate;
  totalDistanceMeters: number;
  endpointDistanceMeters: number;
}): RouteDiagnostics {
  const components = geometryComponents(input.geometry);
  if (components.length === 0 || components.some((component) => component.length < 2)) {
    throw new Error("Preview geometry is empty or incomplete.");
  }
  const coordinates = components.flat();
  const componentLengthsMeters = components.map((component) =>
    component.slice(1).reduce(
      (sum, coordinate, index) => sum + coordinateDistanceMeters(component[index], coordinate),
      0,
    ),
  );
  const topology = analyzeRouteTopology(input.geometry);
  const endpointSelection = selectRouteEndpoints(topology, [input.summitCoordinate]);
  const startCoordinate = endpointSelection.startCoordinate;
  const endCoordinate = endpointSelection.endCoordinate;
  const startToSummitDistanceMeters = startCoordinate
    ? coordinateDistanceMeters(startCoordinate, input.summitCoordinate)
    : null;
  const straightLineDistanceMeters = endpointSelection.straightLineDistanceMeters;
  const routeToStraightLineStatus =
    straightLineDistanceMeters === null
      ? "TOPOLOGY_UNAVAILABLE"
      : straightLineDistanceMeters < 1
        ? "ENDPOINT_DISTANCE_TOO_SMALL"
        : "AVAILABLE";
  return {
    totalDistanceMeters: input.totalDistanceMeters,
    componentLengthsMeters: componentLengthsMeters.map((value) => Math.round(value * 10) / 10),
    boundingBox: {
      minimumLongitude: Math.min(...coordinates.map((coordinate) => coordinate[0])),
      minimumLatitude: Math.min(...coordinates.map((coordinate) => coordinate[1])),
      maximumLongitude: Math.max(...coordinates.map((coordinate) => coordinate[0])),
      maximumLatitude: Math.max(...coordinates.map((coordinate) => coordinate[1])),
    },
    startCoordinate,
    endCoordinate,
    summitCoordinate: input.summitCoordinate,
    endpointDistanceMeters: input.endpointDistanceMeters,
    startToSummitDistanceMeters:
      startToSummitDistanceMeters === null
        ? null
        : Math.round(startToSummitDistanceMeters * 10) / 10,
    straightLineDistanceMeters,
    routeToStraightLineRatio:
      routeToStraightLineStatus !== "AVAILABLE" || straightLineDistanceMeters === null
        ? null
        : Math.round((input.totalDistanceMeters / straightLineDistanceMeters) * 100) / 100,
    routeToStraightLineStatus,
    topologyClassification: topology.classification,
    connectedGroupCount: topology.connectedGroupCount,
    physicalEndpointCount: topology.physicalEndpointCount,
    endpointOrientationReason: endpointSelection.orientationReason,
    endpointSelectionAmbiguous: endpointSelection.ambiguous,
    endpointSelectionWarning: endpointSelection.warning,
    geometryPointCount: coordinates.length,
  };
}

export function buildRouteFeatureCollection(
  geometry: PreviewRouteGeometry,
): GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString> {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  };
}

export function createPreviewNavigation(
  routes: ApprovedStagingRouteListItem[],
  stagingRouteId: string,
): {
  previousId: string | null;
  nextId: string | null;
  previousWarningId: string | null;
  nextWarningId: string | null;
  previousPendingId: string | null;
  nextPendingId: string | null;
} {
  const index = routes.findIndex((route) => route.stagingRouteId === stagingRouteId);
  if (index < 0) throw new Error("Preview route is not in the reviewed set.");
  const warningIndexes = routes
    .map((route, routeIndex) => (route.warnings.length > 0 ? routeIndex : -1))
    .filter((routeIndex) => routeIndex >= 0);
  return {
    previousId: index > 0 ? routes[index - 1].stagingRouteId : null,
    nextId: index + 1 < routes.length ? routes[index + 1].stagingRouteId : null,
    previousWarningId:
      warningIndexes.filter((warningIndex) => warningIndex < index).at(-1) === undefined
        ? null
        : routes[warningIndexes.filter((warningIndex) => warningIndex < index).at(-1) as number]
            .stagingRouteId,
    nextWarningId:
      warningIndexes.find((warningIndex) => warningIndex > index) === undefined
        ? null
        : routes[warningIndexes.find((warningIndex) => warningIndex > index) as number]
            .stagingRouteId,
    previousPendingId:
      routes.slice(0, index).reverse().find((route) => route.qaStatus === "PENDING")
        ?.stagingRouteId ??
      routes.slice(index + 1).reverse().find((route) => route.qaStatus === "PENDING")
        ?.stagingRouteId ??
      null,
    nextPendingId:
      routes.slice(index + 1).find((route) => route.qaStatus === "PENDING")?.stagingRouteId ??
      routes.slice(0, index).find((route) => route.qaStatus === "PENDING")?.stagingRouteId ??
      null,
  };
}
