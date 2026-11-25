#!/usr/bin/env ts-node
/** Deterministic, offline Phase 3 pilot; prepares research tasks, never approvals. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  phase2_bucket: "P1" | "P2" | "P3";
  phase2_batch_id: string;
  phase3_action: "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW" | "THIRD_SOURCE_INVESTIGATION";
  latest_status: string;
  distance_to_boundary_meters: number | null;
  decision: null;
};
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function read<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Missing input: ${path}`);
  const lines = readFileSync(path, "utf8").trim();
  return lines ? lines.split("\n").map((line) => JSON.parse(line) as T) : [];
}
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function write(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}
function rank(row: Row): number {
  return row.phase2_bucket === "P1" ? 0 : row.phase2_bucket === "P2" ? 1 : 2;
}
function pair(row: Row): string {
  return `${row.primary_country_code}->${row.candidate_country_code}`;
}
function selectDiverse(input: Row[], count: number, selectedMountains: Set<number>): Row[] {
  const remaining = [...input].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.distance_to_boundary_meters ?? Infinity) - (b.distance_to_boundary_meters ?? Infinity) ||
    a.mountain_id - b.mountain_id ||
    a.candidate_country_code.localeCompare(b.candidate_country_code));
  const picked: Row[] = [];
  const pairCounts = new Map<string, number>();
  while (picked.length < count) {
    const eligible = remaining.filter((row) => !selectedMountains.has(row.mountain_id));
    if (!eligible.length) throw new Error("Not enough unique mountains for pilot");
    eligible.sort((a, b) =>
      (pairCounts.get(pair(a)) ?? 0) - (pairCounts.get(pair(b)) ?? 0) ||
      rank(a) - rank(b) ||
      (a.distance_to_boundary_meters ?? Infinity) - (b.distance_to_boundary_meters ?? Infinity) ||
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code));
    const row = eligible[0];
    picked.push(row);
    selectedMountains.add(row.mountain_id);
    pairCounts.set(pair(row), (pairCounts.get(pair(row)) ?? 0) + 1);
    remaining.splice(remaining.findIndex((candidate) => candidate.candidate_hash === row.candidate_hash), 1);
  }
  return picked;
}
function main(): void {
  const inputDir = arg("--phase3-dir", "data/border-peaks/phase3");
  const outputDir = arg("--output-dir", join(inputDir, "pilot"));
  const geometricPath = join(inputDir, "geometric-review.jsonl");
  const thirdPath = join(inputDir, "third-source-investigation.jsonl");
  const geometric = read<Row>(geometricPath);
  const third = read<Row>(thirdPath);
  if (geometric.length !== 1812 || third.length !== 665) {
    throw new Error("Phase 3 counts mismatch; expected 1812 geometric and 665 third-source");
  }
  const hashes = new Set<string>();
  for (const row of [...geometric, ...third]) {
    if (hashes.has(row.candidate_hash)) throw new Error("Duplicate candidate hash");
    hashes.add(row.candidate_hash);
    if (row.decision !== null) throw new Error("Pilot cannot consume already decided candidates");
    if (row.primary_country_code == null || row.primary_country_code === row.candidate_country_code ||
        !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
      throw new Error(`Invalid candidate identity/location for ${row.candidate_hash}`);
    }
  }
  if (geometric.some((row) => row.phase3_action !== "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW") ||
      third.some((row) => row.phase3_action !== "THIRD_SOURCE_INVESTIGATION")) {
    throw new Error("Queue/action mismatch");
  }
  const seenMountains = new Set<number>();
  const chosenGeometric = selectDiverse(geometric, 15, seenMountains);
  const chosenThird = selectDiverse(third, 15, seenMountains);
  const pilot = [...chosenGeometric, ...chosenThird].map((row, index) => ({
    ...row,
    pilot_id: `phase3-pilot-${String(index + 1).padStart(3, "0")}`,
    research_status: "NOT_STARTED",
    independent_source_url: null,
    independent_source_authority: null,
    independent_source_title: null,
    independent_source_type: null,
    independent_source_finding: null,
    supporting_quote_or_coordinates: null,
    research_notes: null,
    human_decision: null,
    human_reviewed_by: null,
    human_reviewed_at: null,
  }));
  // No output is touched until all input checks succeed.
  mkdirSync(outputDir, { recursive: true });
  const pilotPath = join(outputDir, "research-queue.jsonl");
  write(pilotPath, pilot);
  const summary = {
    stage: "PHASE3_INDEPENDENT_SOURCE_PILOT",
    pilot_candidates: pilot.length,
    geometric: chosenGeometric.length,
    third_source: chosenThird.length,
    unique_mountains: seenMountains.size,
    distinct_country_pairs: new Set(pilot.map(pair)).size,
    human_decisions: 0,
    input_sha256: { geometric: sha(geometricPath), third_source: sha(thirdPath) },
    output_sha256: sha(pilotPath),
    output: pilotPath,
    safety: "Research queue only. Independent source data and human decisions are blank. No automatic verification, approval, SQL, or database writes.",
  };
  writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
