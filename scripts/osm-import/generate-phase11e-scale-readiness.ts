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
import { iterateJsonLines, readJsonLines, writeJsonAtomically, writeJsonLines } from "./jsonl.ts";
import { buildPhase11c4StagingPreflight } from "./phase11c4-staging-preflight.ts";
import {
  createImportPlanRecord,
  createLockedFirstWriteManifest,
  matchPeakToMountain,
  type ImportPlanRecord,
  type MountainCatalogRecord,
  type Phase7CanonicalRouteRecord,
  type Phase7EligibilityRecord,
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
  type RoadSafetyWay,
} from "./phase11c9-road-safety.ts";
import type {
  Phase11dHumanQaStatus,
  Phase11dQualificationInput,
} from "./phase11d-qualification.ts";
import {
  PHASE11E_AUTO_APPROVAL_ENABLED,
  PHASE11E_GREEN_MINIMUM_QUALITY,
  PHASE11E_RECOVERY_CONTRACT,
  applyMemberChainRecoveryToPlan,
  classifyTopologyCause,
  createSummitRouteExclusionLedger,
  qualifyPhase11eRoute,
  recoverDeterministicMemberChain,
  recoveredRouteQuality,
  resolveExactMountainIdentity,
  selectPhase11eQueue,
  type Phase11eMemberChainRecovery,
  type Phase11eQualificationResult,
} from "./phase11e-recovery.ts";
import {
  classifyRouteActivity,
} from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const PATHS = {
  plan: "data/osm/alps/staging/import-plan.json",
  analysis: "data/osm/alps/route-analysis.jsonl",
  canonical: "data/osm/alps/audit/canonical-confirmed-routes.jsonl",
  eligibility: "data/osm/alps/audit/import-eligibility.jsonl",
  audit: "data/osm/alps/audit/final-audit-summary.json",
  pipeline: "data/osm/alps/summary.json",
  pbf: "data/osm/source/alps-latest.osm.pbf",
  checkpoint: "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite",
  checkpointManifest: "data/osm/alps/checkpoints/fafc4f7a772832f2/manifest.json",
  motorwayIndex: "data/osm/alps/road-safety/phase11c9-motorways.sqlite",
  phase11dReadiness: "data/osm/alps/publication/phase11d-scale-readiness.json",
  phase11dGreen: "data/osm/alps/publication/phase11d-qualified-safe-candidates.json",
  phase11dYellow: "data/osm/alps/publication/phase11d-yellow-review-candidates.json",
  phase11dRed: "data/osm/alps/publication/phase11d-red-blocked-candidates.json",
  exclusionLedger: "data/osm/alps/audit/phase11e-summit-route-exclusion-ledger.json",
  mountainRecovery: "data/osm/alps/audit/phase11e-mountain-identity-recovery.json",
  topologyAudit: "data/osm/alps/audit/phase11e-topology-recovery-audit.json",
  qualityAudit: "data/osm/alps/audit/phase11e-quality-root-cause-audit.json",
  warningAudit: "data/osm/alps/audit/phase11e-warning-evidence-audit.json",
  multiSummitAudit: "data/osm/alps/audit/phase11e-multi-summit-audit.json",
  readiness: "data/osm/alps/publication/phase11e-scale-readiness.json",
  green: "data/osm/alps/publication/phase11e-qualified-safe-candidates.json",
  yellow: "data/osm/alps/publication/phase11e-yellow-review-candidates.json",
  red: "data/osm/alps/publication/phase11e-red-blocked-candidates.json",
  queue: "data/osm/alps/publication/phase11e-qa-queue.json",
  qaManifest: "data/osm/alps/staging/phase11e-qa-manifest.json",
  stagingManifest: "data/osm/alps/staging/phase11e-staging-manifest.json",
  previewMetadata: "data/osm/alps/staging/phase11e-preview-metadata.json",
  stagingPreflight: "data/osm/alps/staging/phase11e-staging-preflight.json",
  stagingConflictDiagnostic: "data/osm/alps/staging/phase11e-staging-conflicts.json",
  executablePlan: "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl",
} as const;

const PHASE11D_READINESS_HASH = "a4615deb9406320e1abc8eac670582297b0ba56ea4efbc52f9fa33f311f63cdc";
const PHASE11E_QUEUE_SIZE = 704;

interface ImportPlanDocument {
  datasetFingerprint: string;
  phase7AuditHash: string;
  records: ImportPlanRecord[];
}

