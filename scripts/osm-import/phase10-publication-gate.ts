import { createHash } from "node:crypto";

import {
  calculateRouteDiagnostics,
  coordinateDistanceMeters,
  createApprovedListItems,
  isQaStatus,
  summarizeQaProgress,
  validateManifestApprovedRows,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewRouteGeometry,
  type PreviewQaStatus,
  type PreviewStagingRouteRow,
  type PreviewStagingSummitRow,
  type StoredPreviewQaDecision,
} from "../../Lib/osmStagingPreview/core.ts";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
  type RouteTopologyClassification,
  type TopologyCoordinate,
} from "../../Lib/osmStagingPreview/topology.ts";
import {
  validateFirstWriteManifest,
  validateStagingContract,
  type FirstWriteManifest,
  type ImportPlanRecord,
  type OSMRouteImportContract,
} from "./phase8-staging.ts";

const QA_STATUSES: PreviewQaStatus[] = [
  "PENDING",
  "VISUALLY_APPROVED",
  "NEEDS_REVIEW",
  "REJECTED",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Phase10StagingRouteRow extends PreviewStagingRouteRow {
  provider: string;
  dataset_version: string;
  geometry_geojson: unknown;
  payload: unknown;
}

export interface Phase10StagingSummitRow extends PreviewStagingSummitRow {
  evidence: unknown;
  payload: unknown;
}

export interface Phase10QaHistoryRow {
  id: number;
  stagingRouteId: string;
  oldStatus: PreviewQaStatus;
  newStatus: PreviewQaStatus;
  reviewerNote: string | null;
  reviewerUserId: string;
  decisionVersion: number;
  occurredAt: string;
}

export interface QaHistoryIntegritySummary {
  status: "PASS";
  historyEventCount: number;
  routesWithHistory: number;
  routesResetToPending: number;
}

export interface PublicationCandidateRecord {
  publicationStatus: "PUBLICATION_READY";
  stagingRouteId: string;
  idempotencyKey: string;
  payloadHash: string;
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  distanceMeters: number;
  originalGeometry: PreviewRouteGeometry;
  topology: {
    classification: RouteTopologyClassification;
    connectedGroupCount: number;
    physicalEndpointCount: number;
    physicalEndpoints: Array<{
      coordinate: TopologyCoordinate;
      degree: number;
    }>;
    startCoordinate: TopologyCoordinate | null;
    endCoordinate: TopologyCoordinate | null;
    endpointOrientationReason: string;
    endpointSelectionAmbiguous: boolean;
    endpointSelectionWarning: string | null;
    summitEndpointDistanceMeters: number | null;
    straightLineDistanceMeters: number | null;
    routeToStraightLineRatio: number | null;
    routeToStraightLineStatus: string;
  };
  warningState: {
    reviewedFlags: string[];
    activeFlags: string[];
    resolvedRepresentationalFlags: string[];
    legacyStartToSummitDistanceMeters: number | null;
    legacyRouteToStraightLineRatio: number | null;
  };
  auditFlags: string[];
  administration: OSMRouteImportContract["routeAdministration"];
  provenance: {
    provider: "openstreetmap";
    sourceType: "relation";
    sourceUrl: string;
    provenanceId: string;
    license: string;
    attribution: string;
    datasetVersion: string;
    phase7AuditHash: string;
  };
  summit: {
    peakOsmId: string;
    peakName: string | null;
    peakCoordinates: TopologyCoordinate;
    mountainId: number;
    mountainMatchClassification: "EXACT_MOUNTAIN_MATCH";
    associationClassification: "CONFIRMED";
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    evidence: string[];
  };
  duplicateProvenance: OSMRouteImportContract["mergedDuplicateProvenance"];
  qaDecision: {
    status: "VISUALLY_APPROVED";
    reviewerUserId: string;
    reviewerNote: string | null;
    reviewedAt: string;
    version: number;
  };
  candidateContentHash: string;
}

export interface PublicationCandidateArtifact {
  schemaVersion: 2;
  artifactType: "PHASE10B_PUBLICATION_CANDIDATES";
  generationMetadata: {
    phase: "10B";
    readOnly: true;
    deterministic: true;
    volatileRuntimeMetadataIncluded: false;
    databaseWrites: 0;
    publicationWrites: 0;
  };
  notice: string;
  contractVersion: string;
  datasetFingerprint: string;
  sourceManifestHash: string;
  totalReviewedRoutes: number;
  qaProgress: ReturnType<typeof summarizeQaProgress>;
  candidateCount: number;
  blockedCandidateCount: number;
  blockedCountsByReason: Record<Exclude<PreviewQaStatus, "VISUALLY_APPROVED">, number>;
  warningCounts: {
    reviewedRoutesWithWarnings: number;
    warningCandidates: number;
    nonWarningCandidates: number;
    blockedWarningRoutes: number;
  };
  integrity: { status: "PASS"; failures: [] };
  qaHistoryIntegrity: QaHistoryIntegritySummary;
  candidates: PublicationCandidateRecord[];
  excludedRecords: Array<{
    stagingRouteId: string;
    sourceRelationId: string;
    qaStatus: Exclude<PreviewQaStatus, "VISUALLY_APPROVED">;
    reason: Exclude<PreviewQaStatus, "VISUALLY_APPROVED">;
  }>;
  deterministicContentHash: string;
}

export interface PublicationCandidateManifestRecord {
  stagingRouteId: string;
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  mountainId: number;
  payloadHash: string;
  qaDecisionVersion: number;
  candidateContentHash: string;
}

export interface PublicationCandidateManifest {
  schemaVersion: 1;
  artifactType: "PHASE10B_PUBLICATION_CANDIDATE_MANIFEST";
  candidateSetVersion: "mountain-tracker-osm-publication-candidates/v1";
  sourceManifestHash: string;
  datasetFingerprint: string;
  contractVersion: string;
  candidateCount: number;
  records: PublicationCandidateManifestRecord[];
  overallDeterministicManifestHash: string;
}

export interface PublicationGateInput {
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
  planDatasetFingerprint: string;
  planRecords: ImportPlanRecord[];
  routes: Phase10StagingRouteRow[];
  summits: Phase10StagingSummitRow[];
  qaDecisions: StoredPreviewQaDecision[];
  qaHistory: Phase10QaHistoryRow[];
}

export class PublicationGateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationGateIntegrityError";
  }
}

