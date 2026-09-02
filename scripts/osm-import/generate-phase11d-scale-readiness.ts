import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  calculateRouteDiagnostics,
  type PreviewMetadataDocument,
  type PreviewMetadataRecord,
  type PreviewRouteGeometry,
  type StoredPreviewQaDecision,
} from "../../Lib/osmStagingPreview/core.ts";
import { analyzeRouteTopology, selectRouteEndpoints } from "../../Lib/osmStagingPreview/topology.ts";
import { validateRouteGeometry } from "./alps-audit.ts";
import { iterateJsonLines, writeJsonAtomically } from "./jsonl.ts";
import { buildPhase11c4StagingPreflight } from "./phase11c4-staging-preflight.ts";
import {
  createLockedFirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import type { PublicationGateInput } from "./phase10-publication-gate.ts";
import { sha256Stable } from "./phase11-publication.ts";
import { loadPhase11c4PublicationGateInput } from "./phase11c4-live-data.ts";
import {
  MotorwaySpatialIndex,
  buildOrVerifyMotorwayIndex,
  createRoadSafetySourceDatasetIdentity,
} from "./phase11c9-road-index.ts";
import { FrozenRouteMemberStore } from "./phase11c9-route-member-store.ts";
import {
  analyzeRouteRoadSafety,
  type RoadSafetyAnalysisMetrics,
  type RoadSafetyRouteResult,
  type RoadSafetyWay,
} from "./phase11c9-road-safety.ts";
import {
  PHASE11D_AUTO_APPROVAL_ENABLED,
  PHASE11D_GREEN_MINIMUM_QUALITY,
  PHASE11D_QUALIFICATION_CONTRACT,
  qualifyPhase11dRoute,
  selectPhase11dQueue,
  type Phase11dHumanQaStatus,
  type Phase11dQualificationInput,
  type Phase11dQualificationResult,
} from "./phase11d-qualification.ts";
import {
  classifyRouteActivity,
  type RouteActivityClassification,
} from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const PATHS = {
  plan: "data/osm/alps/staging/import-plan.json",
  analysis: "data/osm/alps/route-analysis.jsonl",
  audit: "data/osm/alps/audit/final-audit-summary.json",
  pipeline: "data/osm/alps/summary.json",
  pbf: "data/osm/source/alps-latest.osm.pbf",
  checkpoint: "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite",
  checkpointManifest: "data/osm/alps/checkpoints/fafc4f7a772832f2/manifest.json",
  motorwayIndex: "data/osm/alps/road-safety/phase11c9-motorways.sqlite",
  readiness: "data/osm/alps/publication/phase11d-scale-readiness.json",
  green: "data/osm/alps/publication/phase11d-qualified-safe-candidates.json",
  yellow: "data/osm/alps/publication/phase11d-yellow-review-candidates.json",
  red: "data/osm/alps/publication/phase11d-red-blocked-candidates.json",
  queue: "data/osm/alps/publication/phase11d-qa-queue.json",
  stagingManifest: "data/osm/alps/staging/phase11d-staging-manifest.json",
  previewMetadata: "data/osm/alps/staging/phase11d-preview-metadata.json",
  stagingPreflight: "data/osm/alps/staging/phase11d-staging-preflight.json",
} as const;
const QUEUE_SIZE = 600;

interface ImportPlanDocument {
  datasetFingerprint: string;
  phase7AuditHash: string;
  summary: {
    totalEligibleRoutes: number;
    operations: Record<string, number>;
  };
  records: ImportPlanRecord[];
}

interface RouteAnalysisRecord {
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
  summitAssociations: Array<{ finalAssociation: string }>;
}

interface ActivePublicationRow {
  mountain_route_id: number;
  staging_route_id: string;
  canonical_relation_id: string;
  source_url: string;
  publication_status: string;
}

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function activityRoute(
  analysis: RouteAnalysisRecord,
  plan: ImportPlanRecord,
): ClassifiableRoute {
  return {
    sourceId: analysis.routeSourceId,
    sourceUrl: analysis.routeSourceUrl,
    name: analysis.routeName,
    ref: analysis.routeMetadata.ref,
    network: analysis.routeMetadata.network,
    operator: analysis.routeMetadata.operator,
    geometry: plan.contract.route.geometry,
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
  };
}

function isExplicitClosedLoop(analysis: RouteAnalysisRecord): boolean {
  const value = analysis.routeMetadata.roundtrip?.trim().toLowerCase();
  return value === "yes" || value === "roundtrip" || value === "circular";
}

function humanQaByRelation(inputs: PublicationGateInput[]): Map<string, Phase11dHumanQaStatus> {
  const result = new Map<string, Phase11dHumanQaStatus>();
  for (const input of inputs) {
    const relationByStaging = new Map(
      input.routes.map((route) => [route.id, route.canonical_source_id]),
    );
    for (const decision of input.qaDecisions) {
      const relationId = relationByStaging.get(decision.stagingRouteId);
      if (relationId) result.set(relationId, decision.status);
    }
  }
  return result;
}

function nearbyMotorways(
  routeWays: RoadSafetyWay[],
  index: MotorwaySpatialIndex,
  counters: { spatialBoundsQueries: number; spatialCandidateChecks: number },
): RoadSafetyWay[] {
  const ways = new Map<number, RoadSafetyWay>();
  for (const routeWay of routeWays) {
    if (routeWay.nodes.length < 2) continue;
    const longitudes = routeWay.nodes.map((node) => node.coordinate[0]);
    const latitudes = routeWay.nodes.map((node) => node.coordinate[1]);
    const padding = 0.0000001;
    const found = index.queryBounds({
      minimumLongitude: Math.min(...longitudes) - padding,
      maximumLongitude: Math.max(...longitudes) + padding,
      minimumLatitude: Math.min(...latitudes) - padding,
      maximumLatitude: Math.max(...latitudes) + padding,
    });
    counters.spatialBoundsQueries += 1;
    counters.spatialCandidateChecks += found.length;
    for (const way of found) ways.set(way.id, way);
  }
  return [...ways.values()].sort((left, right) => left.id - right.id);
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

function artifact<T extends object>(content: T): T & { deterministicArtifactHash: string } {
  return { ...content, deterministicArtifactHash: sha256Stable(content) };
}

function qualificationArtifact(
  artifactType: string,
  sourceIdentity: object,
  records: Phase11dQualificationResult[],
) {
  return artifact({
    schemaVersion: 1 as const,
    artifactType,
    qualificationContractVersion: PHASE11D_QUALIFICATION_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    humanQaRequiredForPublication: true as const,
    autoApprovalEnabled: PHASE11D_AUTO_APPROVAL_ENABLED,
    sourceIdentity,
    recordCount: records.length,
    records,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });
}

function previewMetadataRecord(
  record: ImportPlanRecord,
  qualificationStatus: "GREEN" | "YELLOW",
): PreviewMetadataRecord {
  if (record.contract.confirmedSummits.length !== 1) {
    throw new Error(`PHASE11D_PREVIEW_REQUIRES_SINGLE_SUMMIT:${record.sourceRelationId}`);
  }
  const summit = record.contract.confirmedSummits[0];
  if (
    summit.peakCoordinates === null ||
    summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
    summit.mountainMatch.mountainId === null
  ) throw new Error(`PHASE11D_PREVIEW_SUMMIT_INVALID:${record.sourceRelationId}`);
  const administration = record.contract.routeAdministration;
  const geometry = record.contract.route.geometry as PreviewRouteGeometry;
  return {
    sourceRelationId: record.sourceRelationId,
    canonicalRouteSourceId: record.canonicalRouteSourceId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    routeName: record.routeName,
    semanticType: record.contract.route.semanticType,
    qualityScore: record.contract.route.qualityScore,
    distanceMeters: record.contract.route.distanceMeters,
    componentCount: record.contract.route.componentCount,
    auditFlags: [...record.contract.auditFlags],
    warnings: [...record.warnings],
    qualificationStatus,
    countryCode: administration.status === "ASSIGNED" ? administration.countryCode : null,
    countryName: administration.status === "ASSIGNED" ? administration.countryName : null,
    admin1Code: administration.status === "ASSIGNED" ? administration.admin1Code : null,
    admin1Name: administration.status === "ASSIGNED" ? administration.admin1Name : null,
    administrationStatus: administration.status,
    summit: {
      peakOsmId: summit.peakOsmId,
      peakName: summit.peakName,
      peakElevationMeters: summit.peakElevationMeters,
      peakCoordinates: summit.peakCoordinates,
      mountainId: summit.mountainMatch.mountainId,
      mountainName: summit.mountainMatch.mountainName,
      mountainElevationMeters: summit.mountainMatch.mountainElevationMeters,
      matchClassification: "EXACT_MOUNTAIN_MATCH",
      finalAssociation: "CONFIRMED",
      finalConfidence: summit.finalConfidence,
      minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
    },
    diagnostics: calculateRouteDiagnostics({
      geometry,
      summitCoordinate: summit.peakCoordinates,
      totalDistanceMeters: record.contract.route.distanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
    }),
  };
}

async function chunks<T, R>(
  values: T[],
  load: (chunk: T[]) => Promise<R[]>,
  size = 100,
): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(...await load(values.slice(index, index + size)));
  }
  return output;
}

