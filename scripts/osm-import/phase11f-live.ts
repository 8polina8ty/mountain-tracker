import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPhase11c4StagingPreflight,
  type Phase11c4StagingPreflightResult,
} from "./phase11c4-staging-preflight.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

export interface Phase11fActivePublicationRow {
  mountain_route_id: number;
  staging_route_id: string;
  canonical_relation_id: string;
  source_url: string;
  publication_status: string;
}

export interface Phase11fQaDecisionRow {
  staging_route_id: string;
  status: "VISUALLY_APPROVED" | "NEEDS_REVIEW" | "REJECTED";
  version: number;
}

export interface Phase11fQaHistoryRow {
  id: number;
  staging_route_id: string;
  old_status: string;
  new_status: "PENDING" | "VISUALLY_APPROVED" | "NEEDS_REVIEW" | "REJECTED";
  decision_version: number;
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

export async function createPhase11fAdminClient(): Promise<SupabaseClient> {
  try {
    loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // This project currently carries two opaque server keys. The dedicated
  // service-role key is the verified Phase 11F read/write credential; the
  // general secret remains a fallback for environments that only define it.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("PHASE11F_SUPABASE_CREDENTIALS_REQUIRED");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function chunks<T>(
  values: string[],
  load: (chunk: string[]) => Promise<T[]>,
  size = 100,
): Promise<T[]> {
  const result: T[] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(...await load(values.slice(index, index + size)));
  }
  return result;
}

export async function loadPhase11fActivePublications(
  client: SupabaseClient,
): Promise<Phase11fActivePublicationRow[]> {
  const result = await client.from("osm_route_publication_provenance")
    .select("mountain_route_id,staging_route_id,canonical_relation_id,source_url,publication_status")
    .eq("publication_status", "ACTIVE")
    .order("mountain_route_id", { ascending: true });
  if (result.error) throw new Error(`PHASE11F_ACTIVE_QUERY:${result.error.message}`);
  return (result.data ?? []) as Phase11fActivePublicationRow[];
}

export async function preflightPhase11fExecution(
  client: SupabaseClient,
  records: ImportPlanRecord[],
): Promise<Phase11c4StagingPreflightResult> {
  const routeColumns = "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,matched_primary_mountain_id,geometry_geojson";
  const [byKey, byRelation, byCanonical] = await Promise.all([
    chunks(records.map((record) => record.idempotencyKey), async (keys) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("idempotency_key", keys);
      if (result.error) throw new Error(`PHASE11F_STAGING_KEY_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
    chunks(records.map((record) => record.sourceRelationId), async (ids) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("source_relation_id", ids);
      if (result.error) throw new Error(`PHASE11F_STAGING_RELATION_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
    chunks(records.map((record) => record.canonicalRouteSourceId), async (ids) => {
      const result = await client.from("osm_route_import_staging").select(routeColumns).in("canonical_source_id", ids);
      if (result.error) throw new Error(`PHASE11F_STAGING_CANONICAL_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
  ]);
  const stagingRoutes = [...new Map([...byKey, ...byRelation, ...byCanonical].map((row) => [String(row.id), row])).values()];
  const stagingIds = stagingRoutes.map((row) => String(row.id));
  const stagingSummits = stagingIds.length === 0 ? [] : await chunks(stagingIds, async (ids) => {
    const result = await client.from("osm_route_import_summit_staging")
      .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association")
      .in("staging_route_id", ids);
    if (result.error) throw new Error(`PHASE11F_STAGING_SUMMIT_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const mountainIds = [...new Set(records.flatMap((record) => record.contract.confirmedSummits
    .map((summit) => summit.mountainMatch.mountainId)
    .filter((id): id is number => id !== null)))].map(String);
  const mountains = await chunks(mountainIds, async (ids) => {
    const result = await client.from("mountains").select("id,osm_id").in("id", ids);
    if (result.error) throw new Error(`PHASE11F_MOUNTAIN_QUERY:${result.error.message}`);
    return result.data ?? [];
  });
  const sourceUrls = records.flatMap((record) => [
    record.contract.source.sourceUrl,
    `/api/osm-route-publications/openstreetmap/relation/${record.canonicalRouteSourceId}/geojson`,
  ]);
  const productionRoutes = await chunks(sourceUrls, async (urls) => {
    const result = await client.from("mountain_routes").select("id,source_url").in("source_url", urls);
    if (result.error) throw new Error(`PHASE11F_PRODUCTION_QUERY:${result.error.message}`);
    return result.data ?? [];
  }, 50);
  return buildPhase11c4StagingPreflight({
    records,
    stagingRoutes: stagingRoutes.map((row) => ({
      id: String(row.id),
      idempotency_key: String(row.idempotency_key),
      payload_hash: String(row.payload_hash),
      source_relation_id: String(row.source_relation_id),
      canonical_source_id: String(row.canonical_source_id),
      contract_version: String(row.contract_version),
      import_eligibility: String(row.import_eligibility),
      matched_primary_mountain_id: row.matched_primary_mountain_id === null ? null : Number(row.matched_primary_mountain_id),
      geometry_geojson: row.geometry_geojson,
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
    productionRoutes: productionRoutes.map((row) => ({ id: String(row.id), source_url: String(row.source_url) })),
  });
}

export async function loadPhase11fQaState(
  client: SupabaseClient,
  stagingRouteIds: string[],
): Promise<{ decisions: Phase11fQaDecisionRow[]; history: Phase11fQaHistoryRow[] }> {
  if (stagingRouteIds.length === 0) return { decisions: [], history: [] };
  const [decisions, history] = await Promise.all([
    chunks(stagingRouteIds, async (ids) => {
      const result = await client.from("osm_staging_route_visual_qa")
        .select("staging_route_id,status,version").in("staging_route_id", ids);
      if (result.error) throw new Error(`PHASE11F_QA_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
    chunks(stagingRouteIds, async (ids) => {
      const result = await client.from("osm_staging_route_visual_qa_history")
        .select("id,staging_route_id,old_status,new_status,decision_version")
        .in("staging_route_id", ids)
        .order("decision_version", { ascending: true })
        .order("id", { ascending: true });
      if (result.error) throw new Error(`PHASE11F_QA_HISTORY_QUERY:${result.error.message}`);
      return result.data ?? [];
    }),
  ]);
  return {
    decisions: decisions.map((row) => ({
      staging_route_id: String(row.staging_route_id),
      status: String(row.status) as Phase11fQaDecisionRow["status"],
      version: Number(row.version),
    })),
    history: history.map((row) => ({
      id: Number(row.id),
      staging_route_id: String(row.staging_route_id),
      old_status: String(row.old_status),
      new_status: String(row.new_status) as Phase11fQaHistoryRow["new_status"],
      decision_version: Number(row.decision_version),
    })),
  };
}

export async function stagePhase11fRecord(
  client: SupabaseClient,
  record: ImportPlanRecord,
): Promise<string> {
  const exactMountainIds = record.contract.confirmedSummits
    .map((summit) => summit.mountainMatch.mountainId)
    .filter((mountainId): mountainId is number => mountainId !== null)
    .sort((left, right) => left - right);
  const routePayload = {
    contract_version: record.contract.contractVersion,
    idempotency_key: record.idempotencyKey,
    provider: record.contract.provider,
    source_relation_id: record.sourceRelationId,
    canonical_source_id: record.canonicalRouteSourceId,
    dataset_version: record.contract.dataset.version,
    payload_hash: record.payloadHash,
    route_name: record.routeName,
    semantic_type: record.contract.route.semanticType,
    quality_score: record.contract.route.qualityScore,
    geometry_geojson: record.contract.route.geometry,
    distance_meters: record.contract.route.distanceMeters,
    matched_primary_mountain_id: exactMountainIds[0] ?? null,
    audit_flags: record.contract.auditFlags,
    import_eligibility: record.contract.importEligibility,
    payload: record.contract,
  };
  const summitPayloads = record.contract.confirmedSummits.map((summit) => ({
    peak_osm_id: summit.peakOsmId,
    mountain_id: summit.mountainMatch.mountainId,
    mountain_match_classification: summit.mountainMatch.classification,
    final_association: summit.finalAssociation,
    final_confidence: summit.finalConfidence,
    minimum_geometry_distance_meters: summit.minimumGeometryDistanceMeters,
    endpoint_distance_meters: summit.endpointDistanceMeters,
    evidence: summit.evidence,
    payload: summit,
  }));
  const result = await client.rpc("stage_osm_route_import", { p_route: routePayload, p_summits: summitPayloads });
  if (result.error) throw new Error(`PHASE11F_STAGING_RPC:${record.sourceRelationId}:${result.error.message}`);
  return String(result.data);
}
