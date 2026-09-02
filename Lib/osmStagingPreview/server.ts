import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAdminClient } from "@/Lib/supabase/admin";
import {
  ChunkedInQueryError,
  loadChunkedInQuery,
} from "@/Lib/supabase/chunked-in-query";
import {
  buildRouteFeatureCollection,
  calculateRouteDiagnostics,
  coordinateDistanceMeters,
  createApprovedListItems,
  normalizePreviewName,
  PHASE9_CONTRACT_VERSION,
  summarizeQaProgress,
  validateManifestApprovedRows,
  validatePhase9Manifest,
  type ApprovedStagingRouteDetail,
  type ApprovedStagingRouteListItem,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewMountainRecord,
  type PreviewRouteGeometry,
  type PreviewStagingRouteRow,
  type PreviewStagingSummitRow,
  type StoredPreviewQaDecision,
} from "./core";
import {
  getPreviewQueueDefinition,
  isCalibrationQueue,
  type PreviewQueueId,
} from "./queue-core";
import {
  loadPreviewQueueContract,
} from "./phase11h-calibration";
import {
  loadPhase11hVisualQaContract,
  type Phase11hVisualQaContract,
  type Phase11hVisualQaRouteContext,
} from "./phase11h-visual-qa";
export {
  loadPhase11hCalibrationPreview,
  type Phase11hCalibrationPreviewResult,
} from "./phase11h-calibration";
import { isMissingPreviewQaSchemaError } from "./query-errors";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const MANIFEST_PATH = resolve(STAGING_DIRECTORY, "first-write-manifest.json");
const METADATA_PATH = resolve(STAGING_DIRECTORY, "phase9-preview-metadata.json");

interface StagingPayload {
  contractVersion: string;
  idempotencyKey: string;
  provider: "openstreetmap";
  source: {
    sourceRelationId: string;
    canonicalSourceId: string;
    sourceUrl: string;
    attribution: string;
    license: string;
  };
  route: { geometry: PreviewRouteGeometry };
  confirmedSummits: Array<{
    peakOsmId: string;
    evidence: string[];
    mountainMatch: { reasons: string[] };
  }>;
  routeAdministration: unknown;
}

interface DetailRouteRow {
  id: string;
  contract_version: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  import_eligibility: string;
  matched_primary_mountain_id: number | string | null;
  geometry_geojson: unknown;
  payload: unknown;
}

interface DatabaseMountainRow {
  id: number;
  osm_id: number | string | null;
  name: string | null;
  name_de: string | null;
  height: number | string | null;
  latitude: number | string | null;
  longitude: number | string | null;
}

export interface PreviewListResult {
  routes: ApprovedStagingRouteListItem[];
  qaSchemaAvailable: boolean;
  queue: {
    id: PreviewQueueId;
    label: string;
    total: number;
    reviewed: number;
    remaining: number;
  } | null;
  performance: {
    serverQueryMilliseconds: number;
    stagingMetadataQueryMilliseconds: number;
    qaDecisionQueryMilliseconds: number;
    serializedPayloadBytes: number;
  };
}



function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedOsmAttribution(value: string): string {
  return /OpenStreetMap contributors$/.test(value)
    ? "© OpenStreetMap contributors"
    : value;
}

function assertExactQueryIdentitySet(input: {
  queryLabel: string;
  expected: readonly string[];
  actual: readonly string[];
}): void {
  const actualSet = new Set(input.actual);
  if (
    actualSet.size !== input.actual.length ||
    actualSet.size !== input.expected.length ||
    input.expected.some((identity) => !actualSet.has(identity))
  ) {
    throw new Error(
      `${input.queryLabel} returned ${actualSet.size} of ${input.expected.length} required identities.`,
    );
  }
}

function parseGeometry(value: unknown): PreviewRouteGeometry {
  if (!isObject(value) || (value.type !== "LineString" && value.type !== "MultiLineString")) {
    throw new Error("Staging preview geometry is invalid.");
  }
  if (!Array.isArray(value.coordinates)) throw new Error("Staging preview coordinates are invalid.");
  return value as unknown as PreviewRouteGeometry;
}

function parsePayload(value: unknown): StagingPayload {
  if (!isObject(value) || !isObject(value.source) || !isObject(value.route)) {
    throw new Error("Staging preview payload is invalid.");
  }
  if (!Array.isArray(value.confirmedSummits)) {
    throw new Error("Staging preview summit payload is invalid.");
  }
  return value as unknown as StagingPayload;
}

