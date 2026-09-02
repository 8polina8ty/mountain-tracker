import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { createOSMStream } from "osm-pbf-parser-node";

import { stableJson } from "./phase10-publication-gate.ts";
import type {
  Coordinate,
  RoadSafetySourceDatasetIdentity,
  RoadSafetyWay,
} from "./phase11c9-road-safety.ts";

const MOTORWAY_TAG_KEYS = [
  "highway",
  "access",
  "access:conditional",
  "foot",
  "foot:conditional",
  "bridge",
  "tunnel",
  "layer",
] as const;

type ParsedPbfNode = {
  type: "node";
  id: number;
  lon: number;
  lat: number;
};

type ParsedPbfWay = {
  type: "way";
  id: number;
  refs: number[];
  tags?: Record<string, string>;
};

type PendingMotorway = {
  id: number;
  highway: "motorway" | "motorway_link";
  tags: Record<string, string>;
  refs: number[];
};

export interface MotorwayIndexMetadata {
  sourcePbfPath: string;
  sourcePbfSizeBytes: number;
  sourcePbfModifiedMilliseconds: number;
  sourcePbfSha256: string;
  motorwayWayCount: number;
  motorwayNodeCount: number;
  contentHash: string;
  complete: true;
}

function isNode(value: object): value is ParsedPbfNode {
  return "type" in value && value.type === "node" &&
    "id" in value && typeof value.id === "number" &&
    "lon" in value && typeof value.lon === "number" &&
    "lat" in value && typeof value.lat === "number";
}

