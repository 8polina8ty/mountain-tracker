#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";

type QueueRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  tier1_status: string | null;
};

type DecisionRow = QueueRow & {
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
  const queuePath = arg(
    "--queue",
    "data/border-peaks/global-review/strong-human-review.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  const queue = readJsonl<QueueRow>(queuePath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (queue.length !== 1372 || decisions.length !== 1372) {
    throw new Error(
      `Expected matching 1372-row queue/decision files, found ${queue.length}/${decisions.length}`,
    );
  }

  const queueByHash = new Map(queue.map((row) => [row.candidate_hash, row]));
  const seen = new Set<string>();

  for (const row of decisions) {
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate decision hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    seen.add(row.candidate_hash);

    const expected = queueByHash.get(row.candidate_hash);
    if (!expected) {
      throw new Error(
        `Decision hash is not in current strong queue: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      row.mountain_id !== expected.mountain_id ||
      row.primary_country_code !== expected.primary_country_code ||
      row.candidate_country_code !== expected.candidate_country_code ||
      row.pair !== expected.pair ||
      row.final_machine_status !== expected.final_machine_status ||
      row.tier1_status !== expected.tier1_status
    ) {
      throw new Error(
        `Queue/decision identity or status mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const completed = decisions.filter((row) => row.decision != null);
  const pending = decisions.filter((row) => row.decision == null);
  const pendingTier1 = pending.filter(
    (row) => row.final_machine_status === "TIER1_VERIFIED",
  );
  const pendingGeometric = pending.filter(
    (row) => row.final_machine_status === "GEOMETRIC_SUPPORT",
  );

  if (
    completed.length !== 800 ||
    completed.some((row) => row.decision !== "APPROVE")
  ) {
    throw new Error(
      `Expected exactly 800 completed APPROVE rows before remainder approval, found completed=${completed.length}`,
    );
  }

  if (
    pending.length !== 572 ||
    pendingTier1.length !== 19 ||
    pendingGeometric.length !== 553
  ) {
    throw new Error(
      `Expected pending=572 with TIER1=19 and GEOMETRIC_SUPPORT=553, found pending=${pending.length}, TIER1=${pendingTier1.length}, GEOMETRIC_SUPPORT=${pendingGeometric.length}`,
    );
  }

  for (const row of pendingTier1) {
    if (row.tier1_status !== "VERIFIED") {
      throw new Error(
        `Pending TIER1 row lacks VERIFIED tier1_status: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      row.reviewed_by != null ||
      row.reviewed_at != null ||
      row.review_notes != null ||
      row.decision_batch_id != null
    ) {
      throw new Error(
        `Pending TIER1 row already has reviewer metadata: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const reviewedAt = new Date().toISOString();
  for (const row of pendingTier1) {
    row.decision = "APPROVE";
    row.reviewed_by =
      "Human reviewer (explicit ChatGPT remaining TIER1 approval)";
    row.reviewed_at = reviewedAt;
    row.review_notes =
      "Human reviewer explicitly approved the remaining TIER1_VERIFIED candidates that were left pending only because they shared mixed batches with GEOMETRIC_SUPPORT rows. Exact-summit dual-country containment is VERIFIED.";
    row.decision_batch_id = "tier1-remainder-after-mixed-batches";
  }

  writeFileSync(
    decisionsPath,
    `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  process.stdout.write(
    `${JSON.stringify({
      approved_rows_written: pendingTier1.length,
      total_tier1_approved: decisions.filter(
        (row) =>
          row.decision === "APPROVE" &&
          row.final_machine_status === "TIER1_VERIFIED",
      ).length,
      remaining_pending_rows: decisions.filter((row) => row.decision == null).length,
      remaining_pending_geometric_support: decisions.filter(
        (row) =>
          row.decision == null &&
          row.final_machine_status === "GEOMETRIC_SUPPORT",
      ).length,
      decision_file: decisionsPath,
      safety:
        "Only the exact 19 remaining TIER1_VERIFIED rows were approved. All 553 GEOMETRIC_SUPPORT rows remain pending. No SQL or database write is performed.",
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
