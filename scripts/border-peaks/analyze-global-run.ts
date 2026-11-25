#!/usr/bin/env ts-node
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type CandidateRow = {
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  classification: "CONFIRMED" | "REVIEW" | "REJECTED";
  distance_to_boundary_meters: number | null;
  review_notes: string | null;
};

type Manifest = {
  coverageGaps: Record<string, string>;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const candidatesPath = arg("--candidates", "data/border-peaks/global-run/candidates.jsonl");
  const mountainsPath = arg("--mountains", "data/border-peaks/mountains-global.jsonl");
  const summaryPath = arg("--summary", "data/border-peaks/global-run/summary.json");
  const manifestPath = arg("--manifest", "data/border-peaks/global-boundaries/source-manifest.json");
  const outputPath = arg("--output", "data/border-peaks/global-run/post-analysis.json");

  for (const path of [candidatesPath, mountainsPath, summaryPath, manifestPath]) {
    if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  }

  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const gapCodes = new Set(Object.keys(manifest.coverageGaps ?? {}));

  const pairCounts: Record<string, number> = {};
  const classificationCounts: Record<string, number> = {};
  const byMountain = new Map<number, CandidateRow[]>();
  const closest: CandidateRow[] = [];

  const candidateLines = createInterface({
    input: createReadStream(candidatesPath),
    crlfDelay: Infinity,
  });
  for await (const line of candidateLines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CandidateRow;
    classificationCounts[row.classification] = (classificationCounts[row.classification] ?? 0) + 1;
    const pair = [row.primary_country_code ?? "??", row.candidate_country_code].sort().join("-");
    pairCounts[pair] = (pairCounts[pair] ?? 0) + 1;

    const list = byMountain.get(row.mountain_id) ?? [];
    list.push(row);
    byMountain.set(row.mountain_id, list);

    closest.push(row);
  }

  closest.sort(
    (a, b) =>
      (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
        (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
      a.mountain_id - b.mountain_id,
  );

  const multiCountryCandidates = [...byMountain.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .map(([mountainId, rows]) => ({
      mountain_id: mountainId,
      mountain_name: rows[0]?.mountain_name ?? null,
      primary_country_code: rows[0]?.primary_country_code ?? null,
      candidate_country_codes: rows.map((row) => row.candidate_country_code).sort(),
      candidate_rows: rows.length,
      min_distance_meters: Math.min(
        ...rows.map((row) => row.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY),
      ),
    }))
    .sort(
      (a, b) =>
        b.candidate_rows - a.candidate_rows ||
        a.min_distance_meters - b.min_distance_meters ||
        a.mountain_id - b.mountain_id,
    );

  const gapCounts: Record<string, number> = {};
  const gapSamples: Record<string, Array<{ id: number; name: string | null }>> = {};
  const mountainLines = createInterface({
    input: createReadStream(mountainsPath),
    crlfDelay: Infinity,
  });
  for await (const line of mountainLines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const code =
      typeof row.primaryCountryCode === "string"
        ? row.primaryCountryCode
        : typeof row.country_code === "string"
          ? row.country_code
          : null;
    if (!code || !gapCodes.has(code)) continue;

    gapCounts[code] = (gapCounts[code] ?? 0) + 1;
    const samples = gapSamples[code] ?? [];
    if (samples.length < 10) {
      samples.push({
        id: Number(row.id),
        name:
          typeof row.name_de === "string"
            ? row.name_de
            : typeof row.name === "string"
              ? row.name
              : null,
      });
      gapSamples[code] = samples;
    }
  }

  const sortedPairs = Object.entries(pairCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([pair, count]) => ({ pair, count }));

  const sourceGapMountains = Object.entries(gapCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([country_code, count]) => ({
      country_code,
      iso3: manifest.coverageGaps[country_code],
      count,
      samples: gapSamples[country_code] ?? [],
    }));

  const result = {
    generated_at: new Date().toISOString(),
    source_summary: summary,
    candidate_rows: Object.values(classificationCounts).reduce((sum, value) => sum + value, 0),
    classification_counts: classificationCounts,
    candidate_pairs: sortedPairs,
    multi_country_candidates: multiCountryCandidates,
    closest_candidates: closest.slice(0, 100),
    source_gap_mountains: sourceGapMountains,
    source_gap_mountain_total: sourceGapMountains.reduce((sum, entry) => sum + entry.count, 0),
  };

  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(
    {
      candidate_rows: result.candidate_rows,
      candidate_pairs: result.candidate_pairs.slice(0, 30),
      multi_country_candidates: result.multi_country_candidates,
      source_gap_mountains: result.source_gap_mountains,
      output: outputPath,
    },
    null,
    2,
  )}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
