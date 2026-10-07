#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type VerificationStatus =
  | "VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "ERROR";

type Phase2BatchRow = BorderCandidate & {
  candidate_hash: string;
  phase2_rank: number;
  phase2_bucket: "P1" | "P2" | "P3";
  phase2_priority_source: "TIER2C_ENRICHMENT" | "REGISTRY_FALLBACK";
  phase2_batch_id: string;
  phase2_action: "OSM_PROBE";
};

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  status: VerificationStatus;
  mode: "CENTER" | "PROBE";
  provider: "OpenStreetMap/Overpass";
  queried_at: string;
  endpoint: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak: {
    type: "node";
    id: number;
    lat: number;
    lon: number;
    distance_meters: number;
    name: string | null;
    wikidata: string | null;
  } | null;
  evidence_reference: string | null;
  notes: string;
};

type TriageRow = Phase2BatchRow & {
  latest_status: VerificationStatus;
  latest_queried_at: string;
  latest_endpoint: string;
  latest_notes: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  triage_action:
    | "HUMAN_REVIEW_GEOMETRIC_SUPPORT"
    | "THIRD_SOURCE_OR_MANUAL_REVIEW"
    | "RETRY_TECHNICAL";
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)
    : [];
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function main(): void {
  const batchId = arg("--batch-id", "phase2-001");
  if (!/^phase2-\d{3}$/.test(batchId)) {
    throw new Error("--batch-id must match phase2-NNN");
  }
  const batchPath = arg(
    "--batch",
    `data/border-peaks/phase2/batches/${batchId}.jsonl`,
  );
  const evidencePath = arg(
    "--evidence",
    `data/border-peaks/phase2/evidence-${batchId}.jsonl`,
  );
  const outputDir = arg(
    "--output-dir",
    `data/border-peaks/phase2/triage/${batchId}`,
  );

  const batch = readJsonl<Phase2BatchRow>(batchPath);
  const evidence = readJsonl<VerificationRow>(evidencePath);

  if (batch.length < 1 || batch.length > 201) {
    throw new Error(`Expected a bounded Phase 2 batch with 1-201 rows, found ${batch.length}`);
  }

  const batchByHash = new Map<string, Phase2BatchRow>();
  for (const row of batch) {
    const recomputed = candidateFingerprint(row);
    if (recomputed !== row.candidate_hash) {
      throw new Error(
        `Batch candidate hash mismatch for mountain ${row.mountain_id}: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (row.phase2_batch_id !== batchId) {
      throw new Error(
        `Unexpected phase2_batch_id ${row.phase2_batch_id} for mountain ${row.mountain_id}`,
      );
    }
    if (batchByHash.has(row.candidate_hash)) {
      throw new Error(`Duplicate candidate hash in batch: ${row.candidate_hash}`);
    }
    batchByHash.set(row.candidate_hash, row);
  }

  const latestByHash = new Map<string, VerificationRow>();
  const evidenceCountsByHash = new Map<string, number>();

  for (const row of evidence) {
    if (row.mode !== "PROBE") continue;

    const batchRow = batchByHash.get(row.candidate_hash);
    if (!batchRow) {
      throw new Error(
        `Evidence contains candidate outside ${batchId}: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      row.mountain_id !== batchRow.mountain_id ||
      row.mountain_name !== batchRow.mountain_name ||
      row.primary_country_code !== batchRow.primary_country_code ||
      row.candidate_country_code !== batchRow.candidate_country_code
    ) {
      throw new Error(
        `Evidence identity mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    evidenceCountsByHash.set(
      row.candidate_hash,
      (evidenceCountsByHash.get(row.candidate_hash) ?? 0) + 1,
    );

    const previous = latestByHash.get(row.candidate_hash);
    if (
      !previous ||
      timestamp(row.queried_at) > timestamp(previous.queried_at)
    ) {
      latestByHash.set(row.candidate_hash, row);
    }
  }

  const missingEvidence = [...batchByHash.keys()].filter(
    (hash) => !latestByHash.has(hash),
  );
  if (missingEvidence.length > 0) {
    throw new Error(
      `Missing latest probe evidence for ${missingEvidence.length} batch candidates`,
    );
  }

  const rows: TriageRow[] = batch.map((batchRow) => {
    const latest = latestByHash.get(batchRow.candidate_hash)!;

    let triageAction: TriageRow["triage_action"];
    if (
      latest.status === "VERIFIED" ||
      latest.status === "GEOMETRIC_SUPPORT"
    ) {
      const primary = batchRow.primary_country_code;
      const secondary = batchRow.candidate_country_code;
      if (!primary) {
        throw new Error(
          `Successful evidence has no primary country for ${batchRow.candidate_hash.slice(0, 12)}…`,
        );
      }
      const centerSupportsBoth =
        latest.center_country_codes.includes(primary) &&
        latest.center_country_codes.includes(secondary);
      const probesSupportBoth =
        latest.probe_country_codes.includes(primary) &&
        latest.probe_country_codes.includes(secondary);

      if (
        (latest.status === "VERIFIED" && !centerSupportsBoth) ||
        (latest.status === "GEOMETRIC_SUPPORT" && !probesSupportBoth)
      ) {
        throw new Error(
          `Successful status is not backed by the required dual-country evidence for ${batchRow.candidate_hash.slice(0, 12)}…`,
        );
      }
      triageAction = "HUMAN_REVIEW_GEOMETRIC_SUPPORT";
    } else if (
      latest.status === "INSUFFICIENT" ||
      latest.status === "CONFLICT"
    ) {
      triageAction = "THIRD_SOURCE_OR_MANUAL_REVIEW";
    } else {
      triageAction = "RETRY_TECHNICAL";
    }

    return {
      ...batchRow,
      latest_status: latest.status,
      latest_queried_at: latest.queried_at,
      latest_endpoint: latest.endpoint,
      latest_notes: latest.notes,
      center_country_codes: latest.center_country_codes,
      probe_country_codes: latest.probe_country_codes,
      osm_peak_distance_meters: latest.osm_peak?.distance_meters ?? null,
      osm_peak_name: latest.osm_peak?.name ?? null,
      osm_peak_wikidata: latest.osm_peak?.wikidata ?? null,
      triage_action: triageAction,
    };
  });

  const successful = rows.filter(
    (row) => row.triage_action === "HUMAN_REVIEW_GEOMETRIC_SUPPORT",
  );
  const needsReview = rows.filter(
    (row) => row.triage_action === "THIRD_SOURCE_OR_MANUAL_REVIEW",
  );
  const technical = rows.filter(
    (row) => row.triage_action === "RETRY_TECHNICAL",
  );

  writeJsonl(`${outputDir}/all.jsonl`, rows);
  writeJsonl(`${outputDir}/successful-geometric.jsonl`, successful);
  writeJsonl(`${outputDir}/needs-third-source-or-manual.jsonl`, needsReview);
  writeJsonl(`${outputDir}/technical-unresolved.jsonl`, technical);

  const latestStatusCounts = {
    VERIFIED: rows.filter((row) => row.latest_status === "VERIFIED").length,
    GEOMETRIC_SUPPORT: rows.filter(
      (row) => row.latest_status === "GEOMETRIC_SUPPORT",
    ).length,
    CONFLICT: rows.filter((row) => row.latest_status === "CONFLICT").length,
    INSUFFICIENT: rows.filter((row) => row.latest_status === "INSUFFICIENT").length,
    ERROR: rows.filter((row) => row.latest_status === "ERROR").length,
  };

  const retryHistoryRows = [...evidenceCountsByHash.values()].filter(
    (count) => count > 1,
  ).length;

  const technicalErrorGroups = Object.entries(
    technical.reduce<Record<string, number>>((acc, row) => {
      const key = row.latest_notes || "(empty error notes)";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([notes, count]) => ({ notes, count }))
    .sort((a, b) => b.count - a.count || a.notes.localeCompare(b.notes));

  const summary = {
    generated_at: new Date().toISOString(),
    batch_id: batchId,
    batch_rows: batch.length,
    raw_evidence_rows: evidence.filter((row) => row.mode === "PROBE").length,
    unique_evidence_candidates: latestByHash.size,
    candidates_with_retry_history: retryHistoryRows,
    latest_status_counts: latestStatusCounts,
    triage_counts: {
      successful_geometric: successful.length,
      needs_third_source_or_manual: needsReview.length,
      technical_unresolved: technical.length,
    },
    technical_error_groups: technicalErrorGroups.slice(0, 20),
    outputs: {
      all: `${outputDir}/all.jsonl`,
      successful_geometric: `${outputDir}/successful-geometric.jsonl`,
      needs_third_source_or_manual:
        `${outputDir}/needs-third-source-or-manual.jsonl`,
      technical_unresolved: `${outputDir}/technical-unresolved.jsonl`,
      summary: `${outputDir}/summary.json`,
    },
    safety:
      "Read-only Phase 2 triage. Latest probe result per candidate hash wins. VERIFIED/GEOMETRIC_SUPPORT remain evidence only and require human review. INSUFFICIENT/CONFLICT route to third-source/manual review. ERROR remains technical retry. No approvals, SQL, or database writes are produced.",
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/summary.json`, JSON.stringify(summary, null, 2));
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
