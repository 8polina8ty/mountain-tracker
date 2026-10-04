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
  classification: "CONFIRMED" | "REVIEW" | "REJECTED";
  evidence_type:
    | "CANDIDATE"
    | "GEOMETRICALLY_SUPPORTED"
    | "EXTERNALLY_VERIFIED"
    | "APPROVED"
    | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
  boundary_license: string | null;
  coordinate_precision_meters: number | null;
  boundary_precision_meters: number | null;
  distance_to_boundary_meters: number | null;
  supporting_external_reference: string | null;
  reason: string;
  review_notes: string | null;
  existing_memberships?: Array<{
    mountain_id: number;
    country_code: string;
    is_primary: boolean;
  }>;
  final_machine_status: FinalMachineStatus;
  tier1_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
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

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJsonl(path: string, rows: unknown[]): void {
  ensureParent(path);
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function candidateShape(row: RegistryRow) {
  return {
    mountain_id: row.mountain_id,
    mountain_name: row.mountain_name,
    latitude: row.latitude,
    longitude: row.longitude,
    height: row.height,
    primary_country_code: row.primary_country_code,
    candidate_country_code: row.candidate_country_code,
    classification: row.classification,
    evidence_type: row.evidence_type,
    boundary_source: row.boundary_source,
    boundary_source_id: row.boundary_source_id,
    boundary_dataset_version: row.boundary_dataset_version,
    boundary_license: row.boundary_license,
    coordinate_precision_meters: row.coordinate_precision_meters,
    boundary_precision_meters: row.boundary_precision_meters,
    distance_to_boundary_meters: row.distance_to_boundary_meters,
    supporting_external_reference: row.supporting_external_reference,
    reason: row.reason,
    review_notes: row.review_notes,
    existing_memberships: row.existing_memberships,
  };
}

function main(): void {
  const registryPath = arg(
    "--registry",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const centerOutput = arg(
    "--center-output",
    "data/border-peaks/global-verification/technical-center-retry.jsonl",
  );
  const probeOutput = arg(
    "--probe-output",
    "data/border-peaks/global-verification/technical-probe-retry.jsonl",
  );
  const summaryOutput = arg(
    "--summary-output",
    "data/border-peaks/global-verification/technical-retry-summary.json",
  );

  const technical = readJsonl<RegistryRow>(registryPath).filter(
    (row) => row.final_machine_status === "TECHNICAL_ERROR",
  );

  const center: RegistryRow[] = [];
  const probe: RegistryRow[] = [];
  const ambiguous: RegistryRow[] = [];

  for (const row of technical) {
    if (row.latest_probe_status === "ERROR") {
      probe.push(row);
    } else if (row.tier1_status === "ERROR") {
      center.push(row);
    } else {
      ambiguous.push(row);
    }
  }

  if (ambiguous.length > 0) {
    throw new Error(
      `Found ${ambiguous.length} TECHNICAL_ERROR rows without an ERROR source; refusing to guess retry mode`,
    );
  }

  const sortRows = (rows: RegistryRow[]) =>
    rows.sort(
      (a, b) =>
        a.mountain_id - b.mountain_id ||
        a.candidate_country_code.localeCompare(b.candidate_country_code),
    );

  writeJsonl(centerOutput, sortRows(center).map(candidateShape));
  writeJsonl(probeOutput, sortRows(probe).map(candidateShape));

  const summary = {
    generated_at: new Date().toISOString(),
    technical_error_rows: technical.length,
    center_retry_rows: center.length,
    center_retry_unique_mountains: new Set(center.map((row) => row.mountain_id)).size,
    probe_retry_rows: probe.length,
    probe_retry_unique_mountains: new Set(probe.map((row) => row.mountain_id)).size,
    ambiguous_rows: ambiguous.length,
    outputs: {
      center_retry: centerOutput,
      probe_retry: probeOutput,
      summary: summaryOutput,
    },
    safety:
      "Queues preserve the immutable candidate fields used by candidateFingerprint. Only TECHNICAL_ERROR rows are included; no approvals or database writes occur.",
  };

  ensureParent(summaryOutput);
  writeFileSync(summaryOutput, JSON.stringify(summary, null, 2));
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
