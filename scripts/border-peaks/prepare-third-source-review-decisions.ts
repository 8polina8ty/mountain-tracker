#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type HumanQueueRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  pair: string;
  third_source_finding: Finding;
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  recommended_human_action:
    | "REVIEW_FOR_APPROVAL"
    | "REVIEW_FOR_REJECTION"
    | "MANUAL_RESOLUTION";
};

type DecisionTemplateRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  pair: string;
  third_source_finding: Finding;
  recommended_human_action: HumanQueueRow["recommended_human_action"];
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  decision: null;
  reviewed_by: null;
  reviewed_at: null;
  review_notes: null;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const input = arg(
    "--input",
    "data/border-peaks/global-review/third-source-human-review.jsonl",
  );
  const output = arg(
    "--output",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );

  if (!existsSync(input)) throw new Error(`Required file is missing: ${input}`);
  if (existsSync(output)) {
    throw new Error(
      `Refusing to overwrite existing human decision file: ${output}. Preserve reviewer work; edit or archive it explicitly instead.`,
    );
  }

  const raw = readFileSync(input, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HumanQueueRow)
    : [];

  const seen = new Set<string>();
  const outputRows: DecisionTemplateRow[] = rows.map((row) => {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error(`Invalid candidate_hash for mountain ${row.mountain_id}`);
    }
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate candidate_hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    seen.add(row.candidate_hash);
    if (!row.primary_country_code || !row.candidate_country_code) {
      throw new Error(`Missing country pair for mountain ${row.mountain_id}`);
    }
    if (!row.evidence_url || !row.evidence_type || !row.evidence_notes) {
      throw new Error(`Incomplete evidence for ${row.candidate_hash.slice(0, 12)}…`);
    }

    return {
      candidate_hash: row.candidate_hash,
      mountain_id: row.mountain_id,
      mountain_name: row.mountain_name,
      primary_country_code: row.primary_country_code,
      candidate_country_code: row.candidate_country_code,
      pair: row.pair,
      third_source_finding: row.third_source_finding,
      recommended_human_action: row.recommended_human_action,
      evidence_url: row.evidence_url,
      evidence_type: row.evidence_type,
      evidence_title: row.evidence_title,
      evidence_authority: row.evidence_authority,
      evidence_notes: row.evidence_notes,
      decision: null,
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
    };
  });

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    outputRows.length
      ? `${outputRows.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      decision_template_rows: outputRows.length,
      decisions_prefilled: 0,
      output,
      safety:
        "Human decision template only. No APPROVE/REJECT values are prefilled, existing reviewer work is never overwritten, and this incomplete template must not be passed to the SQL exporter.",
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
