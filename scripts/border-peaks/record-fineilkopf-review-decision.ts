#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type Decision = "APPROVE" | "REJECT";

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
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

  if (rows.length !== 38) {
    throw new Error(`Expected 38 decision rows, found ${rows.length}`);
  }

  const matches = rows.filter(
    (row) =>
      row.mountain_id === 12809 &&
      row.primary_country_code === "IT" &&
      row.candidate_country_code === "AT",
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Fineilkopf IT->AT decision row, found ${matches.length}`);
  }

  const row = matches[0];
  if (row.third_source_finding !== "SUPPORTS") {
    throw new Error(
      `Expected Fineilkopf evidence to be SUPPORTS, found ${row.third_source_finding}. Refusing stale approval.`,
    );
  }
  if (
    row.decision != null ||
    row.reviewed_by != null ||
    row.reviewed_at != null ||
    row.review_notes != null
  ) {
    throw new Error(
      `Refusing to overwrite existing Fineilkopf human decision for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
  if (rows.filter((item) => item.decision == null).length !== 12) {
    throw new Error(
      "Expected exactly 12 pending rows before applying the Fineilkopf approval",
    );
  }

  const reviewedAt = new Date().toISOString();
  row.decision = "APPROVE";
  row.reviewed_by = "Human reviewer (explicit ChatGPT approval)";
  row.reviewed_at = reviewedAt;
  row.review_notes =
    "Human reviewer explicitly approved Östlicher Fineilkopf IT->AT after the second evidence-upgrade pass established SUPPORTS from the Austrian state-border description over the Fineilköpfe.";

  writeFileSync(
    path,
    rows.length ? `${rows.map((item) => JSON.stringify(item)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      updated_rows: 1,
      mountain_id: row.mountain_id,
      mountain_name: row.mountain_name,
      pair: "IT->AT",
      decision: row.decision,
      remaining_pending_rows: rows.filter((item) => item.decision == null).length,
      reviewed_at: reviewedAt,
      decision_file: path,
      safety:
        "Only the explicitly authorized Fineilkopf APPROVE decision is written. Existing decisions are never overwritten; the remaining 11 unresolved rows stay pending. No SQL is generated or applied.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