function fail(message: string): never {
  throw new PublicationGateIntegrityError(message);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function firstGeometryCoordinate(
  geometry: PreviewRouteGeometry,
): TopologyCoordinate | null {
  return geometry.type === "LineString"
    ? geometry.coordinates[0] ?? null
    : geometry.coordinates[0]?.[0] ?? null;
}

function createWarningState(input: {
  reviewedFlags: string[];
  geometry: PreviewRouteGeometry;
  summitCoordinate: TopologyCoordinate;
  distanceMeters: number;
  topologyRatio: number | null;
}): PublicationCandidateRecord["warningState"] {
  const sourceFirst = firstGeometryCoordinate(input.geometry);
  const rawLegacyStartToSummitDistanceMeters = sourceFirst
    ? coordinateDistanceMeters(sourceFirst, input.summitCoordinate)
    : null;
  const legacyStartToSummitDistanceMeters =
    rawLegacyStartToSummitDistanceMeters === null
      ? null
      : round(rawLegacyStartToSummitDistanceMeters, 1);
  const legacyRouteToStraightLineRatio =
    rawLegacyStartToSummitDistanceMeters === null ||
    rawLegacyStartToSummitDistanceMeters < 1
      ? null
      : round(input.distanceMeters / rawLegacyStartToSummitDistanceMeters);
  const resolvedRepresentationalFlags: string[] = [];
  if (
    legacyRouteToStraightLineRatio !== null &&
    legacyRouteToStraightLineRatio > 10 &&
    (legacyStartToSummitDistanceMeters ?? 0) > 10 &&
    (input.topologyRatio === null || input.topologyRatio <= 10) &&
    !input.reviewedFlags.includes("HIGH_ROUTE_TO_STRAIGHT_LINE_RATIO")
  ) {
    resolvedRepresentationalFlags.push("HIGH_ROUTE_TO_STRAIGHT_LINE_RATIO");
  }
  const activeFlags = [...input.reviewedFlags].sort();
  return {
    reviewedFlags: activeFlags,
    activeFlags,
    resolvedRepresentationalFlags,
    legacyStartToSummitDistanceMeters,
    legacyRouteToStraightLineRatio,
  };
}

function validTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function compareSourceIds(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function validateQaDecision(decision: StoredPreviewQaDecision): void {
  if (
    !isQaStatus(decision.status) ||
    (decision.status as PreviewQaStatus) === "PENDING" ||
    !UUID_PATTERN.test(decision.stagingRouteId) ||
    !UUID_PATTERN.test(decision.reviewerUserId) ||
    !Number.isSafeInteger(decision.version) ||
    decision.version < 1 ||
    !validTimestamp(decision.reviewedAt) ||
    (decision.reviewerNote !== null &&
      (typeof decision.reviewerNote !== "string" || decision.reviewerNote.length > 1000))
  ) fail(`INVALID_QA_STATE:${decision.stagingRouteId}`);
}

export function validateQaHistory(input: {
  reviewedStagingRouteIds: string[];
  currentDecisions: StoredPreviewQaDecision[];
  history: Phase10QaHistoryRow[];
}): QaHistoryIntegritySummary {
  const reviewedIds = new Set(input.reviewedStagingRouteIds);
  if (reviewedIds.size !== input.reviewedStagingRouteIds.length) {
    fail("DUPLICATE_REVIEWED_STAGING_ID");
  }
  const currentByRoute = new Map<string, StoredPreviewQaDecision>();
  for (const decision of input.currentDecisions) {
    validateQaDecision(decision);
    if (!reviewedIds.has(decision.stagingRouteId)) {
      fail(`QA_ROW_OUTSIDE_REVIEWED_MANIFEST:${decision.stagingRouteId}`);
    }
    if (currentByRoute.has(decision.stagingRouteId)) {
      fail(`DUPLICATE_QA_CURRENT_ROW:${decision.stagingRouteId}`);
    }
    currentByRoute.set(decision.stagingRouteId, decision);
  }
  const historyByRoute = new Map<string, Phase10QaHistoryRow[]>();
  const historyIds = new Set<number>();
  for (const event of input.history) {
    if (!reviewedIds.has(event.stagingRouteId)) {
      fail(`QA_HISTORY_OUTSIDE_REVIEWED_MANIFEST:${event.stagingRouteId}`);
    }
    if (
      !QA_STATUSES.includes(event.oldStatus) ||
      !QA_STATUSES.includes(event.newStatus) ||
      !UUID_PATTERN.test(event.reviewerUserId) ||
      !Number.isSafeInteger(event.id) ||
      event.id < 1 ||
      !Number.isSafeInteger(event.decisionVersion) ||
      event.decisionVersion < 1 ||
      !validTimestamp(event.occurredAt) ||
      historyIds.has(event.id) ||
      (event.reviewerNote !== null &&
        (typeof event.reviewerNote !== "string" || event.reviewerNote.length > 1000))
    ) fail(`INVALID_QA_HISTORY_EVENT:${event.stagingRouteId}:${event.id}`);
    historyIds.add(event.id);
    const values = historyByRoute.get(event.stagingRouteId) ?? [];
    values.push(event);
    historyByRoute.set(event.stagingRouteId, values);
  }

  let resetCount = 0;
  for (const stagingRouteId of reviewedIds) {
    const events = [...(historyByRoute.get(stagingRouteId) ?? [])].sort(
      (left, right) => left.decisionVersion - right.decisionVersion || left.id - right.id,
    );
    let previousStatus: PreviewQaStatus = "PENDING";
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    for (const [index, event] of events.entries()) {
      if (event.decisionVersion !== index + 1) {
        fail(`NON_MONOTONIC_QA_VERSION:${stagingRouteId}`);
      }
      if (event.oldStatus !== previousStatus) {
        fail(`IMPOSSIBLE_QA_TRANSITION:${stagingRouteId}:${event.decisionVersion}`);
      }
      const timestamp = Date.parse(event.occurredAt);
      if (timestamp < previousTimestamp) {
        fail(`NON_MONOTONIC_QA_TIMESTAMP:${stagingRouteId}`);
      }
      previousStatus = event.newStatus;
      previousTimestamp = timestamp;
    }

    const current = currentByRoute.get(stagingRouteId);
    const latest = events.at(-1);
    if (current) {
      if (
        !latest ||
        latest.newStatus === "PENDING" ||
        latest.newStatus !== current.status ||
        latest.decisionVersion !== current.version ||
        latest.reviewerUserId !== current.reviewerUserId ||
        latest.reviewerNote !== current.reviewerNote ||
        Date.parse(latest.occurredAt) !== Date.parse(current.reviewedAt)
      ) fail(`STALE_QA_CURRENT_HISTORY_MISMATCH:${stagingRouteId}`);
    } else if (latest && latest.newStatus !== "PENDING") {
      fail(`MISSING_QA_CURRENT_ROW:${stagingRouteId}`);
    } else if (latest?.newStatus === "PENDING") {
      resetCount += 1;
    }
  }
  return {
    status: "PASS",
    historyEventCount: input.history.length,
    routesWithHistory: historyByRoute.size,
    routesResetToPending: resetCount,
  };
}

function validateGeometry(value: unknown, routeId: string): void {
  if (!value || typeof value !== "object") fail(`INVALID_GEOMETRY:${routeId}`);
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") {
    fail(`INVALID_GEOMETRY:${routeId}`);
  }
  const components = geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
  if (!Array.isArray(components) || components.length === 0) {
    fail(`INVALID_GEOMETRY:${routeId}`);
  }
  for (const component of components) {
    if (!Array.isArray(component) || component.length < 2) fail(`INVALID_GEOMETRY:${routeId}`);
    for (const coordinate of component) {
      if (
        !Array.isArray(coordinate) ||
        coordinate.length < 2 ||
        !Number.isFinite(coordinate[0]) ||
        !Number.isFinite(coordinate[1]) ||
        coordinate[0] < -180 ||
        coordinate[0] > 180 ||
        coordinate[1] < -90 ||
        coordinate[1] > 90
      ) fail(`INVALID_GEOMETRY:${routeId}`);
    }
  }
}

function parseContract(value: unknown, routeId: string): OSMRouteImportContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`MALFORMED_STAGING_PAYLOAD:${routeId}`);
  }
  return value as OSMRouteImportContract;
}