function manifestContentHash(manifest: PreviewManifest): string {
  const { manifestHash: ignored, ...content } = manifest;
  void ignored;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function loadLocalContracts(): Promise<{
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
}> {
  const [manifest, metadata] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8").then((value) => JSON.parse(value) as PreviewManifest),
    readFile(METADATA_PATH, "utf8").then(
      (value) => JSON.parse(value) as PreviewMetadataDocument,
    ),
  ]);
  validatePhase9Manifest(manifest);
  if (manifestContentHash(manifest) !== manifest.manifestHash) {
    throw new Error("Phase 9 manifest content hash mismatch.");
  }
  if (
    metadata.manifestHash !== manifest.manifestHash ||
    metadata.datasetFingerprint !== manifest.datasetFingerprint ||
    metadata.contractVersion !== manifest.contractVersion
  ) {
    throw new Error("Phase 9 metadata does not match the reviewed manifest.");
  }
  return { manifest, metadata };
}

interface LoadedPreviewContracts {
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
  expectedRecordCount: number;
  phase11h: Phase11hVisualQaContract | null;
}

async function loadContracts(
  queueId: PreviewQueueId | null,
): Promise<LoadedPreviewContracts> {
  if (queueId === null) {
    const contracts = await loadLocalContracts();
    return {
      ...contracts,
      expectedRecordCount: contracts.manifest.recordCount,
      phase11h: null,
    };
  }
  if (isCalibrationQueue(queueId)) {
    const contract = await loadPhase11hVisualQaContract();
    return {
      manifest: contract.manifest,
      metadata: contract.metadata,
      expectedRecordCount: contract.contexts.length,
      phase11h: contract,
    };
  }
  const contract = await loadPreviewQueueContract(queueId);
  return {
    manifest: contract.manifest,
    metadata: contract.metadata,
    expectedRecordCount: contract.definition.expectedTotal,
    phase11h: null,
  };
}

function mapRouteRow(value: Record<string, unknown>): PreviewStagingRouteRow {
  return {
    id: String(value.id),
    contract_version: String(value.contract_version),
    idempotency_key: String(value.idempotency_key),
    payload_hash: String(value.payload_hash),
    source_relation_id: String(value.source_relation_id),
    canonical_source_id: String(value.canonical_source_id),
    route_name: value.route_name === null ? null : String(value.route_name),
    semantic_type: String(value.semantic_type),
    quality_score: Number(value.quality_score),
    distance_meters: Number(value.distance_meters),
    matched_primary_mountain_id:
      value.matched_primary_mountain_id === null
        ? null
        : Number(value.matched_primary_mountain_id),
    audit_flags: value.audit_flags,
    import_eligibility: String(value.import_eligibility),
  };
}

function mapSummitRow(value: Record<string, unknown>): PreviewStagingSummitRow {
  return {
    staging_route_id: String(value.staging_route_id),
    peak_osm_id: String(value.peak_osm_id),
    mountain_id: Number(value.mountain_id),
    mountain_match_classification: String(value.mountain_match_classification),
    final_association: String(value.final_association),
    final_confidence: Number(value.final_confidence),
    minimum_geometry_distance_meters: Number(value.minimum_geometry_distance_meters),
    endpoint_distance_meters: Number(value.endpoint_distance_meters),
  };
}

function mapQaDecision(value: Record<string, unknown>): StoredPreviewQaDecision {
  const status = String(value.status);
  if (!["VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"].includes(status)) {
    throw new Error("Stored QA decision has an invalid status.");
  }
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Stored QA decision has an invalid version.");
  }
  return {
    stagingRouteId: String(value.staging_route_id),
    status: status as StoredPreviewQaDecision["status"],
    reviewerNote: value.reviewer_note === null ? null : String(value.reviewer_note),
    reviewedAt: String(value.reviewed_at),
    reviewerUserId: String(value.reviewer_user_id),
    version,
  };
}

