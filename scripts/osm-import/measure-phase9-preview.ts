import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  buildRouteFeatureCollection,
  createApprovedListItems,
  summarizeQaProgress,
  validateManifestApprovedRows,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewRouteGeometry,
  type PreviewStagingRouteRow,
  type PreviewStagingSummitRow,
  type StoredPreviewQaDecision,
} from "../../Lib/osmStagingPreview/core.ts";

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

function routeRow(value: Record<string, unknown>): PreviewStagingRouteRow {
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
      value.matched_primary_mountain_id === null ? null : Number(value.matched_primary_mountain_id),
    audit_flags: value.audit_flags,
    import_eligibility: String(value.import_eligibility),
  };
}

function summitRow(value: Record<string, unknown>): PreviewStagingSummitRow {
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

async function main(): Promise<void> {
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Read-only Phase 9 measurement requires Supabase credentials.");
  const directory = resolve("data/osm/alps/staging");
  const [manifest, metadata, plan] = await Promise.all([
    readFile(resolve(directory, "first-write-manifest.json"), "utf8").then(
      (value) => JSON.parse(value) as PreviewManifest,
    ),
    readFile(resolve(directory, "phase9-preview-metadata.json"), "utf8").then(
      (value) => JSON.parse(value) as PreviewMetadataDocument,
    ),
    readFile(resolve(directory, "import-plan.json"), "utf8").then(
      (value) => JSON.parse(value) as { records: Array<{ idempotencyKey: string; contract: { route: { geometry: PreviewRouteGeometry } } }> },
    ),
  ]);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const listStarted = performance.now();
  const { data: routeData, error: routeError } = await client
    .from("osm_route_import_staging")
    .select("id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,route_name,semantic_type,quality_score,distance_meters,matched_primary_mountain_id,audit_flags,import_eligibility")
    .in("idempotency_key", manifest.records.map((record) => record.idempotencyKey));
  if (routeError) throw new Error(routeError.message);
  const routes = ((routeData ?? []) as Array<Record<string, unknown>>).map(routeRow);
  const stagingMetadataQueryMilliseconds = Math.round((performance.now() - listStarted) * 10) / 10;
  const qaStarted = performance.now();
  const qaResult = await client
    .from("osm_staging_route_visual_qa")
    .select("staging_route_id,status,reviewer_note,reviewed_at,reviewer_user_id,version")
    .in("staging_route_id", routes.map((route) => route.id));
  const qaQueryMilliseconds = Math.round((performance.now() - qaStarted) * 10) / 10;
  const qaSchemaAvailable = !qaResult.error;
  if (
    qaResult.error &&
    qaResult.error.code !== "42P01" &&
    qaResult.error.code !== "PGRST205" &&
    !/osm_staging_route_visual_qa.*(?:not found|does not exist)/i.test(qaResult.error.message)
  ) throw new Error(qaResult.error.message);
  const qaDecisions = ((qaResult.data ?? []) as Array<Record<string, unknown>>).map((value) => ({
    stagingRouteId: String(value.staging_route_id),
    status: String(value.status) as StoredPreviewQaDecision["status"],
    reviewerNote: value.reviewer_note === null ? null : String(value.reviewer_note),
    reviewedAt: String(value.reviewed_at),
    reviewerUserId: String(value.reviewer_user_id),
    version: Number(value.version),
  }));
  const { data: summitData, error: summitError } = await client
    .from("osm_route_import_summit_staging")
    .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association,final_confidence,minimum_geometry_distance_meters,endpoint_distance_meters")
    .in("staging_route_id", routes.map((route) => route.id));
  if (summitError) throw new Error(summitError.message);
  const validated = validateManifestApprovedRows({
    manifest,
    routes,
    summits: ((summitData ?? []) as Array<Record<string, unknown>>).map(summitRow),
  });
  const listItems = createApprovedListItems({ validated, metadata, qaDecisions });
  const listQueryMilliseconds = Math.round((performance.now() - listStarted) * 10) / 10;
  const planByKey = new Map(plan.records.map((record) => [record.idempotencyKey, record]));
  const mapInputs = listItems.map((item) => {
    const planRecord = planByKey.get(item.idempotencyKey);
    if (!planRecord) throw new Error(`Missing local geometry for ${item.idempotencyKey}`);
    const geojson = buildRouteFeatureCollection(planRecord.contract.route.geometry);
    return {
      sourceRelationId: item.sourceRelationId,
      pointCount: item.diagnostics.geometryPointCount,
      bytes: Buffer.byteLength(JSON.stringify(geojson), "utf8"),
      componentCount: item.componentCount,
    };
  });
  mapInputs.sort((left, right) => right.bytes - left.bytes);
  const inspection = listItems.find((item) => item.sourceRelationId === "11192622");
  if (!inspection) throw new Error("Required warning route 11192622 is missing.");
  const detailStarted = performance.now();
  const [{ data: detailData, error: detailError }, { data: mountainData, error: mountainError }] =
    await Promise.all([
      client.from("osm_route_import_staging").select("id,geometry_geojson,payload").eq("id", inspection.stagingRouteId).maybeSingle(),
      client.from("mountains").select("id,osm_id,name,name_de,height,latitude,longitude").eq("id", inspection.summit.mountainId).maybeSingle(),
    ]);
  if (detailError || mountainError || !detailData || !mountainData) {
    throw new Error(detailError?.message ?? mountainError?.message ?? "Detail measurement failed.");
  }
  const detailQueryMilliseconds = Math.round((performance.now() - detailStarted) * 10) / 10;
  const detailPayload = detailData.payload as {
    source: { sourceUrl: string; attribution: string; license: string };
    confirmedSummits: Array<{ peakOsmId: string; evidence: string[]; mountainMatch: { reasons: string[] } }>;
    routeAdministration: unknown;
  };
  const detailSummit = detailPayload.confirmedSummits.find(
    (summit) => summit.peakOsmId === inspection.summit.peakOsmId,
  );
  const serializedBrowserPayloadBytes = Buffer.byteLength(JSON.stringify({
    ...inspection,
    geometry: detailData.geometry_geojson,
    mountain: mountainData,
    provenance: {
      sourceUrl: detailPayload.source.sourceUrl,
      attribution: "© OpenStreetMap contributors",
      license: detailPayload.source.license,
      datasetFingerprint: manifest.datasetFingerprint,
      contractVersion: manifest.contractVersion,
      boundary: detailPayload.routeAdministration,
    },
    evidence: detailSummit
      ? [...detailSummit.mountainMatch.reasons, ...detailSummit.evidence]
      : [],
  }), "utf8");
  process.stdout.write(`${JSON.stringify({
    routesVisible: listItems.length,
    warningRoutes: listItems.filter((item) => item.warnings.length > 0).length,
    qaProgress: summarizeQaProgress(listItems),
    list: {
      combinedQueryMilliseconds: listQueryMilliseconds,
      stagingMetadataQueryMilliseconds,
      qaQueryMilliseconds,
      qaSchemaAvailable,
      serializedPayloadBytes: Buffer.byteLength(JSON.stringify(listItems), "utf8"),
      fullGeometries: 0,
    },
    inspectedDetail: {
      sourceRelationId: inspection.sourceRelationId,
      stagingRouteId: inspection.stagingRouteId,
      queryMilliseconds: detailQueryMilliseconds,
      geometryPointCount: inspection.diagnostics.geometryPointCount,
      mapInputBytes: mapInputs.find((item) => item.sourceRelationId === inspection.sourceRelationId)?.bytes,
      componentCount: inspection.componentCount,
      serializedBrowserPayloadBytes,
      serializedDatabaseEvidenceBytes: Buffer.byteLength(JSON.stringify({ detailData, mountainData }), "utf8"),
    },
    largestMapInput: mapInputs[0],
    databaseWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