interface RouteAnalysisRecord {
  routeSourceId: string;
  routeSourceUrl: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  qualityReasons: string[];
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

interface DatabaseMountainRow {
  id: number;
  osm_id: number | string | null;
  name: string | null;
  name_de: string | null;
  height: number | string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  country_code: string | null;
  source: string | null;
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

function numericOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapMountain(row: DatabaseMountainRow): MountainCatalogRecord {
  const latitude = numericOrNull(row.latitude);
  const longitude = numericOrNull(row.longitude);
  return {
    id: Number(row.id),
    osmId: row.osm_id === null ? null : String(row.osm_id),
    name: row.name,
    nameDe: row.name_de,
    heightMeters: numericOrNull(row.height),
    coordinates: latitude === null || longitude === null ? null : [longitude, latitude],
    countryCode: row.country_code,
    source: row.source,
  };
}

async function loadMountainCatalog(client: SupabaseClient): Promise<MountainCatalogRecord[]> {
  const rows: DatabaseMountainRow[] = [];
  for (let from = 0; ; from += 1_000) {
    const result = await client.from("mountains")
      .select("id,osm_id,name,name_de,height,latitude,longitude,country_code,source")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (result.error) throw new Error(`PHASE11E_MOUNTAIN_CATALOG_QUERY:${result.error.message}`);
    const page = (result.data ?? []) as DatabaseMountainRow[];
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  return rows.map(mapMountain);
}

function activityRoute(analysis: RouteAnalysisRecord, plan: ImportPlanRecord): ClassifiableRoute {
  return {
    sourceId: analysis.routeSourceId,
    sourceUrl: analysis.routeSourceUrl,
    name: analysis.routeName,
    ref: analysis.routeMetadata.ref,
    network: analysis.routeMetadata.network,
    operator: analysis.routeMetadata.operator,
    geometry: plan.contract.route.geometry,
    stats: {
      distanceMeters: plan.contract.route.distanceMeters,
      coordinatePoints: plan.contract.route.geometry.type === "LineString"
        ? plan.contract.route.geometry.coordinates.length
        : plan.contract.route.geometry.coordinates.reduce((sum, component) => sum + component.length, 0),
      componentCount: plan.contract.route.componentCount,
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
  return ["yes", "roundtrip", "circular"].includes(
    analysis.routeMetadata.roundtrip?.trim().toLowerCase() ?? "",
  );
}

interface HumanQaBinding {
  stagingRouteId: string;
  stagingPayloadHash: string;
  stagingIdempotencyKey: string;
  status: Phase11dHumanQaStatus;
}

function humanQaBindingsByRelation(inputs: PublicationGateInput[]): Map<string, HumanQaBinding[]> {
  const result = new Map<string, HumanQaBinding[]>();
  for (const input of inputs) {
    const routeByStaging = new Map(input.routes.map((route) => [route.id, route]));
    for (const decision of input.qaDecisions) {
      const route = routeByStaging.get(decision.stagingRouteId);
      if (!route) continue;
      const bindings = result.get(route.canonical_source_id) ?? [];
      const binding: HumanQaBinding = {
        stagingRouteId: route.id,
        stagingPayloadHash: route.payload_hash,
        stagingIdempotencyKey: route.idempotency_key,
        status: decision.status,
      };
      const existingIndex = bindings.findIndex((value) => value.stagingRouteId === binding.stagingRouteId);
      if (existingIndex === -1) bindings.push(binding);
      else bindings[existingIndex] = binding;
      result.set(route.canonical_source_id, bindings);
    }
  }
  return result;
}

function payloadBoundHumanQaStatus(
  bindings: Map<string, HumanQaBinding[]>,
  record: ImportPlanRecord,
): Phase11dHumanQaStatus | null {
  const exact = (bindings.get(record.canonicalRouteSourceId) ?? []).filter((binding) =>
    binding.stagingPayloadHash === record.payloadHash &&
    binding.stagingIdempotencyKey === record.idempotencyKey,
  );
  const statuses = new Set(exact.map((binding) => binding.status));
  if (statuses.size > 1) {
    throw new Error(`PHASE11E_CONFLICTING_PAYLOAD_BOUND_QA:${record.canonicalRouteSourceId}`);
  }
  return exact[0]?.status ?? null;
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
    const found = index.queryBounds({
      minimumLongitude: Math.min(...longitudes) - 0.0000001,
      maximumLongitude: Math.max(...longitudes) + 0.0000001,
      minimumLatitude: Math.min(...latitudes) - 0.0000001,
      maximumLatitude: Math.max(...latitudes) + 0.0000001,
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

function qualificationArtifact(type: string, sourceIdentity: object, records: Phase11eQualificationResult[]) {
  return artifact({
    schemaVersion: 1,
    artifactType: type,
    qualificationContractVersion: PHASE11E_RECOVERY_CONTRACT,
    readOnly: true,
    publishable: false,
    humanQaRequiredForPublication: true,
    autoApprovalEnabled: PHASE11E_AUTO_APPROVAL_ENABLED,
    sourceIdentity,
    recordCount: records.length,
    records,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
}

function refreshExactMountainIdentities(
  record: ImportPlanRecord,
  mountains: MountainCatalogRecord[],
): { record: ImportPlanRecord; recoveredPeakIds: string[] } {
  const recoveredPeakIds: string[] = [];
  const confirmedSummits = record.contract.confirmedSummits.map((summit) => {
    if (summit.mountainMatch.classification === "EXACT_MOUNTAIN_MATCH") return summit;
    const resolution = resolveExactMountainIdentity(summit.peakOsmId, mountains);
    if (resolution.status !== "EXACT") return summit;
    recoveredPeakIds.push(summit.peakOsmId);
    return {
      ...summit,
      mountainMatch: matchPeakToMountain({
        peakOsmId: summit.peakOsmId,
        peakName: summit.peakName,
        peakElevationMeters: summit.peakElevationMeters,
        peakCoordinates: summit.peakCoordinates,
      }, mountains),
    };
  });
  if (recoveredPeakIds.length === 0) return { record, recoveredPeakIds };
  return {
    record: createImportPlanRecord({ ...record.contract, confirmedSummits }),
    recoveredPeakIds,
  };
}

function previewMetadataRecord(
  record: ImportPlanRecord,
  qualificationStatus: "GREEN" | "YELLOW",
): PreviewMetadataRecord {
  if (record.contract.confirmedSummits.length !== 1) {
    throw new Error(`PHASE11E_PREVIEW_REQUIRES_SINGLE_SUMMIT:${record.sourceRelationId}`);
  }
  const summit = record.contract.confirmedSummits[0];
  if (!summit.peakCoordinates || summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" || summit.mountainMatch.mountainId === null) {
    throw new Error(`PHASE11E_PREVIEW_SUMMIT_INVALID:${record.sourceRelationId}`);
  }
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

async function chunks<T, R>(values: T[], load: (chunk: T[]) => Promise<R[]>, size = 100): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(...await load(values.slice(index, index + size)));
  }
  return output;
}

async function preflightSelected(client: SupabaseClient, selected: ImportPlanRecord[]) {
  const routeColumns = "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,matched_primary_mountain_id,geometry_geojson";
  const [byKey, byRelation, byCanonical] = await Promise.all([
    chunks(selected.map((record) => record.idempotencyKey), async (keys) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("idempotency_key", keys);
      if (result.error) throw new Error(`PHASE11E_STAGING_KEY_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
    chunks(selected.map((record) => record.sourceRelationId), async (relationIds) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("source_relation_id", relationIds);
      if (result.error) throw new Error(`PHASE11E_STAGING_RELATION_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
    chunks(selected.map((record) => record.canonicalRouteSourceId), async (canonicalIds) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("canonical_source_id", canonicalIds);
      if (result.error) throw new Error(`PHASE11E_STAGING_CANONICAL_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
  ]);
  const stagingRoutes = [...new Map([...byKey, ...byRelation, ...byCanonical].map((row) => [String(row.id), row])).values()];
  const stagingSummits = await chunks(stagingRoutes.map((row) => String(row.id)), async (ids) => {
    const result = await client.from("osm_route_import_summit_staging")
      .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association")
      .in("staging_route_id", ids);
    if (result.error) throw new Error(`PHASE11E_STAGING_SUMMIT_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const mountainIds = [...new Set(selected.flatMap((record) => record.contract.confirmedSummits.flatMap((summit) =>
    summit.mountainMatch.mountainId === null ? [] : [summit.mountainMatch.mountainId])))];
  const mountains = await chunks(mountainIds, async (ids) => {
    const result = await client.from("mountains").select("id,osm_id").in("id", ids);
    if (result.error) throw new Error(`PHASE11E_STAGING_MOUNTAIN_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const sourceUrls = selected.flatMap((record) => [
    record.contract.source.sourceUrl,
    `/api/osm-route-publications/openstreetmap/relation/${record.canonicalRouteSourceId}/geojson`,
  ]);
  const productionRoutes = await chunks(sourceUrls, async (urls) => {
    const result = await client.from("mountain_routes").select("id,source_url").in("source_url", urls);
    if (result.error) throw new Error(`PHASE11E_STAGING_PRODUCTION_QUERY:${result.error.message}`);
    return result.data ?? [];
  }, 50);
  return buildPhase11c4StagingPreflight({
    records: selected,
    stagingRoutes: stagingRoutes.map((row) => ({
      id: String(row.id), idempotency_key: String(row.idempotency_key), payload_hash: String(row.payload_hash),
      source_relation_id: String(row.source_relation_id), canonical_source_id: String(row.canonical_source_id),
      contract_version: String(row.contract_version), import_eligibility: String(row.import_eligibility),
      matched_primary_mountain_id: row.matched_primary_mountain_id === null ? null : Number(row.matched_primary_mountain_id),
      geometry_geojson: row.geometry_geojson,
    })),
    stagingSummits: stagingSummits.map((row) => ({
      staging_route_id: String(row.staging_route_id), peak_osm_id: String(row.peak_osm_id),
      mountain_id: Number(row.mountain_id), mountain_match_classification: String(row.mountain_match_classification),
      final_association: String(row.final_association),
    })),
    mountains: mountains.map((row) => ({ id: Number(row.id), osm_id: row.osm_id === null ? null : String(row.osm_id) })),
    productionRoutes: productionRoutes.map((row) => ({ id: String(row.id), source_url: String(row.source_url) })),
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
  if (!url || !key) throw new Error("Phase 11E read-only analysis requires Supabase credentials.");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [plan, audit, canonicalRoutes, eligibilityRecords, phase11dReadiness, historicalInput, phase11c4Input, activeResult, mountains] = await Promise.all([
    readFile(PATHS.plan, "utf8").then((value) => JSON.parse(value) as ImportPlanDocument),
    readFile(PATHS.audit, "utf8").then(JSON.parse),
    readJsonLines<Phase7CanonicalRouteRecord>(PATHS.canonical),
    readJsonLines<Phase7EligibilityRecord>(PATHS.eligibility),
    readFile(PATHS.phase11dReadiness, "utf8").then(JSON.parse),
    loadPublicationGateInput(),
    loadPhase11c4PublicationGateInput(),
    client.from("osm_route_publication_provenance")
      .select("mountain_route_id,staging_route_id,canonical_relation_id,source_url,publication_status")
      .eq("publication_status", "ACTIVE").order("mountain_route_id", { ascending: true }),
    loadMountainCatalog(client),
  ]);
  if (phase11dReadiness.deterministicArtifactHash !== PHASE11D_READINESS_HASH) {
    throw new Error("PHASE11E_PHASE11D_CHECKPOINT_DRIFT");
  }
  if (activeResult.error) throw new Error(`PHASE11E_ACTIVE_QUERY:${activeResult.error.message}`);
  const activeRows = (activeResult.data ?? []) as ActivePublicationRow[];
  const activeIds = new Set(activeRows.map((row) => String(row.canonical_relation_id)));
  const activeUrls = new Set(activeRows.map((row) => String(row.source_url)));
  if (activeRows.length !== 118 || activeIds.size !== 118 || activeUrls.size !== 118) {
    throw new Error("PHASE11E_ACTIVE_CHECKPOINT_NOT_CLEAN");
  }

  const planIds = new Set(plan.records.map((record) => record.sourceRelationId));
  const analyses = new Map<string, RouteAnalysisRecord>();
  const summitRouteIds: string[] = [];
  let routeAnalysisRecords = 0;
  let confirmedSummitAssociations = 0;
  for await (const analysis of iterateJsonLines<RouteAnalysisRecord>(PATHS.analysis)) {
    routeAnalysisRecords += 1;
    if (analysis.semanticType === "summit_route") summitRouteIds.push(analysis.routeSourceId);
    confirmedSummitAssociations += analysis.summitAssociations.filter((association) => association.finalAssociation === "CONFIRMED").length;
    if (planIds.has(analysis.routeSourceId)) analyses.set(analysis.routeSourceId, analysis);
    if (routeAnalysisRecords % 10_000 === 0) {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      process.stdout.write(`Scanned ${routeAnalysisRecords} frozen route analyses.\n`);
    }
  }
  if (analyses.size !== plan.records.length || summitRouteIds.length !== 2_780) {
    throw new Error(`PHASE11E_FROZEN_ANALYSIS_INCOMPLETE:${analyses.size}:${summitRouteIds.length}`);
  }
  const exclusionLedgerContent = createSummitRouteExclusionLedger({
    summitRouteRelationIds: summitRouteIds,
    canonicalRoutes,
    eligibilityRecords,
    candidateRelationIds: planIds,
  });
  const excludedCount = Object.values(exclusionLedgerContent.exclusionDistribution).reduce((sum, count) => sum + count, 0);
  if (exclusionLedgerContent.includedRelationIds.length !== 1_065 || excludedCount !== 1_715) {
    throw new Error(`PHASE11E_EXCLUSION_LEDGER_MISMATCH:${exclusionLedgerContent.includedRelationIds.length}:${excludedCount}`);
  }

  const motorwayMetadata = await buildOrVerifyMotorwayIndex({
    pbfPath: PATHS.pbf,
    indexPath: PATHS.motorwayIndex,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  const roadSourceIdentity = await createRoadSafetySourceDatasetIdentity({
    pbfPath: PATHS.pbf,
    checkpointPath: PATHS.checkpoint,
    checkpointManifestPath: PATHS.checkpointManifest,
    pipelineSummaryPath: PATHS.pipeline,
    pipelineDatasetFingerprint: plan.datasetFingerprint,
    motorwayIndexMetadata: motorwayMetadata,
  });
  const sourceIdentity = {
    ...roadSourceIdentity,
    phase7AuditHash: plan.phase7AuditHash,
    importPlanDatasetFingerprint: plan.datasetFingerprint,
    importPlanRecordCount: plan.records.length,
    phase11dReadinessHash: PHASE11D_READINESS_HASH,
  };
  const exclusionLedger = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_SUMMIT_ROUTE_EXCLUSION_LEDGER",
    readOnly: true,
    sourceIdentity,
    summitRouteCount: summitRouteIds.length,
    candidatePopulation: plan.records.length,
    excludedCount,
    ...exclusionLedgerContent,
  });

  const phase11dRecords: Phase11eQualificationResult[] = [];
  for (const path of [PATHS.phase11dGreen, PATHS.phase11dYellow, PATHS.phase11dRed]) {
    const document = JSON.parse(await readFile(path, "utf8"));
    phase11dRecords.push(...document.records);
  }
  const phase11dByRelation = new Map(phase11dRecords.map((record) => [record.sourceRelationId, record]));
  const qaInputs = [historicalInput, phase11c4Input];
  const humanQaBindings = humanQaBindingsByRelation(qaInputs);
  const relationCounts = countBy(plan.records.map((record) => record.sourceRelationId));
  const urlCounts = countBy(plan.records.map((record) => record.contract.source.sourceUrl));
  const roadMetrics: RoadSafetyAnalysisMetrics = { exactIntersectionChecks: 0 };
  const spatialCounters = { spatialBoundsQueries: 0, spatialCandidateChecks: 0 };
  const effectivePlans = new Map<string, ImportPlanRecord>();
  const qualificationInputs: Phase11dQualificationInput[] = [];
  const results: Phase11eQualificationResult[] = [];
  const recoveries = new Map<string, Phase11eMemberChainRecovery>();
  const topologyRecords: Array<Record<string, unknown>> = [];
  const qualityRecords: Array<Record<string, unknown>> = [];
  const identityRecoveryRecords: Array<Record<string, unknown>> = [];
  const routeStore = new FrozenRouteMemberStore(PATHS.checkpoint);
  const motorwayIndex = new MotorwaySpatialIndex(PATHS.motorwayIndex);
  try {
    for (let index = 0; index < plan.records.length; index += 1) {
      const originalRecord = plan.records[index];
      const analysis = analyses.get(originalRecord.sourceRelationId) as RouteAnalysisRecord;
      const identityRefresh = refreshExactMountainIdentities(originalRecord, mountains);
      let effectiveRecord = identityRefresh.record;
      if (identityRefresh.recoveredPeakIds.length > 0) {
        identityRecoveryRecords.push({
          sourceRelationId: originalRecord.sourceRelationId,
          recoveredPeakOsmIds: identityRefresh.recoveredPeakIds,
          evidence: "A unique current Mountain Tracker mountain row has the identical immutable OSM node ID.",
        });
      }
      const originalTopology = analyzeRouteTopology(effectiveRecord.contract.route.geometry);
      const recoveryAttempt = recoverDeterministicMemberChain({
        relationId: effectiveRecord.sourceRelationId,
        originalComponentCount: effectiveRecord.contract.route.componentCount,
        store: routeStore,
      });
      const recovery: Phase11eMemberChainRecovery | null =
        originalTopology.classification !== "SIMPLE" && recoveryAttempt.status === "RECOVERED"
          ? recoveryAttempt
          : null;
      if (originalTopology.classification !== "SIMPLE") {
        topologyRecords.push({
          sourceRelationId: effectiveRecord.sourceRelationId,
          active: activeIds.has(effectiveRecord.canonicalRouteSourceId),
          originalClassification: originalTopology.classification,
          connectedGroupCount: originalTopology.connectedGroupCount,
          physicalEndpointCount: originalTopology.physicalEndpointCount,
          primaryStructuralCause: classifyTopologyCause({
            topology: originalTopology,
            explicitlySupportedClosedLoop: isExplicitClosedLoop(analysis),
            recovery: recoveryAttempt,
          }),
          recovery: recoveryAttempt,
        });
      }
      if (recovery) {
        recoveries.set(effectiveRecord.sourceRelationId, recovery);
        const originalRoute = activityRoute(analysis, effectiveRecord);
        const recalculated = recoveredRouteQuality(originalRoute, recovery);
        effectiveRecord = applyMemberChainRecoveryToPlan({
          record: effectiveRecord,
          recovery,
          qualityScore: recalculated.score,
        });
        qualityRecords.push({
          sourceRelationId: effectiveRecord.sourceRelationId,
          originalQualityScore: originalRecord.contract.route.qualityScore,
          recoveredQualityScore: recalculated.score,
          thresholdUnchanged: PHASE11E_GREEN_MINIMUM_QUALITY,
          originalQualityReasons: analysis.qualityReasons,
          recoveredQualityReasons: recalculated.reasons,
          correctedInput: "Member-order reconstruction artifact changed a fragmented MultiLineString into the proven complete member-chain LineString.",
        });
      }
      effectivePlans.set(effectiveRecord.sourceRelationId, effectiveRecord);
      const activity = classifyRouteActivity(activityRoute(analysis, effectiveRecord));
      const topology = analyzeRouteTopology(effectiveRecord.contract.route.geometry);
      const endpoint = selectRouteEndpoints(topology, effectiveRecord.contract.confirmedSummits.flatMap((summit) =>
        summit.peakCoordinates === null ? [] : [summit.peakCoordinates]));
      let routeMemberDataIntegrityFailure = false;
      let roadSafetyStatus: Phase11dQualificationInput["roadSafetyStatus"] = "BLOCKED";
      let roadSafetyReasonCodes: Phase11dQualificationInput["roadSafetyReasonCodes"] = [];
      try {
        const routeWays = routeStore.routeWays(effectiveRecord.contract.mergedDuplicateProvenance.sourceRouteIds);
        const road = analyzeRouteRoadSafety({
          canonicalRelationId: effectiveRecord.canonicalRouteSourceId,
          stagingRouteId: effectiveRecord.idempotencyKey,
          routeType: activity.routeType,
          routeWays,
          nearbyMotorwayWays: nearbyMotorways(routeWays, motorwayIndex, spatialCounters),
          sourceDatasetIdentity: roadSourceIdentity,
          metrics: roadMetrics,
        });
        roadSafetyStatus = road.status;
        roadSafetyReasonCodes = road.reasonCodes;
      } catch (error) {
        routeMemberDataIntegrityFailure = true;
        process.stderr.write(`Route-member integrity failure ${effectiveRecord.sourceRelationId}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      const geometry = validateRouteGeometry(effectiveRecord.contract.route.geometry);
      const qualificationInput: Phase11dQualificationInput = {
        sourceRelationId: effectiveRecord.sourceRelationId,
        canonicalRouteSourceId: effectiveRecord.canonicalRouteSourceId,
        sourceUrl: effectiveRecord.contract.source.sourceUrl,
        stagingIdempotencyKey: effectiveRecord.idempotencyKey,
        stagingPayloadHash: effectiveRecord.payloadHash,
        semanticType: analysis.semanticType,
        routeType: activity.routeType,
        activityManualReviewRequired: activity.manualReviewRequired,
        geometryValid: geometry.geometryValid && geometry.coordinatesFinite,
        qualityScore: effectiveRecord.contract.route.qualityScore,
        auditFlags: [...effectiveRecord.contract.auditFlags],
        warnings: [...effectiveRecord.warnings],
        summits: effectiveRecord.contract.confirmedSummits.map((summit) => ({
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
        active: activeIds.has(effectiveRecord.canonicalRouteSourceId),
        duplicateRelationIdentity: relationCounts[effectiveRecord.sourceRelationId] > 1,
        duplicateSourceUrl: urlCounts[effectiveRecord.contract.source.sourceUrl] > 1,
        publicationSourceConflict: activeUrls.has(effectiveRecord.contract.source.sourceUrl) && !activeIds.has(effectiveRecord.canonicalRouteSourceId),
        dataIntegrityFailure: effectiveRecord.operation === "BLOCKED_VALIDATION",
        routeMemberDataIntegrityFailure,
        roadSafetyStatus,
        roadSafetyReasonCodes,
        humanQaStatus: payloadBoundHumanQaStatus(humanQaBindings, effectiveRecord),
      };
      qualificationInputs.push(qualificationInput);
      results.push(qualifyPhase11eRoute({ qualificationInput, recovery }));
      if ((index + 1) % 100 === 0 || index + 1 === plan.records.length) {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        process.stdout.write(`Recovered/qualified ${index + 1}/${plan.records.length} candidates.\n`);
      }
    }
  } finally {
    motorwayIndex.close();
    routeStore.close();
  }

  const nonActive = results.filter((result) => !activeIds.has(result.canonicalRouteSourceId));
  const green = nonActive.filter((result) => result.status === "GREEN");
  const yellow = nonActive.filter((result) => result.status === "YELLOW");
  const red = nonActive.filter((result) => result.status === "RED");
  const newlyRecoveredGreen = green.filter((result) =>
    result.recoveredByPhase11e && phase11dByRelation.get(result.sourceRelationId)?.status !== "GREEN");
  const queueEligible = nonActive.filter((result) => {
    const record = effectivePlans.get(result.sourceRelationId);
    return result.summitIdentities.length === 1 && record?.operation === "READY_FOR_STAGING";
  });
  const nonRedQueueEligible = queueEligible.filter((result) => result.status !== "RED");
  if (nonRedQueueEligible.length < PHASE11E_QUEUE_SIZE) {
    throw new Error(`PHASE11E_QUEUE_CAPACITY:${JSON.stringify({
      queueEligible: queueEligible.length,
      nonRedQueueEligible: nonRedQueueEligible.length,
      green: green.length,
      yellow: yellow.length,
      red: red.length,
      recoveredGreen: newlyRecoveredGreen.length,
    })}/${PHASE11E_QUEUE_SIZE}`);
  }
  const queue = selectPhase11eQueue(queueEligible, PHASE11E_QUEUE_SIZE);
  const selectedPlans = queue.map((result) => effectivePlans.get(result.sourceRelationId) as ImportPlanRecord);
  const queueRecords = queue.map((result, index) => ({
    sourceRelationId: result.sourceRelationId,
    canonicalRouteSourceId: result.canonicalRouteSourceId,
    sourceUrl: result.sourceUrl,
    stagingIdempotencyKey: result.stagingIdempotencyKey,
    stagingPayloadHash: result.stagingPayloadHash,
    mountainIdentities: result.summitIdentities.map((summit) => ({ peakOsmId: summit.peakOsmId, mountainId: summit.mountainId })),
    qualificationStatus: result.status,
    recoveredByPhase11e: result.recoveredByPhase11e,
    recoveryReasonCodes: result.recoveryReasonCodes,
    reasonCodes: result.reasonCodes,
    roadSafetyStatus: result.roadSafetyStatus,
    roadSafetyReasonCodes: result.roadSafetyReasonCodes,
    priority: index + 1,
  }));
  const queueArtifact = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_SCALE_QA_QUEUE",
    queueId: "phase11e",
    readOnly: true,
    stagingRequiredBeforeRuntimeUse: true,
    autoApprovalEnabled: PHASE11E_AUTO_APPROVAL_ENABLED,
    sourceIdentity,
    newRoutesQueued: queueRecords.length,
    qualificationCounts: countBy(queueRecords.map((record) => record.qualificationStatus)),
    recoveredGreenQueued: queueRecords.filter((record) => record.qualificationStatus === "GREEN" && record.recoveredByPhase11e).length,
    queue: queueRecords,
    deterministicQueueHash: sha256Stable(queueRecords),
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
  const stagingPreflight = await preflightSelected(client, selectedPlans);
  const blockedRelationIds = new Set(stagingPreflight.records
    .filter((record) => record.action === "BLOCKED")
    .map((record) => record.sourceRelationId));
  const executablePlans = selectedPlans.filter((record) => !blockedRelationIds.has(record.sourceRelationId));
  const qaManifest = createLockedFirstWriteManifest(selectedPlans, plan.datasetFingerprint);
  const stagingManifest = createLockedFirstWriteManifest(executablePlans, plan.datasetFingerprint);
  const previewMetadata: PreviewMetadataDocument = {
    schemaVersion: 1,
    contractVersion: qaManifest.contractVersion,
    datasetFingerprint: qaManifest.datasetFingerprint,
    manifestHash: qaManifest.manifestHash,
    recordCount: selectedPlans.length,
    records: selectedPlans.map((record, index) => previewMetadataRecord(record, queue[index].status as "GREEN" | "YELLOW")),
  };
  const executableRecords = stagingPreflight.records.filter((record) => record.action !== "BLOCKED");
  const executablePreflight = {
    totalPlanned: executablePlans.length,
    wouldCreate: executableRecords.filter((record) => record.action === "WOULD_CREATE").length,
    unchanged: executableRecords.filter((record) => record.action === "UNCHANGED").length,
    blocked: 0,
    conflicts: 0,
    manifestPath: PATHS.stagingManifest,
    manifestHash: stagingManifest.manifestHash,
  };
  const conflictRecords = stagingPreflight.records.filter((record) => record.action === "BLOCKED");
  const conflictDiagnostic = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_STAGING_CONFLICT_DIAGNOSTIC",
    readOnly: true,
    sourceIdentity,
    queueId: "phase11e",
    conflictCount: conflictRecords.length,
    excludedFromExecutableManifest: true,
    executableManifestPath: PATHS.stagingManifest,
    records: conflictRecords.map((record) => {
      const qualification = queue.find((candidate) => candidate.sourceRelationId === record.sourceRelationId);
      const historicalQaBinding = (humanQaBindings.get(record.sourceRelationId) ?? [])
        .find((binding) => binding.stagingRouteId === record.stagingRouteId) ?? null;
      const recovered = recoveries.has(record.sourceRelationId);
      return {
        canonicalRelationId: record.sourceRelationId,
        stagingRouteId: record.stagingRouteId,
        qualificationStatus: qualification?.status ?? null,
        mountainIdentity: record.mountainIdentity,
        existingStagingIdentity: record.existingIdentity,
        plannedStagingIdentity: record.plannedIdentity,
        sourceUrl: record.sourceUrl,
        existingGeometryHash: record.existingIdentity?.geometryHash ?? null,
        plannedGeometryHash: record.plannedIdentity.geometryHash,
        existingStagingPayloadHash: record.existingIdentity?.payloadHash ?? null,
        plannedStagingPayloadHash: record.plannedIdentity.payloadHash,
        mismatchFields: record.mismatchFields,
        exactConflictReason: record.conflictCategory === "F_ACTUAL_DATA_DRIFT" && recovered
          ? `The existing historical staging row is internally consistent, but Phase 11E member-chain recovery changed ${record.existingIdentity?.geometryType ?? "unknown geometry"}/${record.existingIdentity?.componentCount ?? "unknown components"} to ${record.plannedIdentity.geometryType ?? "unknown geometry"}/${record.plannedIdentity.componentCount ?? "unknown components"} and changed the geometry/payload hashes under the same relation/idempotency identity. Overwriting it is forbidden.`
          : record.reason,
        classification: record.conflictCategory,
        exactResumeMatch: false,
        historicalQaDecision: historicalQaBinding === null ? null : {
          status: historicalQaBinding.status,
          stagingPayloadHash: historicalQaBinding.stagingPayloadHash,
        },
        currentPayloadBoundQaStatus: qualification?.humanQaStatus ?? null,
        excludedFromExecutableManifest: true,
      };
    }),
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });
  const preflightArtifact = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_STAGING_PREFLIGHT",
    readOnly: true,
    sourceIdentity,
    queueId: "phase11e",
    queueHash: queueArtifact.deterministicQueueHash,
    totalPlanned: selectedPlans.length,
    alreadyStaged: stagingPreflight.unchanged,
    wouldCreate: stagingPreflight.wouldCreate,
    unchanged: stagingPreflight.unchanged,
    blocked: stagingPreflight.blocked,
    conflicts: stagingPreflight.records.filter((record) => record.action === "BLOCKED").length,
    executable: executablePreflight,
    conflictDiagnosticPath: PATHS.stagingConflictDiagnostic,
    records: stagingPreflight.records,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  });

  const topologyAudit = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_TOPOLOGY_RECOVERY_AUDIT",
    readOnly: true,
    sourceIdentity,
    topologyFailureCount: topologyRecords.length,
    primaryCauseDistribution: countBy(topologyRecords.map((record) => String(record.primaryStructuralCause))),
    recoveredMemberChains: topologyRecords.filter((record) => (record.recovery as { status: string }).status === "RECOVERED").length,
    nonActiveRecoveredMemberChains: topologyRecords.filter((record) => !record.active && (record.recovery as { status: string }).status === "RECOVERED").length,
    records: topologyRecords,
  });
  const qualityAudit = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_QUALITY_ROOT_CAUSE_AUDIT",
    readOnly: true,
    sourceIdentity,
    qualityThresholdBefore: 90,
    qualityThresholdAfter: PHASE11E_GREEN_MINIMUM_QUALITY,
    scoringModel: {
      scoredInputs: ["route name", "route reference", "network", "operator", "from/to", "OSM symbol", "roundtrip", "geometry continuity", "component validity", "distance", "coordinate-count integrity"],
      separateQualificationGatesWithZeroQualityWeight: ["summit identity", "activity", "warnings", "road safety", "human QA"],
    },
    recalculatedRecordCount: qualityRecords.length,
    newlyGreenFromReconstructionRootCauseFix: newlyRecoveredGreen.length,
    records: qualityRecords,
  });
  const warningEntries = plan.records.flatMap((record) => record.warnings.map((warning) => ({
    sourceRelationId: record.sourceRelationId,
    warning,
    warningCode: warning.includes("ambiguous") ? "ADMIN_BOUNDARY_AMBIGUOUS" : "ADMIN_BOUNDARY_UNASSIGNED",
    underlyingEvidence: "reason" in record.contract.routeAdministration
      ? record.contract.routeAdministration.reason
      : "Administrative assignment is present.",
    recovered: false,
    resolution: "No newer authoritative evidence resolves administrative assignment; road-safety SAFE does not supersede this metadata warning.",
  })));
  const warningAudit = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_WARNING_EVIDENCE_AUDIT",
    readOnly: true,
    sourceIdentity,
    warningCount: warningEntries.length,
    recoveredWarningCount: 0,
    warningDistribution: countBy(warningEntries.map((entry) => entry.warningCode)),
    records: warningEntries,
  });
  const exactByPeak = new Map(mountains.filter((mountain) => mountain.osmId !== null).map((mountain) => [mountain.osmId as string, true]));
  const multiSummitRecords = canonicalRoutes.filter((route) => route.confirmedSummits.length > 1).map((route) => ({
    sourceRelationId: route.canonicalRouteSourceId,
    confirmedSummitCount: route.confirmedSummits.length,
    peakOsmIds: route.confirmedSummits.map((summit) => summit.peakSourceId),
    allSummitIdentitiesExact: route.confirmedSummits.every((summit) => exactByPeak.has(summit.peakSourceId)),
    recoveredToGreen: false,
    reason: "The current single-primary-mountain publication representation cannot preserve multi-summit semantics without loss.",
  }));
  const multiSummitAudit = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_MULTI_SUMMIT_AUDIT",
    readOnly: true,
    sourceIdentity,
    routeCount: multiSummitRecords.length,
    allExactIdentityCount: multiSummitRecords.filter((record) => record.allSummitIdentitiesExact).length,
    recoveredGreenCount: 0,
    records: multiSummitRecords,
  });
  const excludedIdentity = canonicalRoutes.filter((route) => !planIds.has(route.canonicalRouteSourceId)).map((route) => ({
    sourceRelationId: route.canonicalRouteSourceId,
    peakIdentities: route.confirmedSummits.map((summit) => ({
      peakOsmId: summit.peakSourceId,
      resolution: resolveExactMountainIdentity(summit.peakSourceId, mountains),
    })),
  }));
  const mountainRecovery = artifact({
    schemaVersion: 1,
    artifactType: "PHASE11E_EXACT_MOUNTAIN_IDENTITY_RECOVERY",
    readOnly: true,
    sourceIdentity,
    method: "Unique equality between frozen summit OSM node ID and current Mountain Tracker mountain osm_id only; names and proximity never recover identity.",
    currentCandidateRecoveredRouteCount: identityRecoveryRecords.length,
    currentCandidateRecoveries: identityRecoveryRecords,
    excludedCanonicalRoutesAudited: excludedIdentity.length,
    excludedAllSummitsExactCount: excludedIdentity.filter((record) => record.peakIdentities.every((peak) => peak.resolution.status === "EXACT")).length,
    excludedRecords: excludedIdentity,
    databaseMutationRequired: false,
    databaseWrites: 0,
  });

  const humanStatuses = ["VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"] as const;
  const qualificationStatuses = ["GREEN", "YELLOW", "RED"] as const;
  const calibrationResults = qualificationInputs
    .filter((input) => input.humanQaStatus !== null)
    .map((qualificationInput) => qualifyPhase11eRoute({
      qualificationInput: {
        ...qualificationInput,
        active: false,
        publicationSourceConflict: false,
      },
      recovery: recoveries.get(qualificationInput.sourceRelationId) ?? null,
    }));
  const calibration = Object.fromEntries(humanStatuses.map((status) => [status, Object.fromEntries(
    qualificationStatuses.map((qualification) => [qualification, calibrationResults.filter((result) => result.humanQaStatus === status && result.status === qualification).length]),
  )]));
  const falseGreen = calibrationResults.filter((result) => result.status === "GREEN" && (result.humanQaStatus === "NEEDS_REVIEW" || result.humanQaStatus === "REJECTED"));
  const humanReadyCount = green.filter((result) => result.humanQaStatus === "VISUALLY_APPROVED").length;
  const greenNeedsReviewCount = green.filter((result) => result.humanQaStatus === "NEEDS_REVIEW").length;
  const greenRejectedCount = green.filter((result) => result.humanQaStatus === "REJECTED").length;
  const pendingGreenCount = green.filter((result) => result.humanQaStatus === null).length;
  const stablePendingGreen = green.filter((result) => !result.recoveredByPhase11e && result.humanQaStatus === null);
  const deterministicRandomGreen = [...stablePendingGreen].sort((left, right) =>
    sha256Stable(`${plan.datasetFingerprint}:${left.sourceRelationId}`).localeCompare(sha256Stable(`${plan.datasetFingerprint}:${right.sourceRelationId}`)));
  const randomAudit = deterministicRandomGreen
    .slice(0, Math.ceil(green.filter((result) => !result.recoveredByPhase11e).length * 0.1))
    .map((record) => record.sourceRelationId);
  const targetedBoundary = stablePendingGreen.filter((record) => record.qualityScore === PHASE11E_GREEN_MINIMUM_QUALITY)
    .sort((left, right) => sha256Stable(`${plan.datasetFingerprint}:boundary:${left.sourceRelationId}`)
      .localeCompare(sha256Stable(`${plan.datasetFingerprint}:boundary:${right.sourceRelationId}`)))
    .slice(0, 50)
    .map((record) => record.sourceRelationId);
  const recoveredGreenAudit = green.filter((record) => record.recoveredByPhase11e && record.humanQaStatus === null)
    .map((record) => record.sourceRelationId)
    .sort(compareNumeric);
  const executableRecoveredGreenAudit = recoveredGreenAudit.filter((relationId) => !blockedRelationIds.has(relationId));
  const blockedRecoveredGreenAudit = recoveredGreenAudit.filter((relationId) => blockedRelationIds.has(relationId));
  const qaAuditIds = [...new Set([...executableRecoveredGreenAudit, ...randomAudit, ...targetedBoundary])].sort(compareNumeric);
  const pendingYellow = yellow.filter((result) => result.humanQaStatus === null).map((result) => result.sourceRelationId).sort(compareNumeric);
  const payloadCompatibleCalibrationGreen = calibrationResults.filter((result) => result.status === "GREEN").length;
  const zeroFailureUpperBound95 = payloadCompatibleCalibrationGreen === 0
    ? null
    : 1 - (0.05 ** (1 / payloadCompatibleCalibrationGreen));

  const greenArtifact = qualificationArtifact("PHASE11E_QUALIFIED_SAFE_CANDIDATES", sourceIdentity, green);
  const yellowArtifact = qualificationArtifact("PHASE11E_YELLOW_REVIEW_CANDIDATES", sourceIdentity, yellow);
  const redArtifact = qualificationArtifact("PHASE11E_RED_BLOCKED_CANDIDATES", sourceIdentity, red);
  const effectiveInputs = qualificationInputs;
  const exactRoutes = effectiveInputs.filter((input) => input.summits.length > 0 && input.summits.every((summit) => summit.mountainMatchClassification === "EXACT_MOUNTAIN_MATCH" && summit.mountainId !== null));
  const geometryValid = exactRoutes.filter((input) => input.geometryValid);
  const hiking = geometryValid.filter((input) => input.routeType === "hiking" && !input.activityManualReviewRequired);
  const validTopology = hiking.filter((input) => input.topologyClassification === "SIMPLE" && input.physicalEndpointCount === 2 && !input.endpointSelectionAmbiguous);
  const nonActiveValidTopology = validTopology.filter((input) => !input.active);
  const preQaEligible = nonActiveValidTopology.filter((input) => input.qualityScore >= 80 && input.summits.length === 1 && !input.duplicateRelationIdentity && !input.duplicateSourceUrl && !input.publicationSourceConflict && !input.dataIntegrityFailure && !input.routeMemberDataIntegrityFailure);
  const remainingBottlenecks = countBy(nonActive.filter((result) => result.status !== "GREEN").map((result) =>
    result.reasonCodes.find((reason) => [
      "HUMAN_QA_REJECTED", "UNSUPPORTED_ROUTE_TYPE", "NO_EXACT_REQUIRED_MOUNTAIN_IDENTITY", "NO_VALID_START_FINISH", "COMPLEX_TOPOLOGY", "QUALITY_BELOW_SUPPORTED_THRESHOLD", "HUMAN_QA_NEEDS_REVIEW", "NON_SIMPLE_TOPOLOGY", "CLOSED_LOOP_REVIEW", "WARNING_EVIDENCE_PRESENT", "QUALITY_BELOW_GREEN_THRESHOLD",
    ].includes(reason)) ?? "OTHER"));
  const readinessContent = {
    schemaVersion: 1,
    artifactType: "PHASE11E_SCALE_READINESS",
    readOnly: true,
    qualificationContractVersion: PHASE11E_RECOVERY_CONTRACT,
    sourceIdentity,
    checkpoint: {
      phase11dHash: PHASE11D_READINESS_HASH,
      expectedActive: 118,
      actualActive: activeRows.length,
      uniqueActiveRelations: activeIds.size,
      duplicateActiveSourceUrls: activeRows.length - activeUrls.size,
    },
    beforeAfter: {
      before: { candidatePopulation: 1_065, publicationGateEligibleBeforeQa: 459, green: 407, yellow: 201, red: 339 },
      after: { candidatePopulation: plan.records.length, publicationGateEligibleBeforeQa: preQaEligible.length, green: green.length, yellow: yellow.length, red: red.length },
    },
    funnel: {
      discoveredRelations: audit.sourceDataset.hikingRelationsAnalyzed,
      reconstructedRelations: audit.sourceDataset.reconstructedRoutes,
      routeAnalysisRecords,
      summitRoute: summitRouteIds.length,
      confirmedSummitAssociations,
      candidatePopulation: plan.records.length,
      exactMountainIdentity: exactRoutes.length,
      geometryValid: geometryValid.length,
      supportedHiking: hiking.length,
      validTopology: validTopology.length,
      nonActive: nonActive.length,
      publicationGateEligibleBeforeQa: preQaEligible.length,
      roadSafety: countBy(effectiveInputs.map((input) => input.roadSafetyStatus)),
    },
    recovery: {
      exactMountainRecoveryCount: identityRecoveryRecords.length,
      topologyRecoveryCount: topologyAudit.nonActiveRecoveredMemberChains,
      qualityRecalculationCount: qualityRecords.length,
      qualityNewGreenCount: newlyRecoveredGreen.length,
      warningRecoveryCount: 0,
      multiSummitRecoveryCount: 0,
      newlyRecoveredGreenCount: newlyRecoveredGreen.length,
      newlyRecoveredGreenRelationIds: newlyRecoveredGreen.map((result) => result.sourceRelationId),
    },
    qualification: {
      greenMinimumQuality: PHASE11E_GREEN_MINIMUM_QUALITY,
      autoApprovalEnabled: PHASE11E_AUTO_APPROVAL_ENABLED,
      green: green.length,
      yellow: yellow.length,
      red: red.length,
      nonActiveGreenSafeHiking: green.filter((result) => result.routeType === "hiking").length,
      nonActiveYellowHiking: yellow.filter((result) => result.routeType === "hiking").length,
      nonActiveRedHiking: red.filter((result) => result.routeType === "hiking").length,
      remainingBottlenecks,
    },
    calibration: {
      qaSnapshotHash: qaSnapshotHash(qaInputs),
      reviewedDecisionCount: calibrationResults.length,
      matrix: calibration,
      falseGreenCount: falseGreen.length,
      falseGreenRelationIds: falseGreen.map((result) => result.sourceRelationId),
    },
    readiness: {
      machineQualifiedSafe500: green.length >= 500,
      reserveBeyond500: Math.max(0, green.length - 500),
      machineQualifiedSafe600: green.length >= 600,
      reserveBeyond600: Math.max(0, green.length - 600),
      humanQaPublicationReady500: humanReadyCount >= 500,
      humanQaPublicationReadyCount: humanReadyCount,
      humanQaCountsAmongGreen: {
        visuallyApproved: humanReadyCount,
        needsReview: greenNeedsReviewCount,
        rejected: greenRejectedCount,
        pending: pendingGreenCount,
      },
    },
    humanQaStrategy: {
      automationStillDisabled: true,
      existingPayloadCompatibleHumanDecisionsPreserved: true,
      calibration: {
        payloadCompatibleReviewedGreen: payloadCompatibleCalibrationGreen,
        falseGreenCount: falseGreen.length,
        zeroFailureOneSidedUpperBound95: zeroFailureUpperBound95,
        caveat: "The historical calibration is supportive but not a substitute for the new deterministic batch sample because it was not selected as a random sample of this queue.",
      },
      deterministicRandomStablePendingGreenAudit: { sampleSize: randomAudit.length, relationIds: randomAudit },
      targetedBoundaryStablePendingGreenAudit: { sampleSize: targetedBoundary.length, relationIds: targetedBoundary },
      allRecoveredPendingGreenAudit: {
        sampleSize: recoveredGreenAudit.length,
        executableSampleSize: executableRecoveredGreenAudit.length,
        blockedUntilIdentityResolution: blockedRecoveredGreenAudit,
        relationIds: recoveredGreenAudit,
      },
      recommendedAdditionalExecutableGreenAudit: { sampleSize: qaAuditIds.length, relationIds: qaAuditIds },
      allYellowRequired: yellow.length,
      pendingYellowAudit: { sampleSize: pendingYellow.length, relationIds: pendingYellow },
      redDebugSample: Math.min(20, red.length),
      policy: "This is a human-review scaling proposal only. It creates no QA decisions, does not auto-approve unsampled GREEN routes, and does not make the 500-route publication gate ready.",
    },
    queue: {
      queueId: "phase11e",
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
      executable: preflightArtifact.executable,
      conflictDiagnosticPath: PATHS.stagingConflictDiagnostic,
      hash: preflightArtifact.deterministicArtifactHash,
    },
    roadSafety: {
      candidateCount: effectiveInputs.length,
      statusDistribution: countBy(effectiveInputs.map((input) => input.roadSafetyStatus)),
      roadWaysIndexed: motorwayMetadata.motorwayWayCount,
      roadNodesIndexed: motorwayMetadata.motorwayNodeCount,
      spatialBoundsQueries: spatialCounters.spatialBoundsQueries,
      spatialCandidateChecks: spatialCounters.spatialCandidateChecks,
      exactIntersectionChecks: roadMetrics.exactIntersectionChecks,
    },
    artifactHashes: {
      exclusionLedger: exclusionLedger.deterministicArtifactHash,
      mountainRecovery: mountainRecovery.deterministicArtifactHash,
      topologyAudit: topologyAudit.deterministicArtifactHash,
      qualityAudit: qualityAudit.deterministicArtifactHash,
      warningAudit: warningAudit.deterministicArtifactHash,
      multiSummitAudit: multiSummitAudit.deterministicArtifactHash,
      qualifiedSafeCandidates: greenArtifact.deterministicArtifactHash,
      yellowReviewCandidates: yellowArtifact.deterministicArtifactHash,
      redBlockedCandidates: redArtifact.deterministicArtifactHash,
      queue: queueArtifact.deterministicArtifactHash,
      qaManifest: qaManifest.manifestHash,
      executableStagingManifest: stagingManifest.manifestHash,
      previewMetadata: sha256Stable(previewMetadata),
      stagingPreflight: preflightArtifact.deterministicArtifactHash,
      stagingConflictDiagnostic: conflictDiagnostic.deterministicArtifactHash,
    },
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };
  const readinessArtifact = artifact(readinessContent);
  await Promise.all([
    writeJsonAtomically(PATHS.exclusionLedger, exclusionLedger),
    writeJsonAtomically(PATHS.mountainRecovery, mountainRecovery),
    writeJsonAtomically(PATHS.topologyAudit, topologyAudit),
    writeJsonAtomically(PATHS.qualityAudit, qualityAudit),
    writeJsonAtomically(PATHS.warningAudit, warningAudit),
    writeJsonAtomically(PATHS.multiSummitAudit, multiSummitAudit),
    writeJsonAtomically(PATHS.green, greenArtifact),
    writeJsonAtomically(PATHS.yellow, yellowArtifact),
    writeJsonAtomically(PATHS.red, redArtifact),
    writeJsonAtomically(PATHS.queue, queueArtifact),
    writeJsonAtomically(PATHS.qaManifest, qaManifest),
    writeJsonAtomically(PATHS.stagingManifest, stagingManifest),
    writeJsonAtomically(PATHS.previewMetadata, previewMetadata),
    writeJsonAtomically(PATHS.stagingPreflight, preflightArtifact),
    writeJsonAtomically(PATHS.stagingConflictDiagnostic, conflictDiagnostic),
    writeJsonAtomically(PATHS.readiness, readinessArtifact),
    writeJsonLines(PATHS.executablePlan, executablePlans),
  ]);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    readinessPath: PATHS.readiness,
    readinessHash: readinessArtifact.deterministicArtifactHash,
    active: activeRows.length,
    exclusionDistribution: exclusionLedger.exclusionDistribution,
    green: green.length,
    yellow: yellow.length,
    red: red.length,
    recoveredGreen: newlyRecoveredGreen.length,
    machineQualifiedSafe500: readinessArtifact.readiness.machineQualifiedSafe500,
    machineQualifiedSafe600: readinessArtifact.readiness.machineQualifiedSafe600,
    queueSize: queueRecords.length,
    queueHash: queueArtifact.deterministicQueueHash,
    stagingPreflight: readinessArtifact.stagingPreflight,
    humanQaCountsAmongGreen: readinessArtifact.readiness.humanQaCountsAmongGreen,
    recommendedAdditionalExecutableGreenAudit: readinessArtifact.humanQaStrategy.recommendedAdditionalExecutableGreenAudit.sampleSize,
    roadSafety: readinessArtifact.roadSafety,
    falseGreenCount: falseGreen.length,
    elapsedMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
    candidateThroughputPerSecond: Math.round(plan.records.length / ((performance.now() - startedAt) / 1_000) * 10) / 10,
    peakRssMegabytes: Math.round(peakRssBytes / 1024 / 1024 * 10) / 10,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  }, null, 2)}\n`);
}

function compareNumeric(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
