#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type FinalMachineStatus =
  | "TIER1_VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "NEEDS_THIRD_SOURCE"
  | "TECHNICAL_ERROR"
  | "DEFERRED_LOW_PRIORITY";

type RegistryRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  distance_to_boundary_meters: number | null;
  final_machine_status: FinalMachineStatus;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
};

type VerificationRow = {
  candidate_hash: string;
  status: "VERIFIED" | "GEOMETRIC_SUPPORT" | "CONFLICT" | "INSUFFICIENT" | "ERROR";
  mode?: "CENTER" | "PROBE";
  center_country_codes?: string[];
  probe_country_codes?: string[];
  osm_peak?: {
    distance_meters: number;
    name: string | null;
    wikidata: string | null;
  } | null;
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
  priority_reasons: string[];
  multi_country_candidate: boolean;
  candidate_rows_for_mountain: number;
  tier1_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  tier1_primary_contained: boolean;
  tier1_candidate_contained: boolean;
  tier1_center_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  third_source_requirements: string[];
  investigation_status: "PENDING";
  evidence_url: null;
  evidence_type: null;
  evidence_notes: null;
  reviewed_by: null;
  reviewed_at: null;
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonl<T>(path: string, required = true): T[] {
  if (!existsSync(path)) {
    if (required) throw new Error(`Required file is missing: ${path}`);
    return [];
  }
  const raw = readFileSync(path, "utf8").trim();
  return raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)
    : [];
}

