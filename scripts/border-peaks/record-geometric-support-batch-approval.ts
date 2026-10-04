#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type ReviewTier =
  | "HIGH_CONFIDENCE_REVIEW"
  | "STANDARD_REVIEW"
  | "THIRD_SOURCE_RECOMMENDED";

type BatchRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  review_tier: ReviewTier;
  review_reasons: string[];
  evidence_source: string;
  probe_status: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  batch_id: string;
  batch_index: number;
  batch_row_index: number;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
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

function main(): void {
  const rawBatch = arg("--batch", "");
  const batchNumber = Number(rawBatch);
  if (!Number.isInteger(batchNumber) || batchNumber <= 0) {
    throw new Error("--batch must be an explicitly supplied positive integer");
  }

  const batchId = `geo-${String(batchNumber).padStart(3, "0")}`;
  const batchPath = join(
    arg(
      "--dir",
      "data/border-peaks/global-review/geometric-support/batches",
    ),
    `${batchId}.jsonl`,
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  const batch = readJsonl<BatchRow>(batchPath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }
  if (batch.length === 0) {
    throw new Error(`Refusing to approve empty batch ${batchId}`);
  }

  const decisionByHash = new Map(
    decisions.map((row) => [row.candidate_hash, row]),
  );
  const seen = new Set<string>();

  for (const row of batch) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error(`Invalid candidate hash in ${batchId}`);
    }
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate candidate hash in ${batchId}`);
    }
    seen.add(row.candidate_hash);

    if (row.batch_id !== batchId) {
      throw new Error(
        `Batch id mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.final_machine_status !== "GEOMETRIC_SUPPORT" ||
      row.review_tier !== "HIGH_CONFIDENCE_REVIEW"
    ) {
      throw new Error(
        `${batchId} contains a non-high-confidence GEOMETRIC_SUPPORT row: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.distance_to_boundary_meters == null ||
      row.distance_to_boundary_meters > 30
    ) {
      throw new Error(
        `High-confidence boundary-distance contract failed for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.osm_peak_distance_meters == null ||
      row.osm_peak_distance_meters > 10 ||
      (!row.osm_peak_name && !row.osm_peak_wikidata)
    ) {
      throw new Error(
        `High-confidence OSM peak-identity contract failed for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.probe_status !== "GEOMETRIC_SUPPORT" &&
      row.probe_status !== "VERIFIED"
    ) {
      throw new Error(
        `Unexpected probe status for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      !row.primary_country_code ||
      !row.probe_country_codes.includes(row.primary_country_code) ||
      !row.probe_country_codes.includes(row.candidate_country_code)
    ) {
      throw new Error(
        `Dual-country probe evidence is incomplete for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    const decision = decisionByHash.get(row.candidate_hash);
    if (!decision) {
      throw new Error(
        `Batch hash missing from decision manifest: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    for (const field of [
      "mountain_id",
      "mountain_name",
      "latitude",
      "longitude",
      "height",
      "primary_country_code",
      "candidate_country_code",
      "pair",
      "final_machine_status",
      "distance_to_boundary_meters",
    ] as const) {
      if (decision[field] !== row[field]) {
        throw new Error(
          `Batch/decision field ${field} mismatch for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
    }

    if (
      decision.decision != null ||
      decision.reviewed_by != null ||
      decision.reviewed_at != null ||
      decision.review_notes != null ||
      decision.decision_batch_id != null
    ) {
      throw new Error(
        `Refusing to overwrite existing decision for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const now = new Date().toISOString();
  for (const hash of seen) {
    const decision = decisionByHash.get(hash)!;
    decision.decision = "APPROVE";
    decision.reviewed_by =
      "Human reviewer (explicit ChatGPT geo batch approval)";
    decision.reviewed_at = now;
    decision.review_notes =
      `Human reviewer explicitly approved ${batchId}. Candidate remains GEOMETRIC_SUPPORT rather than exact dual-containment, but passed the HIGH_CONFIDENCE_REVIEW contract: geoBoundaries <=30m, OSM peak identity <=10m with name/Wikidata, and dual-country probe evidence.`;
    decision.decision_batch_id = batchId;
  }

  writeFileSync(
    decisionsPath,
    `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  process.stdout.write(
    `${JSON.stringify({
      batch_id: batchId,
      approved_rows_written: batch.length,
      high_confidence_contract_valid: true,
      remaining_pending_rows: decisions.filter((row) => row.decision == null)
        .length,
      remaining_pending_geometric_support: decisions.filter(
        (row) =>
          row.decision == null &&
          row.final_machine_status === "GEOMETRIC_SUPPORT",
      ).length,
      decision_file: decisionsPath,
      safety:
        "Only the explicitly authorized HIGH_CONFIDENCE_REVIEW geo batch was approved. GEOMETRIC_SUPPORT evidence classification is preserved. No SQL or database write is performed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
