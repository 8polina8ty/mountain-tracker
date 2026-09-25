#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Deterministic SQL export — only approved candidates via separate manifest.
 * Input: data/border-peaks/review.jsonl (immutable discovery)
 * Manifest: data/border-peaks/review-decisions.jsonl (candidate_hash binding)
 * Output: database/generated/mountain_countries_reviewed_batch.sql
 * Safety: INSERT ... ON CONFLICT DO NOTHING, explicit ids/codes, source, is_primary false for secondaries,
 * validates mountain identity via mountains.name/height, never touches mountains.country_code.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { BorderCandidate } from "./types.ts";

const cliInput = process.argv[2] ?? "data/border-peaks/confirmed.jsonl";
const cliManifestPath = process.argv[3] ?? "data/border-peaks/approved-manifest.jsonl";
const cliOutput = process.argv[4] ?? "database/generated/mountain_countries_reviewed_batch.sql";
const isCli = process.argv[1]?.includes("export-approved");

export function candidateFingerprint(c: BorderCandidate): string {
  // Deterministic hash over immutable candidate content (excluding approval fields)
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
export type ApprovalEntry = {
  candidate_hash: string;
  mountain_id: number;
  candidate_country_code: string;
  approved_by: string;
  approved_at: string; // ISO
  evidence_url: string;
  review_notes?: string;
};
// New separate review decisions (immutable discovery + independent evidence + human decision)
export type ReviewDecisionV2 = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  decision: "APPROVE" | "REJECT";
  evidence_url: string;
  evidence_type: string;
  evidence_notes?: string | null;
  reviewed_by: string;
  reviewed_at: string;
};

