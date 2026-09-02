import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { sha256Stable } from "./phase11-publication.ts";
import type { B2SnapshotRecord } from "./generate-phase11i-b2-source-snapshot.ts";

const STAGING = "data/osm/alps/staging";
const SNAPSHOT_PATH = `${STAGING}/phase11i-b2-human-calibration-source-snapshot.json`;
const STAGEABILITY_PATH = `${STAGING}/phase11i-b2-human-calibration-stageability.json`;
const OUT_PAYLOAD_PATH = `${STAGING}/phase11i-b2-human-calibration-staging-payloads.json`;

export const PAYLOAD_CONTRACT = "mountain-tracker-phase11i-b2-staging-payloads/v1" as const;

export interface RoutePayload {
  contract_version: string;
  idempotency_key: string;
  provider: "openstreetmap";
  source_relation_id: string;
  canonical_source_id: string;
  dataset_version: string;
  payload_hash: string;
  route_name: string | null;
  semantic_type: string;
  quality_score: number;
  geometry_geojson: { type: "LineString"; coordinates: Array<[number, number]> };
  distance_meters: number;
  matched_primary_mountain_id: number;
  audit_flags: string[];
  import_eligibility: "AUTO_IMPORT_READY";
  payload: Record<string, unknown>;
}

export interface SummitPayload {
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: "EXACT_MOUNTAIN_MATCH";
  final_association: "CONFIRMED";
  final_confidence: number;
  minimum_geometry_distance_meters: number;
  endpoint_distance_meters: number;
  evidence: string[];
  payload: Record<string, unknown>;
}

export interface StagingPayloadRecord {
  canonicalRelationId: string;
  mainPayload: RoutePayload;
  mainPayloadHash: string;
  summitPayloads: SummitPayload[];
  summitPayloadHash: string;
  combinedPayloadHash: string;
}

export interface B2StagingPayloadArtifact {
  schemaVersion: number;
  artifactType: "PHASE11I_B2_STAGING_PAYLOADS";
  contractVersion: typeof PAYLOAD_CONTRACT;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  sourceSnapshotHash: string;
  stageabilityHash: string;
  mainPayloadCount: number;
  summitPayloadCount: number;
  records: StagingPayloadRecord[];
  integrity: {
    uniqueRelationIds: boolean;
    allMountainIdsPresent: boolean;
    allPayloadHashesValid: boolean;
    allIdempotencyKeysUnique: boolean;
  };
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface SourceSnapshot {
  records: B2SnapshotRecord[];
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
  deterministicArtifactHash: string;
}

interface StageabilityArtifact {
  records: Array<{
    canonicalRelationId: string;
    stagingEligible: boolean;
  }>;
  deterministicArtifactHash: string;
}

function buildRoutePayload(record: B2SnapshotRecord): RoutePayload {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({
      source_relation_id: record.sourceRelationId,
      canonical_source_id: record.canonicalRelationId,
      semantic_type: record.semanticType,
      quality_score: record.qualityScore,
      distance_meters: record.distanceMeters,
      geometry_hash: record.geometryHash,
    }))
    .digest("hex");

  return {
    contract_version: record.sourceContractVersion,
    idempotency_key: record.idempotencyKey,
    provider: "openstreetmap",
    source_relation_id: record.sourceRelationId,
    canonical_source_id: record.canonicalRelationId,
    dataset_version: record.datasetVersion,
    payload_hash: payloadHash,
    route_name: record.routeName,
    semantic_type: record.semanticType,
    quality_score: record.qualityScore,
    geometry_geojson: record.geometry,
    distance_meters: record.distanceMeters,
    matched_primary_mountain_id: record.mountain!.mountainId,
    audit_flags: record.auditFlags,
    import_eligibility: "AUTO_IMPORT_READY",
    payload: {
      source_contract_version: record.sourceContractVersion,
      snapshot_contract_version: record.snapshotContractVersion,
      dataset_fingerprint: record.datasetFingerprint,
      geometry_hash: record.geometryHash,
      component_count: record.componentCount,
      qualification_hash: record.qualification.qualificationHash,
      candidate_hash: record.qualification.candidateHash,
      name_class: record.qualification.nameClass,
      name_status: record.qualification.nameStatus,
      name_origin: record.qualification.nameOrigin,
      resolved_display_name: record.qualification.resolvedDisplayName,
      start_context: record.qualification.startContext,
      quality_band: record.qualification.qualityBand,
      selection_tier: record.qualification.selectionTier,
    },
  };
}

