#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type FinalMachineStatus =
  | "TIER1_VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "NEEDS_THIRD_SOURCE"
  | "TECHNICAL_ERROR"
  | "DEFERRED_LOW_PRIORITY";

type RegistryRow = BorderCandidate & {
  candidate_hash: string;
  final_machine_status: FinalMachineStatus;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
};

type StrongDecision = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
  distance_to_boundary_meters: number | null;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

type ThirdDecision = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  third_source_finding: "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

type ExistingMembership = {
  mountain_id: number;
  country_code: string;
};

type DiscoverySummary = {
  boundary_coverage_gaps?: string[];
  existing_memberships_skipped?: number;
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

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function assertIso(value: string | null, label: string, hash: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${label} for ${hash.slice(0, 12)}…`);
  }
}

function assertPair(primary: string | null, candidate: string, hash: string): void {
  if (!primary || !/^[A-Z]{2}$/.test(primary)) {
    throw new Error(`Invalid primary country for ${hash.slice(0, 12)}…`);
  }
  if (!/^[A-Z]{2}$/.test(candidate)) {
    throw new Error(`Invalid candidate country for ${hash.slice(0, 12)}…`);
  }
  if (primary === candidate) {
    throw new Error(`Primary/candidate country collision for ${hash.slice(0, 12)}…`);
  }
}

function assertStrongDecision(row: StrongDecision): void {
  if (row.decision == null) {
    throw new Error(`Pending strong decision ${row.candidate_hash.slice(0, 12)}…`);
  }
  if (!row.reviewed_by || !row.review_notes || !row.decision_batch_id) {
    throw new Error(`Incomplete strong reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`);
  }
  assertIso(row.reviewed_at, "reviewed_at", row.candidate_hash);
  if (row.approval_basis != null) {
    if (
      row.decision !== "APPROVE" ||
      row.approval_basis !== "EXPLICIT_HUMAN_OVERRIDE"
    ) {
      throw new Error(`Invalid strong override for ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (!/(unresolved|insufficient|ambiguous|not independently)/i.test(row.review_notes)) {
      throw new Error(`Strong override notes do not preserve evidence uncertainty for ${row.candidate_hash.slice(0, 12)}…`);
    }
  }
}

