/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

async function loadEnvironment(content: string): Promise<void> {
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

async function main(): Promise<void> {
  await loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase credentials not configured.");

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const manifestPath = resolve("data/osm/alps/staging/phase11c4-staging-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const idempotencyKeys = manifest.records.map((r: any) => r.idempotencyKey);

  const stagingResult = await client
    .from("osm_route_import_staging")
    .select("id,idempotency_key,source_relation_id")
    .in("idempotency_key", idempotencyKeys);
  if (stagingResult.error) throw new Error(`Staging query failed: ${stagingResult.error.message}`);

  const stagingRoutes = stagingResult.data ?? [];
  const stagingRouteIds = stagingRoutes.map((r: any) => r.id);
  console.log(`Found ${stagingRouteIds.length} staging routes in DB`);

  console.log(`Phase 11C.4 queue: ${stagingRouteIds.length} routes`);

  const [qaResult, historyResult] = await Promise.all([
    client
      .from("osm_staging_route_visual_qa")
      .select("staging_route_id,status,version,reviewed_at,reviewer_user_id,reviewer_note")
      .in("staging_route_id", stagingRouteIds),
    client
      .from("osm_staging_route_visual_qa_history")
      .select("staging_route_id,old_status,new_status,decision_version,occurred_at,reviewer_user_id,reviewer_note,id")
      .in("staging_route_id", stagingRouteIds)
      .order("decision_version", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  if (qaResult.error) throw new Error(`QA query failed: ${qaResult.error.message}`);
  if (historyResult.error) throw new Error(`History query failed: ${historyResult.error.message}`);

  const qaRows = qaResult.data ?? [];
  const historyRows = historyResult.data ?? [];

  const statusCounts = {
    PENDING: 0,
    VISUALLY_APPROVED: 0,
    NEEDS_REVIEW: 0,
    REJECTED: 0,
  };

  for (const row of qaRows) {
    const status = row.status as keyof typeof statusCounts;
    if (status in statusCounts) statusCounts[status]++;
    else console.log(`Unknown status: ${row.status} for ${row.staging_route_id}`);
  }

  console.log("\n=== Phase 11C.4 Authoritative QA Counts ===");
  console.log(`Total queue: ${stagingRouteIds.length}`);
  console.log(`QA decision rows present: ${qaRows.length}`);
  console.log(`QA history rows present: ${historyRows.length}`);
  console.log(`Pending: ${statusCounts.PENDING}`);
  console.log(`Visually Approved: ${statusCounts.VISUALLY_APPROVED}`);
  console.log(`Needs Review: ${statusCounts.NEEDS_REVIEW}`);
  console.log(`Rejected: ${statusCounts.REJECTED}`);

  console.log("\n=== History by route ===");
  const historyByRoute = new Map<string, typeof historyRows>();
  for (const row of historyRows) {
    const arr = historyByRoute.get(row.staging_route_id) ?? [];
    arr.push(row);
    historyByRoute.set(row.staging_route_id, arr);
  }
  console.log(`Routes with history: ${historyByRoute.size}`);

  console.log("\n=== Decision details ===");
  for (const row of qaRows) {
    console.log(`${row.staging_route_id}: ${row.status} v${row.version} by ${row.reviewer_user_id} at ${row.reviewed_at}`);
  }

  const decidedIds = new Set(qaRows.map(r => r.staging_route_id));
  const pendingIds = stagingRouteIds.filter(id => !decidedIds.has(id));
  console.log(`\nPending route IDs (${pendingIds.length}):`);
  for (const id of pendingIds) console.log(`  ${id}`);

  console.log("\n=== Runtime observed vs DB ===");
  console.log(`Runtime: 84 approved, 1 rejected, 65 pending`);
  console.log(`DB: ${statusCounts.VISUALLY_APPROVED} approved, ${statusCounts.REJECTED} rejected, ${statusCounts.PENDING} pending`);
  console.log(`Match: ${statusCounts.VISUALLY_APPROVED === 84 && statusCounts.REJECTED === 1 && statusCounts.PENDING === 65 ? "YES" : "NO"}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