function timestamplessLatestCenter(rows: VerificationRow[]): Map<string, VerificationRow> {
  const latest = new Map<string, VerificationRow>();
  for (const row of rows) {
    if ((row.mode ?? "CENTER") !== "CENTER") continue;
    latest.set(row.candidate_hash, row);
  }
  return latest;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function main(): void {
  const registryPath = arg(
    "--registry",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const tier1Path = arg(
    "--tier1",
    "data/border-peaks/global-verification/osm-evidence.jsonl",
  );
  const tier1DeltaPath = arg(
    "--tier1-delta",
    "data/border-peaks/global-verification/osm-evidence-v2-delta.jsonl",
  );
  const tier1RetryPath = arg(
    "--tier1-retry",
    "data/border-peaks/global-verification/osm-evidence-technical-center.jsonl",
  );
  const outputPath = arg(
    "--output",
    "data/border-peaks/global-review/third-source-investigation.jsonl",
  );
  const summaryPath = arg(
    "--summary",
    "data/border-peaks/global-review/third-source-investigation-summary.json",
  );

  const registry = readJsonl<RegistryRow>(registryPath);
  const needsThirdSource = registry.filter(
    (row) => row.final_machine_status === "NEEDS_THIRD_SOURCE",
  );

  const candidateCountByMountain = new Map<number, number>();
  for (const row of registry) {
    candidateCountByMountain.set(
      row.mountain_id,
      (candidateCountByMountain.get(row.mountain_id) ?? 0) + 1,
    );
  }

  const centerEvidence = timestamplessLatestCenter([
    ...readJsonl<VerificationRow>(tier1Path),
    ...readJsonl<VerificationRow>(tier1DeltaPath, false),
    ...readJsonl<VerificationRow>(tier1RetryPath, false),
  ]);

  const queue: InvestigationRow[] = needsThirdSource.map((row) => {
    const evidence = centerEvidence.get(row.candidate_hash);
    const centerCodes = evidence?.center_country_codes ?? [];
    const candidateRowsForMountain =
      candidateCountByMountain.get(row.mountain_id) ?? 1;
    const multiCountryCandidate = candidateRowsForMountain >= 2;
    const distance =
      row.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY;
    const peakDistance =
      evidence?.osm_peak?.distance_meters ?? Number.POSITIVE_INFINITY;

    let priority = 0;
    const reasons: string[] = [];

    if (multiCountryCandidate) {
      priority += 100;
      reasons.push("multi-country/trifinio candidate");
    }
    if (distance <= 10) {
      priority += 40;
      reasons.push("geoBoundaries distance <=10m");
    } else if (distance <= 30) {
      priority += 30;
      reasons.push("geoBoundaries distance <=30m");
    } else if (distance <= 75) {
      priority += 15;
      reasons.push("geoBoundaries distance <=75m");
    }

    const primaryContained =
      row.primary_country_code != null &&
      centerCodes.includes(row.primary_country_code);
    const candidateContained = centerCodes.includes(row.candidate_country_code);

    if (primaryContained) {
      priority += 15;
      reasons.push("OSM center contains primary country");
    }
    if (peakDistance <= 10) {
      priority += 20;
      reasons.push("OSM peak identity <=10m");
    } else if (peakDistance <= 25) {
      priority += 10;
      reasons.push("OSM peak identity <=25m");
    }
    if (evidence?.osm_peak?.wikidata) {
      priority += 5;
      reasons.push("OSM peak has Wikidata identity lead");
    }

    const requirements = [
      "Prefer an official national mapping, cadastral, border-commission, or government gazetteer source independent of OSM and geoBoundaries.",
      "Evidence must support the proposed country membership at the summit/border location, not merely identify the mountain.",
      "If authoritative sources disagree, retain the row for human review and record the disagreement; do not auto-approve.",
    ];
    if (multiCountryCandidate) {
      requirements.unshift(
        "Check all candidate countries for this mountain together because this may be a tri-border or multi-country summit.",
      );
    }

    return {
      candidate_hash: row.candidate_hash,
      mountain_id: row.mountain_id,
      mountain_name: row.mountain_name,
      latitude: row.latitude,
      longitude: row.longitude,
      height: row.height,
      primary_country_code: row.primary_country_code,
      candidate_country_code: row.candidate_country_code,
      pair: `${row.primary_country_code}->${row.candidate_country_code}`,
      distance_to_boundary_meters: row.distance_to_boundary_meters,
      priority,
      priority_reasons: reasons,
      multi_country_candidate: multiCountryCandidate,
      candidate_rows_for_mountain: candidateRowsForMountain,
      tier1_status: row.tier1_status,
      latest_probe_status: row.latest_probe_status,
      latest_probe_source: row.latest_probe_source,
      tier1_primary_contained: primaryContained,
      tier1_candidate_contained: candidateContained,
      tier1_center_country_codes: centerCodes,
      osm_peak_distance_meters: Number.isFinite(peakDistance)
        ? peakDistance
        : null,
      osm_peak_name: evidence?.osm_peak?.name ?? null,
      osm_peak_wikidata: evidence?.osm_peak?.wikidata ?? null,
      third_source_requirements: requirements,
      investigation_status: "PENDING",
      evidence_url: null,
      evidence_type: null,
      evidence_notes: null,
      reviewed_by: null,
      reviewed_at: null,
    };
  });

  queue.sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
        (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  ensureParent(outputPath);
  writeFileSync(
    outputPath,
    queue.length
      ? `${queue.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "",
  );

  const summary = {
    generated_at: new Date().toISOString(),
    investigation_rows: queue.length,
    unique_mountains: new Set(queue.map((row) => row.mountain_id)).size,
    multi_country_rows: queue.filter((row) => row.multi_country_candidate).length,
    multi_country_unique_mountains: new Set(
      queue
        .filter((row) => row.multi_country_candidate)
        .map((row) => row.mountain_id),
    ).size,
    priority_buckets: {
      critical: queue.filter((row) => row.priority >= 100).length,
      high: queue.filter((row) => row.priority >= 60 && row.priority < 100).length,
      normal: queue.filter((row) => row.priority < 60).length,
    },
    preview: queue.slice(0, 20).map((row) => ({
      mountain_id: row.mountain_id,
      mountain_name: row.mountain_name,
      pair: row.pair,
      distance_meters: row.distance_to_boundary_meters,
      priority: row.priority,
      reasons: row.priority_reasons,
      osm_peak_wikidata: row.osm_peak_wikidata,
    })),
    output: outputPath,
    safety:
      "This is an investigation queue only. No row is approved automatically. Third-source evidence must be independent of OSM and geoBoundaries and must specifically support the proposed country membership.",
  };

  ensureParent(summaryPath);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