function buildSummitPayload(record: B2SnapshotRecord): SummitPayload {
  const summit = record.summit;
  return {
    peak_osm_id: summit.peakOsmId,
    mountain_id: record.mountain!.mountainId,
    mountain_match_classification: "EXACT_MOUNTAIN_MATCH",
    final_association: "CONFIRMED",
    final_confidence: summit.finalConfidence,
    minimum_geometry_distance_meters: summit.minimumGeometryDistanceMeters,
    endpoint_distance_meters: summit.endpointDistanceMeters,
    evidence: summit.evidence,
    payload: {
      peak_name: summit.peakName,
      peak_elevation_meters: summit.peakElevationMeters,
      peak_coordinates: summit.peakCoordinates,
      source_route_ids: summit.sourceRouteIds,
    },
  };
}

export async function buildStagingPayloads(): Promise<B2StagingPayloadArtifact> {
  const [snapshotRaw, stageabilityRaw] = await Promise.all([
    readFile(SNAPSHOT_PATH, "utf8"),
    readFile(STAGEABILITY_PATH, "utf8"),
  ]);

  const snapshot = JSON.parse(snapshotRaw) as SourceSnapshot;
  const stageability = JSON.parse(stageabilityRaw) as StageabilityArtifact;

  const eligibleIds = new Set(
    stageability.records.filter((r) => r.stagingEligible).map((r) => r.canonicalRelationId),
  );

  const records: StagingPayloadRecord[] = [];
  let summitPayloadCount = 0;

  for (const record of snapshot.records) {
    if (!eligibleIds.has(record.canonicalRelationId)) continue;
    if (!record.mountain) continue;

    const mainPayload = buildRoutePayload(record);
    const mainPayloadHash = createHash("sha256").update(JSON.stringify(mainPayload)).digest("hex");

    const summitPayload = buildSummitPayload(record);
    const summitPayloadHash = createHash("sha256").update(JSON.stringify(summitPayload)).digest("hex");
    summitPayloadCount += 1;

    const combinedPayloadHash = createHash("sha256")
      .update(JSON.stringify({ route: mainPayload, summits: [summitPayload] }))
      .digest("hex");

    records.push({
      canonicalRelationId: record.canonicalRelationId,
      mainPayload,
      mainPayloadHash,
      summitPayloads: [summitPayload],
      summitPayloadHash,
      combinedPayloadHash,
    });
  }

  const idempotencyKeys = records.map((r) => r.mainPayload.idempotency_key);

  const integrity = {
    uniqueRelationIds: new Set(records.map((r) => r.canonicalRelationId)).size === records.length,
    allMountainIdsPresent: records.every((r) => r.mainPayload.matched_primary_mountain_id > 0),
    allPayloadHashesValid: records.every((r) => {
      const recomputed = createHash("sha256").update(JSON.stringify(r.mainPayload)).digest("hex");
      return recomputed === r.mainPayloadHash;
    }),
    allIdempotencyKeysUnique: new Set(idempotencyKeys).size === idempotencyKeys.length,
  };

  const content: Omit<B2StagingPayloadArtifact, "deterministicArtifactHash"> = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_STAGING_PAYLOADS",
    contractVersion: PAYLOAD_CONTRACT,
    readOnly: true,
    publishable: false,
    qaDecisionWrites: 0,
    autoApprovalEnabled: false,
    sourceSnapshotHash: snapshot.deterministicArtifactHash,
    stageabilityHash: stageability.deterministicArtifactHash,
    mainPayloadCount: records.length,
    summitPayloadCount,
    records,
    integrity,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };

  const deterministicArtifactHash = sha256Stable(content);
  return { ...content, deterministicArtifactHash };
}

async function main(): Promise<void> {
  const artifact = await buildStagingPayloads();

  if (artifact.mainPayloadCount !== 44 || artifact.summitPayloadCount !== 44) {
    throw new Error("PHASE11I_B2_PAYLOAD_COUNT_UNEXPECTED");
  }
  if (!artifact.integrity.uniqueRelationIds || !artifact.integrity.allMountainIdsPresent) {
    throw new Error("PHASE11I_B2_PAYLOAD_INTEGRITY_FAILED");
  }

  await writeFile(OUT_PAYLOAD_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const fileHash = sha256Bytes(Buffer.from(JSON.stringify(artifact)));
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PASS",
        mainPayloadCount: artifact.mainPayloadCount,
        summitPayloadCount: artifact.summitPayloadCount,
        payloadPath: OUT_PAYLOAD_PATH,
        payloadHash: fileHash,
        deterministicArtifactHash: artifact.deterministicArtifactHash,
        integrity: artifact.integrity,
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
