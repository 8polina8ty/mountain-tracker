import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadAdminBoundaryDataset } from "./admin-boundary.ts";
import {
  OSM_ROUTE_IMPORT_CONTRACT_VERSION,
  applyStagingPlan,
  buildFirstBatchQa,
  buildFirstBatchSelection,
  buildImportPlan,
  createPhase8DatasetFingerprint,
  parsePhase8CliOptions,
  selectReadyStagingRecords,
  summarizeAdminEnrichment,
  summarizeImportPlan,
  validateFirstWriteManifest,
  type MountainCatalogRecord,
  type FirstWriteManifest,
  type Phase7CanonicalRouteRecord,
  type Phase7EligibilityRecord,
  type StagingSourceRouteRecord,
  type StagingWriter,
} from "./phase8-staging.ts";
import {
  iterateJsonLines,
  readJsonLines,
  writeJsonAtomically,
  writeJsonLines,
} from "./jsonl.ts";

const AUDIT_DIRECTORY = resolve("data/osm/alps/audit");
const ROUTES_PATH = resolve("data/osm/alps/routes.jsonl");
const OUTPUT_DIRECTORY = resolve("data/osm/alps/staging");
const DEFAULT_ADMIN_BOUNDARIES_PATH = resolve(
  "data/osm/boundaries/alps-admin.geojson",
);

interface FinalAuditSummary {
  schemaVersion: number;
  sourceGeneratedAt: string;
  eligibility: {
    autoImportReady: number;
    manualReviewRequired: number;
    exclude: number;
  };
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

interface LocalMountainCatalog {
  generatedAt?: string;
  mountains: MountainCatalogRecord[];
}

interface LiveStagingRouteRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  contract_version: string;
  import_eligibility: string;
  matched_primary_mountain_id: number | null;
}

interface LiveStagingSummitRow {
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: string;
  final_association: string;
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

async function loadEnvironmentIfPresent(): Promise<void> {
  try {
    loadLocalEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function getSupabaseCredentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Read-only mountain catalog discovery requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).",
    );
  }
  return { url, key };
}

