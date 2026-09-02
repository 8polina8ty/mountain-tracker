import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import type {
  PreviewManifest,
  PreviewMetadataDocument,
  StoredPreviewQaDecision,
} from "../../Lib/osmStagingPreview/core.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";
import type {
  Phase10QaHistoryRow,
  Phase10StagingRouteRow,
  Phase10StagingSummitRow,
  PublicationGateInput,
} from "./phase10-publication-gate.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");

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

function mapRoute(value: Record<string, unknown>): Phase10StagingRouteRow {
  return {
    id: String(value.id),
    contract_version: String(value.contract_version),
    idempotency_key: String(value.idempotency_key),
    provider: String(value.provider),
    source_relation_id: String(value.source_relation_id),
    canonical_source_id: String(value.canonical_source_id),
    dataset_version: String(value.dataset_version),
    payload_hash: String(value.payload_hash),
    route_name: value.route_name === null ? null : String(value.route_name),
    semantic_type: String(value.semantic_type),
    quality_score: Number(value.quality_score),
    geometry_geojson: value.geometry_geojson,
    distance_meters: Number(value.distance_meters),
    matched_primary_mountain_id:
      value.matched_primary_mountain_id === null
        ? null
        : Number(value.matched_primary_mountain_id),
    audit_flags: value.audit_flags,
    import_eligibility: String(value.import_eligibility),
    payload: value.payload,
  };
}

function mapSummit(value: Record<string, unknown>): Phase10StagingSummitRow {
  return {
    staging_route_id: String(value.staging_route_id),
    peak_osm_id: String(value.peak_osm_id),
    mountain_id: Number(value.mountain_id),
    mountain_match_classification: String(value.mountain_match_classification),
    final_association: String(value.final_association),
    final_confidence: Number(value.final_confidence),
    minimum_geometry_distance_meters: Number(value.minimum_geometry_distance_meters),
    endpoint_distance_meters: Number(value.endpoint_distance_meters),
    evidence: value.evidence,
    payload: value.payload,
  };
}

function mapDecision(value: Record<string, unknown>): StoredPreviewQaDecision {
  return {
    stagingRouteId: String(value.staging_route_id),
    status: String(value.status) as StoredPreviewQaDecision["status"],
    reviewerNote: value.reviewer_note === null ? null : String(value.reviewer_note),
    reviewerUserId: String(value.reviewer_user_id),
    reviewedAt: String(value.reviewed_at),
    version: Number(value.version),
  };
}

function mapHistory(value: Record<string, unknown>): Phase10QaHistoryRow {
  return {
    id: Number(value.id),
    stagingRouteId: String(value.staging_route_id),
    oldStatus: String(value.old_status) as Phase10QaHistoryRow["oldStatus"],
    newStatus: String(value.new_status) as Phase10QaHistoryRow["newStatus"],
    reviewerNote: value.reviewer_note === null ? null : String(value.reviewer_note),
    reviewerUserId: String(value.reviewer_user_id),
    decisionVersion: Number(value.decision_version),
    occurredAt: String(value.occurred_at),
  };
}

export async function loadPublicationGateInput(): Promise<PublicationGateInput> {
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Read-only publication candidate access requires Supabase credentials.");
  }
  const [manifest, metadata, plan] = await Promise.all([
    readFile(resolve(STAGING_DIRECTORY, "first-write-manifest.json"), "utf8").then(
      (value) => JSON.parse(value) as PreviewManifest,
    ),
    readFile(resolve(STAGING_DIRECTORY, "phase9-preview-metadata.json"), "utf8").then(
      (value) => JSON.parse(value) as PreviewMetadataDocument,
    ),
    readFile(resolve(STAGING_DIRECTORY, "import-plan.json"), "utf8").then(
      (value) => JSON.parse(value) as {
        datasetFingerprint: string;
        records: ImportPlanRecord[];
      },
    ),
  ]);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const routeResult = await client
    .from("osm_route_import_staging")
    .select("id,contract_version,idempotency_key,provider,source_relation_id,canonical_source_id,dataset_version,payload_hash,route_name,semantic_type,quality_score,geometry_geojson,distance_meters,matched_primary_mountain_id,audit_flags,import_eligibility,payload")
    .in("idempotency_key", manifest.records.map((record) => record.idempotencyKey));
  if (routeResult.error) {
    throw new Error(`Publication candidate staging query failed: ${routeResult.error.message}`);
  }
  const routes = ((routeResult.data ?? []) as Array<Record<string, unknown>>).map(mapRoute);
  const routeIds = routes.map((route) => route.id);
  const [summitResult, qaResult, historyResult] = await Promise.all([
    client
      .from("osm_route_import_summit_staging")
      .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association,final_confidence,minimum_geometry_distance_meters,endpoint_distance_meters,evidence,payload")
      .in("staging_route_id", routeIds),
    client
      .from("osm_staging_route_visual_qa")
      .select("staging_route_id,status,reviewer_note,reviewed_at,reviewer_user_id,version")
      .in("staging_route_id", routeIds),
    client
      .from("osm_staging_route_visual_qa_history")
      .select("id,staging_route_id,old_status,new_status,reviewer_note,reviewer_user_id,decision_version,occurred_at")
      .in("staging_route_id", routeIds)
      .order("decision_version", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (summitResult.error) {
    throw new Error(`Publication candidate summit query failed: ${summitResult.error.message}`);
  }
  if (qaResult.error) {
    throw new Error(`Publication candidate QA query failed: ${qaResult.error.message}`);
  }
  if (historyResult.error) {
    throw new Error(`Publication candidate QA history query failed: ${historyResult.error.message}`);
  }
  return {
    manifest,
    metadata,
    planDatasetFingerprint: plan.datasetFingerprint,
    planRecords: plan.records,
    routes,
    summits: ((summitResult.data ?? []) as Array<Record<string, unknown>>).map(mapSummit),
    qaDecisions: ((qaResult.data ?? []) as Array<Record<string, unknown>>).map(mapDecision),
    qaHistory: ((historyResult.data ?? []) as Array<Record<string, unknown>>).map(mapHistory),
  };
}
