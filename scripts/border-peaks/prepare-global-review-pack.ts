#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type FinalMachineStatus =
  | "TIER1_VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "NEEDS_THIRD_SOURCE"
  | "TECHNICAL_ERROR"
  | "DEFERRED_LOW_PRIORITY";

type RegistryRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  distance_to_boundary_meters: number | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
  final_machine_status: FinalMachineStatus;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_queried_at: string | null;
  latest_probe_source: string | null;
  has_successful_probe_evidence: boolean;
  requires_human_approval: true;
};

type MountainInput = {
  id: number;
  name?: string | null;
  name_de?: string | null;
  latitude: number;
  longitude: number;
  height?: number | null;
  primaryCountryCode?: string | null;
  country_code?: string | null;
};

type DiscoverySummary = {
  boundary_coverage_gaps?: string[];
};

type ReviewQueueRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: FinalMachineStatus;
  distance_to_boundary_meters: number | null;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
  review_action:
    | "HUMAN_REVIEW"
    | "THIRD_SOURCE_REQUIRED"
    | "RETRY_TECHNICAL";
  decision: null;
  evidence_url: null;
  evidence_type: null;
  evidence_notes: null;
  reviewed_by: null;
  reviewed_at: null;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)
    : [];
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function toReviewRow(
  row: RegistryRow,
  reviewAction: ReviewQueueRow["review_action"],
): ReviewQueueRow {
  return {
    candidate_hash: row.candidate_hash,
    mountain_id: row.mountain_id,
    mountain_name: row.mountain_name,
    latitude: row.latitude,
    longitude: row.longitude,
    height: row.height,
    primary_country_code: row.primary_country_code,
    candidate_country_code: row.candidate_country_code,
    pair: `${row.primary_country_code}->${row.candidate_country_code}`,
    final_machine_status: row.final_machine_status,
    distance_to_boundary_meters: row.distance_to_boundary_meters,
    tier1_status: row.tier1_status,
    best_probe_status: row.best_probe_status,
    latest_probe_status: row.latest_probe_status,
    latest_probe_source: row.latest_probe_source,
    boundary_source: row.boundary_source,
    boundary_source_id: row.boundary_source_id,
    boundary_dataset_version: row.boundary_dataset_version,
    review_action: reviewAction,
    decision: null,
    evidence_url: null,
    evidence_type: null,
    evidence_notes: null,
    reviewed_by: null,
    reviewed_at: null,
  };
}

