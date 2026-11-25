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

  const supported = rows.filter((row) => row.third_source_finding === "SUPPORTS");
  if (supported.length !== 16) {
    throw new Error(
      `Expected exactly 16 current SUPPORTS rows from the explicit human approval, found ${supported.length}. Refusing to apply a stale bulk decision.`,
    );
  }

  for (const row of supported) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error(`Invalid candidate_hash for mountain ${row.mountain_id}`);
    }
    if (row.decision != null || row.reviewed_by != null || row.reviewed_at != null || row.review_notes != null) {
      throw new Error(
        `Refusing to overwrite existing human decision for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const reviewedAt = new Date().toISOString();
  for (const row of supported) {
    row.decision = "APPROVE";
    row.reviewed_by = "Human reviewer (explicit ChatGPT approval)";
    row.reviewed_at = reviewedAt;
    row.review_notes =
      "Human reviewer explicitly approved all 16 current SUPPORTS candidates after the evidence-backed supported list was presented for final review.";
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      approved_rows_written: supported.length,
      remaining_pending_rows: rows.filter((row) => row.decision == null).length,
      reviewed_at: reviewedAt,
      decision_file: path,
      safety:
        "Only the 16 current SUPPORTS rows were changed from pending to APPROVE. Existing decisions are never overwritten; DOES_NOT_SUPPORT and AMBIGUOUS rows remain pending. No SQL is generated or applied.",
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