async function preflightSelected(
  client: SupabaseClient,
  selected: ImportPlanRecord[],
) {
  const stagingRoutes = await chunks(selected.map((record) => record.idempotencyKey), async (keys) => {
    const result = await client.from("osm_route_import_staging")
      .select("id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,matched_primary_mountain_id")
      .in("idempotency_key", keys);
    if (result.error) throw new Error(`PHASE11D_STAGING_PREFLIGHT_ROUTE_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const stagingIds = stagingRoutes.map((row) => String(row.id));
  const stagingSummits = await chunks(stagingIds, async (ids) => {
    const result = await client.from("osm_route_import_summit_staging")
      .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association")
      .in("staging_route_id", ids);
    if (result.error) throw new Error(`PHASE11D_STAGING_PREFLIGHT_SUMMIT_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const mountainIds = [...new Set(selected.flatMap((record) =>
    record.contract.confirmedSummits.flatMap((summit) =>
      summit.mountainMatch.mountainId === null ? [] : [summit.mountainMatch.mountainId])))];
  const mountains = await chunks(mountainIds, async (ids) => {
    const result = await client.from("mountains").select("id,osm_id").in("id", ids);
    if (result.error) throw new Error(`PHASE11D_STAGING_PREFLIGHT_MOUNTAIN_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const sourceUrls = selected.flatMap((record) => [
    record.contract.source.sourceUrl,
    `/api/osm-route-publications/openstreetmap/relation/${record.canonicalRouteSourceId}/geojson`,
  ]);
  const productionRoutes = await chunks(sourceUrls, async (urls) => {
    const result = await client.from("mountain_routes").select("id,source_url").in("source_url", urls);
    if (result.error) throw new Error(`PHASE11D_STAGING_PREFLIGHT_PRODUCTION_QUERY:${result.error.message}`);
    return result.data ?? [];
  }, 50);
  return buildPhase11c4StagingPreflight({
    records: selected,
    stagingRoutes: stagingRoutes.map((row) => ({
      id: String(row.id),
      idempotency_key: String(row.idempotency_key),
      payload_hash: String(row.payload_hash),
      source_relation_id: String(row.source_relation_id),
      canonical_source_id: String(row.canonical_source_id),
      contract_version: String(row.contract_version),
      import_eligibility: String(row.import_eligibility),
      matched_primary_mountain_id: row.matched_primary_mountain_id === null
        ? null
        : Number(row.matched_primary_mountain_id),
    })),
    stagingSummits: stagingSummits.map((row) => ({
      staging_route_id: String(row.staging_route_id),
      peak_osm_id: String(row.peak_osm_id),
      mountain_id: Number(row.mountain_id),
      mountain_match_classification: String(row.mountain_match_classification),
      final_association: String(row.final_association),
    })),
    mountains: mountains.map((row) => ({
      id: Number(row.id),
      osm_id: row.osm_id === null ? null : String(row.osm_id),
    })),
    productionRoutes: productionRoutes.map((row) => ({
      id: String(row.id),
      source_url: String(row.source_url),
    })),
  });
}

function qaSnapshotHash(inputs: PublicationGateInput[]): string {
  const decisions: StoredPreviewQaDecision[] = inputs.flatMap((input) => input.qaDecisions)
    .sort((left, right) => left.stagingRouteId.localeCompare(right.stagingRouteId));
  return sha256Stable(decisions);
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Phase 11D read-only analysis requires Supabase credentials.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [plan, audit, historicalInput, phase11c4Input, activeResult] = await Promise.all([
    readFile(PATHS.plan, "utf8").then((value) => JSON.parse(value) as ImportPlanDocument),
    readFile(PATHS.audit, "utf8").then(JSON.parse),
    loadPublicationGateInput(),
    loadPhase11c4PublicationGateInput(),
    client.from("osm_route_publication_provenance")
      .select("mountain_route_id,staging_route_id,canonical_relation_id,source_url,publication_status")
      .eq("publication_status", "ACTIVE")
      .order("mountain_route_id", { ascending: true }),
  ]);
  if (activeResult.error) throw new Error(`PHASE11D_ACTIVE_QUERY:${activeResult.error.message}`);
  const activeRows = (activeResult.data ?? []) as ActivePublicationRow[];
  if (activeRows.length !== 118) throw new Error(`PHASE11D_ACTIVE_CHECKPOINT_NOT_118:${activeRows.length}`);
  const activeIds = new Set(activeRows.map((row) => String(row.canonical_relation_id)));
  if (activeIds.size !== 118) throw new Error("PHASE11D_DUPLICATE_ACTIVE_RELATION");
  const activeUrls = new Set(activeRows.map((row) => String(row.source_url)));
  if (activeUrls.size !== 118) throw new Error("PHASE11D_DUPLICATE_ACTIVE_SOURCE_URL");

  const planIds = new Set(plan.records.map((record) => record.sourceRelationId));
  const analyses = new Map<string, RouteAnalysisRecord>();
  let discoveredAnalysisRecords = 0;
  let summitRouteCount = 0;
  let confirmedSummitAssociations = 0;
  for await (const analysis of iterateJsonLines<RouteAnalysisRecord>(PATHS.analysis)) {
    discoveredAnalysisRecords += 1;
    if (analysis.semanticType === "summit_route") summitRouteCount += 1;
    confirmedSummitAssociations += analysis.summitAssociations.filter(
      (association) => association.finalAssociation === "CONFIRMED",
    ).length;
    if (planIds.has(analysis.routeSourceId)) analyses.set(analysis.routeSourceId, analysis);
    if (discoveredAnalysisRecords % 10_000 === 0) {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      process.stdout.write(`Scanned ${discoveredAnalysisRecords} frozen route analyses.\n`);
    }
  }
  if (analyses.size !== plan.records.length) {
    throw new Error(`PHASE11D_ROUTE_ANALYSIS_INCOMPLETE:${analyses.size}/${plan.records.length}`);
  }

  const motorwayMetadata = await buildOrVerifyMotorwayIndex({
    pbfPath: PATHS.pbf,
    indexPath: PATHS.motorwayIndex,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  const sourceDatasetIdentity = await createRoadSafetySourceDatasetIdentity({
    pbfPath: PATHS.pbf,
    checkpointPath: PATHS.checkpoint,
    checkpointManifestPath: PATHS.checkpointManifest,
    pipelineSummaryPath: PATHS.pipeline,
    pipelineDatasetFingerprint: plan.datasetFingerprint,
    motorwayIndexMetadata: motorwayMetadata,
  });
  const sourceIdentity = {
    ...sourceDatasetIdentity,
    phase7AuditHash: plan.phase7AuditHash,
    importPlanDatasetFingerprint: plan.datasetFingerprint,
    importPlanRecordCount: plan.records.length,
  };

  const qaInputs = [historicalInput, phase11c4Input];
  const humanStatus = humanQaByRelation(qaInputs);
  const relationCounts = countBy(plan.records.map((record) => record.sourceRelationId));
  const urlCounts = countBy(plan.records.map((record) => record.contract.source.sourceUrl));
  const roadResults = new Map<string, RoadSafetyRouteResult>();
  const roadMetrics: RoadSafetyAnalysisMetrics = { exactIntersectionChecks: 0 };
  const spatialCounters = { spatialBoundsQueries: 0, spatialCandidateChecks: 0 };
  const activities = new Map<string, RouteActivityClassification>();
  const qualificationInputs: Phase11dQualificationInput[] = [];
  const preliminaryResults = new Map<string, Phase11dQualificationResult>();
  const routeStore = new FrozenRouteMemberStore(PATHS.checkpoint);
  const motorwayIndex = new MotorwaySpatialIndex(PATHS.motorwayIndex);
  try {
    for (let index = 0; index < plan.records.length; index += 1) {
      const record = plan.records[index];
      const analysis = analyses.get(record.sourceRelationId)!;
      const activity = classifyRouteActivity(activityRoute(analysis, record));
      activities.set(record.sourceRelationId, activity);
      const topology = analyzeRouteTopology(record.contract.route.geometry);
      const endpoint = selectRouteEndpoints(
        topology,
        record.contract.confirmedSummits.flatMap((summit) =>
          summit.peakCoordinates === null ? [] : [summit.peakCoordinates]),
      );
      let routeMemberDataIntegrityFailure = false;
      let roadSafetyStatus: Phase11dQualificationInput["roadSafetyStatus"] = "BLOCKED";
      let roadSafetyReasonCodes: Phase11dQualificationInput["roadSafetyReasonCodes"] = [];
      try {
        const routeWays = routeStore.routeWays(
          record.contract.mergedDuplicateProvenance.sourceRouteIds,
        );
        const road = analyzeRouteRoadSafety({
          canonicalRelationId: record.canonicalRouteSourceId,
          stagingRouteId: record.idempotencyKey,
          routeType: activity.routeType,
          routeWays,
          nearbyMotorwayWays: nearbyMotorways(routeWays, motorwayIndex, spatialCounters),
          sourceDatasetIdentity,
          metrics: roadMetrics,
        });
        roadResults.set(record.sourceRelationId, road);
        roadSafetyStatus = road.status;
        roadSafetyReasonCodes = road.reasonCodes;
      } catch (error) {
        routeMemberDataIntegrityFailure = true;
        process.stderr.write(
          `Route-member integrity failure ${record.sourceRelationId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      const geometry = validateRouteGeometry(record.contract.route.geometry);
      const qualificationInput: Phase11dQualificationInput = {
        sourceRelationId: record.sourceRelationId,
        canonicalRouteSourceId: record.canonicalRouteSourceId,
        sourceUrl: record.contract.source.sourceUrl,
        stagingIdempotencyKey: record.idempotencyKey,
        stagingPayloadHash: record.payloadHash,
        semanticType: analysis.semanticType,
        routeType: activity.routeType,
        activityManualReviewRequired: activity.manualReviewRequired,
        geometryValid: geometry.geometryValid && geometry.coordinatesFinite,
        qualityScore: record.contract.route.qualityScore,
        auditFlags: [...record.contract.auditFlags],
        warnings: [...record.warnings],
        summits: record.contract.confirmedSummits.map((summit) => ({
          peakOsmId: summit.peakOsmId,
          mountainId: summit.mountainMatch.mountainId,
          finalAssociation: summit.finalAssociation,
          mountainMatchClassification: summit.mountainMatch.classification,
        })),
        topologyClassification: topology.classification,
        connectedGroupCount: topology.connectedGroupCount,
        physicalEndpointCount: topology.physicalEndpointCount,
        endpointSelectionAmbiguous: endpoint.ambiguous,
        explicitlySupportedClosedLoop: isExplicitClosedLoop(analysis),
        active: activeIds.has(record.canonicalRouteSourceId),
        duplicateRelationIdentity: relationCounts[record.sourceRelationId] > 1,
        duplicateSourceUrl: urlCounts[record.contract.source.sourceUrl] > 1,
        publicationSourceConflict:
          activeUrls.has(record.contract.source.sourceUrl) &&
          !activeIds.has(record.canonicalRouteSourceId),
        dataIntegrityFailure: record.operation === "BLOCKED_VALIDATION",
        routeMemberDataIntegrityFailure,
        roadSafetyStatus,
        roadSafetyReasonCodes,
        humanQaStatus: humanStatus.get(record.canonicalRouteSourceId) ?? null,
      };
      qualificationInputs.push(qualificationInput);
      preliminaryResults.set(
        record.sourceRelationId,
        qualifyPhase11dRoute({
          ...qualificationInput,
          active: false,
          publicationSourceConflict: false,
          humanQaStatus: null,
        }),
      );
      if ((index + 1) % 100 === 0 || index + 1 === plan.records.length) {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        process.stdout.write(`Qualified ${index + 1}/${plan.records.length} frozen candidates.\n`);
      }
    }
  } finally {
    motorwayIndex.close();
    routeStore.close();
  }

  const results = qualificationInputs.map(qualifyPhase11dRoute);
  const nonActive = results.filter((result) => !activeIds.has(result.canonicalRouteSourceId));
  const green = nonActive.filter((result) => result.status === "GREEN");
  const yellow = nonActive.filter((result) => result.status === "YELLOW");
  const red = nonActive.filter((result) => result.status === "RED");
  const planByRelation = new Map(plan.records.map((record) => [record.sourceRelationId, record]));
  const queueEligible = nonActive.filter((result) =>
    result.summitIdentities.length === 1 &&
    planByRelation.get(result.sourceRelationId)?.operation === "READY_FOR_STAGING");
  const queue = selectPhase11dQueue(queueEligible, QUEUE_SIZE);
  if (queue.length !== QUEUE_SIZE) {
    throw new Error(`PHASE11D_QUEUE_CAPACITY:${queue.length}/${QUEUE_SIZE}`);
  }
  const selectedPlans = queue.map((result) => planByRelation.get(result.sourceRelationId)!);
  const stagingManifest = createLockedFirstWriteManifest(selectedPlans, plan.datasetFingerprint);
  const previewMetadata: PreviewMetadataDocument = {
    schemaVersion: 1,
    contractVersion: stagingManifest.contractVersion,
    datasetFingerprint: stagingManifest.datasetFingerprint,
    manifestHash: stagingManifest.manifestHash,
    recordCount: selectedPlans.length,
    records: selectedPlans.map((record, index) =>
      previewMetadataRecord(record, queue[index].status as "GREEN" | "YELLOW")),
  };
  const queueRecords = queue.map((result, index) => ({
    sourceRelationId: result.sourceRelationId,
    canonicalRouteSourceId: result.canonicalRouteSourceId,
    sourceUrl: result.sourceUrl,
    stagingIdempotencyKey: result.stagingIdempotencyKey,
    stagingPayloadHash: result.stagingPayloadHash,
    mountainIdentities: result.summitIdentities.map((summit) => ({
      peakOsmId: summit.peakOsmId,
      mountainId: summit.mountainId,
    })),
    qualificationStatus: result.status,
    reasonCodes: result.reasonCodes,
    roadSafetyStatus: result.roadSafetyStatus,
    roadSafetyReasonCodes: result.roadSafetyReasonCodes,
    priority: index + 1,
  }));
  const queueContent = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11D_SCALE_QA_QUEUE" as const,
    queueId: "phase11d" as const,
    readOnly: true as const,
    stagingRequiredBeforeRuntimeUse: true as const,
    autoApprovalEnabled: PHASE11D_AUTO_APPROVAL_ENABLED,
    sourceIdentity,
    newRoutesQueued: queueRecords.length,
    qualificationCounts: countBy(queueRecords.map((record) => record.qualificationStatus)),
    queue: queueRecords,
    deterministicQueueHash: sha256Stable(queueRecords),
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  };
  const queueArtifact = artifact(queueContent);
  const stagingPreflight = await preflightSelected(client, selectedPlans);
  const preflightContent = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11D_STAGING_PREFLIGHT" as const,
    readOnly: true as const,
    sourceIdentity,
    queueId: "phase11d" as const,
    queueHash: queueArtifact.deterministicQueueHash,
    totalPlanned: selectedPlans.length,
    alreadyStaged: stagingPreflight.unchanged,
    wouldCreate: stagingPreflight.wouldCreate,
    unchanged: stagingPreflight.unchanged,
    blocked: stagingPreflight.blocked,
    conflicts: stagingPreflight.records.filter((record) => record.action === "BLOCKED").length,
    records: stagingPreflight.records,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  };
  const preflightArtifact = artifact(preflightContent);

  const humanStatuses = ["VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"] as const;
  const qualificationStatuses = ["GREEN", "YELLOW", "RED"] as const;
  const calibrationResults = qualificationInputs
    .filter((input) => input.humanQaStatus !== null)
    .map((input) => qualifyPhase11dRoute({
      ...input,
      active: false,
      publicationSourceConflict: false,
    }));
  const calibration = Object.fromEntries(humanStatuses.map((status) => [
    status,
    Object.fromEntries(qualificationStatuses.map((qualification) => [
      qualification,
      calibrationResults.filter((result) =>
        result.humanQaStatus === status && result.status === qualification).length,
    ])),
  ]));
  const falseGreen = calibrationResults.filter((result) =>
    result.status === "GREEN" &&
    (result.humanQaStatus === "NEEDS_REVIEW" || result.humanQaStatus === "REJECTED"));
  const preventedFalseGreens = qualificationInputs.flatMap((input) => {
    const preliminary = preliminaryResults.get(input.sourceRelationId)!;
    const final = calibrationResults.find(
      (result) => result.sourceRelationId === input.sourceRelationId,
    );
    if (!final) return [];
    return preliminary.status === "GREEN" &&
      (input.humanQaStatus === "NEEDS_REVIEW" || input.humanQaStatus === "REJECTED")
      ? [{
          sourceRelationId: input.sourceRelationId,
          humanQaStatus: input.humanQaStatus,
          preGuardStatus: preliminary.status,
          finalStatus: final.status,
          finalReasonCodes: final.reasonCodes,
        }]
      : [];
  });

  const readyPlans = plan.records.filter((record) => record.operation === "READY_FOR_STAGING");
  const allConfirmedExact = plan.records.filter((record) =>
    record.contract.confirmedSummits.length > 0 &&
    record.contract.confirmedSummits.every((summit) =>
      summit.finalAssociation === "CONFIRMED" &&
      summit.mountainMatch.classification === "EXACT_MOUNTAIN_MATCH" &&
      summit.mountainMatch.mountainId !== null));
  const allConfirmedExactIds = new Set(
    allConfirmedExact.map((record) => record.sourceRelationId),
  );
  const exactIdentityRoutes = qualificationInputs.filter((value) =>
    allConfirmedExactIds.has(value.sourceRelationId));
  const geometryValid = exactIdentityRoutes.filter((value) => value.geometryValid);
  const supportedHiking = geometryValid.filter((value) =>
    value.routeType === "hiking" && !value.activityManualReviewRequired);
  const simple = supportedHiking.filter((value) =>
    value.topologyClassification === "SIMPLE" &&
    value.physicalEndpointCount === 2 &&
    !value.endpointSelectionAmbiguous);
  const nonActiveSimple = simple.filter((value) => !value.active);
  const preQaEligible = nonActiveSimple.filter((value) =>
    value.qualityScore >= 80 &&
    value.summits.length === 1 &&
    value.summits.every((summit) =>
      summit.finalAssociation === "CONFIRMED" &&
      summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH" &&
      summit.mountainId !== null) &&
    !value.duplicateRelationIdentity &&
    !value.duplicateSourceUrl &&
    !value.publicationSourceConflict &&
    !value.dataIntegrityFailure &&
    !value.routeMemberDataIntegrityFailure);
  const preQaRoad = countBy(preQaEligible.map((value) => value.roadSafetyStatus));
  const reasonDistribution = countBy(nonActive.flatMap((result) => result.reasonCodes));
  const noValidStartFinish = nonActive.filter((result) =>
    result.reasonCodes.includes("NO_VALID_START_FINISH")).length;
  const roadPopulation = qualificationInputs;
  const roadDistribution = countBy(roadPopulation.map((value) => value.roadSafetyStatus));
  const barrierReasons = new Set([
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
  ]);
  const primaryBottleneckDistribution = countBy(
    nonActive.filter((result) => result.status !== "GREEN").map((result) =>
      result.reasonCodes.find((reason) => barrierReasons.has(reason)) ?? "UNCLASSIFIED"),
  );
  const preQaEligibleIds = new Set(preQaEligible.map((value) => value.sourceRelationId));
  const nearGreen = nonActive.filter((result) =>
    preQaEligibleIds.has(result.sourceRelationId) && result.status !== "GREEN");
  const nearGreenReasonDistribution = countBy(nearGreen.flatMap((result) =>
    result.reasonCodes.filter((reason) => barrierReasons.has(reason))));

  const greenArtifact = qualificationArtifact(
    "PHASE11D_QUALIFIED_SAFE_CANDIDATES",
    sourceIdentity,
    green,
  );
  const yellowArtifact = qualificationArtifact(
    "PHASE11D_YELLOW_REVIEW_CANDIDATES",
    sourceIdentity,
    yellow,
  );
  const redArtifact = qualificationArtifact(
    "PHASE11D_RED_BLOCKED_CANDIDATES",
    sourceIdentity,
    red,
  );
  const readinessContent = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11D_SCALE_READINESS" as const,
    readOnly: true as const,
    qualificationContractVersion: PHASE11D_QUALIFICATION_CONTRACT,
    sourceIdentity,
    checkpoint: {
      expectedActive: 118,
      actualActive: activeRows.length,
      uniqueActiveRelations: activeIds.size,
      duplicateActiveSourceUrls: activeRows.length - activeUrls.size,
    },
    funnel: {
      discoveredRelations: audit.sourceDataset.hikingRelationsAnalyzed,
      reconstructedRelations: audit.sourceDataset.reconstructedRoutes,
      routeAnalysisRecords: discoveredAnalysisRecords,
      summitRoute: summitRouteCount,
      confirmedSummitAssociations,
      candidatePopulation: qualificationInputs.length,
      exactMountainMatchAssociations: plan.records.reduce((sum, record) =>
        sum + record.contract.confirmedSummits.filter((summit) =>
          summit.mountainMatch.classification === "EXACT_MOUNTAIN_MATCH").length, 0),
      allConfirmedSummitsExact: allConfirmedExact.length,
      stagingReadyBeforePhase11d: readyPlans.length,
      geometryValid: geometryValid.length,
      supportedHiking: supportedHiking.length,
      simpleTopologyWithValidStartFinish: simple.length,
      nonActive: qualificationInputs.filter((value) => !value.active).length,
      nonActiveAfterSimpleTopologyGate: nonActiveSimple.length,
      publicationGateEligibleBeforeQa: preQaEligible.length,
      publicationGateEligibleRoadSafety: preQaRoad,
    },
    qualification: {
      greenMinimumQuality: PHASE11D_GREEN_MINIMUM_QUALITY,
      autoApprovalEnabled: PHASE11D_AUTO_APPROVAL_ENABLED,
      nonActiveQualificationTotals: {
        green: green.length,
        yellow: yellow.length,
        red: red.length,
      },
      nonActiveGreenSafeHiking: green.filter((result) => result.routeType === "hiking").length,
      nonActiveYellowHiking: yellow.filter((result) => result.routeType === "hiking").length,
      nonActiveRedHiking: red.filter((result) => result.routeType === "hiking").length,
      noValidStartFinish,
      excessiveDetour: {
        enabled: false,
        count: 0,
        reason: "Endpoint straight-line ratios do not prove a safe shorter mountain path; no network-shortest-path evidence exists in the frozen contract.",
      },
      reasonDistribution,
      bottleneckTo500: {
        greenGap: Math.max(0, 500 - green.length),
        nonGreenCandidateCount: yellow.length + red.length,
        primaryBottleneckDistribution,
        publicationGateEligibleButNotGreen: nearGreen.length,
        publicationGateEligibleButNotGreenReasonDistribution: nearGreenReasonDistribution,
      },
    },
    roadSafety: {
      candidateCount: roadPopulation.length,
      statusDistribution: roadDistribution,
      roadWaysIndexed: motorwayMetadata.motorwayWayCount,
      roadNodesIndexed: motorwayMetadata.motorwayNodeCount,
      spatialBoundsQueries: spatialCounters.spatialBoundsQueries,
      spatialCandidateChecks: spatialCounters.spatialCandidateChecks,
      exactIntersectionChecks: roadMetrics.exactIntersectionChecks,
    },
    calibration: {
      qaSnapshotHash: qaSnapshotHash(qaInputs),
      reviewedDecisionCount: [...humanStatus.values()].filter((status) => status !== null).length,
      matrix: calibration,
      falseGreenCount: falseGreen.length,
      falseGreenRelationIds: falseGreen.map((result) => result.sourceRelationId),
      preventedFalseGreens,
      policy: "Current human NEEDS_REVIEW forces YELLOW and REJECTED forces RED; machine qualification never writes QA.",
    },
    readiness: {
      machineQualifiedSafe500: green.length >= 500,
      machineQualifiedReserveBeyond500: Math.max(0, green.length - 500),
      humanQaPublicationReady500: results.filter((result) =>
        !activeIds.has(result.canonicalRouteSourceId) &&
        result.status === "GREEN" &&
        result.humanQaStatus === "VISUALLY_APPROVED").length >= 500,
      humanQaPublicationReadyCount: results.filter((result) =>
        !activeIds.has(result.canonicalRouteSourceId) &&
        result.status === "GREEN" &&
        result.humanQaStatus === "VISUALLY_APPROVED").length,
    },
    queue: {
      queueId: "phase11d",
      size: queueRecords.length,
      hash: queueArtifact.deterministicQueueHash,
      qualificationCounts: queueArtifact.qualificationCounts,
      stagingRequiredBeforeRuntimeUse: true,
    },
    stagingPreflight: {
      totalPlanned: preflightArtifact.totalPlanned,
      alreadyStaged: preflightArtifact.alreadyStaged,
      wouldCreate: preflightArtifact.wouldCreate,
      unchanged: preflightArtifact.unchanged,
      blocked: preflightArtifact.blocked,
      conflicts: preflightArtifact.conflicts,
      hash: preflightArtifact.deterministicArtifactHash,
    },
    artifactHashes: {
      qualifiedSafeCandidates: greenArtifact.deterministicArtifactHash,
      yellowReviewCandidates: yellowArtifact.deterministicArtifactHash,
      redBlockedCandidates: redArtifact.deterministicArtifactHash,
      queue: queueArtifact.deterministicArtifactHash,
      stagingManifest: stagingManifest.manifestHash,
      previewMetadata: sha256Stable(previewMetadata),
      stagingPreflight: preflightArtifact.deterministicArtifactHash,
    },
    writes: {
      databaseWrites: 0 as const,
      qaWrites: 0 as const,
      publicationWrites: 0 as const,
    },
  };
  const readinessArtifact = artifact(readinessContent);
  await Promise.all([
    writeJsonAtomically(PATHS.green, greenArtifact),
    writeJsonAtomically(PATHS.yellow, yellowArtifact),
    writeJsonAtomically(PATHS.red, redArtifact),
    writeJsonAtomically(PATHS.queue, queueArtifact),
    writeJsonAtomically(PATHS.stagingManifest, stagingManifest),
    writeJsonAtomically(PATHS.previewMetadata, previewMetadata),
    writeJsonAtomically(PATHS.stagingPreflight, preflightArtifact),
    writeJsonAtomically(PATHS.readiness, readinessArtifact),
  ]);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    readinessPath: PATHS.readiness,
    readinessHash: readinessArtifact.deterministicArtifactHash,
    active: activeRows.length,
    green: green.length,
    yellow: yellow.length,
    red: red.length,
    machineQualifiedSafe500: readinessArtifact.readiness.machineQualifiedSafe500,
    queueSize: queueRecords.length,
    queueHash: queueArtifact.deterministicQueueHash,
    stagingPreflight: readinessArtifact.stagingPreflight,
    roadSafety: readinessArtifact.roadSafety,
    falseGreenCount: falseGreen.length,
    elapsedMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
    peakRssMegabytes: Math.round(peakRssBytes / 1024 / 1024 * 10) / 10,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