export async function loadApprovedStagingRouteList(
  queueId: PreviewQueueId | null = null,
): Promise<PreviewListResult> {
  const startedAt = performance.now();
  const { manifest, metadata, expectedRecordCount, phase11h } =
    await loadContracts(queueId);
  const admin = createAdminClient();
  const stagingMetadataStartedAt = performance.now();
  const expectedIdempotencyKeys = manifest.records.map((record) => record.idempotencyKey);
  const routeData = await loadChunkedInQuery({
    values: expectedIdempotencyKeys,
    queryLabel: "Staging preview route query",
    loadChunk: (idempotencyKeys) =>
      admin
        .from("osm_route_import_staging")
        .select(
          "id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,route_name,semantic_type,quality_score,distance_meters,matched_primary_mountain_id,audit_flags,import_eligibility",
        )
        .in("idempotency_key", idempotencyKeys),
    rowIdentity: (row) => String((row as Record<string, unknown>).idempotency_key),
  });
  const routes = (routeData as Array<Record<string, unknown>>).map(mapRouteRow);
  assertExactQueryIdentitySet({
    queryLabel: "Staging preview route query",
    expected: expectedIdempotencyKeys,
    actual: routes.map((route) => route.idempotency_key),
  });
  const stagingMetadataQueryMilliseconds = performance.now() - stagingMetadataStartedAt;
  const [summitMeasurement, qaMeasurement] = await Promise.all([
    (async () => {
      const queryStartedAt = performance.now();
      const data = await loadChunkedInQuery({
        values: routes.map((route) => route.id),
        queryLabel: "Staging preview summit query",
        loadChunk: (stagingRouteIds) =>
          admin
            .from("osm_route_import_summit_staging")
            .select(
              "staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association,final_confidence,minimum_geometry_distance_meters,endpoint_distance_meters",
            )
            .in("staging_route_id", stagingRouteIds),
        rowIdentity: (row) => {
          const value = row as Record<string, unknown>;
          return `${String(value.staging_route_id)}:${String(value.peak_osm_id)}`;
        },
      });
      return { data, milliseconds: performance.now() - queryStartedAt };
    })(),
    (async () => {
      const queryStartedAt = performance.now();
      try {
        const data = await loadChunkedInQuery({
          values: routes.map((route) => route.id),
          queryLabel: "Staging preview QA query",
          loadChunk: (stagingRouteIds) =>
            admin
              .from("osm_staging_route_visual_qa")
              .select(
                "staging_route_id,status,reviewer_note,reviewed_at,reviewer_user_id,version",
              )
              .in("staging_route_id", stagingRouteIds),
          rowIdentity: (row) =>
            String((row as Record<string, unknown>).staging_route_id),
        });
        return {
          data,
          schemaAvailable: true,
          milliseconds: performance.now() - queryStartedAt,
        };
      } catch (error) {
        if (
          error instanceof ChunkedInQueryError &&
          isMissingPreviewQaSchemaError({
            code: error.queryErrorCode,
            message: error.queryErrorMessage,
          })
        ) {
          return {
            data: [],
            schemaAvailable: false,
            milliseconds: performance.now() - queryStartedAt,
          };
        }
        throw error;
      }
    })(),
  ]);
  const qaDecisionQueryMilliseconds = qaMeasurement.milliseconds;
  const qaSchemaAvailable = qaMeasurement.schemaAvailable;
  const summits = (summitMeasurement.data as Array<Record<string, unknown>>).map(mapSummitRow);
  const qaDecisions = (qaMeasurement.data as Array<Record<string, unknown>>).map(mapQaDecision);
  const validated = validateManifestApprovedRows({
    manifest,
    routes,
    summits,
    expectedRecordCount,
    preserveManifestOrder: queueId !== null,
  });
  const listItems = createApprovedListItems({
    validated,
    metadata,
    qaDecisions,
    expectedRecordCount,
  });
  if (
    phase11h &&
    listItems.some((route) => {
      const context = phase11h.contexts.find(
        (candidate) => candidate.canonicalRelationId === route.sourceRelationId,
      );
      return !context || context.stagingRouteId !== route.stagingRouteId;
    })
  ) {
    throw new Error("Phase 11H live staging identity does not match the execution receipt.");
  }
  const progress = summarizeQaProgress(listItems);
  const serializedPayloadBytes = Buffer.byteLength(JSON.stringify(listItems), "utf8");
  return {
    routes: listItems,
    qaSchemaAvailable,
    queue: queueId
      ? {
          id: queueId,
          label: getPreviewQueueDefinition(queueId).label,
          total: progress.total,
          reviewed: progress.decided,
          remaining: progress.pending,
        }
      : null,
    performance: {
      serverQueryMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
      stagingMetadataQueryMilliseconds:
        Math.round(stagingMetadataQueryMilliseconds * 10) / 10,
      qaDecisionQueryMilliseconds: Math.round(qaDecisionQueryMilliseconds * 10) / 10,
      serializedPayloadBytes,
    },
  };
}



export interface ValidatedQaMutationTarget {
  listItem: ApprovedStagingRouteListItem;
  manifestRecord: PreviewManifest["records"][number];
}