function compareReview(a: ReviewQueueRow, b: ReviewQueueRow): number {
  const statusRank = (status: FinalMachineStatus): number =>
    status === "TIER1_VERIFIED" ? 0 : status === "GEOMETRIC_SUPPORT" ? 1 : 2;
  return (
    statusRank(a.final_machine_status) - statusRank(b.final_machine_status) ||
    (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
      (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
    a.mountain_id - b.mountain_id ||
    a.candidate_country_code.localeCompare(b.candidate_country_code)
  );
}

function main(): void {
  const registryPath = arg(
    "--registry",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const mountainsPath = arg(
    "--mountains",
    "data/border-peaks/mountains-global.jsonl",
  );
  const discoverySummaryPath = arg(
    "--discovery-summary",
    "data/border-peaks/global-run-v2/summary.json",
  );
  const strongOutput = arg(
    "--strong-output",
    "data/border-peaks/global-review/strong-human-review.jsonl",
  );
  const thirdSourceOutput = arg(
    "--third-source-output",
    "data/border-peaks/global-review/needs-third-source.jsonl",
  );
  const technicalOutput = arg(
    "--technical-output",
    "data/border-peaks/global-review/technical-errors.jsonl",
  );
  const coverageOutput = arg(
    "--coverage-output",
    "data/border-peaks/global-review/coverage-gap-mountains.jsonl",
  );
  const summaryOutput = arg(
    "--summary-output",
    "data/border-peaks/global-review/review-pack-summary.json",
  );

  const registry = readJsonl<RegistryRow>(registryPath);
  const mountains = readJsonl<MountainInput>(mountainsPath);
  if (!existsSync(discoverySummaryPath)) {
    throw new Error(`Required file is missing: ${discoverySummaryPath}`);
  }
  const discoverySummary = JSON.parse(
    readFileSync(discoverySummaryPath, "utf8"),
  ) as DiscoverySummary;

  const strong = registry
    .filter(
      (row) =>
        row.final_machine_status === "TIER1_VERIFIED" ||
        row.final_machine_status === "GEOMETRIC_SUPPORT",
    )
    .map((row) => toReviewRow(row, "HUMAN_REVIEW"))
    .sort(compareReview);

  const thirdSource = registry
    .filter((row) => row.final_machine_status === "NEEDS_THIRD_SOURCE")
    .map((row) => toReviewRow(row, "THIRD_SOURCE_REQUIRED"))
    .sort(compareReview);

  const technical = registry
    .filter((row) => row.final_machine_status === "TECHNICAL_ERROR")
    .map((row) => toReviewRow(row, "RETRY_TECHNICAL"))
    .sort(compareReview);

  const gapCodes = new Set(discoverySummary.boundary_coverage_gaps ?? []);
  const coverageGaps = mountains
    .map((mountain) => {
      const countryCode =
        mountain.primaryCountryCode ?? mountain.country_code ?? null;
      return {
        mountain_id: Number(mountain.id),
        mountain_name: mountain.name_de ?? mountain.name ?? null,
        latitude: Number(mountain.latitude),
        longitude: Number(mountain.longitude),
        height:
          mountain.height == null || !Number.isFinite(Number(mountain.height))
            ? null
            : Number(mountain.height),
        primary_country_code: countryCode,
        coverage_status: "MISSING_ADM0_SOURCE" as const,
        review_action: "RESOLVE_BOUNDARY_SOURCE" as const,
      };
    })
    .filter(
      (row) =>
        row.primary_country_code != null &&
        gapCodes.has(row.primary_country_code),
    )
    .sort(
      (a, b) =>
        String(a.primary_country_code).localeCompare(
          String(b.primary_country_code),
        ) || a.mountain_id - b.mountain_id,
    );

  writeJsonl(strongOutput, strong);
  writeJsonl(thirdSourceOutput, thirdSource);
  writeJsonl(technicalOutput, technical);
  writeJsonl(coverageOutput, coverageGaps);

  const strongByStatus = {
    TIER1_VERIFIED: strong.filter(
      (row) => row.final_machine_status === "TIER1_VERIFIED",
    ).length,
    GEOMETRIC_SUPPORT: strong.filter(
      (row) => row.final_machine_status === "GEOMETRIC_SUPPORT",
    ).length,
  };

  const coverageByCountry = Object.fromEntries(
    [...gapCodes]
      .sort()
      .map((code) => [
        code,
        coverageGaps.filter((row) => row.primary_country_code === code).length,
      ])
      .filter(([, count]) => Number(count) > 0),
  );

  const summary = {
    generated_at: new Date().toISOString(),
    registry_rows: registry.length,
    strong_human_review_rows: strong.length,
    strong_human_review_unique_mountains: new Set(
      strong.map((row) => row.mountain_id),
    ).size,
    strong_by_status: strongByStatus,
    needs_third_source_rows: thirdSource.length,
    needs_third_source_unique_mountains: new Set(
      thirdSource.map((row) => row.mountain_id),
    ).size,
    technical_error_rows: technical.length,
    technical_error_unique_mountains: new Set(
      technical.map((row) => row.mountain_id),
    ).size,
    coverage_gap_codes: [...gapCodes].sort(),
    coverage_gap_mountain_rows: coverageGaps.length,
    coverage_gap_by_country: coverageByCountry,
    outputs: {
      strong_human_review: strongOutput,
      needs_third_source: thirdSourceOutput,
      technical_errors: technicalOutput,
      coverage_gap_mountains: coverageOutput,
      summary: summaryOutput,
    },
    safety:
      "Review pack generation is read-only. decision/evidence/reviewer fields remain null. Machine evidence never becomes APPROVE automatically, and no SQL is generated or applied.",
  };

  writeFileSync(summaryOutput, JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
