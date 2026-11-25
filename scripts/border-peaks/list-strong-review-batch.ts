#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type BatchRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
  distance_to_boundary_meters: number | null;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  machine_evidence_tier:
    | "EXACT_SUMMIT_CONTAINMENT"
    | "PROBE_GEOMETRIC_SUPPORT";
  batch_id: string;
  batch_index: number;
  batch_row_index: number;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const rawBatch = arg("--batch", "1");
  const batch = Number(rawBatch);
  if (!Number.isInteger(batch) || batch <= 0) {
    throw new Error("--batch must be a positive integer");
  }

  const dir = arg(
    "--dir",
    "data/border-peaks/global-review/strong-batches",
  );
  const batchId = `strong-${String(batch).padStart(3, "0")}`;
  const path = join(dir, `${batchId}.jsonl`);
  if (!existsSync(path)) {
    throw new Error(`Batch file is missing: ${path}`);
  }

  const raw = readFileSync(path, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as BatchRow)
    : [];

  process.stdout.write(
    `${JSON.stringify({
      batch_id: batchId,
      rows: rows.length,
      unique_mountains: new Set(rows.map((row) => row.mountain_id)).size,
      tier1_verified: rows.filter((row) => row.final_machine_status === "TIER1_VERIFIED").length,
      geometric_support: rows.filter((row) => row.final_machine_status === "GEOMETRIC_SUPPORT").length,
      candidates: rows.map((row) => ({
        candidate_hash: row.candidate_hash,
        mountain_id: row.mountain_id,
        mountain_name: row.mountain_name,
        pair: row.pair,
        latitude: row.latitude,
        longitude: row.longitude,
        height: row.height,
        distance_to_boundary_meters: row.distance_to_boundary_meters,
        final_machine_status: row.final_machine_status,
        machine_evidence_tier: row.machine_evidence_tier,
        tier1_status: row.tier1_status,
        best_probe_status: row.best_probe_status,
        latest_probe_status: row.latest_probe_status,
        latest_probe_source: row.latest_probe_source,
      })),
      safety:
        "Read-only batch display. No decisions, evidence, SQL, or database state are changed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