export async function loadValidatedQaMutationTarget(
  stagingRouteId: string,
  queueId: PreviewQueueId | null = null,
): Promise<ValidatedQaMutationTarget> {
  const [{ routes, qaSchemaAvailable }, { manifest }] = await Promise.all([
    loadApprovedStagingRouteList(queueId),
    loadContracts(queueId),
  ]);
  if (!qaSchemaAvailable) throw new Error("Phase 9B QA schema is not available.");
  const listItem = routes.find((route) => route.stagingRouteId === stagingRouteId);
  if (!listItem) throw new Error("Staging route is outside the reviewed manifest.");
  const manifestRecord = manifest.records.find(
    (record) => record.idempotencyKey === listItem.idempotencyKey,
  );
  if (!manifestRecord) throw new Error("Reviewed manifest record is missing.");
  return { listItem, manifestRecord };
}

function mapMountain(row: DatabaseMountainRow): PreviewMountainRecord {
  const latitude = row.latitude === null ? null : Number(row.latitude);
  const longitude = row.longitude === null ? null : Number(row.longitude);
  return {
    id: Number(row.id),
    osmId: row.osm_id === null ? null : String(row.osm_id),
    name: row.name,
    nameDe: row.name_de,
    elevationMeters: row.height === null ? null : Number(row.height),
    coordinates:
      latitude === null || longitude === null ? null : [longitude, latitude],
  };
}

