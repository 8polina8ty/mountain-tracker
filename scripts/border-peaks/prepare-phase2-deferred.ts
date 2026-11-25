#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type DeferredRow = BorderCandidate & {
  tier2_priority?: number;
  tier2_reasons?: string[];
  tier1_status?: string | null;
  tier1_primary_contained?: boolean;
  tier1_peak_distance_meters?: number | null;
  tier1_peak_wikidata?: string | null;
  tier1_multi_country_candidate?: boolean;
  tier2b_action?: "RETRY_PROBE";
  tier2b_reason?: "NO_TIER2_RESULT" | "ERROR";
  tier2_last_status?: string | null;
};

type RegistryRow = BorderCandidate & {
  candidate_hash: string;
  final_machine_status:
    | "TIER1_VERIFIED"
    | "GEOMETRIC_SUPPORT"
    | "NEEDS_THIRD_SOURCE"
    | "TECHNICAL_ERROR"
    | "DEFERRED_LOW_PRIORITY";
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_queried_at: string | null;
  latest_probe_source: string | null;
  has_successful_probe_evidence: boolean;
  deferred_low_priority: boolean;
  requires_human_approval: true;
};

type CoverageGapRow = {
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  coverage_gap_reason?: string;
};

type Phase2Row = DeferredRow & {
  candidate_hash: string;
  phase2_rank: number;
  phase2_bucket: "P1" | "P2" | "P3";
  phase2_priority_source: "TIER2C_ENRICHMENT" | "REGISTRY_FALLBACK";
  phase2_batch_id: string;
  phase2_action: "OSM_PROBE";
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function intArg(name: string, fallback: number, min: number): number {
  const n = Number(arg(name, String(fallback)));
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.length ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "");
}

function priority(row: DeferredRow): number {
  return row.tier2_priority ?? 0;
}

function distance(row: DeferredRow): number {
  return row.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY;
}

function peakDistance(row: DeferredRow): number {
  return row.tier1_peak_distance_meters ?? Number.POSITIVE_INFINITY;
}

function hasTier2cEnrichment(row: DeferredRow): boolean {
  return row.tier2_priority != null || row.tier2_reasons != null || row.tier2b_reason != null;
}

function bucket(row: DeferredRow): "P1" | "P2" | "P3" {
  if (!hasTier2cEnrichment(row)) return "P3";
  const p = priority(row);
  if (
    p >= 60 ||
    (distance(row) <= 30 && peakDistance(row) <= 25) ||
    row.tier1_multi_country_candidate === true
  ) return "P1";
  if (
    p >= 45 ||
    distance(row) <= 30 ||
    peakDistance(row) <= 25 ||
    row.tier1_peak_wikidata
  ) return "P2";
  return "P3";
}

function bucketRank(value: "P1" | "P2" | "P3"): number {
  return value === "P1" ? 1 : value === "P2" ? 2 : 3;
}

function compare(a: DeferredRow, b: DeferredRow): number {
  return (
    bucketRank(bucket(a)) - bucketRank(bucket(b)) ||
    priority(b) - priority(a) ||
    distance(a) - distance(b) ||
    peakDistance(a) - peakDistance(b) ||
    Number(Boolean(b.tier1_peak_wikidata)) - Number(Boolean(a.tier1_peak_wikidata)) ||
    a.mountain_id - b.mountain_id ||
    a.candidate_country_code.localeCompare(b.candidate_country_code)
  );
}

