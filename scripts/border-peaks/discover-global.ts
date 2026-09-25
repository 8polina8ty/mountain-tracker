#!/usr/bin/env ts-node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { classifyCandidate, reasonFor } from "./classify.ts";
import {
  buildAdm0Segments,
  loadGlobalAdm0Dataset,
  type Adm0Segment,
} from "./global-adm0.ts";
import {
  bboxForPoint,
  GridIndex,
  pointToSegmentMeters,
  segmentToSegmentMeters,
} from "./spatial.ts";
import type {
  BorderCandidate,
  DiscoverySummary,
  ExistingMembership,
  MountainRef,
} from "./types.ts";

type Args = {
  input: string;
  boundaries: string;
  memberships: string;
  output: string;
  limit: number;
  country?: string;
  dryRun: boolean;
  resume: boolean;
  candidateRadiusMeters: number;
  searchRadiusMeters: number;
  sharedEdgeToleranceMeters: number;
  checkpointEvery: number;
};

type Counters = {
  examined: number;
  near: number;
  confirmed: number;
  review: number;
  rejected: number;
  skippedExisting: number;
  sourceConflicts: number;
  tripleBorderMountains: number;
};

type Checkpoint = {
  schemaVersion: 1;
  lastMountainId: number;
  counters: Counters;
  generatedAt: string;
};

type NearestBoundary = {
  dist: number;
  seg: Adm0Segment;
};

function parseArgs(): Args {
  const values = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
  };
  const numberArg = (
    name: string,
    fallback: number,
    minimum: number,
  ): number => {
    const raw = get(name);
    const value = raw == null ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < minimum) {
      throw new Error(`${name} must be a finite number >= ${minimum}`);
    }
    return value;
  };

  const rawLimit = get("--limit");
  const limit =
    rawLimit == null || rawLimit === "0"
      ? Number.MAX_SAFE_INTEGER
      : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer or 0 for all rows");
  }

  return {
    input: get("--input") ?? "data/border-peaks/mountains-global.jsonl",
    boundaries:
      get("--boundaries") ??
      "data/border-peaks/global-boundaries/global-adm0.geojson",
    memberships:
      get("--memberships") ?? "data/border-peaks/existing-memberships-global.jsonl",
    output: get("--output") ?? "data/border-peaks/global-run",
    limit,
    country: get("--country"),
    dryRun: values.includes("--dry-run"),
    resume: values.includes("--resume"),
    candidateRadiusMeters: numberArg("--candidate-radius-m", 200, 1),
    searchRadiusMeters: numberArg("--search-radius-m", 5000, 1),
    sharedEdgeToleranceMeters: numberArg("--shared-edge-tolerance-m", 100, 0),
    checkpointEvery: numberArg("--checkpoint-every", 5000, 1),
  };
}

async function* mountainsFromJsonl(path: string): AsyncGenerator<MountainRef> {
  if (!existsSync(path)) {
    throw new Error(`Mountain input does not exist: ${path}`);
  }
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    yield {
      id: Number(row.id),
      name: typeof row.name === "string" ? row.name : null,
      name_de: typeof row.name_de === "string" ? row.name_de : null,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      height:
        row.height == null || !Number.isFinite(Number(row.height))
          ? null
          : Number(row.height),
      primaryCountryCode:
        typeof row.primaryCountryCode === "string"
          ? row.primaryCountryCode
          : typeof row.country_code === "string"
            ? row.country_code
            : null,
    };
  }
}

function readExistingMemberships(path: string): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  if (!existsSync(path)) {
    throw new Error(
      `Existing membership snapshot is required for fail-closed discovery: ${path}`,
    );
  }

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return result;
  const rows: ExistingMembership[] = raw.startsWith("[")
    ? (JSON.parse(raw) as ExistingMembership[])
    : raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ExistingMembership);

  for (const row of rows) {
    const countries = result.get(Number(row.mountain_id)) ?? new Set<string>();
    countries.add(row.country_code);
    result.set(Number(row.mountain_id), countries);
  }
  return result;
}

function querySegmentsNearPoint(
  index: GridIndex<Adm0Segment>,
  point: [number, number],
  radiusMeters: number,
): Adm0Segment[] {
  const [minLon, minLat, maxLon, maxLat] = bboxForPoint(point, radiusMeters);
  const boxes: Array<[number, number, number, number]> = [];
  if (minLon < -180) {
    boxes.push([minLon + 360, minLat, 180, maxLat]);
    boxes.push([-180, minLat, maxLon, maxLat]);
  } else if (maxLon > 180) {
    boxes.push([minLon, minLat, 180, maxLat]);
    boxes.push([-180, minLat, maxLon - 360, maxLat]);
  } else {
    boxes.push([minLon, minLat, maxLon, maxLat]);
  }

  const seen = new Set<Adm0Segment>();
  const result: Adm0Segment[] = [];
  for (const box of boxes) {
    for (const segment of index.query(box)) {
      if (seen.has(segment)) continue;
      seen.add(segment);
      result.push(segment);
    }
  }
  return result;
}