function validateFullStagingRecord(input: {
  route: Phase10StagingRouteRow;
  summits: Phase10StagingSummitRow[];
  plan: ImportPlanRecord;
}): void {
  const { route, summits, plan } = input;
  const contract = parseContract(route.payload, route.id);
  const contractErrors = validateStagingContract(contract);
  if (contractErrors.length > 0) {
    fail(`INVALID_STAGING_PAYLOAD:${route.id}:${contractErrors.join(",")}`);
  }
  validateGeometry(route.geometry_geojson, route.id);
  if (
    route.provider !== "openstreetmap" ||
    route.dataset_version !== contract.dataset.version ||
    route.contract_version !== contract.contractVersion ||
    route.idempotency_key !== contract.idempotencyKey ||
    route.source_relation_id !== contract.source.sourceRelationId ||
    route.canonical_source_id !== contract.source.canonicalSourceId ||
    route.route_name !== contract.route.name ||
    route.semantic_type !== contract.route.semanticType ||
    route.quality_score !== contract.route.qualityScore ||
    route.distance_meters !== contract.route.distanceMeters ||
    route.import_eligibility !== contract.importEligibility ||
    stableJson(route.audit_flags) !== stableJson(contract.auditFlags) ||
    stableJson(route.geometry_geojson) !== stableJson(contract.route.geometry) ||
    stableJson(contract) !== stableJson(plan.contract)
  ) fail(`STAGING_PAYLOAD_DRIFT:${route.id}`);
  const expectedMountainIds = contract.confirmedSummits
    .map((summit) => summit.mountainMatch.mountainId)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (route.matched_primary_mountain_id !== (expectedMountainIds[0] ?? null)) {
    fail(`PRIMARY_MOUNTAIN_DRIFT:${route.id}`);
  }
  const contractSummitByPeak = new Map(
    contract.confirmedSummits.map((summit) => [summit.peakOsmId, summit]),
  );
  for (const summit of summits) {
    const expected = contractSummitByPeak.get(summit.peak_osm_id);
    if (
      !expected ||
      summit.mountain_match_classification !== expected.mountainMatch.classification ||
      summit.mountain_id !== expected.mountainMatch.mountainId ||
      summit.final_association !== expected.finalAssociation ||
      summit.final_confidence !== expected.finalConfidence ||
      summit.minimum_geometry_distance_meters !== expected.minimumGeometryDistanceMeters ||
      summit.endpoint_distance_meters !== expected.endpointDistanceMeters ||
      stableJson(summit.evidence) !== stableJson(expected.evidence) ||
      stableJson(summit.payload) !== stableJson(expected)
    ) fail(`SUMMIT_STAGING_PAYLOAD_DRIFT:${route.id}:${summit.peak_osm_id}`);
  }
}

