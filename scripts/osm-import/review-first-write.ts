import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { writeJsonAtomically } from "./jsonl.ts";
import { buildFirstWriteReview } from "./phase8-prewrite.ts";
import {
  createPhase8DatasetFingerprint,
  type ImportPlanRecord,
  type MountainCatalogRecord,
} from "./phase8-staging.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const PLAN_PATH = resolve(STAGING_DIRECTORY, "import-plan.json");
const FIRST_50_PATH = resolve(STAGING_DIRECTORY, "first-50.json");
const FIRST_50_QA_PATH = resolve(STAGING_DIRECTORY, "first-50-qa.json");
const REVIEW_PATH = resolve(STAGING_DIRECTORY, "first-50-prewrite-review.json");
const MANIFEST_PATH = resolve(STAGING_DIRECTORY, "first-write-manifest.json");

interface PlanDocument {
  generatedAt: string;
  datasetVersion: string;
  phase7AuditHash: string;
  mountainCatalog: { fingerprint: string };
  administrativeBoundaries: {
    status: "available" | "unavailable";
    provenance: { version: string } | null;
  };
  records: ImportPlanRecord[];
}

interface First50Document {
  selectionMethod: string;
  selectedCount: number;
  routes: Array<{ sourceRelationId: string }>;
}

interface First50QaDocument {
  records: Array<{ sourceRelationId: string }>;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

async function loadEnvironment(): Promise<void> {
  try {
    loadLocalEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    id: row.id,
    osmId: row.osm_id === null ? null : String(row.osm_id),
    name: row.name,
    nameDe: row.name_de,
    heightMeters: numericOrNull(row.height),
    coordinates:
      latitude === null || longitude === null ? null : [longitude, latitude],
    countryCode: row.country_code,
    source: row.source,
  };
}

async function loadReviewedMountains(ids: number[]): Promise<MountainCatalogRecord[]> {
  await loadEnvironment();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase credentials are required for read-only mountain verification.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("mountains")
    .select("id,osm_id,name,name_de,height,latitude,longitude,country_code,source")
    .in("id", ids)
    .order("id", { ascending: true });
  if (error) throw new Error(`Read-only mountain verification failed: ${error.message}`);
  return ((data ?? []) as DatabaseMountainRow[]).map(mapMountain);
}

async function main(): Promise<void> {
  const [planContent, first50Content, qaContent] = await Promise.all([
    readFile(PLAN_PATH, "utf8"),
    readFile(FIRST_50_PATH, "utf8"),
    readFile(FIRST_50_QA_PATH, "utf8"),
  ]);
  const plan = JSON.parse(planContent) as PlanDocument;
  const first50 = JSON.parse(first50Content) as First50Document;
  const qa = JSON.parse(qaContent) as First50QaDocument;
  const sourceIds = first50.routes.map((route) => route.sourceRelationId);
  if (first50.selectedCount !== 50 || sourceIds.length !== 50) {
    throw new Error("The deterministic review input is not exactly 50 routes.");
  }
  if (JSON.stringify(sourceIds) !== JSON.stringify(qa.records.map((record) => record.sourceRelationId))) {
    throw new Error("first-50 and first-50-qa select different routes.");
  }
  const selected = new Set(sourceIds);
  const mountainIds = [
    ...new Set(
      plan.records
        .filter((record) => selected.has(record.sourceRelationId))
        .flatMap((record) => record.summits)
        .map((summit) => summit.mountainMatch.mountainId)
        .filter((id): id is number => id !== null),
    ),
  ].sort((left, right) => left - right);
  const mountains = await loadReviewedMountains(mountainIds);
  const datasetFingerprint = createPhase8DatasetFingerprint({
    datasetVersion: plan.datasetVersion,
    phase7AuditHash: plan.phase7AuditHash,
    mountainCatalogFingerprint: plan.mountainCatalog.fingerprint,
    adminBoundaryVersion:
      plan.administrativeBoundaries.status === "available"
        ? plan.administrativeBoundaries.provenance?.version ?? null
        : null,
  });
  const result = buildFirstWriteReview({
    planRecords: plan.records,
    reviewedSourceIds: sourceIds,
    mountains,
    datasetFingerprint,
  });
  const reviewDocument = {
    schemaVersion: 1,
    generatedAt: plan.generatedAt,
    selectionMethod: first50.selectionMethod,
    inputHashes: {
      importPlanSha256: sha256(planContent),
      first50Sha256: sha256(first50Content),
      first50QaSha256: sha256(qaContent),
    },
    datasetFingerprint,
    mountainRowsRead: mountains.length,
    summary: result.summary,
    records: result.reviews,
  };
  await Promise.all([
    writeJsonAtomically(REVIEW_PATH, reviewDocument),
    writeJsonAtomically(MANIFEST_PATH, result.manifest),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      reviewPath: REVIEW_PATH,
      manifestPath: MANIFEST_PATH,
      manifestHash: result.manifest.manifestHash,
      ...result.summary,
      databaseWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
