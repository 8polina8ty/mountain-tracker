import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import type { FirstWriteManifest } from "./phase8-staging.ts";

interface RouteRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  contract_version: string;
  source_relation_id: string;
  canonical_source_id: string;
}

interface SummitRow {
  staging_route_id: string;
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: string;
  final_association: string;
}

const READ_BATCH_SIZE = 20;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += READ_BATCH_SIZE) {
    result.push(values.slice(index, index + READ_BATCH_SIZE));
  }
  return result;
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
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] !== "--manifest" || !arguments_[1] || arguments_.length !== 2) {
    throw new Error("Usage: verify-first-write.ts --manifest <path>");
  }
  const manifest = JSON.parse(
    await readFile(resolve(arguments_[1]), "utf8"),
  ) as FirstWriteManifest;
  try {
    loadLocalEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase credentials are required for read-only verification.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const expectedByKey = new Map(
    manifest.records.map((record) => [record.idempotencyKey, record]),
  );
  const routes: RouteRow[] = [];
  for (const idempotencyKeys of batches([...expectedByKey.keys()])) {
    const { data, error } = await client
      .from("osm_route_import_staging")
      .select(
        "id,idempotency_key,payload_hash,contract_version,source_relation_id,canonical_source_id",
      )
      .in("idempotency_key", idempotencyKeys);
    if (error) throw new Error(`Staging route verification failed: ${error.message}`);
    routes.push(...((data ?? []) as RouteRow[]));
  }
  const failures: string[] = [];
  if (routes.length !== manifest.recordCount) {
    failures.push(`Expected ${manifest.recordCount} route rows, found ${routes.length}.`);
  }
  const routeIdToKey = new Map<string, string>();
  for (const route of routes) {
    const expected = expectedByKey.get(route.idempotency_key);
    if (!expected) {
      failures.push(`Unexpected idempotency key: ${route.idempotency_key}`);
      continue;
    }
    routeIdToKey.set(route.id, route.idempotency_key);
    if (route.payload_hash !== expected.payloadHash) {
      failures.push(`Payload hash mismatch: ${route.idempotency_key}`);
    }
    if (route.contract_version !== manifest.contractVersion) {
      failures.push(`Contract mismatch: ${route.idempotency_key}`);
    }
    if (
      route.source_relation_id !== expected.sourceRelationId ||
      route.canonical_source_id !== expected.canonicalRouteSourceId
    ) {
      failures.push(`Source identity mismatch: ${route.idempotency_key}`);
    }
  }
  const routeIds = [...routeIdToKey.keys()];
  const summits: SummitRow[] = [];
  for (const stagingRouteIds of batches(routeIds)) {
    const { data, error } = await client
      .from("osm_route_import_summit_staging")
      .select(
        "staging_route_id,peak_osm_id,mountain_id,mountain_match_classification,final_association",
      )
      .in("staging_route_id", stagingRouteIds);
    if (error) throw new Error(`Staging summit verification failed: ${error.message}`);
    summits.push(...((data ?? []) as SummitRow[]));
  }
  if (summits.length !== manifest.expectedSummitAssociationCount) {
    failures.push(
      `Expected ${manifest.expectedSummitAssociationCount} summit rows, found ${summits.length}.`,
    );
  }
  const actualAssociations = new Set(
    summits.map((summit) => {
      const key = routeIdToKey.get(summit.staging_route_id) ?? "missing-route";
      return `${key}|${summit.peak_osm_id}|${summit.mountain_id}`;
    }),
  );
  for (const record of manifest.records) {
    for (const match of record.mountainMatches) {
      const association = `${record.idempotencyKey}|${match.peakOsmId}|${match.mountainId}`;
      if (!actualAssociations.has(association)) failures.push(`Missing association: ${association}`);
    }
  }
  for (const summit of summits) {
    if (
      summit.mountain_match_classification !== "EXACT_MOUNTAIN_MATCH" ||
      summit.final_association !== "CONFIRMED"
    ) {
      failures.push(`Invalid association classification for peak ${summit.peak_osm_id}.`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  process.stdout.write(
    `${JSON.stringify({
      manifestHash: manifest.manifestHash,
      verifiedRouteRows: routes.length,
      verifiedSummitRows: summits.length,
      payloadHashesMatch: true,
      exactReviewedSetMatch: true,
      databaseWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
