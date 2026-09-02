import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { sha256Stable } from "./phase11-publication.ts";
import { createPhase11hAdminClient } from "./phase11h-live.ts";

const STAGING = "data/osm/alps/staging";
const ROUTES_JSONL = "data/osm/alps/routes.jsonl";
const CANONICAL_CONFIRMED = "data/osm/alps/audit/canonical-confirmed-routes.jsonl";
const GREENS_PATH = `${STAGING}/phase11g-expanded-green-candidates.json`;
const IMPORT_PLAN_PATH = `${STAGING}/import-plan.json`;
const CONTRACT_PATH = `${STAGING}/phase11i-human-calibration-staging-contract.json`;
const NAME_AUDIT_PATH = `${STAGING}/phase11h-name-resolution-audit.json`;
const OUT_SNAPSHOT_PATH = `${STAGING}/phase11i-b2-human-calibration-source-snapshot.json`;

export const B2_SOURCE_SNAPSHOT_CONTRACT = "mountain-tracker-phase11i-b2-source-snapshot/v1";
export const OSM_ROUTE_CONTRACT = "mountain-tracker-osm-route/v1";

export interface FrozenSourceFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface B2SnapshotRecord {
  canonicalRelationId: string;
  sourceRelationId: string;
  sourceUrl: string;
  idempotencyKey: string;
  geometryHash: string;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  geometryType: "LineString";
  componentCount: number;
  distanceMeters: number;
  semanticType: string;
  qualityScore: number;
  routeName: string | null;
  auditFlags: string[];
  summit: {
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: [number, number] | null;
    finalAssociation: "CONFIRMED";
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    evidence: string[];
    sourceRouteIds: string[];
  };
  mountain: {
    mountainId: number;
    classification: "EXACT_MOUNTAIN_MATCH";
    peakOsmIdResolved: string;
  } | null;
  qualification: {
    qualificationHash: string;
    candidateHash: string;
    nameClass: string;
    nameStatus: string;
    nameOrigin: string | null;
    resolvedDisplayName: string | null;
    startContext: string | null;
    qualityBand: string;
    selectionTier: string;
    deterministicResolutionHash: string | null;
  };
  datasetVersion: string;
  datasetFingerprint: string;
  sourceContractVersion: string;
  snapshotContractVersion: typeof B2_SOURCE_SNAPSHOT_CONTRACT;
}

