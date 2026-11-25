#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

type ManualRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: string;
  distance_to_boundary_meters: number | null;
  review_tier: string;
  review_reasons: string[];
  evidence_source: string;
  probe_status: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  named_review_tier: string;
  named_review_reasons: string[];
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  decision: "APPROVE" | "REJECT" | null;
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
  const manualPath = arg(
    "--manual",
    "data/border-peaks/global-review/geometric-support/named-standard/manual.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  const rows = readJsonl<ManualRow>(manualPath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (rows.length !== 9) {
    throw new Error(`Expected exactly 9 manual review rows, found ${rows.length}`);
  }
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const pending = decisions.filter((row) => row.decision == null);
  if (pending.length !== 9) {
    throw new Error(`Expected exactly 9 pending decisions, found ${pending.length}`);
  }

  const pendingHashes = new Set(pending.map((row) => row.candidate_hash));
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate manual hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    seen.add(row.candidate_hash);

    if (row.named_review_tier !== "STANDARD_MANUAL_REVIEW") {
      throw new Error(
        `Non-manual row found in manual queue: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (!pendingHashes.has(row.candidate_hash)) {
      throw new Error(
        `Manual row is not pending in decision manifest: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const output = rows.map((row, index) => ({
    review_index: index + 1,
    candidate_hash: row.candidate_hash,
    mountain_id: row.mountain_id,
    mountain_name: row.mountain_name,
    pair: row.pair,
    latitude: row.latitude,
    longitude: row.longitude,
    height: row.height,
    distance_to_boundary_meters: row.distance_to_boundary_meters,
    review_tier: row.review_tier,
    named_review_tier: row.named_review_tier,
    named_review_reasons: row.named_review_reasons,
    evidence_source: row.evidence_source,
    probe_status: row.probe_status,
    center_country_codes: row.center_country_codes,
    probe_country_codes: row.probe_country_codes,
    osm_peak_distance_meters: row.osm_peak_distance_meters,
    osm_peak_name: row.osm_peak_name,
    osm_peak_wikidata: row.osm_peak_wikidata,
  }));

  process.stdout.write(
    `${JSON.stringify({
      total_rows: rows.length,
      candidates: output,
      safety:
        "Read-only listing of the final 9 STANDARD_MANUAL_REVIEW candidates. No decisions, SQL, or database writes are performed.",
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
