#!/usr/bin/env ts-node
/**
 * Hardened deterministic SQL export for the global border-peak review.
 *
 * This script only writes a SQL artifact. It never connects to Supabase and
 * never executes SQL. Generation is fail-closed and requires a fresh,
 * hash-bound successful global export preflight.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { BorderCandidate } from "./types.ts";

type Decision = "APPROVE" | "REJECT";

type StrongDecision = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
  decision: Decision | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

type ThirdSourceDecision = {
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
  decision: Decision | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

type ExistingMembership = {
  mountain_id: number;
  country_code: string;
  is_primary?: boolean;
};

type PreflightReport = {
  generated_at: string;
  ready_for_sql_generation: boolean;
  sql_generated: boolean;
  database_written: boolean;
  inputs: {
    discovery_candidates: number;
    final_machine_registry: number;
    existing_global_memberships: number;
    strong_decisions: number;
    third_source_decisions: number;
  };
  input_sha256: {
    discovery_candidates: string;
    final_machine_registry: string;
    strong_queue: string;
    strong_decisions: string;
    third_source_queue: string;
    third_source_decisions: string;
    existing_global_memberships: string;
    discovery_summary: string;
    coverage_gap_mountains: string;
  };
  decisions: {
    strong: {
      approve: number;
      reject: number;
      explicit_human_overrides: number;
    };
    third_source: {
      approve: number;
      reject: number;
      explicit_human_overrides: number;
    };
    combined: {
      approve: number;
      reject: number;
      reviewed: number;
      deferred_unreviewed: number;
    };
  };
  export_set: {
    memberships_to_insert: number;
    duplicate_approved_pairs: number;
    already_existing_pairs: number;
  };
  discovery_limitations: {
    global_discovery_exhaustive: boolean;
    adm0_source_gap_country_codes: string[];
    mountains_in_source_gap_countries: number;
  };
};

type ApprovedRow = {
  candidate: BorderCandidate;
  candidate_hash: string;
  reviewed_by: string;
  layer: "strong" | "third-source";
  approval_basis: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

type Paths = {
  candidates: string;
  registry: string;
  strongQueue: string;
  strongDecisions: string;
  thirdQueue: string;
  thirdDecisions: string;
  existing: string;
  discoverySummary: string;
  coverageGaps: string;
  preflight: string;
  output: string;
};

const DEFAULT_PATHS: Paths = {
  candidates: "data/border-peaks/global-run-v2/candidates.jsonl",
  registry:
    "data/border-peaks/global-verification/final-machine-registry.jsonl",
  strongQueue:
    "data/border-peaks/global-review/strong-human-review.jsonl",
  strongDecisions:
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  thirdQueue:
    "data/border-peaks/global-review/needs-third-source.jsonl",
  thirdDecisions:
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  existing: "data/border-peaks/existing-memberships-global.jsonl",
  discoverySummary: "data/border-peaks/global-run-v2/summary.json",
  coverageGaps:
    "data/border-peaks/global-review/coverage-gap-mountains.jsonl",
  preflight: "data/border-peaks/global-review/export-preflight.json",
  output:
    "database/generated/mountain_countries_global_reviewed_batch.sql",
};

export function candidateFingerprint(c: BorderCandidate): string {
  const payload = {
    mountain_id: c.mountain_id,
    mountain_name: c.mountain_name,
    latitude: c.latitude,
    longitude: c.longitude,
    height: c.height,
    primary_country_code: c.primary_country_code,
    candidate_country_code: c.candidate_country_code,
    boundary_source: c.boundary_source,
    boundary_source_id: c.boundary_source_id,
    boundary_dataset_version: c.boundary_dataset_version,
    distance_to_boundary_meters: c.distance_to_boundary_meters,
    supporting_external_reference: c.supporting_external_reference,
    evidence_type: c.evidence_type,
  };
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(json).digest("hex");
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function resolvePaths(): Paths {
  return {
    candidates: arg("--candidates", DEFAULT_PATHS.candidates),
    registry: arg("--registry", DEFAULT_PATHS.registry),
    strongQueue: arg("--strong-queue", DEFAULT_PATHS.strongQueue),
    strongDecisions: arg(
      "--strong-decisions",
      DEFAULT_PATHS.strongDecisions,
    ),
    thirdQueue: arg("--third-queue", DEFAULT_PATHS.thirdQueue),
    thirdDecisions: arg(
      "--third-decisions",
      DEFAULT_PATHS.thirdDecisions,
    ),
    existing: arg("--existing-memberships", DEFAULT_PATHS.existing),
    discoverySummary: arg(
      "--discovery-summary",
      DEFAULT_PATHS.discoverySummary,
    ),
    coverageGaps: arg(
      "--coverage-gap-mountains",
      DEFAULT_PATHS.coverageGaps,
    ),
    preflight: arg("--preflight", DEFAULT_PATHS.preflight),
    output: arg("--output", DEFAULT_PATHS.output),
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    throw new Error(`Required file is missing: ${path}`);
  }
  const raw = readFileSync(path, "utf8").trim();
  return raw
    ? raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`Required file is missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fileSha256(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`Required file is missing: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Preflight is missing a valid SHA-256 for ${label}`);
  }
}

function assertIso(value: string | null, label: string, hash: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${label} for ${hash.slice(0, 12)}…`);
  }
}

function assertPair(
  primary: string | null,
  candidate: string,
  hash: string,
): asserts primary is string {
  if (!primary || !/^[A-Z]{2}$/.test(primary)) {
    throw new Error(`Invalid primary country for ${hash.slice(0, 12)}…`);
  }
  if (!/^[A-Z]{2}$/.test(candidate)) {
    throw new Error(`Invalid candidate country for ${hash.slice(0, 12)}…`);
  }
  if (primary === candidate) {
    throw new Error(
      `Primary/candidate country collision for ${hash.slice(0, 12)}…`,
    );
  }
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableText(value: string | null): string {
  return value == null ? "null" : `${sqlText(value)}::text`;
}

function sqlNullableNumber(value: number | null): string {
  return value == null ? "null" : `${value}::numeric`;
}

function sourceFor(candidate: BorderCandidate): string {
  const raw = `border-review:${candidate.boundary_source || "unknown"}`;
  return raw.slice(0, 64);
}

function assertPreflight(
  report: PreflightReport,
  paths: Paths,
): void {
  if (
    report.ready_for_sql_generation !== true ||
    report.sql_generated !== false ||
    report.database_written !== false
  ) {
    throw new Error(
      "Global export preflight is not in the required ready/read-only state",
    );
  }

  if (
    report.inputs.discovery_candidates !== 3887 ||
    report.inputs.final_machine_registry !== 3887 ||
    report.inputs.existing_global_memberships !== 364495 ||
    report.inputs.strong_decisions !== 1372 ||
    report.inputs.third_source_decisions !== 38
  ) {
    throw new Error("Global export preflight input counts do not match the reviewed contract");
  }

  if (
    report.decisions.strong.approve !== 1320 ||
    report.decisions.strong.reject !== 52 ||
    report.decisions.strong.explicit_human_overrides !== 7 ||
    report.decisions.third_source.approve !== 30 ||
    report.decisions.third_source.reject !== 8 ||
    report.decisions.third_source.explicit_human_overrides !== 11 ||
    report.decisions.combined.approve !== 1350 ||
    report.decisions.combined.reject !== 60 ||
    report.decisions.combined.reviewed !== 1410 ||
    report.decisions.combined.deferred_unreviewed !== 2477
  ) {
    throw new Error("Global export preflight decision totals do not match the reviewed contract");
  }

  if (
    report.export_set.memberships_to_insert !== 1350 ||
    report.export_set.duplicate_approved_pairs !== 0 ||
    report.export_set.already_existing_pairs !== 0
  ) {
    throw new Error("Global export preflight export-set checks are not clean");
  }

  if (
    report.discovery_limitations.global_discovery_exhaustive !== false ||
    report.discovery_limitations.mountains_in_source_gap_countries !== 78 ||
    report.discovery_limitations.adm0_source_gap_country_codes.length !== 19
  ) {
    throw new Error("Global discovery limitation metadata drifted");
  }

  const expectedHashes: Record<
    keyof PreflightReport["input_sha256"],
    string
  > = {
    discovery_candidates: fileSha256(paths.candidates),
    final_machine_registry: fileSha256(paths.registry),
    strong_queue: fileSha256(paths.strongQueue),
    strong_decisions: fileSha256(paths.strongDecisions),
    third_source_queue: fileSha256(paths.thirdQueue),
    third_source_decisions: fileSha256(paths.thirdDecisions),
    existing_global_memberships: fileSha256(paths.existing),
    discovery_summary: fileSha256(paths.discoverySummary),
    coverage_gap_mountains: fileSha256(paths.coverageGaps),
  };

  for (const key of Object.keys(expectedHashes) as Array<
    keyof typeof expectedHashes
  >) {
    const recorded = report.input_sha256?.[key];
    assertSha256(recorded, key);
    if (recorded !== expectedHashes[key]) {
      throw new Error(
        `Stale preflight: SHA-256 mismatch for ${key}. Re-run border-peaks:preflight-global-export before exporting SQL.`,
      );
    }
  }
}

function validateStrongDecision(
  row: StrongDecision,
  candidate: BorderCandidate,
): void {
  if (row.decision !== "APPROVE" && row.decision !== "REJECT") {
    throw new Error(
      `Incomplete/invalid strong decision for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
  assertPair(
    row.primary_country_code,
    row.candidate_country_code,
    row.candidate_hash,
  );
  assertIso(row.reviewed_at, "reviewed_at", row.candidate_hash);
  if (!row.reviewed_by || !row.review_notes || !row.decision_batch_id) {
    throw new Error(
      `Incomplete strong reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    candidate.mountain_id !== row.mountain_id ||
    candidate.mountain_name !== row.mountain_name ||
    candidate.primary_country_code !== row.primary_country_code ||
    candidate.candidate_country_code !== row.candidate_country_code
  ) {
    throw new Error(
      `Strong decision/candidate identity mismatch for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (row.approval_basis != null) {
    if (
      row.decision !== "APPROVE" ||
      row.approval_basis !== "EXPLICIT_HUMAN_OVERRIDE"
    ) {
      throw new Error(
        `Invalid strong approval_basis for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      !/(unresolved|insufficient|ambiguous|not independently)/i.test(
        row.review_notes,
      )
    ) {
      throw new Error(
        `Strong override does not preserve evidence uncertainty for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }
}

function validateThirdDecision(
  row: ThirdSourceDecision,
  candidate: BorderCandidate,
): void {
  if (row.decision !== "APPROVE" && row.decision !== "REJECT") {
    throw new Error(
      `Incomplete/invalid third-source decision for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
  assertPair(
    row.primary_country_code,
    row.candidate_country_code,
    row.candidate_hash,
  );
  assertIso(row.reviewed_at, "reviewed_at", row.candidate_hash);

  if (
    !row.reviewed_by ||
    !row.review_notes ||
    !row.evidence_url ||
    !/^https?:\/\//.test(row.evidence_url) ||
    !row.evidence_type ||
    !row.evidence_title ||
    !row.evidence_authority ||
    !row.evidence_notes
  ) {
    throw new Error(
      `Incomplete third-source review/evidence for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    candidate.mountain_id !== row.mountain_id ||
    candidate.mountain_name !== row.mountain_name ||
    candidate.primary_country_code !== row.primary_country_code ||
    candidate.candidate_country_code !== row.candidate_country_code
  ) {
    throw new Error(
      `Third-source decision/candidate identity mismatch for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    row.decision === "APPROVE" &&
    row.third_source_finding === "DOES_NOT_SUPPORT"
  ) {
    throw new Error(
      `DOES_NOT_SUPPORT cannot be approved for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    row.decision === "APPROVE" &&
    row.third_source_finding === "AMBIGUOUS"
  ) {
    if (row.approval_basis !== "EXPLICIT_HUMAN_OVERRIDE") {
      throw new Error(
        `AMBIGUOUS approval lacks EXPLICIT_HUMAN_OVERRIDE for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      !/(ambiguous|insufficient|unresolved|not independently)/i.test(
        row.review_notes,
      )
    ) {
      throw new Error(
        `AMBIGUOUS override notes do not preserve uncertainty for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  } else if (
    row.decision === "APPROVE" &&
    row.third_source_finding === "SUPPORTS" &&
    row.approval_basis != null
  ) {
    throw new Error(
      `SUPPORTS approval must not use an override for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (row.decision === "REJECT" && row.approval_basis != null) {
    throw new Error(
      `REJECT must not carry approval_basis for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
}

function buildRuntimeValues(rows: ApprovedRow[]): string {
  return rows
    .map(({ candidate }) =>
      [
        "(",
        `${candidate.mountain_id}::bigint, `,
        `${sqlNullableText(candidate.mountain_name)}, `,
        `${sqlNullableNumber(candidate.height)}, `,
        `${sqlText(candidate.primary_country_code!)}::text, `,
        `${sqlText(candidate.candidate_country_code)}::text`,
        ")",
      ].join(""),
    )
    .join(",\n      ");
}

function buildSql(
  rows: ApprovedRow[],
  report: PreflightReport,
  paths: Paths,
): string {
  const runtimeValues = buildRuntimeValues(rows);
  const generatedAt = new Date().toISOString();

  const inserts = rows
    .map(({ candidate, candidate_hash, reviewed_by, layer, approval_basis }) => {
      const source = sourceFor(candidate);
      const reviewer = reviewed_by.replace(/[\r\n]+/g, " ").slice(0, 80);
      const basis =
        approval_basis === "EXPLICIT_HUMAN_OVERRIDE"
          ? " override=EXPLICIT_HUMAN_OVERRIDE"
          : "";
      return [
        "insert into public.mountain_countries ",
        "(mountain_id, country_code, is_primary, source) values ",
        `(${candidate.mountain_id}, ${sqlText(candidate.candidate_country_code)}, false, ${sqlText(source)}) `,
        "on conflict (mountain_id, country_code) do nothing;",
        ` -- hash=${candidate_hash.slice(0, 12)} layer=${layer} reviewed_by=${reviewer}${basis}`,
      ].join("");
    })
    .join("\n");

  return `-- GENERATED — GLOBAL BORDER-PEAK REVIEW — DO NOT APPLY WITHOUT LIVE PRODUCTION PREFLIGHT
-- Generated: ${generatedAt}
-- Approved memberships: ${rows.length}
-- Human decisions: 1320 strong approvals + 30 third-source approvals
-- Rejections excluded: 60
-- Deferred candidates excluded: 2477
-- Discovery limitation: NOT globally exhaustive; 19 ADM0 source-gap codes / 78 mountains.
-- Preflight report: ${paths.preflight}
-- Preflight generated_at: ${report.generated_at}
-- Discovery SHA-256: ${report.input_sha256.discovery_candidates}
-- Strong decisions SHA-256: ${report.input_sha256.strong_decisions}
-- Third-source decisions SHA-256: ${report.input_sha256.third_source_decisions}
-- Existing memberships SHA-256: ${report.input_sha256.existing_global_memberships}
--
-- This artifact contains SQL only. The generator does not connect to Supabase.
-- Runtime guards abort the transaction if a mountain identity changed or if
-- any target secondary membership already exists before this transaction.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $border_peak_preflight$
declare
  expected record;
begin
  for expected in
    select *
    from (values
      ${runtimeValues}
    ) as approved(id, name, height, primary_country_code, candidate_country_code)
  loop
    if not exists (
      select 1
      from public.mountains m
      where m.id = expected.id
        and m.name is not distinct from expected.name
        and m.height is not distinct from expected.height
        and m.country_code is not distinct from expected.primary_country_code
    ) then
      raise exception
        'Global border export BLOCKED: mountain identity drift for id % (% -> %)',
        expected.id,
        expected.primary_country_code,
        expected.candidate_country_code;
    end if;

    if exists (
      select 1
      from public.mountain_countries mc
      where mc.mountain_id = expected.id
        and mc.country_code = expected.candidate_country_code
    ) then
      raise exception
        'Global border export BLOCKED: membership already exists for mountain % country %',
        expected.id,
        expected.candidate_country_code;
    end if;
  end loop;
end;
$border_peak_preflight$;

${inserts}

do $border_peak_postflight$
declare
  actual_count integer;
begin
  select count(*)
  into actual_count
  from (values
      ${runtimeValues}
  ) as approved(id, name, height, primary_country_code, candidate_country_code)
  join public.mountain_countries mc
    on mc.mountain_id = approved.id
   and mc.country_code = approved.candidate_country_code
   and mc.is_primary = false;

  if actual_count <> ${rows.length} then
    raise exception
      'Global border export BLOCKED: expected % reviewed secondary memberships after insert, found %',
      ${rows.length},
      actual_count;
  end if;
end;
$border_peak_postflight$;

commit;
`;
}

export function runExport(paths: Paths = resolvePaths()): void {
  const report = readJson<PreflightReport>(paths.preflight);
  assertPreflight(report, paths);

  const candidates = readJsonl<BorderCandidate>(paths.candidates);
  const strongDecisions = readJsonl<StrongDecision>(
    paths.strongDecisions,
  );
  const thirdDecisions = readJsonl<ThirdSourceDecision>(
    paths.thirdDecisions,
  );
  const existing = readJsonl<ExistingMembership>(paths.existing);

  if (
    candidates.length !== 3887 ||
    strongDecisions.length !== 1372 ||
    thirdDecisions.length !== 38 ||
    existing.length !== 364495
  ) {
    throw new Error(
      `Global export input counts drifted: candidates=${candidates.length}, strong=${strongDecisions.length}, third=${thirdDecisions.length}, existing=${existing.length}`,
    );
  }

  const candidateByHash = new Map<string, BorderCandidate>();
  for (const candidate of candidates) {
    const hash = candidateFingerprint(candidate);
    if (candidateByHash.has(hash)) {
      throw new Error(
        `Duplicate discovery candidate hash ${hash.slice(0, 12)}…`,
      );
    }
    candidateByHash.set(hash, candidate);
  }

  const approved: ApprovedRow[] = [];
  const seenDecisionHashes = new Set<string>();
  let strongApprove = 0;
  let strongReject = 0;
  let thirdApprove = 0;
  let thirdReject = 0;

  for (const row of strongDecisions) {
    if (
      !/^[a-f0-9]{64}$/.test(row.candidate_hash) ||
      seenDecisionHashes.has(row.candidate_hash)
    ) {
      throw new Error("Invalid or duplicate strong decision hash");
    }
    seenDecisionHashes.add(row.candidate_hash);

    const candidate = candidateByHash.get(row.candidate_hash);
    if (!candidate) {
      throw new Error(
        `Strong decision hash missing from discovery: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (candidateFingerprint(candidate) !== row.candidate_hash) {
      throw new Error(
        `Strong candidate fingerprint mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    // Validate both APPROVE and REJECT before branching.
    validateStrongDecision(row, candidate);

    if (row.decision === "APPROVE") {
      strongApprove++;
      approved.push({
        candidate,
        candidate_hash: row.candidate_hash,
        reviewed_by: row.reviewed_by!,
        layer: "strong",
        approval_basis: row.approval_basis ?? null,
      });
    } else {
      strongReject++;
    }
  }

  for (const row of thirdDecisions) {
    if (
      !/^[a-f0-9]{64}$/.test(row.candidate_hash) ||
      seenDecisionHashes.has(row.candidate_hash)
    ) {
      throw new Error("Invalid, duplicate, or cross-layer decision hash");
    }
    seenDecisionHashes.add(row.candidate_hash);

    const candidate = candidateByHash.get(row.candidate_hash);
    if (!candidate) {
      throw new Error(
        `Third-source decision hash missing from discovery: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (candidateFingerprint(candidate) !== row.candidate_hash) {
      throw new Error(
        `Third-source candidate fingerprint mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    // Validate both APPROVE and REJECT before branching.
    validateThirdDecision(row, candidate);

    if (row.decision === "APPROVE") {
      thirdApprove++;
      approved.push({
        candidate,
        candidate_hash: row.candidate_hash,
        reviewed_by: row.reviewed_by!,
        layer: "third-source",
        approval_basis: row.approval_basis ?? null,
      });
    } else {
      thirdReject++;
    }
  }

  if (
    strongApprove !== 1320 ||
    strongReject !== 52 ||
    thirdApprove !== 30 ||
    thirdReject !== 8 ||
    approved.length !== 1350
  ) {
    throw new Error(
      `Decision totals drifted: strong=${strongApprove}/${strongReject}, third=${thirdApprove}/${thirdReject}, approved=${approved.length}`,
    );
  }

  const existingPairs = new Set<string>();
  for (const row of existing) {
    if (
      !Number.isInteger(row.mountain_id) ||
      row.mountain_id <= 0 ||
      !/^[A-Z]{2}$/.test(row.country_code)
    ) {
      throw new Error("Invalid global existing-membership row");
    }
    const key = `${row.mountain_id}:${row.country_code}`;
    if (existingPairs.has(key)) {
      throw new Error(`Duplicate global existing-membership pair ${key}`);
    }
    existingPairs.add(key);
  }

  const approvedPairs = new Set<string>();
  for (const row of approved) {
    const { candidate } = row;
    assertPair(
      candidate.primary_country_code,
      candidate.candidate_country_code,
      row.candidate_hash,
    );

    if (
      !Number.isInteger(candidate.mountain_id) ||
      candidate.mountain_id <= 0
    ) {
      throw new Error(
        `Invalid mountain_id ${candidate.mountain_id} for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (!candidate.boundary_source || !candidate.boundary_source_id) {
      throw new Error(
        `Missing boundary provenance for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    const key = `${candidate.mountain_id}:${candidate.candidate_country_code}`;
    if (approvedPairs.has(key)) {
      throw new Error(`Duplicate approved membership pair ${key}`);
    }
    if (existingPairs.has(key)) {
      throw new Error(
        `Approved membership already exists in global baseline: ${key}`,
      );
    }
    approvedPairs.add(key);
  }

  approved.sort(
    (a, b) =>
      a.candidate.mountain_id - b.candidate.mountain_id ||
      a.candidate.candidate_country_code.localeCompare(
        b.candidate.candidate_country_code,
      ) ||
      a.candidate_hash.localeCompare(b.candidate_hash),
  );

  const sql = buildSql(approved, report, paths);
  mkdirSync(dirname(paths.output), { recursive: true });
  writeFileSync(paths.output, sql);

  const outputSha256 = fileSha256(paths.output);
  process.stdout.write(
    `${JSON.stringify(
      {
        sql_generated: true,
        database_written: false,
        output: paths.output,
        output_sha256: outputSha256,
        memberships_to_insert: approved.length,
        strong_approve: strongApprove,
        strong_reject: strongReject,
        third_source_approve: thirdApprove,
        third_source_reject: thirdReject,
        explicit_human_overrides:
          approved.filter(
            (row) => row.approval_basis === "EXPLICIT_HUMAN_OVERRIDE",
          ).length,
        preflight_generated_at: report.generated_at,
        discovery_exhaustive: false,
        safety:
          "SQL artifact generated only. No Supabase connection or database execution occurred. Runtime SQL guards abort on mountain identity drift or a pre-existing target membership.",
      },
      null,
      2,
    )}\n`,
  );
}

const isCli =
  process.argv[1]?.endsWith("export-approved.ts") ||
  process.argv[1]?.endsWith("export-approved.js");

if (isCli) {
  try {
    runExport();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
