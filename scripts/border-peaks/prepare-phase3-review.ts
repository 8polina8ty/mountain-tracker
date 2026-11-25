#!/usr/bin/env ts-node
/**
 * Read-only Phase 3 handoff. No human decisions, database, or SQL writes.
 * Never rerun prepare-phase2 here: that command replaces the Phase 2 directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type Phase2Row = BorderCandidate & {
  candidate_hash: string;
  phase2_batch_id: string;
  phase2_bucket: "P1" | "P2" | "P3";
  phase2_rank: number;
  latest_status: "VERIFIED" | "GEOMETRIC_SUPPORT" | "CONFLICT" | "INSUFFICIENT" | "ERROR";
  latest_queried_at: string;
  latest_endpoint: string;
  latest_notes: string;
  triage_action: "HUMAN_REVIEW_GEOMETRIC_SUPPORT" | "THIRD_SOURCE_OR_MANUAL_REVIEW" | "RETRY_TECHNICAL";
  center_country_codes: string[];
  probe_country_codes: string[];
};
type ReviewRow = Phase2Row & {
  phase3_action: "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW" | "THIRD_SOURCE_INVESTIGATION";
  third_source_finding: null;
  evidence_url: null;
  evidence_type: null;
  evidence_title: null;
  evidence_authority: null;
  evidence_notes: null;
  decision: null;
  reviewed_by: null;
  reviewed_at: null;
};
type GapRow = { mountain_id: number; primary_country_code: string | null };

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function load<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const body = readFileSync(path, "utf8").trim();
  return body ? body.split("\n").map((line) => JSON.parse(line) as T) : [];
}
function jsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main(): void {
  const phase2Dir = arg("--phase2-dir", "data/border-peaks/phase2");
  const outputDir = arg("--output-dir", "data/border-peaks/phase3");
  const gapPath = arg("--source-gaps", join(phase2Dir, "source-gap-backlog.jsonl"));
  const rows: ReviewRow[] = [];
  const inputDigests: Record<string, string> = {};
  const seen = new Set<string>();

  for (let n = 1; n <= 13; n += 1) {
    const id = `phase2-${String(n).padStart(3, "0")}`;
    const path = join(phase2Dir, "triage", id, "all.jsonl");
    const batch = load<Phase2Row>(path);
    if (batch.length !== (n === 13 ? 77 : 200)) {
      throw new Error(`${id}: expected ${n === 13 ? 77 : 200} rows, found ${batch.length}`);
    }
    inputDigests[id] = sha(path);
    for (const row of batch) {
      if (row.phase2_batch_id !== id || row.candidate_hash !== candidateFingerprint(row)) {
        throw new Error(`${id}: invalid identity/hash for mountain ${row.mountain_id}`);
      }
      if (seen.has(row.candidate_hash)) throw new Error(`Duplicate candidate: ${row.candidate_hash}`);
      seen.add(row.candidate_hash);
      const supported = row.latest_status === "GEOMETRIC_SUPPORT" || row.latest_status === "VERIFIED";
      const action = supported ? "HUMAN_REVIEW_GEOMETRIC_SUPPORT" : row.latest_status === "ERROR" ? "RETRY_TECHNICAL" : "THIRD_SOURCE_OR_MANUAL_REVIEW";
      if (row.triage_action !== action) throw new Error(`${id}: inconsistent triage action for ${row.mountain_id}`);
      if (row.latest_status === "ERROR") throw new Error(`${id}: unresolved technical error for ${row.mountain_id}`);
      if (!Number.isFinite(Date.parse(row.latest_queried_at))) throw new Error(`${id}: invalid timestamp`);
      if (supported) {
        const codes = row.latest_status === "VERIFIED" ? row.center_country_codes : row.probe_country_codes;
        if (!row.primary_country_code || !codes.includes(row.primary_country_code) || !codes.includes(row.candidate_country_code)) {
          throw new Error(`${id}: missing dual-country support for ${row.mountain_id}`);
        }
      }
      rows.push({
        ...row,
        phase3_action: supported ? "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW" : "THIRD_SOURCE_INVESTIGATION",
        third_source_finding: null,
        evidence_url: null,
        evidence_type: null,
        evidence_title: null,
        evidence_authority: null,
        evidence_notes: null,
        decision: null,
        reviewed_by: null,
        reviewed_at: null,
      });
    }
  }
  if (rows.length !== 2477 || seen.size !== 2477) throw new Error("Phase 3 requires exactly 2477 unique candidates");

  const geometric = rows.filter((row) => row.phase3_action === "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW");
  const insufficient = rows.filter((row) => row.phase3_action === "THIRD_SOURCE_INVESTIGATION");
  const gaps = load<GapRow>(gapPath);
  if (gaps.length !== 78 || new Set(gaps.map((row) => row.mountain_id)).size !== 78) {
    throw new Error("Expected 78 unique source-gap mountains");
  }
  const gapCounts = gaps.reduce<Record<string, number>>((acc, row) => {
    const code = row.primary_country_code ?? "UNKNOWN";
    acc[code] = (acc[code] ?? 0) + 1;
    return acc;
  }, {});
  if (gapCounts.HM !== 8 || gapCounts.TF !== 70 || Object.keys(gapCounts).length !== 2) {
    throw new Error("Unexpected source-gap composition");
  }

  // Nothing is written until all inputs pass validation.
  mkdirSync(outputDir, { recursive: true });
  jsonl(join(outputDir, "all-review.jsonl"), rows);
  jsonl(join(outputDir, "geometric-review.jsonl"), geometric);
  jsonl(join(outputDir, "third-source-investigation.jsonl"), insufficient);
  jsonl(join(outputDir, "source-gap-backlog.jsonl"), gaps);
  const summary = {
    stage: "PHASE3_REVIEW_PREPARATION",
    candidate_count: rows.length,
    geometric_support: geometric.length,
    needs_third_source: insufficient.length,
    unresolved_technical: 0,
    source_gap_mountains: gaps.length,
    human_decisions_recorded: 0,
    input_sha256: { ...inputDigests, source_gaps: sha(gapPath) },
    output_sha256: Object.fromEntries(
      ["all-review.jsonl", "geometric-review.jsonl", "third-source-investigation.jsonl", "source-gap-backlog.jsonl"]
        .map((name) => [name, sha(join(outputDir, name))]),
    ),
    safety: "Preparation only. OSM geometric support is not approval. Independent authority and human review are required. No SQL, production writes, or automatic decisions.",
  };
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
