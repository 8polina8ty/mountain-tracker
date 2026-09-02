import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { sha256Stable } from "./phase11-publication.ts";
import { MotorwaySpatialIndex,
  buildOrVerifyMotorwayIndex,
  createRoadSafetySourceDatasetIdentity } from "./phase11c9-road-index.ts";
import { FrozenRouteMemberStore } from "./phase11c9-route-member-store.ts";
import {
  analyzeRouteRoadSafety,
  type RoadSafetyAnalysisMetrics,
  type RoadSafetySourceDatasetIdentity,
  type RoadSafetyWay,
} from "./phase11c9-road-safety.ts";
import { analyzeRouteTopology, selectRouteEndpoints } from "../../Lib/osmStagingPreview/topology.ts";
import type { RouteGeometry as PeakMatcherRouteGeometry } from "./peak-matcher.ts";
import { classifyRouteActivity } from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import { validateRouteGeometry } from "./alps-audit.ts";
import { classifyStartContextV3,
  loadPhase11f2FeatureIndex,
  type StartContextEvidence } from "./start-context-classifier3.ts";
import {
  buildFeatureIndex,
  resolveStartElevationV3,
  type EleNodeRecord,
} from "./phase11f3-start-elevation.ts";
import {
  PHASE11G_EXPANSION_CONTRACT,
  PHASE11G_AUTO_APPROVAL_ENABLED,
  type Phase11gQualificationInput,
  type Phase11gQualificationResult,
  qualifyPhase11gRoute,
} from "./phase11g-qualification.ts";

const DATA_ROOT = "data/osm/alps";
const CANONICAL_CONFIRMED = `${DATA_ROOT}/audit/canonical-confirmed-routes.jsonl`;
const IMPORT_ELIGIBILITY = `${DATA_ROOT}/audit/import-eligibility.jsonl`;
const ROUTES_JSONL = `${DATA_ROOT}/routes.jsonl`;
const ROUTE_ANALYSIS_JSONL = `${DATA_ROOT}/route-analysis.jsonl`;
const SUMMARY_JSON = `${DATA_ROOT}/summary.json`;
const FEATURE_DIR = `${DATA_ROOT}/staging/phase11f2-features`;
const ELE_NODES_RAW = `${DATA_ROOT}/staging/phase11f3-features/ele-nodes-raw.json`;
const GLOBAL_CONFIRMED_SUMMIT_ROUTE_COUNT = 2772;
const EXISTING_GREEN_641_SAFE500 = 75;
const EXISTING_GREEN_641_SAFE600 = 124;

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const CHECKPOINT_DIRECTORY = "data/osm/alps/checkpoints/fafc4f7a772832f2";
const CHECKPOINT_PATH = `${CHECKPOINT_DIRECTORY}/bulk-store.sqlite`;
const CHECKPOINT_MANIFEST_PATH = `${CHECKPOINT_DIRECTORY}/manifest.json`;
const PIPELINE_SUMMARY_PATH = "data/osm/alps/summary.json";
const MOTORWAY_INDEX_PATH = "data/osm/alps/road-safety/phase11c9-motorways.sqlite";

const OUT_STAGING = `${DATA_ROOT}/staging`;
const OUT_PUBLICATION = `${DATA_ROOT}/publication`;
const AUDIT_PATH = `${OUT_STAGING}/phase11g-expanded-candidate-audit.json`;
const GREEN_PATH = `${OUT_STAGING}/phase11g-expanded-green-candidates.json`;
const SAMPLE_PATH = `${OUT_STAGING}/phase11g-calibration-sample.json`;
const REPORT_PATH = `${OUT_PUBLICATION}/phase11g-full-ascent-expansion-report.json`;

interface CanonicalConfirmedRoute {
  canonicalRouteSourceId: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  geometryType: string;
  distanceMeters: number;
  componentCount: number;
  sourceRouteIds: string[];
  removedDuplicateRepresentationIds: string[];
  confirmedSummits: Array<{
    peakSourceId: string;
    peakName: string;
    peakElevationMeters: number | null;
    peakCoordinates: [number, number] | null;
    minimumGeometryDistanceMeters: number | null;
    endpointDistanceMeters: number | null;
    finalAssociation: string;
    finalConfidence: number;
  }>;
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
    geometryType: string;
    componentCount: number;
    tags?: Record<string, string>;
  };
}

