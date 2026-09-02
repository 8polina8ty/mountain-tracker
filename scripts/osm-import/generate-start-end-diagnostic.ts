import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { createClient } from "@supabase/supabase-js";

import type {
  PreviewManifest,
  PreviewMetadataDocument,
  PreviewRouteGeometry,
} from "../../Lib/osmStagingPreview/core.ts";
import type { BulkRouteRecord } from "./bulk-route-reconstruction.ts";
import type { Coordinate, RouteGeometry } from "./peak-matcher.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";
import {
  buildStartEndDiagnosticArtifact,
  type StartEndDiagnosticRouteInput,
} from "./start-end-diagnostic.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const OUTPUT_PATH = resolve(STAGING_DIRECTORY, "start-end-diagnostic.json");
const ROUTES_PATH = resolve("data/osm/alps/routes.jsonl");
const OBJECT_STORE_PATH = resolve(
  "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite",
);
const TARGET_STAGING_ROUTE_ID = "e7e6f65e-ac60-4e6d-8eaa-ea5105e8ddb0";

interface LiveRouteRow {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  sourceRelationId: string;
  canonicalSourceId: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  distanceMeters: number;
  matchedPrimaryMountainId: number;
  geometry: RouteGeometry;
}

interface MountainRow {
  id: number;
  name: string | null;
  coordinate: Coordinate;
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

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

function asGeometry(value: unknown): RouteGeometry {
  const geometry = value as PreviewRouteGeometry;
  if (geometry?.type !== "LineString" && geometry?.type !== "MultiLineString") {
    throw new Error("Staging row contains an unsupported route geometry.");
  }
  return geometry as RouteGeometry;
}

function mapRoute(value: Record<string, unknown>): LiveRouteRow {
  if (value.matched_primary_mountain_id === null) {
    throw new Error(`Staging route ${String(value.id)} has no matched mountain.`);
  }
  return {
    id: String(value.id),
    idempotencyKey: String(value.idempotency_key),
    payloadHash: String(value.payload_hash),
    sourceRelationId: String(value.source_relation_id),
    canonicalSourceId: String(value.canonical_source_id),
    routeName: value.route_name === null ? null : String(value.route_name),
    semanticType: String(value.semantic_type),
    qualityScore: Number(value.quality_score),
    distanceMeters: Number(value.distance_meters),
    matchedPrimaryMountainId: Number(value.matched_primary_mountain_id),
    geometry: asGeometry(value.geometry_geojson),
  };
}

function mapMountain(value: Record<string, unknown>): MountainRow {
  return {
    id: Number(value.id),
    name:
      value.name === null
        ? value.name_de === null
          ? null
          : String(value.name_de)
        : String(value.name),
    coordinate: [Number(value.longitude), Number(value.latitude)],
  };
}

async function loadReconstructedRoutes(
  sourceIds: Set<string>,
): Promise<Map<string, BulkRouteRecord>> {
  const routes = new Map<string, BulkRouteRecord>();
  const input = createReadStream(ROUTES_PATH, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const route = JSON.parse(line) as BulkRouteRecord;
    if (sourceIds.has(route.sourceId)) routes.set(route.sourceId, route);
  }
  if (routes.size !== sourceIds.size) {
    throw new Error(
      `Reconstruction evidence mismatch: expected ${sourceIds.size}, found ${routes.size}.`,
    );
  }
  return routes;
}

function targetOrderingEvidence(reconstructedRoute: BulkRouteRecord) {
  const ReadOnlyDatabase = DatabaseSync as unknown as new (
    path: string,
    options: { readOnly: boolean },
  ) => DatabaseSync;
  const database = new ReadOnlyDatabase(OBJECT_STORE_PATH, { readOnly: true });
  try {
    const relationRow = database
      .prepare("SELECT payload FROM relations WHERE id = ?")
      .get(Number(reconstructedRoute.sourceId)) as { payload: string } | undefined;
    if (!relationRow) throw new Error("Target OSM relation is absent from the object store.");
    const relation = JSON.parse(relationRow.payload) as {
      members: Array<{ type: string; ref: number; role: string }>;
    };
    const wayMembers = relation.members.filter((member) => member.type === "way");
    const ways = wayMembers.map((member) => {
      const row = database
        .prepare("SELECT payload FROM ways WHERE id = ?")
        .get(member.ref) as { payload: string } | undefined;
      if (!row) throw new Error(`Target OSM way ${member.ref} is absent from the object store.`);
      const way = JSON.parse(row.payload) as {
        id: number;
        nodes: Array<{ nodeId: number; coordinate: Coordinate }>;
      };
      return {
        wayId: way.id,
        pointCount: way.nodes.length,
        startNodeId: way.nodes[0].nodeId,
        startCoordinate: way.nodes[0].coordinate,
        endNodeId: way.nodes.at(-1)!.nodeId,
        endCoordinate: way.nodes.at(-1)!.coordinate,
      };
    });
    const reconstructedComponents =
      reconstructedRoute.geometry.type === "LineString"
        ? [reconstructedRoute.geometry.coordinates]
        : reconstructedRoute.geometry.coordinates;
    const relationMemberOrderPreserved = ways.every((way, index) => {
      const component = reconstructedComponents[index];
      return (
        component &&
        JSON.stringify(component[0]) === JSON.stringify(way.startCoordinate) &&
        JSON.stringify(component.at(-1)) === JSON.stringify(way.endCoordinate)
      );
    });
    return {
      relationMemberWayIds: wayMembers.map((member) => member.ref),
      relationMemberRoles: wayMembers.map((member) => member.role),
      ways,
      reconstructionDisconnectedFlag: reconstructedRoute.flags.disconnected,
      relationMemberOrderPreserved,
      orderingChangedAfterReconstruction: !relationMemberOrderPreserved,
    };
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Read-only diagnostic requires Supabase credentials.");
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
  if (manifest.recordCount !== 46 || metadata.recordCount !== 46) {
    throw new Error("The exact Phase 8B 46-route manifest is required.");
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const routeResult = await client
    .from("osm_route_import_staging")
    .select("id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,route_name,semantic_type,quality_score,distance_meters,matched_primary_mountain_id,geometry_geojson")
    .in("idempotency_key", manifest.records.map((record) => record.idempotencyKey));
  if (routeResult.error) throw new Error(`Staging read failed: ${routeResult.error.message}`);
  const liveRoutes = ((routeResult.data ?? []) as Array<Record<string, unknown>>).map(mapRoute);
  if (liveRoutes.length !== manifest.recordCount) {
    throw new Error(`Expected ${manifest.recordCount} live routes, found ${liveRoutes.length}.`);
  }
  const mountainResult = await client
    .from("mountains")
    .select("id,name,name_de,latitude,longitude")
    .in("id", liveRoutes.map((route) => route.matchedPrimaryMountainId));
  if (mountainResult.error) throw new Error(`Mountain read failed: ${mountainResult.error.message}`);
  const mountains = new Map(
    ((mountainResult.data ?? []) as Array<Record<string, unknown>>)
      .map(mapMountain)
      .map((mountain) => [mountain.id, mountain]),
  );

  const planByKey = new Map(plan.records.map((record) => [record.idempotencyKey, record]));
  const metadataByKey = new Map(metadata.records.map((record) => [record.idempotencyKey, record]));
  const manifestByKey = new Map(manifest.records.map((record) => [record.idempotencyKey, record]));
  const reconstructedRoutes = await loadReconstructedRoutes(
    new Set(manifest.records.map((record) => record.sourceRelationId)),
  );
  const diagnosticInputs: StartEndDiagnosticRouteInput[] = liveRoutes.map((liveRoute) => {
    const manifestRecord = manifestByKey.get(liveRoute.idempotencyKey);
    const planRecord = planByKey.get(liveRoute.idempotencyKey);
    const metadataRecord = metadataByKey.get(liveRoute.idempotencyKey);
    const reconstructedRoute = reconstructedRoutes.get(liveRoute.sourceRelationId);
    const mountain = mountains.get(liveRoute.matchedPrimaryMountainId);
    if (!manifestRecord || !planRecord || !metadataRecord || !reconstructedRoute || !mountain) {
      throw new Error(`Incomplete diagnostic evidence for ${liveRoute.idempotencyKey}.`);
    }
    return {
      stagingRouteId: liveRoute.id,
      sourceRelationId: liveRoute.sourceRelationId,
      canonicalSourceId: liveRoute.canonicalSourceId,
      routeName: liveRoute.routeName,
      semanticType: liveRoute.semanticType,
      qualityScore: liveRoute.qualityScore,
      distanceMeters: liveRoute.distanceMeters,
      geometry: liveRoute.geometry,
      warnings: metadataRecord.warnings,
      summit: {
        peakOsmId: metadataRecord.summit.peakOsmId,
        name: metadataRecord.summit.peakName,
        coordinate: metadataRecord.summit.peakCoordinates as Coordinate,
      },
      mountain: {
        id: mountain.id,
        name: mountain.name,
        coordinate: mountain.coordinate,
      },
      payloadHashMatchesManifest: liveRoute.payloadHash === manifestRecord.payloadHash,
      geometryMatchesLocalPlan:
        JSON.stringify(liveRoute.geometry) ===
        JSON.stringify(planRecord.contract.route.geometry),
      geometryMatchesReconstruction:
        JSON.stringify(liveRoute.geometry) === JSON.stringify(reconstructedRoute.geometry),
      orderingEvidence:
        liveRoute.id === TARGET_STAGING_ROUTE_ID
          ? targetOrderingEvidence(reconstructedRoute)
          : undefined,
    };
  });
  if (diagnosticInputs.some((route) => !route.payloadHashMatchesManifest)) {
    throw new Error("At least one live payload hash differs from the exact manifest.");
  }
  const target = diagnosticInputs.find(
    (route) => route.stagingRouteId === TARGET_STAGING_ROUTE_ID,
  );
  if (!target) throw new Error("The requested staging UUID is not in the 46-route manifest.");

  const artifact = buildStartEndDiagnosticArtifact({
    manifestDatasetFingerprint: manifest.datasetFingerprint,
    manifestRecordCount: manifest.recordCount,
    routes: diagnosticInputs,
  });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeAtomically(OUTPUT_PATH, serialized);
  const targetResult = artifact.routes.find(
    (route) => route.stagingRouteId === TARGET_STAGING_ROUTE_ID,
  );
  process.stdout.write(
    `${JSON.stringify({
      outputPath: OUTPUT_PATH,
      bytes: Buffer.byteLength(serialized, "utf8"),
      manifestRecordCount: artifact.manifestRecordCount,
      databaseWrites: artifact.databaseWrites,
      summary: artifact.summary,
      target: targetResult,
    }, null, 2)}\n`,
  );
}

await main();
