#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  status: "VERIFIED" | "GEOMETRIC_SUPPORT" | "CONFLICT" | "INSUFFICIENT" | "ERROR";
  mode?: "CENTER" | "PROBE";
  center_country_codes: string[];
  osm_peak: {
    distance_meters: number;
    wikidata: string | null;
  } | null;
};

type Tier2Candidate = BorderCandidate & {
  tier2_priority: number;
  tier2_reasons: string[];
  tier1_status: VerificationRow["status"];
  tier1_primary_contained: boolean;
  tier1_peak_distance_meters: number | null;
  tier1_peak_wikidata: string | null;
  tier1_multi_country_candidate: boolean;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function main(): void {
  const candidatesPath = arg(
    "--candidates",
    "data/border-peaks/global-run/candidates.jsonl",
  );
  const evidencePath = arg(
    "--evidence",
    "data/border-peaks/global-verification/osm-evidence.jsonl",
  );
  const outputPath = arg(
    "--output",
    "data/border-peaks/global-verification/tier2-queue.jsonl",
  );

  const candidates = readJsonl<BorderCandidate>(candidatesPath);
  const evidenceRows = readJsonl<VerificationRow>(evidencePath);

  const latestCenter = new Map<string, VerificationRow>();
  for (const row of evidenceRows) {
    if ((row.mode ?? "CENTER") !== "CENTER") continue;
    latestCenter.set(row.candidate_hash, row);
  }

  const candidateCountByMountain = new Map<number, number>();
  for (const candidate of candidates) {
    candidateCountByMountain.set(
      candidate.mountain_id,
      (candidateCountByMountain.get(candidate.mountain_id) ?? 0) + 1,
    );
  }

  const queue: Tier2Candidate[] = [];
  const skipped = {
    no_tier1: 0,
    not_insufficient: 0,
    weak_signal: 0,
  };

  for (const candidate of candidates) {
    const hash = candidateFingerprint(candidate);
    const evidence = latestCenter.get(hash);
    if (!evidence) {
      skipped.no_tier1 += 1;
      continue;
    }
    if (evidence.status !== "INSUFFICIENT") {
      skipped.not_insufficient += 1;
      continue;
    }

    const distance = candidate.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY;
    const peakDistance = evidence.osm_peak?.distance_meters ?? Number.POSITIVE_INFINITY;
    const primaryContained =
      candidate.primary_country_code != null &&
      evidence.center_country_codes.includes(candidate.primary_country_code);
    const hasWikidata = Boolean(evidence.osm_peak?.wikidata);
    const multiCountry = (candidateCountByMountain.get(candidate.mountain_id) ?? 0) >= 2;

    let priority = 0;
    const reasons: string[] = [];

    if (multiCountry) {
      priority += 100;
      reasons.push("multi-country/trifinio candidate");
    }
    if (distance <= 10) {
      priority += 40;
      reasons.push("geoBoundaries distance <=10m");
    } else if (distance <= 30) {
      priority += 30;
      reasons.push("geoBoundaries distance <=30m");
    }
    if (peakDistance <= 10) {
      priority += 30;
      reasons.push("OSM peak identity <=10m");
    } else if (peakDistance <= 25) {
      priority += 20;
      reasons.push("OSM peak identity <=25m");
    }
    if (primaryContained) {
      priority += 15;
      reasons.push("OSM contains primary country");
    }
    if (hasWikidata) {
      priority += 10;
      reasons.push("OSM peak has Wikidata");
    }

    const strongEnough =
      multiCountry ||
      (distance <= 30 && peakDistance <= 25) ||
      (distance <= 30 && primaryContained) ||
      (peakDistance <= 25 && primaryContained && hasWikidata);

    if (!strongEnough) {
      skipped.weak_signal += 1;
      continue;
    }

    queue.push({
      ...candidate,
      tier2_priority: priority,
      tier2_reasons: reasons,
      tier1_status: evidence.status,
      tier1_primary_contained: primaryContained,
      tier1_peak_distance_meters: Number.isFinite(peakDistance)
        ? peakDistance
        : null,
      tier1_peak_wikidata: evidence.osm_peak?.wikidata ?? null,
      tier1_multi_country_candidate: multiCountry,
    });
  }

  queue.sort(
    (a, b) =>
      b.tier2_priority - a.tier2_priority ||
      (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
        (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  writeFileSync(
    outputPath,
    queue.map((row) => JSON.stringify(row)).join("\n") + (queue.length ? "\n" : ""),
  );

  const byPriority = {
    high: queue.filter((row) => row.tier2_priority >= 100).length,
    medium: queue.filter(
      (row) => row.tier2_priority >= 60 && row.tier2_priority < 100,
    ).length,
    normal: queue.filter((row) => row.tier2_priority < 60).length,
  };

  process.stdout.write(
    `${JSON.stringify(
      {
        tier2_queue_rows: queue.length,
        unique_mountains: new Set(queue.map((row) => row.mountain_id)).size,
        priority_buckets: byPriority,
        skipped,
        preview: queue.slice(0, 20).map((row) => ({
          mountain_id: row.mountain_id,
          mountain_name: row.mountain_name,
          pair: `${row.primary_country_code}->${row.candidate_country_code}`,
          distance_meters: row.distance_to_boundary_meters,
          priority: row.tier2_priority,
          reasons: row.tier2_reasons,
        })),
        output: outputPath,
      },
      null,
      2,
    )}\n`,
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
