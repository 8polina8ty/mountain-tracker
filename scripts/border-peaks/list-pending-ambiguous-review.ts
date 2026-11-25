#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  pair: string;
  third_source_finding: "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  decision: "APPROVE" | "REJECT" | null;
};

type InvestigationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  distance_to_boundary_meters: number | null;
  priority: number;
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
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
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );
  const investigationPath = arg(
    "--investigation",
    "data/border-peaks/global-review/third-source-investigation.jsonl",
  );

  const decisions = readJsonl<DecisionRow>(decisionsPath);
  const investigation = readJsonl<InvestigationRow>(investigationPath);
  const byHash = new Map(investigation.map((row) => [row.candidate_hash, row]));

  const rows = decisions
    .filter(
      (row) => row.decision == null && row.third_source_finding === "AMBIGUOUS",
    )
    .map((row) => {
      const investigationRow = byHash.get(row.candidate_hash);
      if (!investigationRow) {
        throw new Error(
          `Missing investigation row for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
      return {
        candidate_hash: row.candidate_hash,
        mountain_id: row.mountain_id,
        mountain_name: row.mountain_name,
        pair: row.pair,
        latitude: investigationRow.latitude,
        longitude: investigationRow.longitude,
        height: investigationRow.height,
        distance_meters: investigationRow.distance_to_boundary_meters,
        priority: investigationRow.priority,
        osm_peak_distance_meters: investigationRow.osm_peak_distance_meters,
        osm_peak_name: investigationRow.osm_peak_name,
        osm_peak_wikidata: investigationRow.osm_peak_wikidata,
        current_evidence_url: row.evidence_url,
        current_evidence_type: row.evidence_type,
        current_evidence_title: row.evidence_title,
        current_evidence_authority: row.evidence_authority,
        current_evidence_notes: row.evidence_notes,
      };
    });

  const expectedIndex = process.argv.indexOf("--expected");
  if (expectedIndex >= 0) {
    const expected = Number(process.argv[expectedIndex + 1]);
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error("--expected must be a non-negative integer");
    }
    if (rows.length !== expected) {
      throw new Error(
        `Expected exactly ${expected} current pending AMBIGUOUS rows, found ${rows.length}`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ambiguous_pending_rows: rows.length,
      rows,
      safety: "Read-only listing. No evidence, decision, SQL, or database state is changed.",
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
