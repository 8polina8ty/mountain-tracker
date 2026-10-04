#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type InvestigationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  priority: number;
};

type ThirdSourceEvidenceEntry = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: null;
  source_url: null;
  source_type: null;
  source_title: null;
  source_authority: null;
  evidence_notes: null;
  checked_by: null;
  checked_at: null;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const input = arg(
    "--input",
    "data/border-peaks/global-review/third-source-investigation.jsonl",
  );
  const output = arg(
    "--output",
    "data/border-peaks/global-review/third-source-evidence.jsonl",
  );

  if (!existsSync(input)) throw new Error(`Required file is missing: ${input}`);
  const raw = readFileSync(input, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as InvestigationRow)
    : [];

  const seen = new Set<string>();
  const manifest: ThirdSourceEvidenceEntry[] = rows.map((row) => {
    if (!row.candidate_hash) throw new Error("Investigation row is missing candidate_hash");
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate investigation candidate_hash: ${row.candidate_hash}`);
    }
    seen.add(row.candidate_hash);
    if (!row.primary_country_code) {
      throw new Error(`Missing primary country for mountain ${row.mountain_id}`);
    }
    return {
      candidate_hash: row.candidate_hash,
      mountain_id: row.mountain_id,
      primary_country_code: row.primary_country_code,
      candidate_country_code: row.candidate_country_code,
      finding: null,
      source_url: null,
      source_type: null,
      source_title: null,
      source_authority: null,
      evidence_notes: null,
      checked_by: null,
      checked_at: null,
    };
  });

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    manifest.length
      ? `${manifest.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      investigation_rows: rows.length,
      manifest_rows: manifest.length,
      output,
      safety:
        "Template only. All findings and evidence fields are null; this file is not an approval manifest and cannot generate SQL by itself.",
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