function main(): void {
  const deferredPath = arg(
    "--deferred",
    "data/border-peaks/global-verification/tier2c-deferred.jsonl",
  );
  const registryPath = arg(
    "--registry",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const coverageGapPath = arg(
    "--coverage-gaps",
    "data/border-peaks/global-review/coverage-gap-mountains.jsonl",
  );
  const outputDir = arg(
    "--output-dir",
    "data/border-peaks/phase2",
  );
  const batchTarget = intArg("--batch-target", 200, 1);

  const tier2cDeferred = readJsonl<DeferredRow>(deferredPath);
  const registry = readJsonl<RegistryRow>(registryPath);
  const coverageGaps = readJsonl<CoverageGapRow>(coverageGapPath);

  if (tier2cDeferred.length !== 1171) {
    throw new Error(`Expected exactly 1171 Tier2C deferred enrichment rows, found ${tier2cDeferred.length}`);
  }
  if (registry.length !== 3887) {
    throw new Error(`Expected exactly 3887 registry rows, found ${registry.length}`);
  }
  if (coverageGaps.length !== 78) {
    throw new Error(`Expected exactly 78 source-gap mountains, found ${coverageGaps.length}`);
  }

  const registryDeferred = registry.filter(
    (row) => row.final_machine_status === "DEFERRED_LOW_PRIORITY",
  );
  if (registryDeferred.length !== 2477) {
    throw new Error(
      `Expected exactly 2477 DEFERRED_LOW_PRIORITY registry rows, found ${registryDeferred.length}`,
    );
  }

  const registryByHash = new Map(registry.map((row) => [row.candidate_hash, row]));
  if (registryByHash.size !== registry.length) {
    throw new Error("Duplicate candidate_hash in final machine registry");
  }

  const tier2cByHash = new Map<string, DeferredRow>();
  for (const row of tier2cDeferred) {
    const hash = candidateFingerprint(row);
    if (tier2cByHash.has(hash)) {
      throw new Error(`Duplicate Tier2C deferred candidate hash ${hash}`);
    }
    const registryRow = registryByHash.get(hash);
    if (!registryRow) {
      throw new Error(`Tier2C deferred row missing from registry: ${hash.slice(0, 12)}…`);
    }
    if (registryRow.final_machine_status !== "DEFERRED_LOW_PRIORITY") {
      throw new Error(
        `Tier2C deferred row has registry status ${registryRow.final_machine_status}: ${hash.slice(0, 12)}…`,
      );
    }
    if (row.tier2b_reason && row.tier2b_reason !== "NO_TIER2_RESULT") {
      throw new Error(
        `Tier2C deferred row is not a clean NO_TIER2_RESULT candidate: ${hash.slice(0, 12)}…`,
      );
    }
    tier2cByHash.set(hash, row);
  }

  const deferred: DeferredRow[] = registryDeferred.map((registryRow) => {
    if (registryRow.has_successful_probe_evidence) {
      throw new Error(
        `Deferred registry row unexpectedly has successful probe evidence: ${registryRow.candidate_hash.slice(0, 12)}…`,
      );
    }
    const enrichment = tier2cByHash.get(registryRow.candidate_hash);
    if (!enrichment) return { ...registryRow };

    return {
      ...registryRow,
      tier2_priority: enrichment.tier2_priority,
      tier2_reasons: enrichment.tier2_reasons,
      tier1_primary_contained: enrichment.tier1_primary_contained,
      tier1_peak_distance_meters: enrichment.tier1_peak_distance_meters,
      tier1_peak_wikidata: enrichment.tier1_peak_wikidata,
      tier1_multi_country_candidate: enrichment.tier1_multi_country_candidate,
      tier2b_action: enrichment.tier2b_action,
      tier2b_reason: enrichment.tier2b_reason,
      tier2_last_status: enrichment.tier2_last_status,
    };
  });

  const enrichedCount = deferred.filter(hasTier2cEnrichment).length;
  if (enrichedCount !== 1171) {
    throw new Error(`Expected 1171 enriched Phase 2 rows, found ${enrichedCount}`);
  }

  const byMountain = new Map<number, DeferredRow[]>();
  for (const row of deferred) {
    const group = byMountain.get(row.mountain_id) ?? [];
    group.push(row);
    byMountain.set(row.mountain_id, group);
  }

  const groups = [...byMountain.values()]
    .map((rows) => rows.sort(compare))
    .sort((a, b) => compare(a[0], b[0]));

  const batches: DeferredRow[][] = [];
  let current: DeferredRow[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > batchTarget) {
      batches.push(current);
      current = [];
    }
    current.push(...group.sort(compare));
  }
  if (current.length) batches.push(current);

  if (batches.flat().length !== deferred.length) {
    throw new Error("Batch row accounting failed");
  }

  const mountainToBatch = new Map<number, string>();
  const allRows: Phase2Row[] = [];
  let rank = 0;

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(join(outputDir, "batches"), { recursive: true });

  const batchSummaries = batches.map((rows, index) => {
    const batchId = `phase2-${String(index + 1).padStart(3, "0")}`;
    const outputRows: Phase2Row[] = rows.map((row) => {
      rank += 1;
      const previous = mountainToBatch.get(row.mountain_id);
      if (previous && previous !== batchId) {
        throw new Error(
          `mountain_id ${row.mountain_id} was split between ${previous} and ${batchId}`,
        );
      }
      mountainToBatch.set(row.mountain_id, batchId);
      return {
        ...row,
        candidate_hash: candidateFingerprint(row),
        phase2_rank: rank,
        phase2_bucket: bucket(row),
        phase2_priority_source: hasTier2cEnrichment(row)
          ? "TIER2C_ENRICHMENT"
          : "REGISTRY_FALLBACK",
        phase2_batch_id: batchId,
        phase2_action: "OSM_PROBE",
      };
    });

    allRows.push(...outputRows);
    writeJsonl(join(outputDir, "batches", `${batchId}.jsonl`), outputRows);

    return {
      batch_id: batchId,
      rows: outputRows.length,
      unique_mountains: new Set(outputRows.map((row) => row.mountain_id)).size,
      bucket_counts: {
        P1: outputRows.filter((row) => row.phase2_bucket === "P1").length,
        P2: outputRows.filter((row) => row.phase2_bucket === "P2").length,
        P3: outputRows.filter((row) => row.phase2_bucket === "P3").length,
      },
      first_rank: outputRows[0]?.phase2_rank ?? null,
      last_rank: outputRows.at(-1)?.phase2_rank ?? null,
    };
  });

  if (allRows.length !== 2477) {
    throw new Error(`Expected 2477 Phase 2 rows after batching, found ${allRows.length}`);
  }
  if (mountainToBatch.size !== byMountain.size) {
    throw new Error("Mountain group accounting failed");
  }

  writeJsonl(join(outputDir, "all.jsonl"), allRows);

  const p1 = allRows.filter((row) => row.phase2_bucket === "P1");
  const p2 = allRows.filter((row) => row.phase2_bucket === "P2");
  const p3 = allRows.filter((row) => row.phase2_bucket === "P3");
  writeJsonl(join(outputDir, "p1.jsonl"), p1);
  writeJsonl(join(outputDir, "p2.jsonl"), p2);
  writeJsonl(join(outputDir, "p3.jsonl"), p3);
  writeJsonl(join(outputDir, "source-gap-backlog.jsonl"), coverageGaps);

  const sourceGapByCountry = Object.fromEntries(
    [...new Set(coverageGaps.map((row) => row.primary_country_code ?? "NULL"))]
      .sort()
      .map((code) => [
        code,
        coverageGaps.filter((row) => (row.primary_country_code ?? "NULL") === code).length,
      ]),
  );

  const multiCandidateMountains = [...byMountain.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([mountainId, rows]) => ({
      mountain_id: mountainId,
      mountain_name: rows[0]?.mountain_name ?? null,
      primary_country_code: rows[0]?.primary_country_code ?? null,
      candidate_country_codes: rows
        .map((row) => row.candidate_country_code)
        .sort(),
      rows: rows.length,
      batch_id: mountainToBatch.get(mountainId),
    }))
    .sort((a, b) => a.mountain_id - b.mountain_id);

  const summary = {
    generated_at: new Date().toISOString(),
    phase: "BORDER_PEAKS_PHASE_2",
    deferred_rows: allRows.length,
    deferred_unique_mountains: byMountain.size,
    tier2c_enrichment_rows: allRows.filter((row) => row.phase2_priority_source === "TIER2C_ENRICHMENT").length,
    registry_fallback_rows: allRows.filter((row) => row.phase2_priority_source === "REGISTRY_FALLBACK").length,
    bucket_counts: {
      P1: p1.length,
      P2: p2.length,
      P3: p3.length,
    },
    bucket_unique_mountains: {
      P1: new Set(p1.map((row) => row.mountain_id)).size,
      P2: new Set(p2.map((row) => row.mountain_id)).size,
      P3: new Set(p3.map((row) => row.mountain_id)).size,
    },
    multi_candidate_mountains: multiCandidateMountains.length,
    multi_candidate_details: multiCandidateMountains,
    batch_target_rows: batchTarget,
    batches: batchSummaries.length,
    batch_summaries: batchSummaries,
    source_gap_mountains: coverageGaps.length,
    source_gap_by_primary_country: sourceGapByCountry,
    outputs: {
      all: join(outputDir, "all.jsonl"),
      p1: join(outputDir, "p1.jsonl"),
      p2: join(outputDir, "p2.jsonl"),
      p3: join(outputDir, "p3.jsonl"),
      batches: join(outputDir, "batches"),
      source_gap_backlog: join(outputDir, "source-gap-backlog.jsonl"),
      summary: join(outputDir, "summary.json"),
    },
    safety:
      "Read-only Phase 2 preparation. The 2477-row final registry is the source of truth; the 1171-row Tier2C deferred file is enrichment only. No candidate is approved or rejected. Every mountain_id group stays in one batch. Source-gap mountains remain a separate backlog until missing ADM0 boundary coverage is obtained. No SQL is generated and no database write is performed.",
  };

  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