function isWay(value: object): value is ParsedPbfWay {
  return "type" in value && value.type === "way" &&
    "id" in value && typeof value.id === "number" &&
    "refs" in value && Array.isArray(value.refs);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readMetadata(database: DatabaseSync): MotorwayIndexMetadata | null {
  try {
    const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all();
    const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    if (values.complete !== "true") return null;
    return {
      sourcePbfPath: values.sourcePbfPath,
      sourcePbfSizeBytes: Number(values.sourcePbfSizeBytes),
      sourcePbfModifiedMilliseconds: Number(values.sourcePbfModifiedMilliseconds),
      sourcePbfSha256: values.sourcePbfSha256,
      motorwayWayCount: Number(values.motorwayWayCount),
      motorwayNodeCount: Number(values.motorwayNodeCount),
      contentHash: values.contentHash,
      complete: true,
    };
  } catch {
    return null;
  }
}

function assertReusableIndex(
  metadata: MotorwayIndexMetadata,
  expected: Pick<MotorwayIndexMetadata,
    "sourcePbfPath" | "sourcePbfSizeBytes" | "sourcePbfModifiedMilliseconds">,
): void {
  if (
    metadata.sourcePbfPath !== expected.sourcePbfPath ||
    metadata.sourcePbfSizeBytes !== expected.sourcePbfSizeBytes ||
    metadata.sourcePbfModifiedMilliseconds !== expected.sourcePbfModifiedMilliseconds
  ) {
    throw new Error("PHASE11C9_MOTORWAY_INDEX_SOURCE_DRIFT");
  }
}

export async function buildOrVerifyMotorwayIndex(input: {
  pbfPath: string;
  indexPath: string;
  onProgress?: (message: string) => void;
}): Promise<MotorwayIndexMetadata> {
  const sourceStat = await stat(input.pbfPath);
  const expectedSource = {
    sourcePbfPath: input.pbfPath,
    sourcePbfSizeBytes: sourceStat.size,
    sourcePbfModifiedMilliseconds: sourceStat.mtimeMs,
  };
  if (await exists(input.indexPath)) {
    const existing = new DatabaseSync(input.indexPath);
    try {
      const metadata = readMetadata(existing);
      if (!metadata) throw new Error("PHASE11C9_MOTORWAY_INDEX_INCOMPLETE");
      assertReusableIndex(metadata, expectedSource);
      input.onProgress?.(
        `Reusing complete motorway index (${metadata.motorwayWayCount} ways).`,
      );
      return metadata;
    } finally {
      existing.close();
    }
  }

  const pending: PendingMotorway[] = [];
  const requiredNodeIds = new Set<number>();
  let firstPassObjects = 0;
  input.onProgress?.("PBF pass 1/2: collecting motorway and motorway_link ways.");
  for await (const value of createOSMStream(input.pbfPath, {
    withTags: { node: false, way: [...MOTORWAY_TAG_KEYS], relation: false },
    withInfo: false,
  })) {
    firstPassObjects += 1;
    if (firstPassObjects % 5_000_000 === 0) {
      input.onProgress?.(
        `PBF pass 1/2: ${firstPassObjects} objects, ${pending.length} motorway ways.`,
      );
    }
    if (!value || typeof value !== "object" || !isWay(value)) continue;
    const highway = value.tags?.highway;
    if (highway !== "motorway" && highway !== "motorway_link") continue;
    const refs = value.refs.map(Number);
    pending.push({
      id: value.id,
      highway,
      tags: value.tags ?? { highway },
      refs,
    });
    refs.forEach((nodeId) => requiredNodeIds.add(nodeId));
  }
  pending.sort((left, right) => left.id - right.id);

  const coordinates = new Map<number, Coordinate>();
  let secondPassObjects = 0;
  input.onProgress?.(
    `PBF pass 2/2: resolving ${requiredNodeIds.size} motorway node coordinates.`,
  );
  for await (const value of createOSMStream(input.pbfPath, {
    withTags: false,
    withInfo: false,
  })) {
    secondPassObjects += 1;
    if (secondPassObjects % 5_000_000 === 0) {
      input.onProgress?.(
        `PBF pass 2/2: ${secondPassObjects} objects, ${coordinates.size}/${requiredNodeIds.size} coordinates.`,
      );
    }
    if (!value || typeof value !== "object" || !isNode(value)) continue;
    if (requiredNodeIds.has(value.id)) coordinates.set(value.id, [value.lon, value.lat]);
  }
  if (coordinates.size !== requiredNodeIds.size) {
    throw new Error(
      `PHASE11C9_MOTORWAY_NODE_LOCATIONS_MISSING:${requiredNodeIds.size - coordinates.size}`,
    );
  }

  const database = new DatabaseSync(input.indexPath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE motorway_ways (
        id INTEGER PRIMARY KEY,
        highway TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        nodes_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE motorway_way_bounds USING rtree(
        id, minimum_longitude, maximum_longitude, minimum_latitude, maximum_latitude
      );
    `);
    const putWay = database.prepare(
      "INSERT INTO motorway_ways (id, highway, tags_json, nodes_json) VALUES (?, ?, ?, ?)",
    );
    const putBounds = database.prepare(
      "INSERT INTO motorway_way_bounds (id, minimum_longitude, maximum_longitude, minimum_latitude, maximum_latitude) VALUES (?, ?, ?, ?, ?)",
    );
    const contentHash = createHash("sha256");
    database.exec("BEGIN");
    try {
      for (const way of pending) {
        const nodes = way.refs.map((nodeId) => ({
          nodeId,
          coordinate: coordinates.get(nodeId)!,
        }));
        const longitudes = nodes.map((node) => node.coordinate[0]);
        const latitudes = nodes.map((node) => node.coordinate[1]);
        const content = { id: way.id, highway: way.highway, tags: way.tags, nodes };
        contentHash.update(`${stableJson(content)}\n`);
        putWay.run(way.id, way.highway, stableJson(way.tags), stableJson(nodes));
        putBounds.run(
          way.id,
          Math.min(...longitudes),
          Math.max(...longitudes),
          Math.min(...latitudes),
          Math.max(...latitudes),
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    input.onProgress?.("Hashing the frozen PBF source.");
    const sourcePbfSha256 = await fileSha256(input.pbfPath);
    const metadata: MotorwayIndexMetadata = {
      ...expectedSource,
      sourcePbfSha256,
      motorwayWayCount: pending.length,
      motorwayNodeCount: requiredNodeIds.size,
      contentHash: contentHash.digest("hex"),
      complete: true,
    };
    const putMetadata = database.prepare(
      "INSERT INTO metadata (key, value) VALUES (?, ?)",
    );
    database.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(metadata)) {
        putMetadata.run(key, String(value));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    input.onProgress?.(
      `Motorway index complete (${metadata.motorwayWayCount} ways, ${metadata.motorwayNodeCount} nodes).`,
    );
    return metadata;
  } finally {
    database.close();
  }
}

export class MotorwaySpatialIndex {
  private readonly database: DatabaseSync;
  private readonly query;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    const metadata = readMetadata(this.database);
    if (!metadata) throw new Error("PHASE11C9_MOTORWAY_INDEX_INCOMPLETE");
    this.query = this.database.prepare(`
      SELECT ways.id, ways.tags_json, ways.nodes_json
      FROM motorway_way_bounds bounds
      JOIN motorway_ways ways ON ways.id = bounds.id
      WHERE bounds.minimum_longitude <= ?
        AND bounds.maximum_longitude >= ?
        AND bounds.minimum_latitude <= ?
        AND bounds.maximum_latitude >= ?
      ORDER BY ways.id
    `);
  }

  queryBounds(bounds: {
    minimumLongitude: number;
    maximumLongitude: number;
    minimumLatitude: number;
    maximumLatitude: number;
  }): RoadSafetyWay[] {
    return this.query.all(
      bounds.maximumLongitude,
      bounds.minimumLongitude,
      bounds.maximumLatitude,
      bounds.minimumLatitude,
    ).map((row) => ({
      id: Number(row.id),
      tags: JSON.parse(String(row.tags_json)) as Record<string, string>,
      nodes: JSON.parse(String(row.nodes_json)) as RoadSafetyWay["nodes"],
    }));
  }

  close(): void {
    this.database.close();
  }
}

export async function createRoadSafetySourceDatasetIdentity(input: {
  pbfPath: string;
  checkpointPath: string;
  checkpointManifestPath: string;
  pipelineSummaryPath: string;
  pipelineDatasetFingerprint: string;
  motorwayIndexMetadata: MotorwayIndexMetadata;
}): Promise<RoadSafetySourceDatasetIdentity> {
  const [checkpointManifest, summary] = await Promise.all([
    readFile(input.checkpointManifestPath),
    readFile(input.pipelineSummaryPath, "utf8").then((value) => JSON.parse(value) as {
      generatedAt: string;
    }),
  ]);
  return {
    pbfPath: input.pbfPath,
    pbfSizeBytes: input.motorwayIndexMetadata.sourcePbfSizeBytes,
    pbfModifiedMilliseconds:
      input.motorwayIndexMetadata.sourcePbfModifiedMilliseconds,
    pbfSha256: input.motorwayIndexMetadata.sourcePbfSha256,
    pipelineDatasetFingerprint: input.pipelineDatasetFingerprint,
    pipelineGeneratedAt: summary.generatedAt,
    checkpointPath: input.checkpointPath,
    checkpointManifestSha256: createHash("sha256")
      .update(checkpointManifest)
      .digest("hex"),
    motorwayIndexContentHash: input.motorwayIndexMetadata.contentHash,
  };
}
