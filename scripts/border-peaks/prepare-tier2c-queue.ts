#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { BorderCandidate } from "./types.ts";

type VerificationStatus =
  | "VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "ERROR";

type Tier2BRow = BorderCandidate & {
  tier2_priority?: number;
  tier2_reasons?: string[];
  tier1_peak_distance_meters?: number | null;
  tier1_peak_wikidata?: string | null;
  tier1_multi_country_candidate?: boolean;
  tier2b_action: "RETRY_PROBE";
  tier2b_reason: "NO_TIER2_RESULT" | "ERROR";
  tier2_last_status: VerificationStatus | null;
};

type Tier2CRow = Tier2BRow & {
  tier2c_action: "PRIORITY_PROBE";
  tier2c_rank: number;
  tier2c_selection_reason: "MULTI_COUNTRY" | "TOP_PRIORITY";
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function integerArg(name: string, fallback: number, min: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
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

function priority(row: Tier2BRow): number {
  return row.tier2_priority ?? 0;
}

function distance(row: Tier2BRow): number {
  return row.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY;
}

function peakDistance(row: Tier2BRow): number {
  return row.tier1_peak_distance_meters ?? Number.POSITIVE_INFINITY;
}

function compare(a: Tier2BRow, b: Tier2BRow): number {
  return (
    priority(b) - priority(a) ||
    distance(a) - distance(b) ||
    peakDistance(a) - peakDistance(b) ||
    Number(Boolean(b.tier1_peak_wikidata)) -
      Number(Boolean(a.tier1_peak_wikidata)) ||
    a.mountain_id - b.mountain_id ||
    a.candidate_country_code.localeCompare(b.candidate_country_code)
  );
}

function main(): void {
  const inputPath = arg(
    "--input",
    "data/border-peaks/global-verification/tier2b-retry-probe.jsonl",
  );
  const priorityOutputPath = arg(
    "--priority-output",
    "data/border-peaks/global-verification/tier2c-priority-probe.jsonl",
  );
  const errorOutputPath = arg(
    "--error-output",
    "data/border-peaks/global-verification/tier2c-error-retry.jsonl",
  );
  const deferredOutputPath = arg(
    "--deferred-output",
    "data/border-peaks/global-verification/tier2c-deferred.jsonl",
  );
  const summaryOutputPath = arg(
    "--summary-output",
    "data/border-peaks/global-verification/tier2c-summary.json",
  );
  const maxNew = integerArg("--max-new", 300, 0);

  const rows = readJsonl<Tier2BRow>(inputPath);
  const errors = rows.filter((row) => row.tier2b_reason === "ERROR").sort(compare);
  const unprocessed = rows
    .filter((row) => row.tier2b_reason === "NO_TIER2_RESULT")
    .sort(compare);

  const mandatory = unprocessed.filter(
    (row) => row.tier1_multi_country_candidate === true,
  );
  const mandatoryKeys = new Set(
    mandatory.map(
      (row) =>
        `${row.mountain_id}:${row.primary_country_code}:${row.candidate_country_code}`,
    ),
  );

  const regular = unprocessed.filter(
    (row) =>
      !mandatoryKeys.has(
        `${row.mountain_id}:${row.primary_country_code}:${row.candidate_country_code}`,
      ),
  );

  const regularSlots = Math.max(0, maxNew - mandatory.length);
  const selectedRegular = regular.slice(0, regularSlots);
  const selectedBase = [...mandatory, ...selectedRegular].sort(compare);

  const selected: Tier2CRow[] = selectedBase.map((row, index) => ({
    ...row,
    tier2c_action: "PRIORITY_PROBE",
    tier2c_rank: index + 1,
    tier2c_selection_reason:
      row.tier1_multi_country_candidate === true
        ? "MULTI_COUNTRY"
        : "TOP_PRIORITY",
  }));

  const selectedKeys = new Set(
    selected.map(
      (row) =>
        `${row.mountain_id}:${row.primary_country_code}:${row.candidate_country_code}`,
    ),
  );
  const deferred = unprocessed.filter(
    (row) =>
      !selectedKeys.has(
        `${row.mountain_id}:${row.primary_country_code}:${row.candidate_country_code}`,
      ),
  );

  writeJsonl(priorityOutputPath, selected);
  writeJsonl(errorOutputPath, errors);
  writeJsonl(deferredOutputPath, deferred);

  const thresholdPriority =
    selected.length > 0 ? Math.min(...selected.map((row) => priority(row))) : null;

  const summary = {
    generated_at: new Date().toISOString(),
    input_rows: rows.length,
    input_breakdown: {
      NO_TIER2_RESULT: unprocessed.length,
      ERROR: errors.length,
    },
    max_new: maxNew,
    mandatory_multi_country_rows: mandatory.length,
    selected_priority_rows: selected.length,
    selected_unique_mountains: new Set(selected.map((row) => row.mountain_id)).size,
    selected_min_priority: thresholdPriority,
    error_retry_rows: errors.length,
    error_retry_unique_mountains: new Set(errors.map((row) => row.mountain_id)).size,
    deferred_rows: deferred.length,
    deferred_unique_mountains: new Set(deferred.map((row) => row.mountain_id)).size,
    selected_preview: selected.slice(0, 20).map((row) => ({
      rank: row.tier2c_rank,
      mountain_id: row.mountain_id,
      mountain_name: row.mountain_name,
      pair: `${row.primary_country_code}->${row.candidate_country_code}`,
      tier2_priority: priority(row),
      distance_to_boundary_meters: row.distance_to_boundary_meters,
      peak_distance_meters: row.tier1_peak_distance_meters ?? null,
      wikidata: row.tier1_peak_wikidata ?? null,
      multi_country: row.tier1_multi_country_candidate ?? false,
      selection_reason: row.tier2c_selection_reason,
    })),
    priority_output: priorityOutputPath,
    error_output: errorOutputPath,
    deferred_output: deferredOutputPath,
    safety:
      "Tier 2C does not re-probe resolved or INSUFFICIENT candidates. Errors are isolated from new priority candidates. Deferred rows remain untouched for later review.",
  };

  writeFileSync(summaryOutputPath, JSON.stringify(summary, null, 2));
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