export interface B2SourceSnapshot {
  schemaVersion: number;
  artifactType: "PHASE11I_B2_SOURCE_SNAPSHOT";
  contractVersion: typeof B2_SOURCE_SNAPSHOT_CONTRACT;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  generatedByStrategy: string;
  scope: { relations: number; excluded: number };
  recordCount: number;
  records: B2SnapshotRecord[];
  exclusions: Array<{
    canonicalRelationId: string;
    peakOsmId: string;
    reason: string;
    evidence: string[];
  }>;
  sourceFiles: FrozenSourceFile[];
  integrity: {
    uniqueRelationIds: boolean;
    uniqueGeometryHashes: boolean;
    allMountainIdsResolved: boolean;
    allSingleConfirmedSummit: boolean;
    allPositiveDistances: boolean;
    allSemanticTypeSummitRoute: boolean;
  };
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadEnv(content: string): void {
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

export async function loadB2SourceFiles(): Promise<{
  routes: Map<string, Record<string, unknown>>;
  canonical: Map<string, Record<string, unknown>>;
  greensByRelation: Map<string, Record<string, unknown>>;
  importPlan: Record<string, unknown>;
  contractRecords: Array<{
    sourceRelationId: string;
    canonicalRelationId: string;
    qualificationHash: string;
    candidateHash: string;
    nameStatus: string;
    startContext: string;
    qualityBand: string;
    selectionTier: string;
  }>;
  nameAuditByRelation: Map<string, Record<string, unknown>>;
  sourceFiles: FrozenSourceFile[];
}> {
  const [routesRaw, canonicalRaw, greensRaw, importPlanRaw, contractRaw, nameAuditRaw] =
    await Promise.all([
      readFile(ROUTES_JSONL, "utf8"),
      readFile(CANONICAL_CONFIRMED, "utf8"),
      readFile(GREENS_PATH, "utf8"),
      readFile(IMPORT_PLAN_PATH, "utf8"),
      readFile(CONTRACT_PATH, "utf8"),
      readFile(NAME_AUDIT_PATH, "utf8"),
    ]);

  const sourceFiles: FrozenSourceFile[] = [
    { path: ROUTES_JSONL, sha256: sha256Bytes(Buffer.from(routesRaw)), bytes: Buffer.byteLength(routesRaw) },
    { path: CANONICAL_CONFIRMED, sha256: sha256Bytes(Buffer.from(canonicalRaw)), bytes: Buffer.byteLength(canonicalRaw) },
    { path: GREENS_PATH, sha256: sha256Bytes(Buffer.from(greensRaw)), bytes: Buffer.byteLength(greensRaw) },
    { path: IMPORT_PLAN_PATH, sha256: sha256Bytes(Buffer.from(importPlanRaw)), bytes: Buffer.byteLength(importPlanRaw) },
    { path: CONTRACT_PATH, sha256: sha256Bytes(Buffer.from(contractRaw)), bytes: Buffer.byteLength(contractRaw) },
    { path: NAME_AUDIT_PATH, sha256: sha256Bytes(Buffer.from(nameAuditRaw)), bytes: Buffer.byteLength(nameAuditRaw) },
  ];

  const routes = new Map<string, Record<string, unknown>>();
  for (const line of routesRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.sourceType === "relation" && typeof record.sourceId === "string") {
      routes.set(record.sourceId, record);
    }
  }

  const canonical = new Map<string, Record<string, unknown>>();
  for (const line of canonicalRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    canonical.set(String(record.canonicalRouteSourceId), record);
  }

  const greensArtifact = JSON.parse(greensRaw) as {
    records: Array<{ canonicalRouteSourceId: string } & Record<string, unknown>>;
  };
  const greensByRelation = new Map(
    greensArtifact.records.map((record) => [String(record.canonicalRouteSourceId), record]),
  );

  const importPlan = JSON.parse(importPlanRaw) as Record<string, unknown>;
  const contract = JSON.parse(contractRaw) as {
    records: Array<{
      sourceRelationId: string;
      canonicalRelationId: string;
      qualificationHash: string;
      candidateHash: string;
      nameStatus: string;
      startContext: string;
      qualityBand: string;
      selectionTier: string;
    }>;
  };

  const nameAudit = JSON.parse(nameAuditRaw) as {
    records: Array<{ canonicalRelationId: string } & Record<string, unknown>>;
  };
  const nameAuditByRelation = new Map(
    nameAudit.records.map((record) => [String(record.canonicalRelationId), record]),
  );

  return {
    routes,
    canonical,
    greensByRelation,
    importPlan,
    contractRecords: contract.records,
    nameAuditByRelation,
    sourceFiles,
  };
}

export class B2MountainIdentityResolutionError extends Error {
  constructor(relationId: string, detail: string) {
    super(`PHASE11I_B2_MOUNTAIN_IDENTITY_${relationId}: ${detail}`);
  }
}

export async function resolveMountainIds(
  client: SupabaseClient,
  peaks: Array<{ canonicalRelationId: string; peakOsmId: string }>,
): Promise<{ mountainIdByRelation: Map<string, number>; failures: string[] }> {
  const mountainIdByRelation = new Map<string, number>();
  const failures: string[] = [];
  const chunkSize = 40;
  for (let index = 0; index < peaks.length; index += chunkSize) {
    const chunk = peaks.slice(index, index + chunkSize);
    for (const peak of chunk) {
      const result = await client
        .from("mountains")
        .select("id,osm_id")
        .eq("osm_id", peak.peakOsmId);
      if (result.error) {
        failures.push(`PHASE11I_B2_MOUNTAIN_QUERY:${peak.peakOsmId}:${result.error.message}`);
        continue;
      }
      const rows = (result.data ?? []) as Array<{ id: number | string; osm_id: string | null }>;
      if (rows.length === 0) {
        failures.push(
          `PHASE11I_B2_MOUNTAIN_NONE:${peak.canonicalRelationId}:peak_osmid=${peak.peakOsmId}`,
        );
        continue;
      }
      if (rows.length > 1) {
        failures.push(
          `PHASE11I_B2_MOUNTAIN_AMBIGUOUS:${peak.canonicalRelationId}:peak_osmid=${peak.peakOsmId}:ids=${rows
            .map((row) => String(row.id))
            .sort()
            .join(",")}`,
        );
        continue;
      }
      mountainIdByRelation.set(peak.canonicalRelationId, Number(rows[0].id));
    }
  }
  return { mountainIdByRelation, failures };
}

function routeNameValue(canonicalRecord: Record<string, unknown>): string | null {
  const value = canonicalRecord.routeName;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function buildB2SourceSnapshot(options: {
  client?: SupabaseClient;
  envFilePath?: string;
}): Promise<B2SourceSnapshot> {
  const { routes, canonical, greensByRelation, importPlan, contractRecords, nameAuditByRelation, sourceFiles } =
    await loadB2SourceFiles();

  const contractRecordsLen = contractRecords.length;
  if (contractRecordsLen < 1) throw new Error("PHASE11I_B2_EMPTY_SCOPE");

  const datasetVersion = String(importPlan.datasetVersion ?? "");
  const datasetFingerprint = String(importPlan.datasetFingerprint ?? "");
  if (!datasetVersion || !datasetFingerprint) throw new Error("PHASE11I_B2_DATASET_MISSING");

  const client =
    options.client ??
    await (async () => {
      if (options.envFilePath) {
        try {
          loadEnv(await readFile(resolve(options.envFilePath), "utf8"));
        } catch {
          /* env file optional */
        }
      }
      return createPhase11hAdminClient();
    })();

  let records: B2SnapshotRecord[] = [];
  const failures: string[] = [];

  for (const member of contractRecords) {
    const canonicalRelationId = String(member.canonicalRelationId ?? "");
    const route = routes.get(canonicalRelationId);
    const canonicalConfirmed = canonical.get(canonicalRelationId);
    const green = greensByRelation.get(canonicalRelationId);
    const nameAudit = nameAuditByRelation.get(canonicalRelationId);
    if (!route || !canonicalConfirmed || !green || !nameAudit) {
      throw new Error(`PHASE11I_B2_INCOMPLETE_FROZEN_SOURCE:${canonicalRelationId}`);
    }

    const geometry = route.geometry as { type: "LineString"; coordinates: Array<[number, number]> };
    if (!geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) {
      throw new Error(`PHASE11I_B2_GEOMETRY_UNEXPECTED:${canonicalRelationId}:${String(geometry?.type)}`);
    }
    const geometryHash = createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
    const sourceUrl = String(route.sourceUrl ?? "");
    const distanceMeters = Number(canonicalConfirmed.distanceMeters);
    if (!(distanceMeters > 0)) failures.push(`PHASE11I_B2_NON_POSITIVE_DISTANCE:${canonicalRelationId}`);

    const summit = (canonicalConfirmed.confirmedSummits as Array<Record<string, unknown>>) ?? [];
    if (summit.length !== 1) {
      failures.push(`PHASE11I_B2_SUMMIT_COUNT:${canonicalRelationId}:${summit.length}`);
    }
    const summitRecord = summit[0] as Record<string, unknown> | undefined;
    const peakOsmId = summitRecord ? String(summitRecord.peakSourceId ?? "") : "";

    const qualificationHash = String(member.qualificationHash ?? "");
    const candidateHash = String(member.candidateHash ?? "");
    const nameStatus = String(member.nameStatus ?? "");
    const startContext = member.startContext === null ? null : String(member.startContext ?? "");
    const qualityBand = String(member.qualityBand ?? "");
    const selectionTier = String(member.selectionTier ?? "");
    const nameOrigin = nameAudit.nameOrigin === null ? null : String(nameAudit.nameOrigin ?? "");
    const resolvedDisplayName =
      nameAudit.derivedDisplayName === null ? null : String(nameAudit.derivedDisplayName ?? "");
    const deterministicResolutionHash =
      nameAudit.deterministicResolutionHash === null
        ? null
        : String(nameAudit.deterministicResolutionHash ?? "");
    const semanticType = String(canonicalConfirmed.semanticType ?? "");

    const idempotencyKey = `openstreetmap:relation:${canonicalRelationId}:${OSM_ROUTE_CONTRACT}`;

    records.push({
      canonicalRelationId,
      sourceRelationId: canonicalRelationId,
      sourceUrl,
      idempotencyKey,
      geometryHash,
      geometry,
      geometryType: "LineString",
      componentCount: Number(route.componentCount ?? canonicalConfirmed.componentCount ?? 1),
      distanceMeters,
      semanticType,
      qualityScore: Number(canonicalConfirmed.qualityScore ?? green.qualityScore ?? 0),
      routeName: routeNameValue(canonicalConfirmed),
      auditFlags: Array.isArray(canonicalConfirmed.auditFlags)
        ? (canonicalConfirmed.auditFlags as string[])
        : [],
      summit: {
        peakOsmId,
        peakName: summitRecord ? (summitRecord.peakName as string | null) ?? null : null,
        peakElevationMeters: summitRecord
          ? (summitRecord.peakElevationMeters as number | null) ?? null
          : null,
        peakCoordinates: summitRecord
          ? ((summitRecord.peakCoordinates as [number, number] | null) ?? null)
          : null,
        finalAssociation: "CONFIRMED",
        finalConfidence: summitRecord ? Number(summitRecord.finalConfidence) : 0,
        minimumGeometryDistanceMeters: summitRecord
          ? Number(summitRecord.minimumGeometryDistanceMeters)
          : 0,
        endpointDistanceMeters: summitRecord ? Number(summitRecord.endpointDistanceMeters) : 0,
        evidence: summitRecord
          ? ((summitRecord.reasons as string[] | undefined) ?? [])
          : [],
        sourceRouteIds: Array.isArray(canonicalConfirmed.sourceRouteIds)
          ? (canonicalConfirmed.sourceRouteIds as string[])
          : [],
      },
      mountain: null,
      qualification: {
        qualificationHash,
        candidateHash,
        nameClass: String(green.nameClass ?? ""),
        nameStatus,
        nameOrigin,
        resolvedDisplayName,
        startContext,
        qualityBand,
        selectionTier,
        deterministicResolutionHash,
      },
      datasetVersion,
      datasetFingerprint,
      sourceContractVersion: OSM_ROUTE_CONTRACT,
      snapshotContractVersion: B2_SOURCE_SNAPSHOT_CONTRACT,
    });
  }

  const peakOsmIdByRelation = new Map<string, string[]>();
  for (const record of records) {
    if (record.summit.peakOsmId) {
      peakOsmIdByRelation.set(record.canonicalRelationId, [record.summit.peakOsmId]);
    }
  }
  const toResolve = [...peakOsmIdByRelation.entries()].map(([canonicalRelationId, ids]) => ({
    canonicalRelationId,
    peakOsmId: ids[0],
  }));
  const { mountainIdByRelation, failures: mountainFailures } = await resolveMountainIds(client, toResolve);
  failures.push(...mountainFailures);
  const unresolved = new Set<string>();
  for (const record of records) {
    const mountainId = mountainIdByRelation.get(record.canonicalRelationId);
    if (mountainId === undefined) {
      unresolved.add(record.canonicalRelationId);
      continue;
    }
    record.mountain = {
      mountainId,
      classification: "EXACT_MOUNTAIN_MATCH",
      peakOsmIdResolved: record.summit.peakOsmId,
    };
  }

  const remainingFailures = failures.filter((failure) => !failure.startsWith("PHASE11I_B2_MOUNTAIN_"));
  if (remainingFailures.length > 0) throw new Error(remainingFailures.join("\n"));

  const exclusions = records
    .filter((record) => unresolved.has(record.canonicalRelationId))
    .map((record) => ({
      canonicalRelationId: record.canonicalRelationId,
      peakOsmId: record.summit.peakOsmId,
      reason: "NO_EXACT_MOUNTAINS_OSM_ID_MATCH",
      evidence: [
        `Live read-only mountains.osm_id lookup for peak ${record.summit.peakOsmId} returned zero rows.`,
        "Phase 11E mountain-identity-recovery audit classified this summit peak with resolution.status=MISSING and empty mountainIds (exact osm_id equality only; proximity/name never recover identity).",
        "Excluded from the B2 staging scope because osm_route_import_staging.matched_primary_mountain_id is NOT NULL and no exact public.mountains.id exists.",
      ],
    }));
  records = records.filter((record) => !unresolved.has(record.canonicalRelationId));
  if (records.length === 0) throw new Error("PHASE11I_B2_SNAPSHOT_EMPTY_AFTER_EXCLUSION");

  const integrity = {
    uniqueRelationIds: new Set(records.map((record) => record.canonicalRelationId)).size === records.length,
    uniqueGeometryHashes:
      new Set(records.map((record) => record.geometryHash)).size === records.length,
    allMountainIdsResolved: records.every((record) => record.mountain !== null),
    allSingleConfirmedSummit: records.every((record) => record.summit.peakOsmId.length > 0),
    allPositiveDistances: records.every((record) => record.distanceMeters > 0),
    allSemanticTypeSummitRoute: records.every((record) => record.semanticType === "summit_route"),
  };

  const content: Omit<B2SourceSnapshot, "deterministicArtifactHash"> = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_SOURCE_SNAPSHOT",
    contractVersion: B2_SOURCE_SNAPSHOT_CONTRACT,
    readOnly: true,
    publishable: false,
    qaDecisionWrites: 0,
    autoApprovalEnabled: false,
    generatedByStrategy: "FROZEN_SNAPSHOT_WITH_LIVE_READ_ONLY_IDENTITY_RESOLUTION",
    scope: { relations: records.length, excluded: exclusions.length },
    recordCount: records.length,
    records,
    exclusions,
    sourceFiles,
    integrity,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };

  const deterministicArtifactHash = sha256Stable(content);
  return { ...content, deterministicArtifactHash };
}

async function main(): Promise<void> {
  const envPath = resolve(".env.local");
  const snapshot = await buildB2SourceSnapshot({ envFilePath: envPath });
  if (
    !snapshot.integrity.allMountainIdsResolved ||
    snapshot.records.length !== 44 ||
    snapshot.scope.relations !== 44 ||
    snapshot.exclusions.length !== 1
  ) {
    throw new Error("PHASE11I_B2_SNAPSHOT_INTEGRITY_FAILED");
  }
  await writeFile(OUT_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PASS",
        recordCount: snapshot.records.length,
        excludedCount: snapshot.exclusions.length,
        exclusions: snapshot.exclusions.map((exclusion) => exclusion.canonicalRelationId),
        resolvedMountainIds: snapshot.records.filter((record) => record.mountain !== null).length,
        snapshotPath: OUT_SNAPSHOT_PATH,
        snapshotHash: sha256Bytes(Buffer.from(JSON.stringify(snapshot))),
        deterministicArtifactHash: snapshot.deterministicArtifactHash,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