export function buildPublicationCandidateArtifact(
  input: PublicationGateInput,
  options?: { expectedRecordCount?: number },
): PublicationCandidateArtifact {
  let selectedPlan: ImportPlanRecord[];
  try {
    selectedPlan = validateFirstWriteManifest(
      input.planRecords,
      input.manifest as FirstWriteManifest,
      input.planDatasetFingerprint,
    );
  } catch (error) {
    fail(`MANIFEST_OR_DATASET_DRIFT:${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    input.metadata.datasetFingerprint !== input.manifest.datasetFingerprint ||
    input.metadata.manifestHash !== input.manifest.manifestHash ||
    input.metadata.contractVersion !== input.manifest.contractVersion ||
    input.metadata.recordCount !== input.manifest.recordCount
  ) fail("PREVIEW_METADATA_DRIFT");
  for (const decision of input.qaDecisions) validateQaDecision(decision);

  let validated;
  try {
    validated = validateManifestApprovedRows({
      manifest: input.manifest,
      routes: input.routes,
      summits: input.summits,
      expectedRecordCount: options?.expectedRecordCount,
    });
  } catch (error) {
    fail(`STAGING_INTEGRITY_FAILURE:${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    new Set(input.routes.map((route) => route.id)).size !== input.routes.length ||
    new Set(input.routes.map((route) => route.source_relation_id)).size !== input.routes.length ||
    new Set(input.routes.map((route) => route.canonical_source_id)).size !== input.routes.length
  ) fail("DUPLICATE_STAGING_IDENTITY");

  const planByKey = new Map(selectedPlan.map((record) => [record.idempotencyKey, record]));
  const summitsByRoute = new Map<string, Phase10StagingSummitRow[]>();
  for (const summit of input.summits) {
    const values = summitsByRoute.get(summit.staging_route_id) ?? [];
    values.push(summit);
    summitsByRoute.set(summit.staging_route_id, values);
  }
  for (const { route } of validated) {
    const plan = planByKey.get(route.idempotency_key);
    if (!plan) fail(`PLAN_RECORD_MISSING:${route.id}`);
    validateFullStagingRecord({
      route: route as Phase10StagingRouteRow,
      summits: summitsByRoute.get(route.id) ?? [],
      plan,
    });
  }

  const historyIntegrity = validateQaHistory({
    reviewedStagingRouteIds: input.routes.map((route) => route.id),
    currentDecisions: input.qaDecisions,
    history: input.qaHistory,
  });
  const listItems = createApprovedListItems({
    validated,
    metadata: input.metadata,
    qaDecisions: input.qaDecisions,
    expectedRecordCount: options?.expectedRecordCount,
  });
  const currentByRoute = new Map(
    input.qaDecisions.map((decision) => [decision.stagingRouteId, decision]),
  );
  const routeById = new Map(input.routes.map((route) => [route.id, route]));
  const candidates: PublicationCandidateRecord[] = [];
  const excludedRecords: PublicationCandidateArtifact["excludedRecords"] = [];
  for (const item of listItems) {
    if (item.qaStatus !== "VISUALLY_APPROVED") {
      excludedRecords.push({
        stagingRouteId: item.stagingRouteId,
        sourceRelationId: item.sourceRelationId,
        qaStatus: item.qaStatus,
        reason: item.qaStatus,
      });
      continue;
    }
    const decision = currentByRoute.get(item.stagingRouteId);
    const route = routeById.get(item.stagingRouteId);
    if (!decision || !route || decision.status !== "VISUALLY_APPROVED") {
      fail(`APPROVED_DECISION_REFERENCE_MISMATCH:${item.stagingRouteId}`);
    }
    const plan = planByKey.get(item.idempotencyKey);
    if (!plan) fail(`PLAN_RECORD_MISSING:${item.stagingRouteId}`);
    const contract = plan.contract;
    const confirmedSummit = contract.confirmedSummits[0];
    if (
      contract.confirmedSummits.length !== 1 ||
      !confirmedSummit ||
      confirmedSummit.peakCoordinates === null ||
      confirmedSummit.mountainMatch.mountainId === null ||
      confirmedSummit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
      confirmedSummit.finalAssociation !== "CONFIRMED"
    ) {
      fail(`CANDIDATE_SUMMIT_INTEGRITY_FAILURE:${item.stagingRouteId}`);
    }
    const geometry = contract.route.geometry as PreviewRouteGeometry;
    const topology = analyzeRouteTopology(geometry);
    const endpointSelection = selectRouteEndpoints(topology, [
      confirmedSummit.peakCoordinates,
    ]);
    const diagnostics = calculateRouteDiagnostics({
      geometry,
      summitCoordinate: confirmedSummit.peakCoordinates,
      totalDistanceMeters: contract.route.distanceMeters,
      endpointDistanceMeters: confirmedSummit.endpointDistanceMeters,
    });
    const candidateContent = {
      publicationStatus: "PUBLICATION_READY" as const,
      stagingRouteId: item.stagingRouteId,
      idempotencyKey: item.idempotencyKey,
      payloadHash: route.payload_hash,
      sourceRelationId: item.sourceRelationId,
      canonicalRouteSourceId: item.canonicalRouteSourceId,
      routeName: item.routeName,
      semanticType: item.semanticType,
      qualityScore: item.qualityScore,
      distanceMeters: contract.route.distanceMeters,
      originalGeometry: geometry,
      topology: {
        classification: topology.classification,
        connectedGroupCount: topology.connectedGroupCount,
        physicalEndpointCount: topology.physicalEndpointCount,
        physicalEndpoints: topology.physicalEndpoints.map((endpoint) => ({
          coordinate: endpoint.coordinate,
          degree: endpoint.degree,
        })),
        startCoordinate: endpointSelection.startCoordinate,
        endCoordinate: endpointSelection.endCoordinate,
        endpointOrientationReason: endpointSelection.orientationReason,
        endpointSelectionAmbiguous: endpointSelection.ambiguous,
        endpointSelectionWarning: endpointSelection.warning,
        summitEndpointDistanceMeters: endpointSelection.summitEndpointDistanceMeters,
        straightLineDistanceMeters: diagnostics.straightLineDistanceMeters,
        routeToStraightLineRatio: diagnostics.routeToStraightLineRatio,
        routeToStraightLineStatus: diagnostics.routeToStraightLineStatus,
      },
      warningState: createWarningState({
        reviewedFlags: item.warnings,
        geometry,
        summitCoordinate: confirmedSummit.peakCoordinates,
        distanceMeters: contract.route.distanceMeters,
        topologyRatio: diagnostics.routeToStraightLineRatio,
      }),
      auditFlags: [...contract.auditFlags],
      administration: contract.routeAdministration,
      provenance: {
        provider: contract.provider as "openstreetmap",
        sourceType: contract.source.sourceType as "relation",
        sourceUrl: contract.source.sourceUrl,
        provenanceId: contract.source.provenanceId,
        license: contract.source.license,
        attribution: contract.source.attribution,
        datasetVersion: contract.dataset.version,
        phase7AuditHash: contract.dataset.phase7AuditHash,
      },
      summit: {
        peakOsmId: confirmedSummit.peakOsmId,
        peakName: confirmedSummit.peakName,
        peakCoordinates: confirmedSummit.peakCoordinates,
        mountainId: confirmedSummit.mountainMatch.mountainId,
        mountainMatchClassification: "EXACT_MOUNTAIN_MATCH" as const,
        associationClassification: "CONFIRMED" as const,
        finalConfidence: confirmedSummit.finalConfidence,
        minimumGeometryDistanceMeters: confirmedSummit.minimumGeometryDistanceMeters,
        endpointDistanceMeters: confirmedSummit.endpointDistanceMeters,
        evidence: [...confirmedSummit.evidence],
      },
      duplicateProvenance: contract.mergedDuplicateProvenance,
      qaDecision: {
        status: "VISUALLY_APPROVED" as const,
        reviewerUserId: decision.reviewerUserId,
        reviewerNote: decision.reviewerNote,
        reviewedAt: decision.reviewedAt,
        version: decision.version,
      },
    };
    candidates.push({
      ...candidateContent,
      candidateContentHash: sha256(candidateContent),
    });
  }
  candidates.sort((left, right) => compareSourceIds(left.sourceRelationId, right.sourceRelationId));
  excludedRecords.sort((left, right) => compareSourceIds(left.sourceRelationId, right.sourceRelationId));
  const qaProgress = summarizeQaProgress(listItems);
  const blockedCountsByReason: Record<
    Exclude<PreviewQaStatus, "VISUALLY_APPROVED">,
    number
  > = {
    PENDING: qaProgress.pending,
    NEEDS_REVIEW: qaProgress.needsReview,
    REJECTED: qaProgress.rejected,
  };
  if (candidates.length + excludedRecords.length !== input.manifest.recordCount) {
    fail("CANDIDATE_AND_BLOCKED_COUNT_MUST_EQUAL_SOURCE_MANIFEST");
  }
  const warningCandidates = candidates.filter(
    (candidate) => candidate.warningState.activeFlags.length > 0,
  ).length;
  const content = {
    schemaVersion: 2 as const,
    artifactType: "PHASE10B_PUBLICATION_CANDIDATES" as const,
    generationMetadata: {
      phase: "10B" as const,
      readOnly: true as const,
      deterministic: true as const,
      volatileRuntimeMetadataIncluded: false as const,
      databaseWrites: 0 as const,
      publicationWrites: 0 as const,
    },
    notice: "Planning artifact only. Visual approval is not publication and this file grants no write authority.",
    contractVersion: input.manifest.contractVersion,
    datasetFingerprint: input.manifest.datasetFingerprint,
    sourceManifestHash: input.manifest.manifestHash,
    totalReviewedRoutes: listItems.length,
    qaProgress,
    candidateCount: candidates.length,
    blockedCandidateCount: listItems.length - candidates.length,
    blockedCountsByReason,
    warningCounts: {
      reviewedRoutesWithWarnings: qaProgress.warnings,
      warningCandidates,
      nonWarningCandidates: candidates.length - warningCandidates,
      blockedWarningRoutes: qaProgress.warnings - warningCandidates,
    },
    integrity: { status: "PASS" as const, failures: [] as [] },
    qaHistoryIntegrity: historyIntegrity,
    candidates,
    excludedRecords,
  };
  return {
    ...content,
    deterministicContentHash: sha256(content),
  };
}

export function buildPublicationCandidateManifest(
  artifact: PublicationCandidateArtifact,
): PublicationCandidateManifest {
  const stagingIds = artifact.candidates.map((candidate) => candidate.stagingRouteId);
  if (new Set(stagingIds).size !== stagingIds.length) {
    fail("DUPLICATE_CANDIDATE_STAGING_ID");
  }
  const records = artifact.candidates.map((candidate) => ({
    stagingRouteId: candidate.stagingRouteId,
    sourceRelationId: candidate.sourceRelationId,
    canonicalRouteSourceId: candidate.canonicalRouteSourceId,
    mountainId: candidate.summit.mountainId,
    payloadHash: candidate.payloadHash,
    qaDecisionVersion: candidate.qaDecision.version,
    candidateContentHash: candidate.candidateContentHash,
  }));
  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE10B_PUBLICATION_CANDIDATE_MANIFEST" as const,
    candidateSetVersion: "mountain-tracker-osm-publication-candidates/v1" as const,
    sourceManifestHash: artifact.sourceManifestHash,
    datasetFingerprint: artifact.datasetFingerprint,
    contractVersion: artifact.contractVersion,
    candidateCount: records.length,
    records,
  };
  return {
    ...content,
    overallDeterministicManifestHash: sha256(content),
  };
}

export function combinePublicationCandidateArtifacts(
  artifacts: PublicationCandidateArtifact[],
): PublicationCandidateArtifact {
  if (artifacts.length === 0) fail("COMBINED_CANDIDATE_SOURCES_REQUIRED");
  for (const artifact of artifacts) validateCandidateArtifactIntegrity(artifact);
  const contractVersion = artifacts[0].contractVersion;
  const datasetFingerprint = artifacts[0].datasetFingerprint;
  if (
    artifacts.some(
      (artifact) =>
        artifact.contractVersion !== contractVersion ||
        artifact.datasetFingerprint !== datasetFingerprint,
    )
  ) {
    fail("COMBINED_CANDIDATE_SOURCE_CONTRACT_DRIFT");
  }
  const candidates = artifacts
    .flatMap((artifact) => artifact.candidates)
    .sort((left, right) => compareSourceIds(left.sourceRelationId, right.sourceRelationId));
  const excludedRecords = artifacts
    .flatMap((artifact) => artifact.excludedRecords)
    .sort((left, right) => compareSourceIds(left.sourceRelationId, right.sourceRelationId));
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(candidates.map((candidate) => candidate.stagingRouteId)) ||
    !unique(candidates.map((candidate) => candidate.sourceRelationId)) ||
    !unique(candidates.map((candidate) => candidate.canonicalRouteSourceId)) ||
    !unique(candidates.map((candidate) => candidate.provenance.sourceUrl))
  ) {
    fail("COMBINED_CANDIDATE_DUPLICATE_IDENTITY");
  }
  const sum = (select: (artifact: PublicationCandidateArtifact) => number) =>
    artifacts.reduce((total, artifact) => total + select(artifact), 0);
  const qaProgress = {
    total: sum((artifact) => artifact.qaProgress.total),
    decided: sum((artifact) => artifact.qaProgress.decided),
    pending: sum((artifact) => artifact.qaProgress.pending),
    visuallyApproved: sum((artifact) => artifact.qaProgress.visuallyApproved),
    needsReview: sum((artifact) => artifact.qaProgress.needsReview),
    rejected: sum((artifact) => artifact.qaProgress.rejected),
    warnings: sum((artifact) => artifact.qaProgress.warnings),
    warningsPending: sum((artifact) => artifact.qaProgress.warningsPending),
  };
  const content = {
    schemaVersion: 2 as const,
    artifactType: "PHASE10B_PUBLICATION_CANDIDATES" as const,
    generationMetadata: {
      phase: "10B" as const,
      readOnly: true as const,
      deterministic: true as const,
      volatileRuntimeMetadataIncluded: false as const,
      databaseWrites: 0 as const,
      publicationWrites: 0 as const,
    },
    notice:
      "Combined planning artifact only. Visual approval is not publication and this file grants no write authority.",
    contractVersion,
    datasetFingerprint,
    sourceManifestHash: sha256(
      artifacts.map((artifact) => artifact.sourceManifestHash).sort(),
    ),
    totalReviewedRoutes: sum((artifact) => artifact.totalReviewedRoutes),
    qaProgress,
    candidateCount: candidates.length,
    blockedCandidateCount: excludedRecords.length,
    blockedCountsByReason: {
      PENDING: sum((artifact) => artifact.blockedCountsByReason.PENDING),
      NEEDS_REVIEW: sum((artifact) => artifact.blockedCountsByReason.NEEDS_REVIEW),
      REJECTED: sum((artifact) => artifact.blockedCountsByReason.REJECTED),
    },
    warningCounts: {
      reviewedRoutesWithWarnings: sum(
        (artifact) => artifact.warningCounts.reviewedRoutesWithWarnings,
      ),
      warningCandidates: sum((artifact) => artifact.warningCounts.warningCandidates),
      nonWarningCandidates: sum((artifact) => artifact.warningCounts.nonWarningCandidates),
      blockedWarningRoutes: sum((artifact) => artifact.warningCounts.blockedWarningRoutes),
    },
    integrity: { status: "PASS" as const, failures: [] as [] },
    qaHistoryIntegrity: {
      status: "PASS" as const,
      historyEventCount: sum((artifact) => artifact.qaHistoryIntegrity.historyEventCount),
      routesWithHistory: sum((artifact) => artifact.qaHistoryIntegrity.routesWithHistory),
      routesResetToPending: sum(
        (artifact) => artifact.qaHistoryIntegrity.routesResetToPending,
      ),
    },
    candidates,
    excludedRecords,
  };
  return { ...content, deterministicContentHash: sha256(content) };
}

