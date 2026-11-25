#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type Decision = "APPROVE" | "REJECT";

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  third_source_finding: Finding;
  decision: Decision | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const path = arg(
    "--decisions",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);

  const raw = readFileSync(path, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as DecisionRow)
    : [];

  const rejectedEvidenceRows = rows.filter(
    (row) => row.third_source_finding === "DOES_NOT_SUPPORT",
  );
  if (rejectedEvidenceRows.length !== 7) {
    throw new Error(
      `Expected exactly 7 current DOES_NOT_SUPPORT rows from the explicit human rejection, found ${rejectedEvidenceRows.length}. Refusing to apply a stale bulk decision.`,
    );
  }

  for (const row of rejectedEvidenceRows) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error(`Invalid candidate_hash for mountain ${row.mountain_id}`);
    }
    if (
      row.decision != null ||
      row.reviewed_by != null ||
      row.reviewed_at != null ||
      row.review_notes != null
    ) {
      throw new Error(
        `Refusing to overwrite existing human decision for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const reviewedAt = new Date().toISOString();
  for (const row of rejectedEvidenceRows) {
    row.decision = "REJECT";
    row.reviewed_by = "Human reviewer (explicit ChatGPT rejection)";
    row.reviewed_at = reviewedAt;
    row.review_notes =
      "Human reviewer explicitly rejected all 7 current DOES_NOT_SUPPORT candidates after the evidence-backed rejection list was presented for final review.";
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      rejected_rows_written: rejectedEvidenceRows.length,
      remaining_pending_rows: rows.filter((row) => row.decision == null).length,
      reviewed_at: reviewedAt,
      decision_file: path,
      safety:
        "Only the 7 current DOES_NOT_SUPPORT rows were changed from pending to REJECT. Existing decisions are never overwritten; all AMBIGUOUS rows remain pending. No SQL is generated or applied.",
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