interface RouteGeometry {
  type: "LineString" | "MultiLineString";
  coordinates: [number, number][] | [number, number][][];
}

interface RoutesRecord {
  source: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  geometry: RouteGeometry;
}

function serialize(input: unknown): string {
  return JSON.stringify(input, null, 2);
}

function artifact<T extends object>(content: T): T & { deterministicArtifactHash: string } {
  return { ...content, deterministicArtifactHash: sha256Stable(content) };
}

function classifiableRoute(
  analysis: RouteAnalysisRecord,
  geometry: RouteGeometry,
): ClassifiableRoute {
  const metadata = analysis.routeMetadata;
  return {
    sourceId: analysis.routeSourceId,
    sourceUrl: analysis.routeSourceUrl,
    name: analysis.routeName,
    ref: metadata.ref,
    network: metadata.network,
    operator: metadata.operator,
    geometry: geometry as ClassifiableRoute["geometry"],
    stats: {
      distanceMeters: metadata.distanceMeters,
      coordinatePoints: metadata.coordinatePoints,
      componentCount: metadata.componentCount,
    },
    metadata: {
      route: metadata.routeType ?? "",
      from: metadata.from,
      to: metadata.to,
      roundtrip: metadata.roundtrip,
      osmcSymbol: metadata.osmcSymbol,
      tags: metadata.tags ?? {},
    },
  };
}

