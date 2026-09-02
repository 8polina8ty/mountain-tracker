import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { BulkCheckpoint, fingerprintInput } from "./bulk-checkpoint.ts";
import {
  OSM_ATTRIBUTION,
  OSM_LICENSE,
  reconstructBulkRoute,
  type BulkObjectStore,
} from "./bulk-route-reconstruction.ts";
import {
  generatePeakCandidates,
  SpatialPeakIndex,
} from "./bulk-spatial-index.ts";
import { generateDedupCandidates } from "./dedup-candidates.ts";
import {
  combineJsonlChunks,
  readJsonLines,
  serializeJsonLine,
  writeJsonLines,
} from "./jsonl.ts";
import type {
  Coordinate,
  MatchablePeak,
  MatchableRoute,
  RouteGeometry,
} from "./peak-matcher.ts";
import type { OplRelation, OplWay } from "./opl-parser.ts";
import { parseOplLine } from "./opl-parser.ts";
import {
  compareRoutes,
  type ComparableRoute,
} from "./route-similarity.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;

function coordinateFromMeters(east: number, north: number): Coordinate {
  const latitude = 47;
  return [
    11 +
      (east /
        (EARTH_RADIUS_METERS * Math.cos((latitude * Math.PI) / 180))) *
        (180 / Math.PI),
    latitude + (north / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function line(start: number, end: number): RouteGeometry {
  return {
    type: "LineString",
    coordinates: [coordinateFromMeters(start, 0), coordinateFromMeters(end, 0)],
  };
}

function comparableRoute(
  sourceId: string,
  geometry: RouteGeometry,
): ComparableRoute {
  return {
    sourceId,
    name: `Route ${sourceId}`,
    geometry,
    summitEvidence: { confirmedPeakIds: [], associatedPeakIds: [] },
  };
}

function matchableRoute(geometry: RouteGeometry): MatchableRoute {
  const components =
    geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  return {
    sourceId: "route",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    name: "Route",
    ref: null,
    network: null,
    operator: null,
    geometry,
    stats: {
      distanceMeters: 1_000,
      coordinatePoints: components.flat().length,
      componentCount: components.length,
    },
    metadata: {
      route: "hiking",
      from: null,
      to: null,
      roundtrip: null,
      osmcSymbol: null,
    },
  };
}

function peak(sourceId: string, east: number, north: number): MatchablePeak {
  return {
    sourceId,
    sourceUrl: `https://www.openstreetmap.org/node/${sourceId}`,
    name: `Peak ${sourceId}`,
    coordinates: coordinateFromMeters(east, north),
    elevationMeters: 2_000,
  };
}

function objectStore(
  relations: OplRelation[],
  ways: OplWay[],
): BulkObjectStore {
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]));
  const waysById = new Map(ways.map((way) => [way.id, way]));
  return {
    getRelation: (id) => relationsById.get(id) ?? null,
    getWay: (id) => waysById.get(id) ?? null,
  };
}

test("spatial peak lookup supplies nearby candidates for precise matching", () => {
  const index = new SpatialPeakIndex([
    peak("near", 500, 20),
    peak("far", 500, 2_000),
  ]);
  const candidates = generatePeakCandidates(matchableRoute(line(0, 1_000)), index);

  assert.deepEqual(candidates.map((candidate) => candidate.sourceId), ["near"]);
});

test("spatial index excludes peaks outside the requested radius", () => {
  const origin = coordinateFromMeters(0, 0);
  const index = new SpatialPeakIndex([peak("inside", 490, 0), peak("outside", 510, 0)]);

  assert.deepEqual(
    index.queryRadius(origin, 500).map((candidate) => candidate.sourceId),
    ["inside"],
  );
});

test("dedup candidate filtering omits geographically separate routes", () => {
  const report = generateDedupCandidates([
    comparableRoute("a", line(0, 1_000)),
    comparableRoute("b", line(10, 1_010)),
    comparableRoute("c", line(20_000, 21_000)),
  ]);

  assert.equal(report.theoreticalPairs, 3);
  assert.deepEqual(
    report.candidatePairs.map((pair) => [pair.routeAId, pair.routeBId]),
    [["a", "b"]],
  );
  assert.ok(report.reductionPercentage > 60);
});

test("reversed duplicate reaches the dedup candidate stage", () => {
  const report = generateDedupCandidates([
    comparableRoute("forward", line(0, 1_000)),
    comparableRoute("reverse", line(1_000, 0)),
  ]);

  assert.equal(report.candidatePairs.length, 1);
  assert.ok(report.candidatePairs[0].endpointDistanceMeters < 1);
});

