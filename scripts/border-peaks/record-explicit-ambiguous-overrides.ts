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
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
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

  const pending = rows.filter((row) => row.decision == null);
  if (pending.length !== 11) {
    throw new Error(
      `Expected exactly 11 pending rows from the explicit human confirmation, found ${pending.length}`,
    );
  }

  for (const row of pending) {
    if (row.third_source_finding !== "AMBIGUOUS") {
      throw new Error(
        `Pending row ${row.candidate_hash.slice(0, 12)}… is ${row.third_source_finding}, not AMBIGUOUS. Refusing stale bulk override.`,
      );
    }
    if (
      row.reviewed_by != null ||
      row.reviewed_at != null ||
      row.review_notes != null ||
      row.approval_basis != null
    ) {
      throw new Error(
        `Refusing to overwrite reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const reviewedAt = new Date().toISOString();
  for (const row of pending) {
    row.decision = "APPROVE";
    row.reviewed_by = "Human reviewer (explicit ChatGPT confirmation)";
    row.reviewed_at = reviewedAt;
    row.approval_basis = "EXPLICIT_HUMAN_OVERRIDE";
    row.review_notes =
      "Human reviewer explicitly approved this remaining candidate despite AMBIGUOUS third-source evidence. The evidence layer remains unchanged and insufficient to independently prove exact summit dual-country membership; this decision is an auditable human override.";
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      overridden_rows_written: pending.length,
      remaining_pending_rows: rows.filter((row) => row.decision == null).length,
      approve_rows: rows.filter((row) => row.decision === "APPROVE").length,
      reject_rows: rows.filter((row) => row.decision === "REJECT").length,
      reviewed_at: reviewedAt,
      decision_file: path,
      safety:
        "All 11 previously pending AMBIGUOUS rows were explicitly approved by the human reviewer using an auditable EXPLICIT_HUMAN_OVERRIDE. Evidence findings were not changed. No SQL is generated or applied.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