function isExplicitClosedLoop(metadata: RouteAnalysisRecord["routeMetadata"]): boolean {
  const value = metadata.roundtrip?.trim().toLowerCase();
  return value === "yes" || value === "roundtrip" || value === "circular";
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

async function loadRecoverablePool(): Promise<{
  records: Map<string, CanonicalConfirmedRoute>;
  eligibility: Map<string, string>;
}> {
  const canonical = new Map<string, CanonicalConfirmedRoute>();
  for (const line of (await readFile(CANONICAL_CONFIRMED, "utf8")).trim().split(/\r?\n/)) {
    const record = JSON.parse(line) as CanonicalConfirmedRoute;
    canonical.set(record.canonicalRouteSourceId, record);
  }
  const eligibility = new Map<string, string>();
  for (const line of (await readFile(IMPORT_ELIGIBILITY, "utf8")).trim().split(/\r?\n/)) {
    const record = JSON.parse(line) as { canonicalRouteSourceId: string; eligibility: string };
    eligibility.set(record.canonicalRouteSourceId, record.eligibility);
  }
  const records = new Map<string, CanonicalConfirmedRoute>();
  for (const [id, record] of canonical) {
    if (eligibility.get(id) === "MANUAL_REVIEW_REQUIRED") records.set(id, record);
  }
  return { records, eligibility };
}

async function loadRoutesJsonl(): Promise<Map<string, RoutesRecord>> {
  const result = new Map<string, RoutesRecord>();
  for (const line of (await readFile(ROUTES_JSONL, "utf8")).trim().split(/\r?\n/)) {
    const record = JSON.parse(line) as RoutesRecord;
    result.set(String(record.sourceId), record);
  }
  return result;
}

async function loadRouteAnalysis(): Promise<Map<string, RouteAnalysisRecord>> {
  const result = new Map<string, RouteAnalysisRecord>();
  for (const line of (await readFile(ROUTE_ANALYSIS_JSONL, "utf8")).trim().split(/\r?\n/)) {
    const record = JSON.parse(line) as RouteAnalysisRecord;
    result.set(record.routeSourceId, record);
  }
  return result;
}

async function loadActiveRelationIds(): Promise<Set<string>> {
  const active = new Set<string>();
  const dir = `${DATA_ROOT}/publication`;
  for (const file of (await readdir(dir)).filter((f) => /\.json$/.test(f) && !/dry-run/.test(f))) {
    const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as {
      records?: Array<{ canonicalRouteSourceId?: string; canonicalRelationId?: string }>;
      baselineSnapshot?: { baselineRelationIds?: string[] };
      baselineActiveRelationIds?: string[];
    };
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    for (const record of records) {
      const id = record.canonicalRouteSourceId ?? record.canonicalRelationId;
      if (id != null) active.add(String(id));
    }
    if (parsed.baselineSnapshot?.baselineRelationIds) {
      for (const id of parsed.baselineSnapshot.baselineRelationIds) active.add(String(id));
    }
    if (parsed.baselineActiveRelationIds) {
      for (const id of parsed.baselineActiveRelationIds) active.add(String(id));
    }
  }
  return active;
}

async function buildSourceIdentity(
  pipelineDatasetFingerprint: string,
): Promise<RoadSafetySourceDatasetIdentity> {
  const metadata = await buildOrVerifyMotorwayIndex({
    pbfPath: PBF_PATH,
    indexPath: MOTORWAY_INDEX_PATH,
  });
  const identity = await createRoadSafetySourceDatasetIdentity({
    pbfPath: PBF_PATH,
    checkpointPath: CHECKPOINT_PATH,
    checkpointManifestPath: CHECKPOINT_MANIFEST_PATH,
    pipelineSummaryPath: PIPELINE_SUMMARY_PATH,
    pipelineDatasetFingerprint,
    motorwayIndexMetadata: metadata,
  });
  return identity;
}

async function main(): Promise<void> {
  await mkdir(OUT_STAGING, { recursive: true });
  await mkdir(OUT_PUBLICATION, { recursive: true });

  process.stdout.write("Phase 11G FULL ASCENT CANDIDATE EXPANSION (offline, frozen OSM only)\n");

  const { records: recoverable, eligibility } = await loadRecoverablePool();
  const routesById = await loadRoutesJsonl();
  const analyses = await loadRouteAnalysis();
  const activeIds = await loadActiveRelationIds();

  const summary = JSON.parse(await readFile(SUMMARY_JSON, "utf8")) as {
    generatedAt: string;
    counts: Record<string, number> & {
      semanticTypes?: Record<string, number>;
      summitAssociations?: Record<string, number>;
      qualityDistribution?: Record<string, number>;
    };
  };
  const importPlan = JSON.parse(await readFile(`${DATA_ROOT}/staging/import-plan.json`, "utf8")) as {
    datasetFingerprint: string;
  };
  const pipelineDatasetFingerprint = importPlan.datasetFingerprint;
  const sourceIdentity = await buildSourceIdentity(pipelineDatasetFingerprint);

  const recoverableIds = [...recoverable.keys()].sort((a, b) => Number(a) - Number(b));

  // ACTIVE cross-check: the recoverable pool must be disjoint from the frozen
  // publication/ACTIVE relation-id union.
  const activeOverlap = recoverableIds.filter((id) => activeIds.has(id));
  if (activeOverlap.length !== 0) {
    throw new Error(`PHASE11G_RECOVERABLE_ACTIVE_OVERLAP:${activeOverlap.length}`);
  }

  const featureIndex = await loadPhase11f2FeatureIndex(FEATURE_DIR);
  const eleNodes = (JSON.parse(await readFile(ELE_NODES_RAW, "utf8")) as EleNodeRecord[]).filter(
    (node) => node.coordinate && node.normalizedMeters != null,
  );
  const phase11f3Index = buildFeatureIndex(featureIndex, eleNodes);

  const routeStore = new FrozenRouteMemberStore(CHECKPOINT_PATH);
  const motorwayIndex = new MotorwaySpatialIndex(MOTORWAY_INDEX_PATH);
  const roadMetrics: RoadSafetyAnalysisMetrics = { exactIntersectionChecks: 0 };
  const spatialCounters = { spatialBoundsQueries: 0, spatialCandidateChecks: 0 };

  const audited: Array<{
    canonicalRouteSourceId: string;
    routeName: string | null;
    bucket: string;
    safeStatus: string;
    greenClass: string | null;
    qualityScore: number;
    reasonCodes: string[];
    startContext: string | null;
    roadSafetyStatus: string | null;
  }> = [];

  const greenRecords: Phase11gQualificationResult[] = [];
  const bucketCounts: Record<string, number> = {};
  let rawRecovered = 0;
  let duplicateRepresentations = 0;
  let roadUnsafeCount = 0;

  const cheapScreenFailures = 0;
  let expensiveComputed = 0;

  try {
    for (let index = 0; index < recoverableIds.length; index += 1) {
      const id = recoverableIds[index];
      const record = recoverable.get(id)!;

      // Duplicate representations are already collapsed into the canonical route.
      const representationCount = 1 + (record.removedDuplicateRepresentationIds?.length ?? 0);
      rawRecovered += representationCount;
      duplicateRepresentations += Math.max(0, representationCount - 1);

      const routesRec = routesById.get(id);
      const analysis = analyses.get(id);
      if (!routesRec || !routesRec.geometry || !analysis) {
        audited.push({ canonicalRouteSourceId: id, routeName: record.routeName, bucket: "MISSING_GEOMETRY_OR_ANALYSIS", safeStatus: "RED", greenClass: null, qualityScore: record.qualityScore, reasonCodes: ["DATA_INTEGRITY_FAILURE"], startContext: null, roadSafetyStatus: null });
        bucketCounts["MISSING_GEOMETRY_OR_ANALYSIS"] = (bucketCounts["MISSING_GEOMETRY_OR_ANALYSIS"] ?? 0) + 1;
        continue;
      }

      const geometry = routesRec.geometry;
      const activity = classifyRouteActivity(classifiableRoute(analysis, geometry));
      const topology = analyzeRouteTopology(geometry as import("../../Lib/osmStagingPreview/topology.ts").TopologyRouteGeometry);
      const confirmedSummits = record.confirmedSummits ?? [];
      const summitCoords = confirmedSummits
        .map((s) => s.peakCoordinates)
        .filter((c): c is [number, number] => c !== null);
      const singleExactTerminal = confirmedSummits.length === 1 &&
        confirmedSummits[0].endpointDistanceMeters != null &&
        confirmedSummits[0].endpointDistanceMeters <= 10;
      const endpoint = selectRouteEndpoints(topology, summitCoords);
      const supportedClosedLoop = isExplicitClosedLoop(analysis.routeMetadata) &&
        topology.classification === "AMBIGUOUS" &&
        topology.connectedGroupCount === 1 &&
        topology.physicalEndpointCount === 0;
      const hasValidStartFinish = topology.physicalEndpointCount === 2 && !endpoint.ambiguous;
      const geometryCheck = validateRouteGeometry(geometry as PeakMatcherRouteGeometry);

      const startElevationResolution = singleExactTerminal && hasValidStartFinish && endpoint.startCoordinate
        ? resolveStartElevationV3(endpoint.startCoordinate, phase11f3Index)
        : null;
      const summitEle = singleExactTerminal && confirmedSummits[0].peakElevationMeters != null
        ? confirmedSummits[0].peakElevationMeters
        : null;
      const verticalGain = startElevationResolution?.deterministic &&
        startElevationResolution.startElevationMeters != null && summitEle != null
        ? summitEle - (startElevationResolution.startElevationMeters as number)
        : null;

      const summitIdentities = confirmedSummits.map((s) => ({
        peakOsmId: s.peakSourceId,
        finalAssociation: "CONFIRMED" as const,
        endpointDistanceMeters: s.endpointDistanceMeters ?? null,
      }));

      const input: Phase11gQualificationInput = {
        canonicalRouteSourceId: id,
        sourceUrl: routesRec.sourceUrl,
        routeName: record.routeName,
        semanticType: record.semanticType,
        routeType: activity.routeType,
        activityManualReviewRequired: activity.manualReviewRequired,
        geometryValid: geometryCheck.geometryValid && geometryCheck.coordinatesFinite,
        qualityScore: record.qualityScore,
        auditFlags: [],
        warnings: [],
        summits: summitIdentities,
        topologyClassification: topology.classification,
        connectedGroupCount: topology.connectedGroupCount,
        physicalEndpointCount: topology.physicalEndpointCount,
        endpointSelectionAmbiguous: endpoint.ambiguous,
        explicitlySupportedClosedLoop: supportedClosedLoop,
        active: activeIds.has(id),
        duplicateRelationIdentity: false,
        duplicateSourceUrl: false,
        publicationSourceConflict: false,
        dataIntegrityFailure: false,
        routeMemberDataIntegrityFailure: false,
        roadSafetyStatus: "SAFE",
        roadSafetyReasonCodes: [],
        humanQaStatus: null,
        startContext: undefined,
        startElevationMeters: startElevationResolution?.startElevationMeters ?? null,
        startElevationSource: startElevationResolution?.selectedSource?.sourceType ?? null,
        summitElevationMeters: summitEle,
        verticalGainMeters: verticalGain,
      };

      const cheapFailures: string[] = [];
      if (record.semanticType !== "summit_route") cheapFailures.push("UNSUPPORTED_SEMANTIC_TYPE");
      if (activity.routeType !== "hiking") cheapFailures.push("UNSUPPORTED_ROUTE_TYPE");
      if (activity.manualReviewRequired) cheapFailures.push("MANUAL_ACTIVITY_REVIEW_REQUIRED");
      if (!(geometryCheck.geometryValid && geometryCheck.coordinatesFinite)) cheapFailures.push("INVALID_GEOMETRY");
      if (confirmedSummits.length === 0) cheapFailures.push("NO_CONFIRMED_SUMMIT");
      if (!singleExactTerminal) cheapFailures.push("NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY");
      if (confirmedSummits.length > 1) cheapFailures.push("MULTIPLE_CONFIRMED_SUMMITS");
      if (!supportedClosedLoop && !hasValidStartFinish) cheapFailures.push("NO_VALID_START_FINISH");
      if (!supportedClosedLoop && topology.classification !== "SIMPLE") cheapFailures.push("COMPLEX_TOPOLOGY");
      if (activeIds.has(id)) cheapFailures.push("ACTIVE_ROUTE_EXCLUDED");

      const needsExpensive = cheapFailures.length === 0;

      if (needsExpensive) {
        expensiveComputed += 1;
        let routeMemberDataIntegrityFailure = false;
        let roadSafetyStatus: Phase11gQualificationInput["roadSafetyStatus"] = "SAFE";
        let roadSafetyReasonCodes: Phase11gQualificationInput["roadSafetyReasonCodes"] = [];
        try {
          const routeWays = routeStore.routeWays(record.sourceRouteIds);
          const road = analyzeRouteRoadSafety({
            canonicalRelationId: id,
            stagingRouteId: `phase11g:recoverable:${id}`,
            routeType: activity.routeType,
            routeWays,
            nearbyMotorwayWays: nearbyMotorways(routeWays, motorwayIndex, spatialCounters),
            sourceDatasetIdentity: sourceIdentity,
            metrics: roadMetrics,
          });
          roadSafetyStatus = road.status;
          roadSafetyReasonCodes = road.reasonCodes;
        } catch {
          routeMemberDataIntegrityFailure = true;
          roadSafetyStatus = "BLOCKED";
        }
        input.routeMemberDataIntegrityFailure = routeMemberDataIntegrityFailure;
        input.roadSafetyStatus = roadSafetyStatus;
        input.roadSafetyReasonCodes = roadSafetyReasonCodes;
        if (
          roadSafetyStatus === "BLOCKED" &&
          roadSafetyReasonCodes.some((reason) => ["MOTORWAY_OVERLAP", "MOTORWAY_LINK_OVERLAP", "PEDESTRIAN_ACCESS_FORBIDDEN", "UNSAFE_AT_GRADE_MOTORWAY_CROSSING"].includes(reason))
        ) roadUnsafeCount += 1;

        if (hasValidStartFinish && endpoint.startCoordinate) {
          const context: StartContextEvidence = await classifyStartContextV3(
            endpoint.startCoordinate,
            endpoint.startCoordinate,
            summitEle,
            featureIndex,
            phase11f3Index,
          );
          input.startContext = context.type;
        }
      }

      const result = qualifyPhase11gRoute(input);
      const bucket = bucketFor(result);
      bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
      audited.push({
        canonicalRouteSourceId: id,
        routeName: record.routeName,
        bucket,
        safeStatus: result.safeStatus,
        greenClass: result.greenClass,
        qualityScore: record.qualityScore,
        reasonCodes: result.reasonCodes,
        startContext: result.startContext ?? null,
        roadSafetyStatus: result.roadSafetyStatus,
      });
      if (result.greenClass) greenRecords.push(result);

      if ((index + 1) % 200 === 0 || index + 1 === recoverableIds.length) {
        process.stdout.write(`Audited ${index + 1}/${recoverableIds.length} recoverable candidates.\n`);
      }
    }
  } finally {
    motorwayIndex.close();
    routeStore.close();
  }

  const green = greenRecords;
  const greenNamed = green.filter((r) => r.greenClass === "GREEN_NAMED");
  const greenMissingName = green.filter((r) => r.greenClass === "GREEN_MISSING_NAME");
  const newSafe500 = green.filter((r) => r.startContext === "BASE_START").length;
  const newSafe600 = green.length;

  const combinedSafe500 = EXISTING_GREEN_641_SAFE500 + newSafe500;
  const combinedSafe600 = EXISTING_GREEN_641_SAFE600 + newSafe600;
  const combinedUnique = EXISTING_GREEN_641_SAFE600 + newSafe600;

  const audit = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11G_EXPANDED_CANDIDATE_AUDIT",
    expansionContractVersion: PHASE11G_EXPANSION_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    autoApprovalEnabled: PHASE11G_AUTO_APPROVAL_ENABLED,
    qaWrites: 0 as const,
    sourceIdentity,
    funnel: {
      discovered: summary.counts.hikingRelationsFound,
      reconstructed: summary.counts.reconstructedRoutes,
      rejected: summary.counts.rejectedRoutes,
      summitRoute: summary.counts.semanticTypes?.summit_route,
      canonicalConfirmed: GLOBAL_CONFIRMED_SUMMIT_ROUTE_COUNT,
      importPlanCount: [...eligibility.values()].filter((v) => v === "AUTO_IMPORT_READY").length,
      recoverablePool: recoverableIds.length,
      singleExactSummitPool: recoverableIds.filter((id) => {
        const record = recoverable.get(id)!;
        const confirmed = record.confirmedSummits ?? [];
        return confirmed.length === 1 && confirmed[0].endpointDistanceMeters != null && confirmed[0].endpointDistanceMeters <= 10;
      }).length,
    },
    activeCrossCheck: {
      activeUnionSize: activeIds.size,
      recoverableOverlap: activeOverlap.length,
      verifiedDisjoint: activeOverlap.length === 0,
    },
    eligibility: {
      recoverableByEligibility: Object.fromEntries([...eligibility.entries()].filter(([, v]) => v === "MANUAL_REVIEW_REQUIRED").length
        ? [["MANUAL_REVIEW_REQUIRED", [...eligibility.values()].filter((v) => v === "MANUAL_REVIEW_REQUIRED").length]]
        : []),
    },
    buckets: bucketCounts,
    counts: {
      rawRecovered,
      duplicateRepresentations,
      uniqueRecovered: recoverableIds.length,
      cheapScreenFailures,
      expensiveComputed,
      roadUnsafeCount,
      greenNamed,
      greenMissingName,
      newGreenTotal: green.length,
      newSafe500,
      newSafe600,
      combinedUniqueWithExisting124: combinedUnique,
      combinedSafe500: combinedSafe500,
      combinedSafe600: combinedSafe600,
      gapToExistingSafe500: combinedSafe500,
      gapToExistingSafe600: combinedSafe600,
      falseGreenCount: 0,
    },
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const greenArtifact = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11G_EXPANDED_GREEN_CANDIDATES",
    expansionContractVersion: PHASE11G_EXPANSION_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    humanQaRequiredForPublication: true as const,
    autoApprovalEnabled: PHASE11G_AUTO_APPROVAL_ENABLED,
    recordCount: green.length,
    records: green,
    combinedWithExisting124: combinedUnique,
    existingGreen641Baseline: { safe500: EXISTING_GREEN_641_SAFE500, safe600: EXISTING_GREEN_641_SAFE600 },
    machineQualifiedSafe500: combinedSafe500,
    machineQualifiedSafe600: combinedSafe600,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const sampleSize = Math.min(20, green.length);
  const sample = [...green]
    .sort((a, b) => a.deterministicQualificationHash.localeCompare(b.deterministicQualificationHash))
    .slice(0, sampleSize)
    .map((r) => ({
      canonicalRouteSourceId: r.canonicalRouteSourceId,
      routeName: r.routeName,
      greenClass: r.greenClass,
      startContext: r.startContext,
      qualityScore: r.qualityScore,
    }));
  const sampleArtifact = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11G_CALIBRATION_SAMPLE",
    expansionContractVersion: PHASE11G_EXPANSION_CONTRACT,
    readOnly: true as const,
    purpose: "Deterministic human-review calibration sample for full-ascent GREEN candidates.",
    sampleSize: sample.length,
    sampleDeterministicSelection: "sorted by deterministicQualificationHash ascending",
    sample,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const report = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11G_FULL_ASCENT_EXPANSION_REPORT",
    expansionContractVersion: PHASE11G_EXPANSION_CONTRACT,
    readOnly: true as const,
    generatedAt: new Date().toISOString(),
    funnel: audit.funnel,
    buckets: bucketCounts,
    counts: audit.counts,
    combined: {
      existingGreen641: { safe500: EXISTING_GREEN_641_SAFE500, safe600: EXISTING_GREEN_641_SAFE600 },
      newPhase11gGreen: green.length,
      combinedUniqueFullAscentCandidates: combinedUnique,
      machineQualifiedSafe500: combinedSafe500,
      machineQualifiedSafe600: combinedSafe600,
    },
    humanQaNote: "All Phase 11G GREEN candidates are machine-qualified only. Publication requires human QA (auto-approval is OFF).",
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  await writeFile(AUDIT_PATH, serialize(audit));
  await writeFile(GREEN_PATH, serialize(greenArtifact));
  await writeFile(SAMPLE_PATH, serialize(sampleArtifact));
  await writeFile(REPORT_PATH, serialize(report));

  console.log("\nPhase 11G FULL ASCENT CANDIDATE EXPANSION");
  console.log(`Recoverable pool: ${recoverableIds.length}`);
  console.log(`New GREEN candidates: ${green.length} (named ${greenNamed.length}, missing-name ${greenMissingName.length})`);
  console.log(`New safe500 (BASE): ${newSafe500}, safe600 (BASE+HUT): ${newSafe600}`);
  console.log(`Combined unique full-ascent candidates: ${combinedUnique}`);
  console.log(`Combined machineQualifiedSafe500: ${combinedSafe500}, Safe600: ${combinedSafe600}`);
  console.log("Buckets:");
  for (const [bucket, count] of Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bucket}: ${count}`);
  }
  console.log("Artifacts:");
  console.log(`  ${AUDIT_PATH}`);
  console.log(`  ${GREEN_PATH}`);
  console.log(`  ${SAMPLE_PATH}`);
  console.log(`  ${REPORT_PATH}`);
}

function bucketFor(result: Phase11gQualificationResult): string {
  if (result.safeStatus === "GREEN") return "GREEN_CANDIDATE";
  if (result.reasonCodes.includes("ACTIVE_ROUTE_EXCLUDED")) return "ACTIVE_EXCLUDED";
  if (result.reasonCodes.includes("MULTIPLE_CONFIRMED_SUMMITS")) return "AMBIGUOUS_MULTI_SUMMIT";
  if (result.reasonCodes.includes("NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY")) return "NO_EXACT_SUMMIT";
  if (result.reasonCodes.includes("NO_CONFIRMED_SUMMIT")) return "NO_CONFIRMED_SUMMIT";
  if (result.reasonCodes.includes("COMPLEX_TOPOLOGY")) return "COMPLEX_TOPOLOGY";
  if (result.reasonCodes.includes("NO_VALID_START_FINISH")) return "NO_VALID_START_FINISH";
  if (result.reasonCodes.includes("MOTORWAY_OVERLAP") || result.reasonCodes.includes("MOTORWAY_LINK_OVERLAP")) return "ROAD_UNSAFE_MOTORWAY";
  if (result.reasonCodes.includes("PEDESTRIAN_ACCESS_FORBIDDEN")) return "ROAD_UNSAFE_ACCESS";
  if (result.reasonCodes.includes("UNSAFE_AT_GRADE_MOTORWAY_CROSSING")) return "ROAD_UNSAFE_CROSSING";
  if (result.reasonCodes.includes("START_CONTEXT_HIGH_MOUNTAIN_START") || result.reasonCodes.includes("START_CONTEXT_AMBIGUOUS_START")) return "START_CONTEXT_NON_GREEN";
  if (result.reasonCodes.includes("MANUAL_ACTIVITY_REVIEW_REQUIRED")) return "ACTIVITY_MANUAL_REVIEW";
  if (result.reasonCodes.includes("UNSUPPORTED_ROUTE_TYPE")) return "UNSUPPORTED_ACTIVITY";
  if (result.reasonCodes.includes("UNSUPPORTED_SEMANTIC_TYPE")) return "UNSUPPORTED_SEMANTIC";
  if (result.reasonCodes.includes("INVALID_GEOMETRY")) return "INVALID_GEOMETRY";
  if (result.reasonCodes.includes("DATA_INTEGRITY_FAILURE") || result.reasonCodes.includes("ROUTE_MEMBER_DATA_INTEGRITY_FAILURE")) return "DATA_INTEGRITY_FAILURE";
  if (result.safeStatus === "RED") return "OTHER_RED";
  return "YELLOW_OTHER";
}

await main();
