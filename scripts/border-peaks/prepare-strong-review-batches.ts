#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type StrongStatus = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";

type StrongReviewRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: StrongStatus;
  distance_to_boundary_meters: number | null;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
  review_action: "HUMAN_REVIEW";
  decision: null;
  evidence_url: null;
  evidence_type: null;
  evidence_notes: null;
  reviewed_by: null;
  reviewed_at: null;
};

type BatchedRow = StrongReviewRow & {
  batch_id: string;
  batch_index: number;
  batch_row_index: number;
  machine_evidence_tier: "EXACT_SUMMIT_CONTAINMENT" | "PROBE_GEOMETRIC_SUPPORT";
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function intArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function main(): void {
  const input = arg(
    "--input",
    "data/border-peaks/global-review/strong-human-review.jsonl",
  );
  const outputDir = arg(
    "--output-dir",
    "data/border-peaks/global-review/strong-batches",
  );
  const batchSize = intArg("--batch-size", 100);
  const expected = intArg("--expected", 1372);

  const rows = readJsonl<StrongReviewRow>(input);
  if (rows.length !== expected) {
    throw new Error(
      `Expected exactly ${expected} strong review rows, found ${rows.length}. Regenerate/reconcile the review pack before batching.`,
    );
  }

  const seenHashes = new Set<string>();
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error(`Invalid candidate_hash for mountain ${row.mountain_id}`);
    }
    if (seenHashes.has(row.candidate_hash)) {
      throw new Error(`Duplicate strong candidate hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    seenHashes.add(row.candidate_hash);

    if (
      row.final_machine_status !== "TIER1_VERIFIED" &&
      row.final_machine_status !== "GEOMETRIC_SUPPORT"
    ) {
      throw new Error(
        `Unexpected strong status ${row.final_machine_status} for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.review_action !== "HUMAN_REVIEW" ||
      row.decision != null ||
      row.evidence_url != null ||
      row.evidence_type != null ||
      row.evidence_notes != null ||
      row.reviewed_by != null ||
      row.reviewed_at != null
    ) {
      throw new Error(
        `Strong review input must remain undecided/unmodified for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const groups: StrongReviewRow[][] = [];
  for (const row of rows) {
    const previous = groups.at(-1);
    if (previous && previous[0]?.mountain_id === row.mountain_id) {
      previous.push(row);
    } else {
      groups.push([row]);
    }
  }

  const batches: StrongReviewRow[][] = [];
  let current: StrongReviewRow[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > batchSize) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push(current);

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const batchSummaries = batches.map((batch, index) => {
    const batchIndex = index + 1;
    const batchId = `strong-${String(batchIndex).padStart(3, "0")}`;
    const batched: BatchedRow[] = batch.map((row, rowIndex) => ({
      ...row,
      batch_id: batchId,
      batch_index: batchIndex,
      batch_row_index: rowIndex + 1,
      machine_evidence_tier:
        row.final_machine_status === "TIER1_VERIFIED"
          ? "EXACT_SUMMIT_CONTAINMENT"
          : "PROBE_GEOMETRIC_SUPPORT",
    }));

    writeJsonl(join(outputDir, `${batchId}.jsonl`), batched);

    return {
      batch_id: batchId,
      batch_index: batchIndex,
      rows: batch.length,
      unique_mountains: new Set(batch.map((row) => row.mountain_id)).size,
      tier1_verified: batch.filter((row) => row.final_machine_status === "TIER1_VERIFIED").length,
      geometric_support: batch.filter((row) => row.final_machine_status === "GEOMETRIC_SUPPORT").length,
      min_distance_meters: Math.min(
        ...batch.map((row) => row.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY),
      ),
      max_distance_meters: Math.max(
        ...batch.map((row) => row.distance_to_boundary_meters ?? 0),
      ),
      first_mountain_id: batch[0]?.mountain_id ?? null,
      last_mountain_id: batch.at(-1)?.mountain_id ?? null,
      file: join(outputDir, `${batchId}.jsonl`),
    };
  });

  const summary = {
    generated_at: new Date().toISOString(),
    input,
    expected_rows: expected,
    total_rows: rows.length,
    unique_mountains: new Set(rows.map((row) => row.mountain_id)).size,
    batch_size_target: batchSize,
    batch_count: batches.length,
    status_counts: {
      TIER1_VERIFIED: rows.filter((row) => row.final_machine_status === "TIER1_VERIFIED").length,
      GEOMETRIC_SUPPORT: rows.filter((row) => row.final_machine_status === "GEOMETRIC_SUPPORT").length,
    },
    batches: batchSummaries,
    safety:
      "Read-only review batching only. Mountain groups are never split across batches. No APPROVE/REJECT decisions, SQL, or database writes are created.",
  };

  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