export async function loadApprovedStagingRouteDetail(
  stagingRouteId: string,
  queueId: PreviewQueueId | null = null,
): Promise<{
  detail: ApprovedStagingRouteDetail;
  navigationRoutes: ApprovedStagingRouteListItem[];
  qaSchemaAvailable: boolean;
  phase11hContext: Phase11hVisualQaRouteContext | null;
}> {
  const startedAt = performance.now();
  const [list, contracts] = await Promise.all([
    loadApprovedStagingRouteList(queueId),
    loadContracts(queueId),
  ]);
  const listItem = list.routes.find((route) => route.stagingRouteId === stagingRouteId);
  if (!listItem) throw new Error("Staging preview route is not manifest-approved.");
  const phase11hContext = contracts.phase11h?.contexts.find(
    (context) => context.canonicalRelationId === listItem.sourceRelationId,
  ) ?? null;
  if (isCalibrationQueue(queueId) && !phase11hContext) {
    throw new Error("Phase 11H visual QA context is missing.");
  }
  const admin = createAdminClient();
  const [{ data: routeData, error: routeError }, { data: mountainData, error: mountainError }] =
    await Promise.all([
      admin
        .from("osm_route_import_staging")
        .select(
          "id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,import_eligibility,matched_primary_mountain_id,geometry_geojson,payload",
        )
        .eq("id", stagingRouteId)
        .maybeSingle(),
      admin
        .from("mountains")
        .select("id,osm_id,name,name_de,height,latitude,longitude")
        .eq("id", listItem.summit.mountainId)
        .maybeSingle(),
    ]);
  if (routeError) throw new Error(`Staging preview detail query failed: ${routeError.message}`);
  if (mountainError) throw new Error(`Staging preview mountain query failed: ${mountainError.message}`);
  if (!routeData || !mountainData) throw new Error("Staging preview detail evidence is missing.");
  const detailRow = routeData as DetailRouteRow;
  const geometry = parseGeometry(detailRow.geometry_geojson);
  if (
    detailRow.id !== stagingRouteId ||
    detailRow.contract_version !== PHASE9_CONTRACT_VERSION ||
    detailRow.idempotency_key !== listItem.idempotencyKey ||
    detailRow.payload_hash !== listItem.payloadHash ||
    detailRow.source_relation_id !== listItem.sourceRelationId ||
    detailRow.canonical_source_id !== listItem.canonicalRouteSourceId ||
    detailRow.import_eligibility !== "AUTO_IMPORT_READY" ||
    Number(detailRow.matched_primary_mountain_id) !== listItem.summit.mountainId
  ) {
    throw new Error("Staging preview detail payload failed contract validation.");
  }
  let sourceUrl: string;
  let attribution: string;
  let license: string;
  let boundary: unknown;
  let evidence: string[];
  if (phase11hContext) {
    const storedPayload = isObject(detailRow.payload) ? detailRow.payload : null;
    if (
      phase11hContext.stagingRouteId !== stagingRouteId ||
      canonicalJson(phase11hContext.geometry) !== canonicalJson(geometry) ||
      !storedPayload ||
      storedPayload.geometry_hash !== phase11hContext.geometryHash ||
      storedPayload.qualification_hash !== listItem.qualificationHash ||
      canonicalJson(storedPayload) !==
        canonicalJson(phase11hContext.expectedStoredPayload)
    ) {
      throw new Error("Phase 11H staging detail does not match its frozen payload.");
    }
    sourceUrl = phase11hContext.sourceUrl;
    attribution = "© OpenStreetMap contributors";
    license = "ODbL 1.0";
    boundary = null;
    evidence = [
      ...phase11hContext.summitEvidence,
      ...phase11hContext.startEvidence,
    ];
  } else {
    const payload = parsePayload(detailRow.payload);
    if (
      payload.contractVersion !== PHASE9_CONTRACT_VERSION ||
      payload.idempotencyKey !== listItem.idempotencyKey ||
      payload.provider !== "openstreetmap" ||
      payload.source.sourceRelationId !== listItem.sourceRelationId ||
      payload.source.canonicalSourceId !== listItem.canonicalRouteSourceId ||
      JSON.stringify(payload.route.geometry) !== JSON.stringify(geometry)
    ) {
      throw new Error("Staging preview detail payload failed contract validation.");
    }
    const payloadSummit = payload.confirmedSummits.find(
      (summit) => summit.peakOsmId === listItem.summit.peakOsmId,
    );
    if (!payloadSummit) throw new Error("Reviewed summit evidence is missing from payload.");
    sourceUrl = payload.source.sourceUrl;
    attribution = normalizedOsmAttribution(payload.source.attribution);
    license = payload.source.license;
    boundary = payload.routeAdministration;
    evidence = [...payloadSummit.mountainMatch.reasons, ...payloadSummit.evidence];
  }
  const mountain = mapMountain(mountainData as DatabaseMountainRow);
  if (mountain.id !== listItem.summit.mountainId || mountain.osmId !== listItem.summit.peakOsmId) {
    throw new Error("Mountain Tracker mountain resolution changed.");
  }
  const featureCollection = buildRouteFeatureCollection(geometry);
  const mapInputBytes = Buffer.byteLength(JSON.stringify(featureCollection), "utf8");
  const coordinateDifferenceMeters =
    mountain.coordinates === null
      ? null
      : Math.round(
          coordinateDistanceMeters(listItem.summit.peakCoordinates, mountain.coordinates) * 10,
        ) / 10;
  const elevationDifferenceMeters =
    listItem.summit.peakElevationMeters === null || mountain.elevationMeters === null
      ? null
      : Math.abs(listItem.summit.peakElevationMeters - mountain.elevationMeters);
  const baseDetail = {
    ...listItem,
    geometry,
    diagnostics: calculateRouteDiagnostics({
      geometry,
      summitCoordinate: listItem.summit.peakCoordinates,
      totalDistanceMeters: listItem.distanceMeters,
      endpointDistanceMeters: listItem.summit.endpointDistanceMeters,
    }),
    mountain,
    mountainComparison: {
      coordinateDifferenceMeters,
      elevationDifferenceMeters,
      normalizedPeakName: normalizePreviewName(listItem.summit.peakName),
      normalizedMountainNames: [mountain.name, mountain.nameDe]
        .map(normalizePreviewName)
        .filter((value, index, values) => value && values.indexOf(value) === index),
      classification: "EXACT_MOUNTAIN_MATCH" as const,
    },
    provenance: {
      provider: "openstreetmap" as const,
      sourceUrl,
      attribution,
      license,
      datasetFingerprint: contracts.manifest.datasetFingerprint,
      contractVersion: contracts.manifest.contractVersion,
      boundary,
    },
    evidence,
  };
  const geometryPointCount = listItem.diagnostics.geometryPointCount;
  const performanceBase = {
    serverQueryMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
    serializedPayloadBytes: 0,
    mapInputBytes,
    geometryPointCount,
    unusuallyLarge: geometryPointCount > 10_000 || mapInputBytes > 1_000_000,
  };
  const detail = {
    ...baseDetail,
    performance: performanceBase,
  } as ApprovedStagingRouteDetail;
  detail.performance.serializedPayloadBytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
  if (detail.performance.serializedPayloadBytes > 1_250_000) {
    detail.performance.unusuallyLarge = true;
  }
  return {
    detail,
    navigationRoutes: list.routes,
    qaSchemaAvailable: list.qaSchemaAvailable,
    phase11hContext,
  };
}