function createAdminClient(): SupabaseClient {
  const credentials = getSupabaseCredentials();
  return createClient(credentials.url, credentials.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadMountainCatalogFromDatabase(
  client: SupabaseClient,
): Promise<MountainCatalogRecord[]> {
  const rows: DatabaseMountainRow[] = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from("mountains")
      .select(
        "id,osm_id,name,name_de,height,latitude,longitude,country_code,source",
      )
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Mountain catalog read failed: ${error.message}`);
    const page = (data ?? []) as DatabaseMountainRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(mapMountain);
}

async function loadMountainCatalog(
  path: string | null,
): Promise<{ records: MountainCatalogRecord[]; source: string }> {
  if (path) {
    const value = JSON.parse(await readFile(resolve(path), "utf8")) as
      | MountainCatalogRecord[]
      | LocalMountainCatalog;
    const records = Array.isArray(value) ? value : value.mountains;
    if (!Array.isArray(records)) throw new Error("Mountain catalog JSON is invalid");
    return { records, source: `local:${resolve(path)}` };
  }
  await loadEnvironmentIfPresent();
  return {
    records: await loadMountainCatalogFromDatabase(createAdminClient()),
    source: "supabase:public.mountains:read-only",
  };
}

async function loadRelevantSourceRoutes(
  canonicalSourceIds: Set<string>,
): Promise<StagingSourceRouteRecord[]> {
  const records: StagingSourceRouteRecord[] = [];
  for await (const route of iterateJsonLines<StagingSourceRouteRecord>(ROUTES_PATH)) {
    if (canonicalSourceIds.has(route.sourceId)) records.push(route);
  }
  return records;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function catalogFingerprint(records: MountainCatalogRecord[]): string {
  const stable = [...records]
    .sort((left, right) => left.id - right.id)
    .map((record) => ({
      id: record.id,
      osmId: record.osmId,
      heightMeters: record.heightMeters,
      coordinates: record.coordinates,
    }));
  return sha256(JSON.stringify(stable));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createSupabaseStagingWriter(client: SupabaseClient): StagingWriter {
  return {
    async findByIdempotencyKey(idempotencyKey) {
      const { data, error } = await client
        .from("osm_route_import_staging")
        .select("id,payload_hash")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (error) throw new Error(`Staging lookup failed: ${error.message}`);
      if (!data) return null;
      return { id: String(data.id), payloadHash: String(data.payload_hash) };
    },
    async inspectRecord(record) {
      const routeColumns =
        "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,matched_primary_mountain_id";
      const mountainMatches = record.contract.confirmedSummits.map((summit) => ({
        peakOsmId: summit.peakOsmId,
        mountainId: summit.mountainMatch.mountainId,
      }));
      if (mountainMatches.some((match) => match.mountainId === null)) {
        return { status: "CONFLICT", reason: "Manifest summit no longer has an exact mountain ID." };
      }
      const mountainIds = mountainMatches.map((match) => match.mountainId as number);
      const productionSourceUrls = [
        record.contract.source.sourceUrl,
        `/api/osm-route-publications/openstreetmap/relation/${record.canonicalRouteSourceId}/geojson`,
      ];
      const [byKey, byRelation, byCanonical, mountains, productionRoutes] = await Promise.all([
        client.from("osm_route_import_staging").select(routeColumns).eq("idempotency_key", record.idempotencyKey),
        client.from("osm_route_import_staging").select(routeColumns).eq("source_relation_id", record.sourceRelationId),
        client.from("osm_route_import_staging").select(routeColumns).eq("canonical_source_id", record.canonicalRouteSourceId),
        client.from("mountains").select("id,osm_id").in("id", mountainIds),
        client.from("mountain_routes").select("id,source_url").in("source_url", productionSourceUrls),
      ]);
      for (const [label, result] of [
        ["idempotency", byKey],
        ["relation", byRelation],
        ["canonical", byCanonical],
        ["mountain", mountains],
        ["production URL", productionRoutes],
      ] as const) {
        if (result.error) throw new Error(`Staging ${label} preflight failed: ${result.error.message}`);
      }
      const mountainById = new Map(
        (mountains.data ?? []).map((row) => [Number(row.id), row.osm_id === null ? null : String(row.osm_id)]),
      );
      for (const match of mountainMatches) {
        if (mountainById.get(match.mountainId as number) !== match.peakOsmId) {
          return {
            status: "CONFLICT",
            reason: `Mountain ${match.mountainId} no longer exactly resolves peak ${match.peakOsmId}.`,
          };
        }
      }
      if ((productionRoutes.data ?? []).length > 0) {
        return { status: "CONFLICT", reason: "A production route already uses this source URL." };
      }
      const rows = new Map<string, LiveStagingRouteRow>();
      for (const row of [
        ...(byKey.data ?? []),
        ...(byRelation.data ?? []),
        ...(byCanonical.data ?? []),
      ] as LiveStagingRouteRow[]) {
        rows.set(row.id, row);
      }
      if (rows.size === 0) return { status: "MISSING" };
      const exact = [...rows.values()].find((row) => row.idempotency_key === record.idempotencyKey);
      if (!exact || rows.size !== 1) {
        return { status: "CONFLICT", reason: "Staging source identity resolves to a different row." };
      }
      const expectedPrimaryMountainId = [...mountainIds].sort((left, right) => left - right)[0] ?? null;
      if (
        exact.payload_hash !== record.payloadHash ||
        exact.source_relation_id !== record.sourceRelationId ||
        exact.canonical_source_id !== record.canonicalRouteSourceId ||
        exact.contract_version !== record.contract.contractVersion ||
        exact.import_eligibility !== "AUTO_IMPORT_READY" ||
        exact.matched_primary_mountain_id !== expectedPrimaryMountainId
      ) {
        return { status: "DRIFT", reason: "Existing staging route differs from the locked manifest." };
      }
      const summitResult = await client
        .from("osm_route_import_summit_staging")
        .select("peak_osm_id,mountain_id,mountain_match_classification,final_association")
        .eq("staging_route_id", exact.id);
      if (summitResult.error) {
        throw new Error(`Staging summit preflight failed: ${summitResult.error.message}`);
      }
      const actualSummits = (summitResult.data ?? []) as LiveStagingSummitRow[];
      const summitRowsMatch =
        actualSummits.length === mountainMatches.length &&
        actualSummits.every((actual) =>
          mountainMatches.some(
            (expected) =>
              actual.peak_osm_id === expected.peakOsmId &&
              actual.mountain_id === expected.mountainId &&
              actual.mountain_match_classification === "EXACT_MOUNTAIN_MATCH" &&
              actual.final_association === "CONFIRMED",
          ),
        );
      return summitRowsMatch
        ? { status: "UNCHANGED", id: exact.id }
        : { status: "DRIFT", reason: "Existing staging summit rows differ from the locked manifest." };
    },
    async upsertRouteWithSummits(record) {
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
      const { data, error } = await client.rpc("stage_osm_route_import", {
        p_route: routePayload,
        p_summits: summitPayloads,
      });
      if (error) throw new Error(`Transactional staging upsert failed: ${error.message}`);
      return { id: String(data) };
    },
  };
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const options = parsePhase8CliOptions(process.argv.slice(2));
  const finalAuditPath = resolve(AUDIT_DIRECTORY, "final-audit-summary.json");
  const eligibilityPath = resolve(AUDIT_DIRECTORY, "import-eligibility.jsonl");
  const canonicalRoutesPath = resolve(
    AUDIT_DIRECTORY,
    "canonical-confirmed-routes.jsonl",
  );
  const auditContent = await readFile(finalAuditPath, "utf8");
  const auditSummary = JSON.parse(auditContent) as FinalAuditSummary;
  const phase7AuditHash = sha256(auditContent);
  const datasetVersion = `alps-phase7:${auditSummary.sourceGeneratedAt}:${phase7AuditHash.slice(0, 12)}`;
  const eligibilityRecords =
    await readJsonLines<Phase7EligibilityRecord>(eligibilityPath);
  const canonicalRoutes =
    await readJsonLines<Phase7CanonicalRouteRecord>(canonicalRoutesPath);
  const autoIds = new Set(
    eligibilityRecords
      .filter((record) => record.eligibility === "AUTO_IMPORT_READY")
      .map((record) => record.canonicalRouteSourceId),
  );
  const [sourceRoutes, catalog] = await Promise.all([
    loadRelevantSourceRoutes(autoIds),
    loadMountainCatalog(options.mountainCatalogPath),
  ]);

  const requestedBoundaryPath =
    options.adminBoundariesPath === null
      ? DEFAULT_ADMIN_BOUNDARIES_PATH
      : resolve(options.adminBoundariesPath);
  const boundaryAvailable = await fileExists(requestedBoundaryPath);
  const adminBoundaries = boundaryAvailable
    ? await loadAdminBoundaryDataset(requestedBoundaryPath)
    : null;
  const plan = buildImportPlan({
    eligibilityRecords,
    canonicalRoutes,
    sourceRoutes,
    mountains: catalog.records,
    datasetVersion,
    phase7AuditHash,
    adminBoundaries,
  });
  const summary = summarizeImportPlan(plan.records);
  const administrativeEnrichment = summarizeAdminEnrichment(plan.records);
  const mountainCatalogFingerprint = catalogFingerprint(catalog.records);
  const datasetFingerprint = createPhase8DatasetFingerprint({
    datasetVersion,
    phase7AuditHash,
    mountainCatalogFingerprint,
    adminBoundaryVersion: adminBoundaries?.metadata.version ?? null,
  });
  const manifest = options.manifestPath
    ? (JSON.parse(await readFile(resolve(options.manifestPath), "utf8")) as FirstWriteManifest)
    : null;
  const first50 = buildFirstBatchSelection(plan.records, 50);
  const first50Qa = buildFirstBatchQa(plan.records, 50);
  const selectedForExecution = manifest
    ? validateFirstWriteManifest(plan.records, manifest, datasetFingerprint)
    : selectReadyStagingRecords(plan.records, options.limit);

  const generatedAt = auditSummary.sourceGeneratedAt;
  const planDocument = {
    schemaVersion: 1,
    contractVersion: OSM_ROUTE_IMPORT_CONTRACT_VERSION,
    generatedAt,
    mode: options.mode,
    datasetVersion,
    phase7AuditHash,
    sourceArtifacts: {
      finalAuditPath,
      eligibilityPath,
      canonicalRoutesPath,
      routesPath: ROUTES_PATH,
    },
    mountainCatalog: {
      source: catalog.source,
      recordCount: catalog.records.length,
      fingerprint: mountainCatalogFingerprint,
    },
    administrativeBoundaries: adminBoundaries
      ? {
          status: "available",
          path: requestedBoundaryPath,
          provenance: adminBoundaries.metadata,
        }
      : {
          status: "unavailable",
          path: requestedBoundaryPath,
          provenance: null,
          reason:
            "No local validated boundary dataset was found; country and region were not guessed.",
        },
    phase7Eligibility: auditSummary.eligibility,
    excludedEligibilityCounts: plan.excludedEligibilityCounts,
    summary,
    administrativeEnrichment,
    datasetFingerprint,
    executionSelection: {
      requestedLimit: options.limit,
      readyRecordsSelected: selectedForExecution.length,
      idempotencyKeys: selectedForExecution.map((record) => record.idempotencyKey),
    },
    records: plan.records,
  };
  await Promise.all([
    writeJsonAtomically(resolve(OUTPUT_DIRECTORY, "import-plan.json"), planDocument),
    writeJsonLines(resolve(OUTPUT_DIRECTORY, "import-plan.jsonl"), plan.records),
    writeJsonAtomically(resolve(OUTPUT_DIRECTORY, "first-50.json"), first50),
    writeJsonAtomically(resolve(OUTPUT_DIRECTORY, "first-50-qa.json"), {
      schemaVersion: 1,
      generatedAt,
      selectionMethod: first50.selectionMethod,
      records: first50Qa,
    }),
  ]);

  const applyResult = await applyStagingPlan(
    plan.records,
    options,
    options.mode === "apply-staging"
      ? createSupabaseStagingWriter(createAdminClient())
      : undefined,
    manifest
      ? {
          manifest,
          datasetFingerprint,
        }
      : undefined,
  );
  const result = {
    mode: options.mode,
    datasetVersion,
    mountainCatalogRecords: catalog.records.length,
    adminBoundaryStatus: adminBoundaries ? "available" : "unavailable",
    summary,
    administrativeEnrichment,
    first50Composition: first50.composition,
    applyResult,
    runtimeSeconds: Math.round((performance.now() - startedAt) / 10) / 100,
    outputDirectory: OUTPUT_DIRECTORY,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
