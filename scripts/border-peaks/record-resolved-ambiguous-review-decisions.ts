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

type ExplicitDecision = {
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  expected_finding: Exclude<Finding, "AMBIGUOUS">;
  decision: Decision;
  note: string;
};

const EXPLICIT_DECISIONS: ExplicitDecision[] = [
  {
    mountain_id: 331893,
    primary_country_code: "UG",
    candidate_country_code: "CD",
    expected_finding: "SUPPORTS",
    decision: "APPROVE",
    note:
      "Human reviewer explicitly approved Mount Sabyinyo 3rd Peak UG->CD after the upgraded third-source evidence identified the 3rd peak as the Uganda/Rwanda/DRC meeting point.",
  },
  {
    mountain_id: 5991,
    primary_country_code: "ES",
    candidate_country_code: "AD",
    expected_finding: "SUPPORTS",
    decision: "APPROVE",
    note:
      "Human reviewer explicitly approved Tosseta de Vallcivera ES->AD after the upgraded official boundary evidence placed the summit on the Andorra-Spain border sequence.",
  },
  {
    mountain_id: 2737,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    expected_finding: "DOES_NOT_SUPPORT",
    decision: "REJECT",
    note:
      "Human reviewer explicitly rejected Tatzen AT->DE after the upgraded official evidence placed the state boundary along the eastern flank rather than through the summit.",
  },
];

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
    throw new Error(
      `Expected the current 38-row third-source decision file, found ${rows.length}`,
    );
  }

  const targets: Array<{ row: DecisionRow; explicit: ExplicitDecision }> = [];
  for (const explicit of EXPLICIT_DECISIONS) {
    const matches = rows.filter(
      (row) =>
        row.mountain_id === explicit.mountain_id &&
        row.primary_country_code === explicit.primary_country_code &&
        row.candidate_country_code === explicit.candidate_country_code,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one decision row for ${explicit.mountain_id} ${explicit.primary_country_code}->${explicit.candidate_country_code}, found ${matches.length}`,
      );
    }

    const row = matches[0];
    if (row.third_source_finding !== explicit.expected_finding) {
      throw new Error(
        `Expected finding ${explicit.expected_finding} for ${explicit.mountain_id}, found ${row.third_source_finding}. Refusing to apply a stale human decision.`,
      );
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
    targets.push({ row, explicit });
  }

  if (rows.filter((row) => row.decision == null).length !== 15) {
    throw new Error(
      "Expected exactly 15 pending rows before applying the explicit three-case decision batch",
    );
  }

  const reviewedAt = new Date().toISOString();
  for (const { row, explicit } of targets) {
    row.decision = explicit.decision;
    row.reviewed_by = "Human reviewer (explicit ChatGPT decision)";
    row.reviewed_at = reviewedAt;
    row.review_notes = explicit.note;
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      updated_rows: targets.length,
      approved_rows_written: targets.filter(({ explicit }) => explicit.decision === "APPROVE").length,
      rejected_rows_written: targets.filter(({ explicit }) => explicit.decision === "REJECT").length,
      remaining_pending_rows: rows.filter((row) => row.decision == null).length,
      updated: targets.map(({ row, explicit }) => ({
        mountain_id: row.mountain_id,
        mountain_name: row.mountain_name,
        pair: `${row.primary_country_code}->${row.candidate_country_code}`,
        decision: explicit.decision,
      })),
      reviewed_at: reviewedAt,
      decision_file: path,
      safety:
        "Only the three explicitly authorized human decisions are written. Existing decisions are never overwritten; the remaining 12 unresolved rows stay pending. No SQL is generated or applied.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
