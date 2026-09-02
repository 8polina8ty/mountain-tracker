import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  validateFirstWriteManifest,
  type FirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";
import {
  buildPhase11c4StagingPreflight,
  type Phase11c4MountainIdentityRow,
  type Phase11c4ProductionRouteRow,
  type Phase11c4StagingRouteRow,
  type Phase11c4StagingSummitRow,
} from "./phase11c4-staging-preflight.ts";
import { writeJsonAtomically } from "./jsonl.ts";

const IMPORT_PLAN_PATH = resolve("data/osm/alps/staging/import-plan.json");
const MANIFEST_PATH = resolve("data/osm/alps/staging/phase11c4-staging-manifest.json");
const OUTPUT_PATH = resolve("data/osm/alps/staging/phase11c4-db-staging-readiness.json");

interface ImportPlanDocument {
  datasetFingerprint: string;
  records: ImportPlanRecord[];
}

function loadLocalEnvironment(content: string): void {
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
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) throw new Error("Supabase read credentials are not configured.");

  const [plan, manifest] = await Promise.all([
    readFile(IMPORT_PLAN_PATH, "utf8").then((value) => JSON.parse(value) as ImportPlanDocument),
    readFile(MANIFEST_PATH, "utf8").then((value) => JSON.parse(value) as FirstWriteManifest),
  ]);
  const selected = validateFirstWriteManifest(
    plan.records,
    manifest,
    plan.datasetFingerprint,
  );
  const mountainIds = [
    ...new Set(
      selected.flatMap((record) =>
        record.contract.confirmedSummits.map((summit) => summit.mountainMatch.mountainId as number),
      ),
    ),
  ];
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const routeColumns =
    "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,matched_primary_mountain_id";
  const [stagingRouteResult, mountains, publishedOsmRoutes, publishedApiRoutes] = await Promise.all([
    client.from("osm_route_import_staging").select(routeColumns),
    client.from("mountains").select("id,osm_id").in("id", mountainIds),
    client.from("mountain_routes").select("id,source_url").like("source_url", "https://www.openstreetmap.org/relation/%"),
    client.from("mountain_routes").select("id,source_url").like("source_url", "/api/osm-route-publications/openstreetmap/relation/%/geojson"),
  ]);
  for (const [label, result] of [
    ["staging route", stagingRouteResult],
    ["mountain", mountains],
    ["production OSM URL", publishedOsmRoutes],
    ["production API URL", publishedApiRoutes],
  ] as const) {
    if (result.error) throw new Error(`${label} read failed: ${result.error.message}`);
  }
  const stagingRoutes = (stagingRouteResult.data ?? []) as Phase11c4StagingRouteRow[];
  const productionRoutes = [
    ...(publishedOsmRoutes.data ?? []),
    ...(publishedApiRoutes.data ?? []),
  ] as Phase11c4ProductionRouteRow[];
  const stagingRouteIds = stagingRoutes.map((route) => route.id);
  const [summitResult, qaResult, historyResult] = stagingRouteIds.length
    ? await Promise.all([
        client
          .from("osm_route_import_summit_staging")
          .select("staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association")
          .in("staging_route_id", stagingRouteIds),
        client.from("osm_staging_route_visual_qa").select("staging_route_id").in("staging_route_id", stagingRouteIds),
        client.from("osm_staging_route_visual_qa_history").select("staging_route_id").in("staging_route_id", stagingRouteIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (summitResult.error) throw new Error(`Summit read failed: ${summitResult.error.message}`);
  if (qaResult.error) throw new Error(`QA read failed: ${qaResult.error.message}`);
  if (historyResult.error) throw new Error(`QA history read failed: ${historyResult.error.message}`);

  const preflight = buildPhase11c4StagingPreflight({
    records: selected,
    stagingRoutes,
    stagingSummits: (summitResult.data ?? []) as Phase11c4StagingSummitRow[],
    mountains: (mountains.data ?? []) as Phase11c4MountainIdentityRow[],
    productionRoutes,
  });
  const selectedStagingRouteIds = new Set(
    preflight.records
      .map((record) => record.stagingRouteId)
      .filter((value): value is string => value !== null),
  );
  const selectedQaRows = (qaResult.data ?? []).filter((row) =>
    selectedStagingRouteIds.has(String(row.staging_route_id)),
  );
  const selectedHistoryRows = (historyResult.data ?? []).filter((row) =>
    selectedStagingRouteIds.has(String(row.staging_route_id)),
  );
  const summary = {
    queueTotal: selected.length,
    phase8ReadyCount: selected.length,
    wouldCreate: preflight.wouldCreate,
    unchanged: preflight.unchanged,
    blocked: preflight.blocked,
    stagingRowsPresent: selectedStagingRouteIds.size,
    stagingRowsMissing: preflight.wouldCreate,
    qaReadyCount: preflight.unchanged,
    qaDecisionRowsPresent: selectedQaRows.length,
    qaHistoryRowsPresent: selectedHistoryRows.length,
    summitMountainIdentitiesVerified: selected.reduce(
      (count, record) => count + record.contract.confirmedSummits.length,
      0,
    ),
    uniqueMountainsVerified: mountainIds.length,
    existingStagingRowsScanned: stagingRoutes.length,
    productionSourceUrlConflicts: preflight.records.filter(
      (record) => record.reason === "PRODUCTION_SOURCE_URL_CONFLICT",
    ).length,
  };
  const report = {
    schemaVersion: 2,
    artifactType: "PHASE11C4_DB_STAGING_READINESS",
    auditedAt: new Date().toISOString(),
    databaseMode: "SELECT_ONLY",
    manifestHash: manifest.manifestHash,
    summary,
    records: preflight.records,
  };
  await writeJsonAtomically(OUTPUT_PATH, report);
  process.stdout.write(
    `${JSON.stringify({ summary, outputPath: OUTPUT_PATH, databaseWrites: 0 }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