function validateCandidateArtifactIntegrity(
  artifact: PublicationCandidateArtifact,
): void {
  const { deterministicContentHash, ...content } = artifact;
  if (sha256(content) !== deterministicContentHash) {
    fail("CANDIDATE_ARTIFACT_HASH_MISMATCH");
  }
  if (
    artifact.totalReviewedRoutes <= 0 ||
    artifact.candidateCount !== artifact.candidates.length ||
    artifact.blockedCandidateCount !== artifact.excludedRecords.length ||
    artifact.candidateCount + artifact.blockedCandidateCount !== artifact.totalReviewedRoutes
  ) {
    fail("CANDIDATE_SET_COUNT_MISMATCH");
  }
  const stagingIds = artifact.candidates.map((candidate) => candidate.stagingRouteId);
  if (new Set(stagingIds).size !== stagingIds.length) {
    fail("DUPLICATE_CANDIDATE_STAGING_ID");
  }
  for (const candidate of artifact.candidates) {
    const { candidateContentHash, ...candidateContent } = candidate;
    if (sha256(candidateContent) !== candidateContentHash) {
      fail(`CANDIDATE_CONTENT_HASH_MISMATCH:${candidate.stagingRouteId}`);
    }
    const topology = analyzeRouteTopology(candidate.originalGeometry);
    const selection = selectRouteEndpoints(topology, [candidate.summit.peakCoordinates]);
    const diagnostics = calculateRouteDiagnostics({
      geometry: candidate.originalGeometry,
      summitCoordinate: candidate.summit.peakCoordinates,
      totalDistanceMeters: candidate.distanceMeters,
      endpointDistanceMeters: candidate.summit.endpointDistanceMeters,
    });
    const expectedTopology = {
      classification: topology.classification,
      connectedGroupCount: topology.connectedGroupCount,
      physicalEndpointCount: topology.physicalEndpointCount,
      physicalEndpoints: topology.physicalEndpoints.map((endpoint) => ({
        coordinate: endpoint.coordinate,
        degree: endpoint.degree,
      })),
      startCoordinate: selection.startCoordinate,
      endCoordinate: selection.endCoordinate,
      endpointOrientationReason: selection.orientationReason,
      endpointSelectionAmbiguous: selection.ambiguous,
      endpointSelectionWarning: selection.warning,
      summitEndpointDistanceMeters: selection.summitEndpointDistanceMeters,
      straightLineDistanceMeters: diagnostics.straightLineDistanceMeters,
      routeToStraightLineRatio: diagnostics.routeToStraightLineRatio,
      routeToStraightLineStatus: diagnostics.routeToStraightLineStatus,
    };
    if (stableJson(candidate.topology) !== stableJson(expectedTopology)) {
      fail(`CANDIDATE_TOPOLOGY_DRIFT:${candidate.stagingRouteId}`);
    }
    if (
      candidate.publicationStatus !== "PUBLICATION_READY" ||
      candidate.qaDecision.status !== "VISUALLY_APPROVED" ||
      candidate.summit.mountainMatchClassification !== "EXACT_MOUNTAIN_MATCH" ||
      candidate.summit.associationClassification !== "CONFIRMED" ||
      candidate.provenance.provider !== "openstreetmap" ||
      !candidate.provenance.sourceUrl ||
      !candidate.provenance.license ||
      !candidate.provenance.attribution
    ) {
      fail(`CANDIDATE_GATE_DRIFT:${candidate.stagingRouteId}`);
    }
  }
}

