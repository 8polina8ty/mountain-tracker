#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

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
  priority_reasons: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
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
  if (!existsSync(input)) throw new Error(`Required file is missing: ${input}`);

  const raw = readFileSync(input, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as InvestigationRow)
    : [];

  const normal = rows
    .filter((row) => row.priority < 60)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
          (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
        a.mountain_id - b.mountain_id ||
        a.candidate_country_code.localeCompare(b.candidate_country_code),
    );

  process.stdout.write(
    `${JSON.stringify({
      normal_rows: normal.length,
      rows: normal.map((row) => ({
        mountain_id: row.mountain_id,
        mountain_name: row.mountain_name,
        pair: row.pair,
        latitude: row.latitude,
        longitude: row.longitude,
        height: row.height,
        distance_meters: row.distance_to_boundary_meters,
        priority: row.priority,
        reasons: row.priority_reasons,
        osm_peak_distance_meters: row.osm_peak_distance_meters,
        osm_peak_name: row.osm_peak_name,
        osm_peak_wikidata: row.osm_peak_wikidata,
        candidate_hash: row.candidate_hash,
      })),
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