function closestByCountry(
  segments: Adm0Segment[],
  point: [number, number],
): Map<string, NearestBoundary> {
  const result = new Map<string, NearestBoundary>();
  for (const seg of segments) {
    const dist = pointToSegmentMeters(point, seg.a, seg.b);
    const current = result.get(seg.countryCode);
    if (current == null || dist < current.dist) {
      result.set(seg.countryCode, { dist, seg });
    }
  }
  return result;
}

function defaultCounters(): Counters {
  return {
    examined: 0,
    near: 0,
    confirmed: 0,
    review: 0,
    rejected: 0,
    skippedExisting: 0,
    sourceConflicts: 0,
    tripleBorderMountains: 0,
  };
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  if (
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.lastMountainId) ||
    !value.counters
  ) {
    throw new Error(`Invalid global border checkpoint: ${path}`);
  }
  return value;
}

function writeCheckpoint(
  path: string,
  lastMountainId: number,
  counters: Counters,
): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        lastMountainId,
        counters,
        generatedAt: new Date().toISOString(),
      } satisfies Checkpoint,
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.candidateRadiusMeters > args.searchRadiusMeters) {
    throw new Error("--candidate-radius-m cannot exceed --search-radius-m");
  }

  const dataset = loadGlobalAdm0Dataset(args.boundaries);
  const segments = buildAdm0Segments(dataset);
  if (segments.length === 0) {
    throw new Error("Global ADM0 dataset produced no boundary segments");
  }

  const index = new GridIndex<Adm0Segment>(0.5);
  for (const segment of segments) index.insert(segment.bbox, segment);

  const existing = readExistingMemberships(args.memberships);

  mkdirSync(args.output, { recursive: true });
  const candidatePath = `${args.output}/candidates.jsonl`;
  const reviewPath = `${args.output}/review.jsonl`;
  const summaryPath = `${args.output}/summary.json`;
  const checkpointPath = `${args.output}/checkpoint.json`;

  let counters = defaultCounters();
  let resumeAfterMountainId = -1;
  if (args.resume) {
    const checkpoint = loadCheckpoint(checkpointPath);
    if (!checkpoint) {
      throw new Error("--resume requested but checkpoint.json is missing");
    }
    counters = { ...checkpoint.counters };
    resumeAfterMountainId = checkpoint.lastMountainId;
  } else if (!args.dryRun) {
    for (const path of [candidatePath, reviewPath, summaryPath, checkpointPath]) {
      if (existsSync(path)) rmSync(path);
    }
  }

  const countryCodes = [
    ...new Set(dataset.features.map((feature) => feature.properties.countryCode)),
  ].sort();
  let lastMountainId = resumeAfterMountainId;
  let processedThisRun = 0;

  for await (const mountain of mountainsFromJsonl(args.input)) {
    if (mountain.id <= resumeAfterMountainId) continue;
    if (args.country && mountain.primaryCountryCode !== args.country) continue;
    if (processedThisRun >= args.limit) break;

    processedThisRun += 1;
    counters.examined += 1;
    lastMountainId = mountain.id;

    if (
      !Number.isFinite(mountain.latitude) ||
      !Number.isFinite(mountain.longitude) ||
      !mountain.primaryCountryCode
    ) {
      counters.rejected += 1;
      continue;
    }

    const point: [number, number] = [
      mountain.longitude,
      mountain.latitude,
    ];
    const nearbySegments = querySegmentsNearPoint(
      index,
      point,
      args.searchRadiusMeters,
    );
    const nearest = closestByCountry(nearbySegments, point);
    const primary = nearest.get(mountain.primaryCountryCode);

    if (!primary || primary.dist > args.searchRadiusMeters) {
      counters.rejected += 1;
      continue;
    }

    const possible: Array<{
      code: string;
      distance: number;
      foreign: NearestBoundary;
      sharedEdgeDistance: number;
    }> = [];

    for (const [code, foreign] of nearest) {
      if (code === mountain.primaryCountryCode) continue;
      if (foreign.dist > args.searchRadiusMeters) continue;

      const sharedEdgeDistance = segmentToSegmentMeters(
        primary.seg.a,
        primary.seg.b,
        foreign.seg.a,
        foreign.seg.b,
      );
      if (sharedEdgeDistance > args.sharedEdgeToleranceMeters) continue;

      const conservativeDistance = Math.max(primary.dist, foreign.dist);
      if (conservativeDistance > args.candidateRadiusMeters) continue;

      possible.push({
        code,
        distance: conservativeDistance,
        foreign,
        sharedEdgeDistance,
      });
    }

    possible.sort(
      (left, right) =>
        left.distance - right.distance || left.code.localeCompare(right.code),
    );

    if (possible.length === 0) {
      counters.rejected += 1;
    } else {
      if (possible.length >= 2) counters.tripleBorderMountains += 1;

      for (const match of possible) {
        if (existing.get(mountain.id)?.has(match.code)) {
          counters.skippedExisting += 1;
          continue;
        }

        counters.near += 1;
        const classification = classifyCandidate({
          distanceMeters: match.distance,
          boundarySource: dataset.metadata.source,
          supportingReference: null,
          coordinateAccuracyMeters: 30,
          boundaryPrecisionMeters: dataset.metadata.boundaryPrecisionMeters,
          conflictingSources: false,
          disputed: false,
          hasInternationalGeometry: true,
        });

        if (classification === "CONFIRMED") counters.confirmed += 1;
        else if (classification === "REVIEW") counters.review += 1;
        else counters.rejected += 1;

        const pair = [mountain.primaryCountryCode, match.code]
          .sort()
          .join("-");
        const candidate: BorderCandidate = {
          mountain_id: mountain.id,
          mountain_name: mountain.name_de ?? mountain.name,
          latitude: mountain.latitude,
          longitude: mountain.longitude,
          height: mountain.height,
          primary_country_code: mountain.primaryCountryCode,
          candidate_country_code: match.code,
          classification,
          evidence_type:
            classification === "REVIEW" ? "CANDIDATE" : null,
          boundary_source: dataset.metadata.provider,
          boundary_source_id: `${primary.seg.featureId},${match.foreign.seg.featureId}`,
          boundary_dataset_version: dataset.metadata.version,
          boundary_license: dataset.metadata.license,
          coordinate_precision_meters: 30,
          boundary_precision_meters: dataset.metadata.boundaryPrecisionMeters,
          distance_to_boundary_meters: Math.round(match.distance),
          supporting_external_reference: null,
          reason: reasonFor(classification, Math.round(match.distance)),
          review_notes:
            possible.length >= 2
              ? `ADM0 geometric candidate for ${pair}; possible triple/multi-country summit (${possible.map((entry) => entry.code).join(",")}); shared-edge separation ${Math.round(match.sharedEdgeDistance)}m. External evidence required.`
              : `ADM0 geometric candidate for ${pair}; shared-edge separation ${Math.round(match.sharedEdgeDistance)}m. External evidence required.`,
          existing_memberships: [...(existing.get(mountain.id) ?? [])]
            .sort()
            .map((countryCode) => ({
              mountain_id: mountain.id,
              country_code: countryCode,
              is_primary: countryCode === mountain.primaryCountryCode,
            })),
        };

        if (!args.dryRun) {
          appendFileSync(candidatePath, `${JSON.stringify(candidate)}\n`);
          if (classification === "REVIEW") {
            appendFileSync(reviewPath, `${JSON.stringify(candidate)}\n`);
          }
        }
      }
    }

    if (
      !args.dryRun &&
      counters.examined % args.checkpointEvery === 0
    ) {
      writeCheckpoint(checkpointPath, lastMountainId, counters);
    }
  }

  const summary: DiscoverySummary & {
    triple_border_mountains: number;
    candidate_radius_meters: number;
    search_radius_meters: number;
    shared_edge_tolerance_meters: number;
    boundary_segments: number;
    boundary_coverage_gaps: string[];
  } = {
    total_mountains_examined: counters.examined,
    near_border_candidates: counters.near,
    confirmed: counters.confirmed,
    review: counters.review,
    rejected: counters.rejected,
    existing_memberships_skipped: counters.skippedExisting,
    source_conflicts: counters.sourceConflicts,
    countries_covered: countryCodes,
    per_country_pair: {},
    dataset: {
      provider: dataset.metadata.provider,
      dataset: dataset.metadata.dataset,
      version: dataset.metadata.version,
    },
    generated_at: new Date().toISOString(),
    triple_border_mountains: counters.tripleBorderMountains,
    candidate_radius_meters: args.candidateRadiusMeters,
    search_radius_meters: args.searchRadiusMeters,
    shared_edge_tolerance_meters: args.sharedEdgeToleranceMeters,
    boundary_segments: segments.length,
    boundary_coverage_gaps: dataset.metadata.coverageGaps ?? [],
  };

  if (!args.dryRun) {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    writeCheckpoint(checkpointPath, lastMountainId, counters);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
