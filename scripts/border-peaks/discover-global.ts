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
  buildAdm0SegmentsFromSource,
  loadGlobalAdm0SourceManifest,
  type Adm0Segment,
  type GlobalAdm0SourceManifestEntry,
} from "./global-adm0.ts";
import {
  bboxForPoint,
  bboxIntersects,
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

type Bbox = [number, number, number, number];

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
  schemaVersion: 2;
  completedCountries: string[];
  counters: Counters;
  generatedAt: string;
};

type NearestBoundary = {
  dist: number;
  seg: Adm0Segment;
};

type BorderMatch = {
  code: string;
  distance: number;
  foreign: NearestBoundary;
  sharedEdgeDistance: number;
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
      "data/border-peaks/global-boundaries/source-manifest.json",
    memberships:
      get("--memberships") ??
      "data/border-peaks/existing-memberships-global.jsonl",
    output: get("--output") ?? "data/border-peaks/global-run",
    limit,
    country: get("--country"),
    dryRun: values.includes("--dry-run"),
    resume: values.includes("--resume"),
    candidateRadiusMeters: numberArg("--candidate-radius-m", 200, 1),
    searchRadiusMeters: numberArg("--search-radius-m", 5000, 1),
    sharedEdgeToleranceMeters: numberArg(
      "--shared-edge-tolerance-m",
      100,
      0,
    ),
    checkpointEvery: numberArg("--checkpoint-every", 5000, 1),
  };
}

function splitWrappedBbox(bbox: Bbox): Bbox[] {
  if (bbox[0] <= bbox[2]) return [bbox];
  return [
    [bbox[0], bbox[1], 180, bbox[3]],
    [-180, bbox[1], bbox[2], bbox[3]],
  ];
}

function expandBbox(bbox: Bbox, meters: number): Bbox[] {
  const pieces = splitWrappedBbox(bbox);
  return pieces.map((piece) => {
    const midLat = (piece[1] + piece[3]) / 2;
    const latDelta = meters / 111000;
    const lonDelta =
      meters /
      (111000 *
        Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
    return [
      Math.max(-180, piece[0] - lonDelta),
      Math.max(-90, piece[1] - latDelta),
      Math.min(180, piece[2] + lonDelta),
      Math.min(90, piece[3] + latDelta),
    ];
  });
}

function sourceBboxesOverlap(
  left: Bbox,
  right: Bbox,
  marginMeters: number,
): boolean {
  return expandBbox(left, marginMeters).some((a) =>
    expandBbox(right, marginMeters).some((b) => bboxIntersects(a, b)),
  );
}

function overlapFilters(
  left: Bbox,
  right: Bbox,
  marginMeters: number,
): Bbox[] {
  const result: Bbox[] = [];
  for (const a of expandBbox(left, marginMeters)) {
    for (const b of expandBbox(right, marginMeters)) {
      if (!bboxIntersects(a, b)) continue;
      result.push([
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
        Math.min(a[2], b[2]),
        Math.min(a[3], b[3]),
      ]);
    }
  }
  return result;
}

async function readMountainsGrouped(
  path: string,
  args: Args,
): Promise<Map<string, MountainRef[]>> {
  if (!existsSync(path)) {
    throw new Error(`Mountain input does not exist: ${path}`);
  }

  const grouped = new Map<string, MountainRef[]>();
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let selected = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    if (selected >= args.limit) break;

    const row = JSON.parse(line) as Record<string, unknown>;
    const primaryCountryCode =
      typeof row.primaryCountryCode === "string"
        ? row.primaryCountryCode
        : typeof row.country_code === "string"
          ? row.country_code
          : null;
    if (!primaryCountryCode) continue;
    if (args.country && primaryCountryCode !== args.country) continue;

    const mountain: MountainRef = {
      id: Number(row.id),
      name: typeof row.name === "string" ? row.name : null,
      name_de: typeof row.name_de === "string" ? row.name_de : null,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      height:
        row.height == null || !Number.isFinite(Number(row.height))
          ? null
          : Number(row.height),
      primaryCountryCode,
    };

    const list = grouped.get(primaryCountryCode) ?? [];
    list.push(mountain);
    grouped.set(primaryCountryCode, list);
    selected += 1;
  }

  return grouped;
}