test("contained short and long routes are compared but not grouped as duplicates", () => {
  const longRoute = comparableRoute("long", line(0, 3_000));
  const shortRoute = comparableRoute("short", line(1_200, 1_800));
  const candidates = generateDedupCandidates([longRoute, shortRoute]);
  const comparison = compareRoutes(longRoute, shortRoute);

  assert.equal(candidates.candidatePairs.length, 1);
  assert.notEqual(comparison.classification, "EXACT_DUPLICATE");
  assert.notEqual(comparison.classification, "NEAR_DUPLICATE");
});

test("chunk output and completed checkpoint survive restart", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-checkpoint-"));
  try {
    const inputPath = resolve(directory, "input.osm.pbf");
    const firstChunk = resolve(directory, "000-routes.jsonl");
    const secondChunk = resolve(directory, "001-routes.jsonl");
    const combined = resolve(directory, "routes.jsonl");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(inputPath, "fixture", "utf8");
    await writeJsonLines(firstChunk, [{ sourceId: "1" }]);
    await writeJsonLines(secondChunk, [{ sourceId: "2" }]);
    await combineJsonlChunks([firstChunk, secondChunk], combined);
    const expected = {
      version: 1 as const,
      input: await fingerprintInput(inputPath),
      options: { limitRoutes: 100, includeFootCount: true },
    };
    const checkpoint = await BulkCheckpoint.open(manifestPath, expected);
    await checkpoint.complete("referenced-extraction");
    const restarted = await BulkCheckpoint.open(manifestPath, expected);

    assert.deepEqual(await readJsonLines(combined), [
      { sourceId: "1" },
      { sourceId: "2" },
    ]);
    assert.equal(restarted.isComplete("referenced-extraction"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid completed checkpoint artifact is reused without regeneration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-artifact-"));
  try {
    const inputPath = resolve(directory, "source.osm.pbf");
    const artifactPath = resolve(directory, "selected-routes.osm.pbf");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(inputPath, "source", "utf8");
    await writeFile(artifactPath, "valid pbf", "utf8");
    const expected = {
      version: 1 as const,
      input: await fingerprintInput(inputPath),
      options: { limitRoutes: 100, includeFootCount: true },
    };
    const checkpoint = await BulkCheckpoint.open(manifestPath, expected);
    await checkpoint.complete("referenced-extraction");
    const restarted = await BulkCheckpoint.open(manifestPath, expected);
    let generations = 0;

    const result = await restarted.ensureArtifact({
      stage: "referenced-extraction",
      artifactPath,
      sourcePath: inputPath,
      validate: async () => true,
      generate: async () => {
        generations += 1;
      },
    });

    assert.equal(result, "reused");
    assert.equal(generations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid artifact recovers an incomplete matching checkpoint", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-recovery-"));
  try {
    const inputPath = resolve(directory, "source.osm.pbf");
    const artifactPath = resolve(directory, "selected-routes.osm.pbf");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(inputPath, "source", "utf8");
    await writeFile(artifactPath, "valid pbf", "utf8");
    const expected = {
      version: 1 as const,
      input: await fingerprintInput(inputPath),
      options: { limitRoutes: 100, includeFootCount: true },
    };
    await BulkCheckpoint.open(manifestPath, expected);
    const restarted = await BulkCheckpoint.open(manifestPath, expected);
    let generations = 0;

    const result = await restarted.ensureArtifact({
      stage: "referenced-extraction",
      artifactPath,
      sourcePath: inputPath,
      validate: async () => true,
      generate: async () => {
        generations += 1;
      },
    });

    assert.equal(result, "recovered");
    assert.equal(restarted.isComplete("referenced-extraction"), true);
    assert.equal(generations, 0);
    assert.equal(
      await restarted.ensureArtifact({
        stage: "referenced-extraction",
        artifactPath,
        sourcePath: inputPath,
        validate: async () => true,
        generate: async () => {
          generations += 1;
        },
      }),
      "reused",
    );
    assert.equal(generations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid and empty generated artifacts are replaced deterministically", async (context) => {
  for (const initialContents of ["", "invalid pbf"]) {
    await context.test(JSON.stringify(initialContents), async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-rerun-"));
      try {
        const inputPath = resolve(directory, "source.osm.pbf");
        const artifactPath = resolve(directory, "selected-routes.osm.pbf");
        const manifestPath = resolve(directory, "manifest.json");
        await writeFile(inputPath, "source", "utf8");
        await writeFile(artifactPath, initialContents, "utf8");
        const expected = {
          version: 1 as const,
          input: await fingerprintInput(inputPath),
          options: { limitRoutes: 100, includeFootCount: true },
        };
        await BulkCheckpoint.open(manifestPath, expected);
        const checkpoint = await BulkCheckpoint.open(manifestPath, expected);
        let generations = 0;

        const result = await checkpoint.ensureArtifact({
          stage: "referenced-extraction",
          artifactPath,
          sourcePath: inputPath,
          validate: async (path) => (await readFile(path, "utf8")) === "valid pbf",
          generate: async () => {
            generations += 1;
            await writeFile(artifactPath, "valid pbf", "utf8");
          },
        });

        assert.equal(result, "generated");
        assert.equal(generations, 1);
        assert.equal(await readFile(artifactPath, "utf8"), "valid pbf");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("checkpoint cleanup never deletes the source PBF", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-source-safe-"));
  try {
    const inputPath = resolve(directory, "alps-latest.osm.pbf");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(inputPath, "source pbf", "utf8");
    const expected = {
      version: 1 as const,
      input: await fingerprintInput(inputPath),
      options: { limitRoutes: 100, includeFootCount: true },
    };
    const checkpoint = await BulkCheckpoint.open(manifestPath, expected);

    await assert.rejects(
      checkpoint.ensureArtifact({
        stage: "referenced-extraction",
        artifactPath: inputPath,
        sourcePath: inputPath,
        validate: async () => false,
        generate: async () => {
          throw new Error("must not generate");
        },
      }),
      /Refusing to remove source PBF/,
    );
    assert.equal(await readFile(inputPath, "utf8"), "source pbf");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL serialization emits one compact record per line", () => {
  const serialized = serializeJsonLine({ sourceId: "1", name: "Alps" });

  assert.equal(serialized, '{"sourceId":"1","name":"Alps"}\n');
  assert.equal(serialized.trim().split("\n").length, 1);
});

test("missing relation way is rejected instead of partially reconstructed", () => {
  const relation: OplRelation = {
    type: "relation",
    id: 10,
    tags: { type: "route", route: "hiking", name: "Broken" },
    members: [{ type: "way", ref: 404, role: "" }],
  };
  const result = reconstructBulkRoute(10, objectStore([relation], []));

  assert.equal(result.route, null);
  assert.ok(result.rejected?.reasons.includes("missing way 404"));
});

test("reconstructed source record retains explicit ODbL provenance", () => {
  const relation: OplRelation = {
    type: "relation",
    id: 10,
    tags: { type: "route", route: "hiking", name: "Valid" },
    members: [{ type: "way", ref: 20, role: "" }],
  };
  const way: OplWay = {
    type: "way",
    id: 20,
    tags: {},
    nodes: [
      { nodeId: 1, coordinate: coordinateFromMeters(0, 0) },
      { nodeId: 2, coordinate: coordinateFromMeters(100, 0) },
    ],
  };
  const result = reconstructBulkRoute(10, objectStore([relation], [way]));

  assert.equal(result.route?.source, "openstreetmap");
  assert.equal(result.route?.sourceType, "relation");
  assert.equal(result.route?.sourceId, "10");
  assert.equal(result.route?.license, OSM_LICENSE);
  assert.equal(result.route?.attribution, OSM_ATTRIBUTION);
});

test("atomic JSONL rewrite is deterministic across reruns", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osm-bulk-jsonl-"));
  try {
    const outputPath = resolve(directory, "routes.jsonl");
    const records = [{ sourceId: "2" }, { sourceId: "10" }];
    await writeJsonLines(outputPath, records);
    const first = await readFile(outputPath, "utf8");
    await writeJsonLines(outputPath, records);
    const second = await readFile(outputPath, "utf8");

    assert.equal(second, first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OPL parser retains relation metadata and ordered members", () => {
  const parsed = parseOplLine(
    "r7 Ttype=route,route=hiking,name=Alpine%20%Route Mw2@forward,w1@backward",
  );

  assert.equal(parsed.type, "relation");
  assert.equal(parsed.tags.name, "Alpine Route");
  assert.deepEqual(parsed.members, [
    { type: "way", ref: 2, role: "forward" },
    { type: "way", ref: 1, role: "backward" },
  ]);
});
