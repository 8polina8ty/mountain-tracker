#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type VerificationStatus =
  | "VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "ERROR";

type FinalMachineStatus =
  | "TIER1_VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "NEEDS_THIRD_SOURCE"
  | "TECHNICAL_ERROR"
  | "DEFERRED_LOW_PRIORITY";

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  status: VerificationStatus;
  mode?: "CENTER" | "PROBE";
  queried_at?: string;
  endpoint?: string;
  center_country_codes?: string[];
  probe_country_codes?: string[];
  evidence_reference?: string | null;
  notes?: string;
};

type RegistryRow = BorderCandidate & {
  candidate_hash: string;
  final_machine_status: FinalMachineStatus;
  tier1_status: VerificationStatus | null;
  best_probe_status: VerificationStatus | null;
  latest_probe_status: VerificationStatus | null;
  latest_probe_queried_at: string | null;
  latest_probe_source: string | null;
  has_successful_probe_evidence: boolean;
  deferred_low_priority: boolean;
  requires_human_approval: true;
};

type EvidenceSource = {
  label: string;
  path: string;
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

function timestamp(row: VerificationRow): number {
  if (!row.queried_at) return 0;
  const value = Date.parse(row.queried_at);
  return Number.isFinite(value) ? value : 0;
}

function evidenceRank(status: VerificationStatus): number {
  switch (status) {
    case "VERIFIED":
      return 5;
    case "GEOMETRIC_SUPPORT":
      return 4;
    case "INSUFFICIENT":
      return 3;
    case "CONFLICT":
      return 2;
    case "ERROR":
      return 1;
  }
}

function main(): void {
  const candidatesPath = arg(
    "--candidates",
    "data/border-peaks/global-run/candidates.jsonl",
  );
  const tier1Path = arg(
    "--tier1",
    "data/border-peaks/global-verification/osm-evidence.jsonl",
  );
  const deferredPath = arg(
    "--deferred",
    "data/border-peaks/global-verification/tier2c-deferred.jsonl",
  );
  const outputPath = arg(
    "--output",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const summaryPath = arg(
    "--summary",
    "data/border-peaks/global-verification/final-machine-summary.json",
  );

  const probeSources: EvidenceSource[] = [
    {
      label: "tier2",
      path: "data/border-peaks/global-verification/osm-evidence-tier2.jsonl",
    },
    {
      label: "tier2b-retry",
      path: "data/border-peaks/global-verification/osm-evidence-tier2b-retry.jsonl",
    },
    {
      label: "tier2c-priority",
      path: "data/border-peaks/global-verification/osm-evidence-tier2c.jsonl",
    },
    {
      label: "tier2c-errors",
      path: "data/border-peaks/global-verification/osm-evidence-tier2c-errors.jsonl",
    },
  ];

  const candidates = readJsonl<BorderCandidate>(candidatesPath);
  const tier1Rows = readJsonl<VerificationRow>(tier1Path);
  const deferredRows = readJsonl<BorderCandidate>(deferredPath, false);

  const candidateByHash = new Map<string, BorderCandidate>();
  for (const candidate of candidates) {
    const hash = candidateFingerprint(candidate);
    if (candidateByHash.has(hash)) {
      throw new Error(`Duplicate candidate hash in discovery input: ${hash}`);
    }
    candidateByHash.set(hash, candidate);
  }

  const latestTier1 = new Map<string, VerificationRow>();
  for (const row of tier1Rows) {
    latestTier1.set(row.candidate_hash, row);
  }

  const probeRowsByHash = new Map<
    string,
    Array<{ row: VerificationRow; source: string }>
  >();
  const sourceStats: Record<string, number> = {};

  for (const source of probeSources) {
    const rows = readJsonl<VerificationRow>(source.path, false);
    sourceStats[source.label] = rows.length;
    for (const row of rows) {
      if (row.mode && row.mode !== "PROBE") continue;
      const list = probeRowsByHash.get(row.candidate_hash) ?? [];
      list.push({ row, source: source.label });
      probeRowsByHash.set(row.candidate_hash, list);
    }
  }

  const deferredHashes = new Set(
    deferredRows.map((candidate) => candidateFingerprint(candidate)),
  );

  const registry: RegistryRow[] = [];
  const counts: Record<FinalMachineStatus, number> = {
    TIER1_VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
    NEEDS_THIRD_SOURCE: 0,
    TECHNICAL_ERROR: 0,
    DEFERRED_LOW_PRIORITY: 0,
  };

  for (const [hash, candidate] of candidateByHash) {
    const tier1 = latestTier1.get(hash) ?? null;
    const probeEntries = probeRowsByHash.get(hash) ?? [];

    const latestProbeEntry =
      probeEntries.length === 0
        ? null
        : [...probeEntries].sort(
            (a, b) =>
              timestamp(b.row) - timestamp(a.row) ||
              evidenceRank(b.row.status) - evidenceRank(a.row.status),
          )[0];

    const bestProbeEntry =
      probeEntries.length === 0
        ? null
        : [...probeEntries].sort(
            (a, b) =>
              evidenceRank(b.row.status) - evidenceRank(a.row.status) ||
              timestamp(b.row) - timestamp(a.row),
          )[0];

    const hasSuccessfulProbeEvidence = probeEntries.some(
      ({ row }) =>
        row.status === "VERIFIED" || row.status === "GEOMETRIC_SUPPORT",
    );

    let finalStatus: FinalMachineStatus;

    if (tier1?.status === "VERIFIED") {
      finalStatus = "TIER1_VERIFIED";
    } else if (hasSuccessfulProbeEvidence) {
      finalStatus = "GEOMETRIC_SUPPORT";
    } else if (
      probeEntries.some(
        ({ row }) => row.status === "INSUFFICIENT" || row.status === "CONFLICT",
      )
    ) {
      finalStatus = "NEEDS_THIRD_SOURCE";
    } else if (
      latestProbeEntry?.row.status === "ERROR" ||
      tier1?.status === "ERROR"
    ) {
      finalStatus = "TECHNICAL_ERROR";
    } else {
      finalStatus = "DEFERRED_LOW_PRIORITY";
    }

    counts[finalStatus] += 1;

    registry.push({
      ...candidate,
      candidate_hash: hash,
      final_machine_status: finalStatus,
      tier1_status: tier1?.status ?? null,
      best_probe_status: bestProbeEntry?.row.status ?? null,
      latest_probe_status: latestProbeEntry?.row.status ?? null,
      latest_probe_queried_at: latestProbeEntry?.row.queried_at ?? null,
      latest_probe_source: latestProbeEntry?.source ?? null,
      has_successful_probe_evidence: hasSuccessfulProbeEvidence,
      deferred_low_priority:
        deferredHashes.has(hash) || finalStatus === "DEFERRED_LOW_PRIORITY",
      requires_human_approval: true,
    });
  }

  registry.sort(
    (a, b) =>
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  writeFileSync(
    outputPath,
    registry.map((row) => JSON.stringify(row)).join("\n") +
      (registry.length ? "\n" : ""),
  );

  const strongRows = registry.filter(
    (row) =>
      row.final_machine_status === "TIER1_VERIFIED" ||
      row.final_machine_status === "GEOMETRIC_SUPPORT",
  );

  const multiCountryByMountain = new Map<number, RegistryRow[]>();
  for (const row of registry) {
    const list = multiCountryByMountain.get(row.mountain_id) ?? [];
    list.push(row);
    multiCountryByMountain.set(row.mountain_id, list);
  }

  const multiCountryMountains = [...multiCountryByMountain.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .map(([mountainId, rows]) => ({
      mountain_id: mountainId,
      mountain_name: rows[0]?.mountain_name ?? null,
      primary_country_code: rows[0]?.primary_country_code ?? null,
      candidates: rows.map((row) => ({
        candidate_country_code: row.candidate_country_code,
        final_machine_status: row.final_machine_status,
      })),
    }))
    .sort((a, b) => a.mountain_id - b.mountain_id);

  const summary = {
    generated_at: new Date().toISOString(),
    candidate_rows: registry.length,
    unique_mountains: new Set(registry.map((row) => row.mountain_id)).size,
    status_counts: counts,
    strong_machine_evidence_rows: strongRows.length,
    strong_machine_evidence_unique_mountains: new Set(
      strongRows.map((row) => row.mountain_id),
    ).size,
    tier1_rows: tier1Rows.length,
    probe_source_rows: sourceStats,
    deferred_manifest_rows: deferredRows.length,
    multi_country_mountains: multiCountryMountains,
    outputs: {
      registry: outputPath,
      summary: summaryPath,
    },
    safety:
      "This registry is machine evidence only. TIER1_VERIFIED and GEOMETRIC_SUPPORT do not equal human APPROVE. SQL export remains gated by the separate hash-bound approval manifest.",
  };

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