function readExistingMemberships(
  path: string,
): Map<number, Set<string>> {
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
    const countries =
      result.get(Number(row.mountain_id)) ?? new Set<string>();
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
  const [minLon, minLat, maxLon, maxLat] = bboxForPoint(
    point,
    radiusMeters,
  );
  const boxes: Bbox[] = [];

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

function nearestBoundary(
  index: GridIndex<Adm0Segment>,
  point: [number, number],
  radiusMeters: number,
): NearestBoundary | null {
  let best: NearestBoundary | null = null;
  for (const segment of querySegmentsNearPoint(
    index,
    point,
    radiusMeters,
  )) {
    const dist = pointToSegmentMeters(point, segment.a, segment.b);
    if (!best || dist < best.dist) {
      best = { dist, seg: segment };
    }
  }
  return best;
}

function buildIndex(segments: Adm0Segment[]): GridIndex<Adm0Segment> {
  const index = new GridIndex<Adm0Segment>(0.5);
  for (const segment of segments) {
    index.insert(segment.bbox, segment);
  }
  return index;
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
  const value = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<Checkpoint>;
  if (
    value.schemaVersion !== 2 ||
    !Array.isArray(value.completedCountries) ||
    !value.counters
  ) {
    throw new Error(`Invalid global border checkpoint: ${path}`);
  }
  return value as Checkpoint;
}

function writeCheckpoint(
  path: string,
  completedCountries: Set<string>,
  counters: Counters,
): void {
  writeFileSync(
    path,
    JSON.stringify(
      {
        schemaVersion: 2,
        completedCountries: [...completedCountries].sort(),
        counters,
        generatedAt: new Date().toISOString(),
      } satisfies Checkpoint,
      null,
      2,
    ),
  );
}

function sourceByCountry(
  sources: GlobalAdm0SourceManifestEntry[],
): Map<string, GlobalAdm0SourceManifestEntry> {
  return new Map(sources.map((source) => [source.countryCode, source]));
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.candidateRadiusMeters > args.searchRadiusMeters) {
    throw new Error(
      "--candidate-radius-m cannot exceed --search-radius-m",
    );
  }

  const manifest = loadGlobalAdm0SourceManifest(args.boundaries);
  const sourcesByCountry = sourceByCountry(manifest.sources);
  const mountainsByCountry = await readMountainsGrouped(args.input, args);
  const existing = readExistingMemberships(args.memberships);

  mkdirSync(args.output, { recursive: true });
  const candidatePath = `${args.output}/candidates.jsonl`;
  const reviewPath = `${args.output}/review.jsonl`;
  const summaryPath = `${args.output}/summary.json`;
  const checkpointPath = `${args.output}/checkpoint.json`;

  let counters = defaultCounters();
  const completedCountries = new Set<string>();

  if (args.resume) {
    const checkpoint = loadCheckpoint(checkpointPath);
    if (!checkpoint) {
      throw new Error(
        "--resume requested but checkpoint.json is missing",
      );
    }
    counters = { ...checkpoint.counters };
    checkpoint.completedCountries.forEach((country) =>
      completedCountries.add(country),
    );
  } else if (!args.dryRun) {
    for (const path of [
      candidatePath,
      reviewPath,
      summaryPath,
      checkpointPath,
    ]) {
      if (existsSync(path)) rmSync(path);
    }
  }

  const pairCounts: Record<string, number> = {};
  let boundarySegmentCount = 0;
  const countryCodes = [...mountainsByCountry.keys()].sort();

  for (const primaryCode of countryCodes) {
    if (completedCountries.has(primaryCode)) continue;

    const mountains = mountainsByCountry.get(primaryCode) ?? [];
    const primarySource = sourcesByCountry.get(primaryCode);

    if (!primarySource) {
      counters.examined += mountains.length;
      counters.sourceConflicts += mountains.length;
      completedCountries.add(primaryCode);
      if (!args.dryRun) {
        writeCheckpoint(
          checkpointPath,
          completedCountries,
          counters,
        );
      }
      continue;
    }

    const neighborMargin =
      args.searchRadiusMeters + args.sharedEdgeToleranceMeters;
    const neighbors = manifest.sources
      .filter(
        (source) =>
          source.countryCode !== primaryCode &&
          sourceBboxesOverlap(
            primarySource.bbox,
            source.bbox,
            neighborMargin,
          ),
      )
      .sort((a, b) =>
        a.countryCode.localeCompare(b.countryCode),
      );

    counters.examined += mountains.length;

    if (neighbors.length === 0) {
      counters.rejected += mountains.length;
      completedCountries.add(primaryCode);
      if (!args.dryRun) {
        writeCheckpoint(
          checkpointPath,
          completedCountries,
          counters,
        );
      }
      continue;
    }

    const primaryFilters = neighbors.flatMap((neighbor) =>
      overlapFilters(
        primarySource.bbox,
        neighbor.bbox,
        neighborMargin,
      ),
    );

    const primarySegments = buildAdm0SegmentsFromSource(
      readFileSync(primarySource.localGeojsonPath, "utf8"),
      primarySource,
      primaryFilters,
    );
    boundarySegmentCount += primarySegments.length;
    const primaryIndex = buildIndex(primarySegments);

    const primaryNearest = new Map<number, NearestBoundary>();
    for (const mountain of mountains) {
      if (
        !Number.isFinite(mountain.latitude) ||
        !Number.isFinite(mountain.longitude)
      ) {
        continue;
      }
      const nearest = nearestBoundary(
        primaryIndex,
        [mountain.longitude, mountain.latitude],
        args.searchRadiusMeters,
      );
      if (nearest && nearest.dist <= args.searchRadiusMeters) {
        primaryNearest.set(mountain.id, nearest);
      }
    }

    const matchesByMountain = new Map<number, BorderMatch[]>();

    for (const neighbor of neighbors) {
      const filters = overlapFilters(
        primarySource.bbox,
        neighbor.bbox,
        neighborMargin,
      );
      if (filters.length === 0) continue;

      const foreignSegments = buildAdm0SegmentsFromSource(
        readFileSync(neighbor.localGeojsonPath, "utf8"),
        neighbor,
        filters,
      );
      boundarySegmentCount += foreignSegments.length;
      if (foreignSegments.length === 0) continue;

      const foreignIndex = buildIndex(foreignSegments);

      for (const mountain of mountains) {
        const primary = primaryNearest.get(mountain.id);
        if (!primary) continue;

        const point: [number, number] = [
          mountain.longitude,
          mountain.latitude,
        ];
        const foreign = nearestBoundary(
          foreignIndex,
          point,
          args.searchRadiusMeters,
        );
        if (!foreign || foreign.dist > args.searchRadiusMeters) {
          continue;
        }

        const sharedEdgeDistance = segmentToSegmentMeters(
          primary.seg.a,
          primary.seg.b,
          foreign.seg.a,
          foreign.seg.b,
        );
        if (
          sharedEdgeDistance > args.sharedEdgeToleranceMeters
        ) {
          continue;
        }

        const conservativeDistance = Math.max(
          primary.dist,
          foreign.dist,
        );
        if (
          conservativeDistance > args.candidateRadiusMeters
        ) {
          continue;
        }

        const list = matchesByMountain.get(mountain.id) ?? [];
        list.push({
          code: neighbor.countryCode,
          distance: conservativeDistance,
          foreign,
          sharedEdgeDistance,
        });
        matchesByMountain.set(mountain.id, list);
      }
    }

    for (const mountain of mountains) {
      const matches = (matchesByMountain.get(mountain.id) ?? [])
        .sort(
          (left, right) =>
            left.distance - right.distance ||
            left.code.localeCompare(right.code),
        );

      if (matches.length === 0) {
        counters.rejected += 1;
        continue;
      }
      if (matches.length >= 2) {
        counters.tripleBorderMountains += 1;
      }

      const primary = primaryNearest.get(mountain.id);
      if (!primary) {
        counters.sourceConflicts += 1;
        continue;
      }

      for (const match of matches) {
        if (existing.get(mountain.id)?.has(match.code)) {
          counters.skippedExisting += 1;
          continue;
        }

        counters.near += 1;
        const classification = classifyCandidate({
          distanceMeters: match.distance,
          boundarySource: "geoBoundaries gbOpen ADM0",
          supportingReference: null,
          coordinateAccuracyMeters: 30,
          boundaryPrecisionMeters: 100,
          conflictingSources: false,
          disputed: false,
          hasInternationalGeometry: true,
        });

        if (classification === "CONFIRMED") {
          counters.confirmed += 1;
        } else if (classification === "REVIEW") {
          counters.review += 1;
        } else {
          counters.rejected += 1;
        }

        const pair = [primaryCode, match.code].sort().join("-");
        if (classification === "CONFIRMED") {
          pairCounts[pair] = (pairCounts[pair] ?? 0) + 1;
        }

        const candidate: BorderCandidate = {
          mountain_id: mountain.id,
          mountain_name: mountain.name_de ?? mountain.name,
          latitude: mountain.latitude,
          longitude: mountain.longitude,
          height: mountain.height,
          primary_country_code: primaryCode,
          candidate_country_code: match.code,
          classification,
          evidence_type:
            classification === "REVIEW" ? "CANDIDATE" : null,
          boundary_source: "William & Mary geoLab",
          boundary_source_id:
            `${primary.seg.featureId},${match.foreign.seg.featureId}`,
          boundary_dataset_version: manifest.snapshotVersion,
          boundary_license:
            "Mixed open licenses; see source manifest.",
          coordinate_precision_meters: 30,
          boundary_precision_meters: 100,
          distance_to_boundary_meters: Math.round(
            match.distance,
          ),
          supporting_external_reference: null,
          reason: reasonFor(
            classification,
            Math.round(match.distance),
          ),
          review_notes:
            matches.length >= 2
              ? `ADM0 geometric candidate for ${pair}; possible triple/multi-country summit (${matches.map((entry) => entry.code).join(",")}); shared-edge separation ${Math.round(match.sharedEdgeDistance)}m. External evidence required.`
              : `ADM0 geometric candidate for ${pair}; shared-edge separation ${Math.round(match.sharedEdgeDistance)}m. External evidence required.`,
          existing_memberships: [
            ...(existing.get(mountain.id) ?? []),
          ]
            .sort()
            .map((countryCode) => ({
              mountain_id: mountain.id,
              country_code: countryCode,
              is_primary: countryCode === primaryCode,
            })),
        };

        if (!args.dryRun) {
          appendFileSync(
            candidatePath,
            `${JSON.stringify(candidate)}\n`,
          );
          if (classification === "REVIEW") {
            appendFileSync(
              reviewPath,
              `${JSON.stringify(candidate)}\n`,
            );
          }
        }
      }
    }

    completedCountries.add(primaryCode);
    if (!args.dryRun) {
      writeCheckpoint(
        checkpointPath,
        completedCountries,
        counters,
      );
    }
  }

  const summary: DiscoverySummary & {
    triple_border_mountains: number;
    candidate_radius_meters: number;
    search_radius_meters: number;
    shared_edge_tolerance_meters: number;
    boundary_segments_loaded: number;
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
    per_country_pair: pairCounts,
    dataset: {
      provider: "William & Mary geoLab",
      dataset:
        "geoBoundaries gbOpen ADM0 full-resolution single-country files",
      version: manifest.snapshotVersion,
    },
    generated_at: new Date().toISOString(),
    triple_border_mountains: counters.tripleBorderMountains,
    candidate_radius_meters: args.candidateRadiusMeters,
    search_radius_meters: args.searchRadiusMeters,
    shared_edge_tolerance_meters:
      args.sharedEdgeToleranceMeters,
    boundary_segments_loaded: boundarySegmentCount,
    boundary_coverage_gaps: Object.keys(
      manifest.coverageGaps,
    ),
  };

  if (!args.dryRun) {
    writeFileSync(
      summaryPath,
      JSON.stringify(summary, null, 2),
    );
    writeCheckpoint(
      checkpointPath,
      completedCountries,
      counters,
    );
  }

  process.stdout.write(
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
