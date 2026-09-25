#!/usr/bin/env ts-node
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type VerificationStatus =
  | "VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "ERROR";

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  status: VerificationStatus;
  center_country_codes: string[];
  probe_country_codes: string[];
  evidence_reference: string | null;
  notes: string;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const input = arg(
    "--input",
    "data/border-peaks/global-verification/osm-evidence.jsonl",
  );
  const output = arg(
    "--output",
    "data/border-peaks/global-verification/summary.json",
  );
  if (!existsSync(input)) {
    throw new Error(`Verification input does not exist: ${input}`);
  }

  const counts: Record<VerificationStatus, number> = {
    VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
    CONFLICT: 0,
    INSUFFICIENT: 0,
    ERROR: 0,
  };
  const pairs: Record<string, Record<VerificationStatus, number>> = {};
  const verified: VerificationRow[] = [];
  const conflicts: VerificationRow[] = [];
  const errors: VerificationRow[] = [];
  const lines = createInterface({
    input: createReadStream(input),
    crlfDelay: Infinity,
  });

  let total = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as VerificationRow;
    if (!(row.status in counts)) {
      throw new Error(`Unknown verification status: ${row.status}`);
    }
    total += 1;
    counts[row.status] += 1;
    const pair = [row.primary_country_code, row.candidate_country_code]
      .sort()
      .join("-");
    const pairCounts =
      pairs[pair] ??
      {
        VERIFIED: 0,
        GEOMETRIC_SUPPORT: 0,
        CONFLICT: 0,
        INSUFFICIENT: 0,
        ERROR: 0,
      };
    pairCounts[row.status] += 1;
    pairs[pair] = pairCounts;

    if (row.status === "VERIFIED") verified.push(row);
    if (row.status === "CONFLICT") conflicts.push(row);
    if (row.status === "ERROR") errors.push(row);
  }

  verified.sort(
    (a, b) =>
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );
  conflicts.sort(
    (a, b) =>
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  const pairRows = Object.entries(pairs)
    .map(([pair, value]) => ({ pair, ...value }))
    .sort(
      (a, b) =>
        b.VERIFIED - a.VERIFIED ||
        b.GEOMETRIC_SUPPORT - a.GEOMETRIC_SUPPORT ||
        a.pair.localeCompare(b.pair),
    );

  const result = {
    generated_at: new Date().toISOString(),
    total_rows: total,
    status_counts: counts,
    pair_counts: pairRows,
    verified_rows: verified,
    conflict_rows: conflicts,
    error_rows: errors,
    safety:
      "VERIFIED means independent OSM admin_level=2 evidence; it is not a human APPROVE decision and must not be exported to SQL without the existing review manifest gate.",
  };

  writeFileSync(output, JSON.stringify(result, null, 2));
  process.stdout.write(
    `${JSON.stringify(
      {
        total_rows: total,
        status_counts: counts,
        top_pairs: pairRows.slice(0, 30),
        verified_preview: verified.slice(0, 20),
        conflict_preview: conflicts.slice(0, 20),
        errors: errors.length,
        output,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