function validateCandidateManifestIntegrity(
  manifest: PublicationCandidateManifest,
): void {
  const { overallDeterministicManifestHash, ...content } = manifest;
  if (sha256(content) !== overallDeterministicManifestHash) {
    fail("CANDIDATE_MANIFEST_HASH_MISMATCH");
  }
  if (
    manifest.candidateCount !== manifest.records.length ||
    new Set(manifest.records.map((record) => record.stagingRouteId)).size !==
      manifest.records.length
  ) {
    fail("CANDIDATE_MANIFEST_SET_MISMATCH");
  }
}

export function verifyPublicationCandidateDocuments(input: {
  expectedArtifact: PublicationCandidateArtifact;
  expectedManifest: PublicationCandidateManifest;
  liveArtifact: PublicationCandidateArtifact;
  liveManifest: PublicationCandidateManifest;
}): {
  status: "PASS";
  candidateCount: number;
  blockedCount: number;
  artifactHash: string;
  manifestHash: string;
  databaseWrites: 0;
  publicationWrites: 0;
} {
  validateCandidateArtifactIntegrity(input.expectedArtifact);
  validateCandidateArtifactIntegrity(input.liveArtifact);
  validateCandidateManifestIntegrity(input.expectedManifest);
  validateCandidateManifestIntegrity(input.liveManifest);
  if (stableJson(input.expectedArtifact) !== stableJson(input.liveArtifact)) {
    fail("LIVE_CANDIDATE_ARTIFACT_DRIFT");
  }
  if (stableJson(input.expectedManifest) !== stableJson(input.liveManifest)) {
    fail("LIVE_CANDIDATE_MANIFEST_DRIFT");
  }
  return {
    status: "PASS",
    candidateCount: input.liveArtifact.candidateCount,
    blockedCount: input.liveArtifact.blockedCandidateCount,
    artifactHash: input.liveArtifact.deterministicContentHash,
    manifestHash: input.liveManifest.overallDeterministicManifestHash,
    databaseWrites: 0,
    publicationWrites: 0,
  };
}

