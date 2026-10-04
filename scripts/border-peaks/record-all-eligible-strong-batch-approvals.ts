#!/usr/bin/env ts-node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";

type BatchRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  machine_evidence_tier:
    | "EXACT_SUMMIT_CONTAINMENT"
    | "PROBE_GEOMETRIC_SUPPORT";
  batch_id: string;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
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
  const dir = arg(
    "--dir",
    "data/border-peaks/global-review/strong-batches",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  if (!existsSync(dir)) throw new Error(`Batch directory is missing: ${dir}`);

  const decisions = readJsonl<DecisionRow>(decisionsPath);
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const decisionByHash = new Map(decisions.map((row) => [row.candidate_hash, row]));

  const batchFiles = readdirSync(dir)
    .filter((name) => /^strong-\d{3}\.jsonl$/.test(name))
    .sort();

  if (batchFiles.length === 0) {
    throw new Error("No strong batch files found");
  }

  const eligible: Array<{ batchId: string; rows: BatchRow[] }> = [];
  const skipped: Array<{
    batch_id: string;
    rows: number;
    tier1_verified: number;
    geometric_support: number;
    reason: string;
  }> = [];

  for (const file of batchFiles) {
    const rows = readJsonl<BatchRow>(join(dir, file));
    if (rows.length === 0) throw new Error(`Refusing empty batch ${file}`);

    const batchId = file.replace(/\.jsonl$/, "");
    const seen = new Set<string>();
    let tier1 = 0;
    let geometric = 0;
    let hasPending = false;
    let hasCompleted = false;

    for (const row of rows) {
      if (row.batch_id !== batchId) {
        throw new Error(`Batch id mismatch in ${file} for ${row.candidate_hash.slice(0, 12)}…`);
      }
      if (seen.has(row.candidate_hash)) {
        throw new Error(`Duplicate candidate hash in ${file}`);
      }
      seen.add(row.candidate_hash);

      if (
        row.final_machine_status === "TIER1_VERIFIED" &&
        row.machine_evidence_tier === "EXACT_SUMMIT_CONTAINMENT"
      ) {
        tier1 += 1;
      } else if (
        row.final_machine_status === "GEOMETRIC_SUPPORT" &&
        row.machine_evidence_tier === "PROBE_GEOMETRIC_SUPPORT"
      ) {
        geometric += 1;
      } else {
        throw new Error(
          `Invalid machine-evidence pairing in ${file} for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }

      const decision = decisionByHash.get(row.candidate_hash);
      if (!decision) {
        throw new Error(`Batch hash missing from decision template: ${row.candidate_hash.slice(0, 12)}…`);
      }
      if (
        decision.mountain_id !== row.mountain_id ||
        decision.primary_country_code !== row.primary_country_code ||
        decision.candidate_country_code !== row.candidate_country_code ||
        decision.pair !== row.pair ||
        decision.final_machine_status !== row.final_machine_status
      ) {
        throw new Error(`Batch/decision identity mismatch for ${row.candidate_hash.slice(0, 12)}…`);
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
        `Batch ${batchId} is partially decided. Refusing mass approval until the batch is reconciled.`,
      );
    }

    if (!hasPending) {
      skipped.push({
        batch_id: batchId,
        rows: rows.length,
        tier1_verified: tier1,
        geometric_support: geometric,
        reason: "already_completed",
      });
      continue;
    }

    if (geometric > 0) {
      skipped.push({
        batch_id: batchId,
        rows: rows.length,
        tier1_verified: tier1,
        geometric_support: geometric,
        reason: "contains_GEOMETRIC_SUPPORT",
      });
      continue;
    }

    if (tier1 !== rows.length) {
      throw new Error(`Unexpected batch composition for ${batchId}`);
    }

    eligible.push({ batchId, rows });
  }

  if (eligible.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        eligible_batches: 0,
        approved_rows_written: 0,
        skipped_batches: skipped,
        remaining_pending_rows: decisions.filter((row) => row.decision == null).length,
        safety:
          "No eligible pending TIER1-only batches were found. GEOMETRIC_SUPPORT batches remain untouched. No SQL or database write is performed.",
      }, null, 2)}\n`,
    );
    return;
  }

  const now = new Date().toISOString();
  let approvedRows = 0;

  for (const { batchId, rows } of eligible) {
    for (const batchRow of rows) {
      const decision = decisionByHash.get(batchRow.candidate_hash)!;
      decision.decision = "APPROVE";
      decision.reviewed_by =
        "Human reviewer (explicit ChatGPT mass TIER1 batch approval)";
      decision.reviewed_at = now;
      decision.review_notes =
        `Human reviewer explicitly approved all remaining eligible TIER1-only batches in one action. ${batchId} candidate has TIER1_VERIFIED exact-summit dual-country containment machine evidence.`;
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
      eligible_batches: eligible.length,
      approved_batch_ids: eligible.map(({ batchId }) => batchId),
      approved_rows_written: approvedRows,
      skipped_batches: skipped,
      remaining_pending_rows: decisions.filter((row) => row.decision == null).length,
      decision_file: decisionsPath,
      safety:
        "Only pending batches composed entirely of TIER1_VERIFIED / EXACT_SUMMIT_CONTAINMENT rows were approved. GEOMETRIC_SUPPORT batches were left pending. No SQL or database write is performed.",
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
