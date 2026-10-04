#!/usr/bin/env ts-node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  probe_status: string;
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  batch_id: string;
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

function validateHighConfidence(row: BatchRow): void {
  if (
    row.final_machine_status !== "GEOMETRIC_SUPPORT" ||
    row.review_tier !== "HIGH_CONFIDENCE_REVIEW"
  ) {
    throw new Error(
      `Non-high-confidence row encountered: ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
  if (
    row.distance_to_boundary_meters == null ||
    row.distance_to_boundary_meters > 30
  ) {
    throw new Error(
      `Boundary-distance contract failed for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
  if (
    row.osm_peak_distance_meters == null ||
    row.osm_peak_distance_meters > 10 ||
    (!row.osm_peak_name && !row.osm_peak_wikidata)
  ) {
    throw new Error(
      `OSM peak-identity contract failed for ${row.candidate_hash.slice(0, 12)}…`,
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
      `Dual-country probe evidence incomplete for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
}

function main(): void {
  const dir = arg(
    "--dir",
    "data/border-peaks/global-review/geometric-support/batches",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  if (!existsSync(dir)) {
    throw new Error(`Geo batch directory is missing: ${dir}`);
  }

  const decisions = readJsonl<DecisionRow>(decisionsPath);
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const completed = decisions.filter((row) => row.decision != null);
  const pending = decisions.filter((row) => row.decision == null);
  const pendingGeo = pending.filter(
    (row) => row.final_machine_status === "GEOMETRIC_SUPPORT",
  );

  if (
    completed.length !== 894 ||
    pending.length !== 478 ||
    pendingGeo.length !== 478
  ) {
    throw new Error(
      `Expected state after geo-001 approval: completed=894, pending=478, pendingGeo=478; found ${completed.length}/${pending.length}/${pendingGeo.length}`,
    );
  }

  const decisionByHash = new Map(
    decisions.map((row) => [row.candidate_hash, row]),
  );

  const files = readdirSync(dir)
    .filter((name) => /^geo-\d{3}\.jsonl$/.test(name))
    .sort();

  if (files.length !== 8) {
    throw new Error(`Expected exactly 8 geo batch files, found ${files.length}`);
  }

  const eligible: Array<{ batchId: string; rows: BatchRow[] }> = [];
  const skipped: Array<{
    batch_id: string;
    rows: number;
    review_tier: ReviewTier | null;
    reason: string;
  }> = [];

  let pendingHighConfidenceRows = 0;
  let pendingStandardRows = 0;

  for (const file of files) {
    const batchId = file.replace(/\.jsonl$/, "");
    const rows = readJsonl<BatchRow>(join(dir, file));
    if (rows.length === 0) {
      throw new Error(`Refusing empty batch ${batchId}`);
    }

    const tiers = new Set(rows.map((row) => row.review_tier));
    if (tiers.size !== 1) {
      throw new Error(`Batch ${batchId} mixes review tiers`);
    }
    const tier = rows[0]?.review_tier ?? null;

    let hasPending = false;
    let hasCompleted = false;
    const seen = new Set<string>();

    for (const row of rows) {
      if (row.batch_id !== batchId) {
        throw new Error(
          `Batch id mismatch in ${batchId} for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
      if (seen.has(row.candidate_hash)) {
        throw new Error(`Duplicate candidate hash in ${batchId}`);
      }
      seen.add(row.candidate_hash);

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

      if (decision.decision == null) {
        if (
          decision.reviewed_by != null ||
          decision.reviewed_at != null ||
          decision.review_notes != null ||
          decision.decision_batch_id != null
        ) {
          throw new Error(
            `Pending decision has reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`,
          );
        }
        hasPending = true;
      } else {
        hasCompleted = true;
      }
    }

    if (hasPending && hasCompleted) {
      throw new Error(
        `Batch ${batchId} is partially decided; reconcile before mass approval`,
      );
    }

    if (!hasPending) {
      skipped.push({
        batch_id: batchId,
        rows: rows.length,
        review_tier: tier,
        reason: "already_completed",
      });
      continue;
    }

    if (tier === "HIGH_CONFIDENCE_REVIEW") {
      for (const row of rows) validateHighConfidence(row);
      pendingHighConfidenceRows += rows.length;
      eligible.push({ batchId, rows });
      continue;
    }

    if (tier === "STANDARD_REVIEW") {
      pendingStandardRows += rows.length;
      skipped.push({
        batch_id: batchId,
        rows: rows.length,
        review_tier: tier,
        reason: "STANDARD_REVIEW_requires_separate_human_decision",
      });
      continue;
    }

    skipped.push({
      batch_id: batchId,
      rows: rows.length,
      review_tier: tier,
      reason: "THIRD_SOURCE_RECOMMENDED_requires_separate_review",
    });
  }

  if (
    pendingHighConfidenceRows !== 329 ||
    pendingStandardRows !== 149
  ) {
    throw new Error(
      `Expected remaining split HIGH_CONFIDENCE=329 and STANDARD=149; found ${pendingHighConfidenceRows}/${pendingStandardRows}`,
    );
  }

  const now = new Date().toISOString();
  let approvedRows = 0;

  for (const { batchId, rows } of eligible) {
    for (const row of rows) {
      const decision = decisionByHash.get(row.candidate_hash)!;
      decision.decision = "APPROVE";
      decision.reviewed_by =
        "Human reviewer (explicit ChatGPT mass high-confidence geo approval)";
      decision.reviewed_at = now;
      decision.review_notes =
        `Human reviewer explicitly approved all remaining HIGH_CONFIDENCE_REVIEW geo batches in one action. ${batchId} candidate remains GEOMETRIC_SUPPORT but passed the strict high-confidence contract: geoBoundaries <=30m, OSM peak identity <=10m with name/Wikidata, and dual-country probe evidence.`;
      decision.decision_batch_id = batchId;
      approvedRows += 1;
    }
  }

  writeFileSync(
    decisionsPath,
    `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  process.stdout.write(
    `${JSON.stringify({
      approved_batch_ids: eligible.map(({ batchId }) => batchId),
      approved_rows_written: approvedRows,
      high_confidence_contract_valid: true,
      skipped_batches: skipped,
      remaining_pending_rows: decisions.filter((row) => row.decision == null).length,
      remaining_pending_standard_review: pendingStandardRows,
      decision_file: decisionsPath,
      safety:
        "Only the remaining HIGH_CONFIDENCE_REVIEW geo batches were approved. STANDARD_REVIEW and any weaker tiers remain pending. No SQL or database write is performed.",
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