export function renderPublicationReadinessReport(
  artifact: PublicationCandidateArtifact,
): string {
  const lines = [
    "# Phase 10B publication candidate finalization",
    "",
    "> Visual approval, publication candidacy, and actual publication are three separate states. This report performs no publication.",
    "",
    "## Readiness summary",
    "",
    `- Reviewed staging routes: ${artifact.totalReviewedRoutes}`,
    `- Pending: ${artifact.qaProgress.pending}`,
    `- Visually approved: ${artifact.qaProgress.visuallyApproved}`,
    `- Needs review: ${artifact.qaProgress.needsReview}`,
    `- Rejected: ${artifact.qaProgress.rejected}`,
    `- Warning routes: ${artifact.qaProgress.warnings}`,
    `- Warnings pending: ${artifact.qaProgress.warningsPending}`,
    `- Publication candidates: ${artifact.candidateCount}`,
    `- Blocked candidates: ${artifact.blockedCandidateCount}`,
    `- Warning candidates: ${artifact.warningCounts.warningCandidates}`,
    `- Non-warning candidates: ${artifact.warningCounts.nonWarningCandidates}`,
    "- Manifest/staging integrity: PASS",
    `- QA history integrity: PASS (${artifact.qaHistoryIntegrity.historyEventCount} events; ${artifact.qaHistoryIntegrity.routesResetToPending} reset route(s))`,
    "- Integrity failures: 0",
    "- Manifest drift: 0",
    "- Staging drift: 0",
    "- QA anomalies: 0",
    "",
    "## Excluded routes",
    "",
    ...(artifact.excludedRecords.length === 0
      ? ["None."]
      : artifact.excludedRecords.map(
          (record) => `- OSM relation ${record.sourceRelationId} (${record.stagingRouteId}): ${record.reason}`,
        )),
    "",
    "## Candidate records",
    "",
    ...(artifact.candidates.length === 0
      ? ["None. No route is currently authorized for publication candidacy."]
      : artifact.candidates.map(
          (record) => `- OSM relation ${record.sourceRelationId}: visually approved at ${record.qaDecision.reviewedAt}, decision version ${record.qaDecision.version}.`,
        )),
    "",
    "## Publication boundary",
    "",
    "This gate is read-only. It does not create a publication RPC, modify `mountain_routes`, or authorize an automatic promotion.",
    "",
  ];
  return lines.join("\n");
}