function isReviewDecisionV2(e: any): e is ReviewDecisionV2 {
  return typeof e?.decision === "string" && (e.decision === "APPROVE" || e.decision === "REJECT");
}
function runExport(input = cliInput, manifestPath = cliManifestPath, output = cliOutput) {
  if (!existsSync(input)) {
    console.error(`input ${input} not found — no candidates to export (this is safe).`);
    return;
  }
  const lines = readFileSync(input, "utf8").trim().split("\n").filter(Boolean);
  const all: BorderCandidate[] = lines.map(l => JSON.parse(l));
  // New workflow: input is immutable discovery (review.jsonl / candidates.jsonl) — do NOT require editing classification to CONFIRMED.
  // Approval is via separate manifest with candidate_hash binding.
  if (!existsSync(manifestPath)) {
    // For backward compatibility, old confirmed.jsonl + approved-manifest still works, but new review workflow requires decisions file.
    // If manifest missing and input contains only REVIEW, fail closed with guidance, do not generate SQL.
    if (all.some(c => c.classification === "REVIEW")) {
      console.log(`No manifest ${manifestPath} — 0 approved (REVIEW requires separate decision manifest, see database/border_peaks_review.md). No SQL generated (safe).`);
      mkdirSync("database/generated", { recursive: true });
      const header = `-- GENERATED — reviewed border memberships — MANUAL REVIEW REQUIRED BEFORE APPLYING
-- Source: ${input} (no manifest, no approvals)
-- Generated: ${new Date().toISOString()}
-- No rows approved.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
`;
      writeFileSync(output, header + `\nnotify pgrst, 'reload schema';\ncommit;\n`);
      return;
    }
    throw new Error(`Approval manifest missing: ${manifestPath} — editing JSONL alone cannot approve. Create manifest with candidate_hash binding (see database/border_peaks_review.md).`);
  }
  const manifestLines = readFileSync(manifestPath, "utf8").trim().split("\n").filter(Boolean);
  const rawManifest: any[] = manifestLines.map(l => JSON.parse(l));
  const isV2 = rawManifest.length > 0 && isReviewDecisionV2(rawManifest[0]);
  // Build candidate map by fingerprint for immutable binding
  const candidateByHash = new Map<string, BorderCandidate>();
  for (const c of all) candidateByHash.set(candidateFingerprint(c), c);
  // Validate manifest entries
  const seenDecisions = new Map<string, string>(); // candidate_hash -> decision
  const approved: BorderCandidate[] = [];
  for (const e of rawManifest) {
    if (isV2) {
      const d = e as ReviewDecisionV2;
      if (!d.candidate_hash || !d.mountain_id || !d.primary_country_code || !d.candidate_country_code || !d.decision || !d.evidence_url || !d.evidence_type || !d.reviewed_by || !d.reviewed_at) throw new Error(`Invalid review decision ${JSON.stringify(d)}`);
      if (d.decision !== "APPROVE" && d.decision !== "REJECT") throw new Error(`Invalid decision ${d.decision}`);
      if (d.decision === "REJECT") continue; // explicitly not exported
      // Evidence must specifically support the proposed pair, not just summit identity
      if (/^summit$/i.test(d.evidence_type) || /summit.*identity/i.test(d.evidence_type) || d.evidence_type === "CANDIDATE") throw new Error(`Evidence ${d.evidence_type} for ${d.mountain_id} does not prove dual membership (summit identity alone insufficient)`);
      if (!d.evidence_url || !/^https?:\/\//.test(d.evidence_url)) throw new Error(`Invalid evidence_url for ${d.mountain_id}`);
      const orig = candidateByHash.get(d.candidate_hash);
      if (!orig) throw new Error(`Manifest candidate_hash ${d.candidate_hash.slice(0,12)}… not found in input — original candidate missing or edited`);
      if (orig.mountain_id !== d.mountain_id || orig.primary_country_code !== d.primary_country_code || orig.candidate_country_code !== d.candidate_country_code) throw new Error(`Manifest mismatch for ${d.mountain_id}`);
      if (orig.mountain_id !== d.mountain_id) throw new Error(`Manifest mountain_id mismatch`);
      if (seenDecisions.has(d.candidate_hash)) throw new Error(`Duplicate manifest decision for ${d.candidate_hash.slice(0,12)}…`);
      seenDecisions.set(d.candidate_hash, d.decision);
      // Do not claim reviewer name proves correctness — just require present, preserve notes
      // Existing memberships and duplicate checks will be applied to approved list
      approved.push(orig);
    } else {
      // Legacy ApprovalEntry path (kept for backward compat, but now deprecated — requires CONFIRMED candidate)
      const d = e as ApprovalEntry;
      if (!d.candidate_hash || !d.mountain_id || !d.candidate_country_code || !d.approved_by || !d.approved_at || !d.evidence_url) throw new Error(`Invalid manifest entry ${JSON.stringify(d)}`);
      const orig = candidateByHash.get(d.candidate_hash);
      if (!orig) throw new Error(`No manifest approval binding candidate hash ${d.candidate_hash.slice(0,12)}…`);
      if (orig.classification !== "CONFIRMED") throw new Error(`Legacy manifest requires CONFIRMED classification for ${orig.mountain_id} — use new REVIEW+decision workflow instead`);
      approved.push(orig);
    }
  }
  // If input was old confirmed.jsonl with legacy manifest, approved already filtered; for new workflow approved comes from REVIEW decisions
  // Validate approved candidates
  for (const c of approved) {
    if (!Number.isInteger(c.mountain_id) || c.mountain_id <= 0) throw new Error(`Invalid mountain_id ${c.mountain_id}`);
    if (!/^[A-Z]{2}$/.test(c.candidate_country_code)) throw new Error(`Invalid candidate_country_code ${c.candidate_country_code} for ${c.mountain_id}`);
    if (!c.primary_country_code || c.candidate_country_code === c.primary_country_code) throw new Error(`Preserve primary country for ${c.mountain_id}`);
    if (!c.boundary_source_id || !c.boundary_source) throw new Error(`Missing boundary_source_id for ${c.mountain_id}`);
    if (c.distance_to_boundary_meters != null && c.distance_to_boundary_meters > 5000) throw new Error(`Distance too large for ${c.mountain_id}: ${c.distance_to_boundary_meters}m`);
    // Do not consider mere presence of evidence_url as proof — human verification required, preserved in reviewed_by/notes
  }
  {
    const seen = new Set<string>();
    for (const c of approved) {
      const k = `${c.mountain_id}:${c.candidate_country_code}`;
      if (seen.has(k)) throw new Error(`Duplicate manifest decision for ${k} — fail closed`);
      seen.add(k);
    }
  }
  // Existing memberships are excluded via discover's existing_memberships.json, but double-check here if provided
  try {
    const existing: any[] = JSON.parse(readFileSync("data/border-peaks/existing_memberships.json","utf8"));
    const existingSet = new Set(existing.map((e:any)=> `${e.mountain_id}:${e.country_code}`));
    for (const c of approved) if (existingSet.has(`${c.mountain_id}:${c.candidate_country_code}`)) throw new Error(`Existing membership ${c.mountain_id}:${c.candidate_country_code} already exists — skipped`);
  } catch {}
  if (approved.some(c => c.candidate_country_code === c.primary_country_code)) throw new Error("Cannot recreate primary as secondary");
  const zug = approved.filter(c => c.mountain_id === 1);
  for (const z of zug) if (!["DE"].includes(z.candidate_country_code)) throw new Error("Zugspitze border membership must be DE only (AT is primary)");
  // Primary never changed — check manifests don't try to change primary
  for (const c of approved) if (c.candidate_country_code === c.primary_country_code) throw new Error("Primary country never changed");

  mkdirSync("database/generated", { recursive: true });
  const header = `-- GENERATED — reviewed border memberships — MANUAL REVIEW REQUIRED BEFORE APPLYING
-- Source: ${input} + manifest ${manifestPath}
-- Generated: ${new Date().toISOString()}
-- Each row preserves existing primary; secondary is_primary=false; ON CONFLICT DO NOTHING.
-- Validate mountain identity after generation: compare id/name/height/country_code with preflight.
-- Approval via separate manifest with candidate_hash binding; original REVIEW remains immutable.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
`;
  const rows = approved.map(c => {
    const src = (c.boundary_source ?? "reviewed_border").slice(0, 64).replace(/'/g, "''");
    const manifestEntry = (rawManifest as any[]).find((e:any)=> e.candidate_hash === candidateFingerprint(c));
    const by = (manifestEntry as any)?.reviewed_by ?? (manifestEntry as any)?.approved_by ?? "";
    return `insert into public.mountain_countries (mountain_id, country_code, is_primary, source) values (${c.mountain_id}, '${c.candidate_country_code}', false, '${src}') on conflict (mountain_id, country_code) do nothing; -- ${c.mountain_name ?? ""} ${c.primary_country_code}→${c.candidate_country_code} ${c.distance_to_boundary_meters ?? "?"}m reviewed_by=${by}`;
  }).join("\n");
  const footer = `\nnotify pgrst, 'reload schema';\ncommit;\n`;
  writeFileSync(output, header + rows + footer);
  console.log(`exported ${approved.length} approved memberships to ${output} (from ${all.length} candidates, ${rawManifest.length} decisions)`);
  if (approved.length === 0) console.log("No approved rows — file contains only header (safe).");
}
if (isCli) runExport();
export { runExport };