function assertThirdDecision(row: ThirdDecision): void {
  if (row.decision == null) {
    throw new Error(`Pending third-source decision ${row.candidate_hash.slice(0, 12)}…`);
  }
  if (!row.reviewed_by || !row.review_notes) {
    throw new Error(`Incomplete third-source reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`);
  }
  assertIso(row.reviewed_at, "reviewed_at", row.candidate_hash);

  if (
    !row.evidence_url ||
    !/^https?:\/\//.test(row.evidence_url) ||
    !row.evidence_type ||
    !row.evidence_title ||
    !row.evidence_authority ||
    !row.evidence_notes
  ) {
    throw new Error(`Incomplete third-source evidence for ${row.candidate_hash.slice(0, 12)}…`);
  }

  if (row.decision === "APPROVE") {
    if (row.third_source_finding === "DOES_NOT_SUPPORT") {
      throw new Error(`DOES_NOT_SUPPORT cannot be approved for ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (row.third_source_finding === "AMBIGUOUS") {
      if (row.approval_basis !== "EXPLICIT_HUMAN_OVERRIDE") {
        throw new Error(`AMBIGUOUS approval lacks EXPLICIT_HUMAN_OVERRIDE for ${row.candidate_hash.slice(0, 12)}…`);
      }
      if (!/(ambiguous|insufficient|unresolved|not independently)/i.test(row.review_notes)) {
        throw new Error(`AMBIGUOUS override notes do not preserve uncertainty for ${row.candidate_hash.slice(0, 12)}…`);
      }
    } else if (row.approval_basis != null) {
      throw new Error(`SUPPORTS approval must not carry override basis for ${row.candidate_hash.slice(0, 12)}…`);
    }
  } else if (row.approval_basis != null) {
    throw new Error(`REJECT must not carry approval_basis for ${row.candidate_hash.slice(0, 12)}…`);
  }
}

function main(): void {
  const candidatesPath = arg(
    "--candidates",
    "data/border-peaks/global-run-v2/candidates.jsonl",
  );
  const registryPath = arg(
    "--registry",
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  );
  const strongQueuePath = arg(
    "--strong-queue",
    "data/border-peaks/global-review/strong-human-review.jsonl",
  );
  const strongDecisionsPath = arg(
    "--strong-decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );
  const thirdQueuePath = arg(
    "--third-queue",
    "data/border-peaks/global-review/needs-third-source.jsonl",
  );
  const thirdDecisionsPath = arg(
    "--third-decisions",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );
  const existingPath = arg(
    "--existing-memberships",
    "data/border-peaks/existing-memberships-global.jsonl",
  );
  const discoverySummaryPath = arg(
    "--discovery-summary",
    "data/border-peaks/global-run-v2/summary.json",
  );
  const coverageGapPath = arg(
    "--coverage-gap-mountains",
    "data/border-peaks/global-review/coverage-gap-mountains.jsonl",
  );
  const outputPath = arg(
    "--output",
    "data/border-peaks/global-review/export-preflight.json",
  );

  const candidates = readJsonl<BorderCandidate>(candidatesPath);
  const registry = readJsonl<RegistryRow>(registryPath);
  const strongQueue = readJsonl<StrongDecision>(strongQueuePath);
  const strongDecisions = readJsonl<StrongDecision>(strongDecisionsPath);
  const thirdQueue = readJsonl<ThirdDecision>(thirdQueuePath);
  const thirdDecisions = readJsonl<ThirdDecision>(thirdDecisionsPath);
  const existing = readJsonl<ExistingMembership>(existingPath);
  const coverageGaps = readJsonl<{ mountain_id: number; primary_country_code: string }>(
    coverageGapPath,
  );
  const discoverySummary = readJson<DiscoverySummary>(discoverySummaryPath);

  if (candidates.length !== 3887 || registry.length !== 3887) {
    throw new Error(
      `Expected 3887 discovery/registry rows, found ${candidates.length}/${registry.length}`,
    );
  }
  if (strongQueue.length !== 1372 || strongDecisions.length !== 1372) {
    throw new Error(
      `Expected 1372 strong queue/decision rows, found ${strongQueue.length}/${strongDecisions.length}`,
    );
  }
  if (thirdQueue.length !== 38 || thirdDecisions.length !== 38) {
    throw new Error(
      `Expected 38 third-source queue/decision rows, found ${thirdQueue.length}/${thirdDecisions.length}`,
    );
  }
  if (existing.length !== 364495) {
    throw new Error(
      `Expected 364495 existing global memberships, found ${existing.length}`,
    );
  }

  const candidateByHash = new Map<string, BorderCandidate>();
  for (const candidate of candidates) {
    const hash = candidateFingerprint(candidate);
    if (candidateByHash.has(hash)) {
      throw new Error(`Duplicate discovery candidate hash ${hash.slice(0, 12)}…`);
    }
    candidateByHash.set(hash, candidate);
  }

  const registryByHash = new Map<string, RegistryRow>();
  const statusCounts: Record<FinalMachineStatus, number> = {
    TIER1_VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
    NEEDS_THIRD_SOURCE: 0,
    TECHNICAL_ERROR: 0,
    DEFERRED_LOW_PRIORITY: 0,
  };

  for (const row of registry) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error("Registry row has invalid candidate_hash");
    }
    if (registryByHash.has(row.candidate_hash)) {
      throw new Error(`Duplicate registry hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    const candidate = candidateByHash.get(row.candidate_hash);
    if (!candidate) {
      throw new Error(`Registry hash missing from discovery candidates: ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (candidateFingerprint(candidate) !== row.candidate_hash) {
      throw new Error(`Registry hash fingerprint mismatch for ${row.candidate_hash.slice(0, 12)}…`);
    }
    for (const field of [
      "mountain_id",
      "mountain_name",
      "latitude",
      "longitude",
      "height",
      "primary_country_code",
      "candidate_country_code",
      "boundary_source",
      "boundary_source_id",
      "boundary_dataset_version",
      "distance_to_boundary_meters",
    ] as const) {
      if (row[field] !== candidate[field]) {
        throw new Error(`Registry/discovery field ${field} mismatch for ${row.candidate_hash.slice(0, 12)}…`);
      }
    }
    statusCounts[row.final_machine_status]++;
    registryByHash.set(row.candidate_hash, row);
  }

  if (registryByHash.size !== candidateByHash.size) {
    throw new Error("Registry does not exactly cover discovery candidate hashes");
  }

  const strongQueueByHash = new Map(strongQueue.map((row) => [row.candidate_hash, row]));
  const thirdQueueByHash = new Map(thirdQueue.map((row) => [row.candidate_hash, row]));
  if (strongQueueByHash.size !== 1372 || thirdQueueByHash.size !== 38) {
    throw new Error("Duplicate hash detected in strong or third-source review queue");
  }

  const strongSeen = new Set<string>();
  const thirdSeen = new Set<string>();
  const approved: Array<{ hash: string; mountain_id: number; country_code: string; layer: "strong" | "third-source" }> = [];
  let strongApprove = 0;
  let strongReject = 0;
  let strongOverrides = 0;

  for (const row of strongDecisions) {
    if (strongSeen.has(row.candidate_hash)) {
      throw new Error(`Duplicate strong decision hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    strongSeen.add(row.candidate_hash);
    assertStrongDecision(row);
    assertPair(row.primary_country_code, row.candidate_country_code, row.candidate_hash);

    const queue = strongQueueByHash.get(row.candidate_hash);
    const registryRow = registryByHash.get(row.candidate_hash);
    if (!queue || !registryRow) {
      throw new Error(`Strong decision missing queue/registry binding for ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (
      registryRow.final_machine_status !== "TIER1_VERIFIED" &&
      registryRow.final_machine_status !== "GEOMETRIC_SUPPORT"
    ) {
      throw new Error(`Strong decision bound to wrong registry status for ${row.candidate_hash.slice(0, 12)}…`);
    }
    for (const field of [
      "mountain_id",
      "mountain_name",
      "primary_country_code",
      "candidate_country_code",
      "final_machine_status",
      "distance_to_boundary_meters",
    ] as const) {
      if (row[field] !== queue[field] || row[field] !== registryRow[field]) {
        throw new Error(`Strong identity field ${field} drifted for ${row.candidate_hash.slice(0, 12)}…`);
      }
    }

    if (row.approval_basis === "EXPLICIT_HUMAN_OVERRIDE") strongOverrides++;
    if (row.decision === "APPROVE") {
      strongApprove++;
      approved.push({
        hash: row.candidate_hash,
        mountain_id: row.mountain_id,
        country_code: row.candidate_country_code,
        layer: "strong",
      });
    } else {
      strongReject++;
    }
  }

  let thirdApprove = 0;
  let thirdReject = 0;
  let thirdOverrides = 0;
  for (const row of thirdDecisions) {
    if (thirdSeen.has(row.candidate_hash)) {
      throw new Error(`Duplicate third-source decision hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    thirdSeen.add(row.candidate_hash);
    if (strongSeen.has(row.candidate_hash)) {
      throw new Error(`Candidate appears in both strong and third-source decision layers: ${row.candidate_hash.slice(0, 12)}…`);
    }
    assertThirdDecision(row);
    assertPair(row.primary_country_code, row.candidate_country_code, row.candidate_hash);

    const queue = thirdQueueByHash.get(row.candidate_hash);
    const registryRow = registryByHash.get(row.candidate_hash);
    if (!queue || !registryRow) {
      throw new Error(`Third-source decision missing queue/registry binding for ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (registryRow.final_machine_status !== "NEEDS_THIRD_SOURCE") {
      throw new Error(`Third-source decision bound to wrong registry status for ${row.candidate_hash.slice(0, 12)}…`);
    }
    for (const field of [
      "mountain_id",
      "mountain_name",
      "primary_country_code",
      "candidate_country_code",
    ] as const) {
      if (row[field] !== queue[field] || row[field] !== registryRow[field]) {
        throw new Error(`Third-source identity field ${field} drifted for ${row.candidate_hash.slice(0, 12)}…`);
      }
    }

    if (row.approval_basis === "EXPLICIT_HUMAN_OVERRIDE") thirdOverrides++;
    if (row.decision === "APPROVE") {
      thirdApprove++;
      approved.push({
        hash: row.candidate_hash,
        mountain_id: row.mountain_id,
        country_code: row.candidate_country_code,
        layer: "third-source",
      });
    } else {
      thirdReject++;
    }
  }

  if (
    strongApprove !== 1320 ||
    strongReject !== 52 ||
    thirdApprove !== 30 ||
    thirdReject !== 8
  ) {
    throw new Error(
      `Unexpected decision totals strong ${strongApprove}/${strongReject}, third ${thirdApprove}/${thirdReject}`,
    );
  }

  if (
    statusCounts.TIER1_VERIFIED + statusCounts.GEOMETRIC_SUPPORT !== 1372 ||
    statusCounts.NEEDS_THIRD_SOURCE !== 38 ||
    statusCounts.TECHNICAL_ERROR !== 0 ||
    statusCounts.DEFERRED_LOW_PRIORITY !== 2477
  ) {
    throw new Error(
      `Unexpected registry status totals: ${JSON.stringify(statusCounts)}`,
    );
  }

  const existingPairs = new Set<string>();
  for (const row of existing) {
    if (
      !Number.isInteger(row.mountain_id) ||
      row.mountain_id <= 0 ||
      !/^[A-Z]{2}$/.test(row.country_code)
    ) {
      throw new Error("Invalid row in existing-memberships-global.jsonl");
    }
    const key = `${row.mountain_id}:${row.country_code}`;
    if (existingPairs.has(key)) {
      throw new Error(`Duplicate existing membership pair ${key}`);
    }
    existingPairs.add(key);
  }

  const approvedPairs = new Set<string>();
  for (const row of approved) {
    const key = `${row.mountain_id}:${row.country_code}`;
    if (approvedPairs.has(key)) {
      throw new Error(`Duplicate approved membership pair ${key}`);
    }
    if (existingPairs.has(key)) {
      throw new Error(`Approved membership already exists in global baseline: ${key}`);
    }
    approvedPairs.add(key);
  }

  const reviewedHashes = new Set([...strongSeen, ...thirdSeen]);
  for (const row of registry) {
    if (
      row.final_machine_status === "DEFERRED_LOW_PRIORITY" &&
      reviewedHashes.has(row.candidate_hash)
    ) {
      throw new Error(`Deferred candidate leaked into human decision layers: ${row.candidate_hash.slice(0, 12)}…`);
    }
  }

  const perMountain = new Map<number, typeof approved>();
  for (const row of approved) {
    const items = perMountain.get(row.mountain_id) ?? [];
    items.push(row);
    perMountain.set(row.mountain_id, items);
  }
  const multiApprovedMountains = [...perMountain.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([mountain_id, rows]) => ({
      mountain_id,
      approved_secondary_country_codes: rows
        .map((row) => row.country_code)
        .sort(),
      rows: rows.length,
    }))
    .sort((a, b) => a.mountain_id - b.mountain_id);

  const gapCodes = [...new Set(discoverySummary.boundary_coverage_gaps ?? [])].sort();
  const expectedGapCodes = [
    "AX","BV","CC","CX","EH","GS","HK","HM","IO","JE","MF","MO","NF","PM","PR","SJ","SX","TF","UM",
  ];
  if (JSON.stringify(gapCodes) !== JSON.stringify(expectedGapCodes)) {
    throw new Error(
      `Boundary source-gap set drifted. Expected ${expectedGapCodes.join(",")}, found ${gapCodes.join(",")}`,
    );
  }
  if (coverageGaps.length !== 78) {
    throw new Error(`Expected 78 mountains in ADM0 source-gap countries, found ${coverageGaps.length}`);
  }

  const totalApproved = strongApprove + thirdApprove;
  const totalRejected = strongReject + thirdReject;
  const totalReviewed = totalApproved + totalRejected;
  if (
    totalApproved !== 1350 ||
    totalRejected !== 60 ||
    totalReviewed !== 1410 ||
    totalReviewed + statusCounts.DEFERRED_LOW_PRIORITY !== 3887
  ) {
    throw new Error("Reviewed/deferred accounting does not close over the 3887-candidate registry");
  }

  const report = {
    generated_at: new Date().toISOString(),
    ready_for_sql_generation: true,
    sql_generated: false,
    database_written: false,
    inputs: {
      discovery_candidates: candidates.length,
      final_machine_registry: registry.length,
      existing_global_memberships: existing.length,
      strong_decisions: strongDecisions.length,
      third_source_decisions: thirdDecisions.length,
    },
    registry_status_counts: statusCounts,
    decisions: {
      strong: {
        approve: strongApprove,
        reject: strongReject,
        explicit_human_overrides: strongOverrides,
      },
      third_source: {
        approve: thirdApprove,
        reject: thirdReject,
        explicit_human_overrides: thirdOverrides,
      },
      combined: {
        approve: totalApproved,
        reject: totalRejected,
        reviewed: totalReviewed,
        deferred_unreviewed: statusCounts.DEFERRED_LOW_PRIORITY,
      },
    },
    export_set: {
      memberships_to_insert: totalApproved,
      duplicate_approved_pairs: 0,
      already_existing_pairs: 0,
      multi_secondary_country_mountains: multiApprovedMountains.length,
      multi_secondary_country_details: multiApprovedMountains,
    },
    discovery_limitations: {
      global_discovery_exhaustive: false,
      adm0_source_gap_country_codes: gapCodes,
      mountains_in_source_gap_countries: coverageGaps.length,
      note:
        "The reviewed export set is internally consistent, but the global discovery cannot be described as exhaustive because 19 ADM0 source codes remain unavailable and 78 database mountains fall in those source-gap countries.",
    },
    safety:
      "Read-only hardened export preflight passed. This report does not generate SQL and performs no database writes. The legacy export-approved.ts is still not authorized for global export until it is hardened to consume these exact global inputs fail-closed.",
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
