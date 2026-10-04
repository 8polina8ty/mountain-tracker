#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type ReviewTier =
  | "HIGH_CONFIDENCE_REVIEW"
  | "STANDARD_REVIEW"
  | "THIRD_SOURCE_RECOMMENDED";
type NamedTier = "STANDARD_STRONG_REVIEW" | "STANDARD_MANUAL_REVIEW";

type NamedRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  review_tier: ReviewTier;
  probe_status: string;
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  named_review_tier: NamedTier;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
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

function blank(value: string | null): boolean {
  return value == null || value.trim().length === 0;
}

function assertStrong(row: NamedRow): void {
  if (
    row.final_machine_status !== "GEOMETRIC_SUPPORT" ||
    row.review_tier !== "STANDARD_REVIEW" ||
    row.named_review_tier !== "STANDARD_STRONG_REVIEW"
  ) {
    throw new Error(
      `Row is not STANDARD_STRONG_REVIEW GEOMETRIC_SUPPORT: ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (blank(row.mountain_name)) {
    throw new Error(
      `Strong row has blank mountain name: ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    row.distance_to_boundary_meters == null ||
    row.distance_to_boundary_meters > 100
  ) {
    throw new Error(
      `Boundary-distance contract failed for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    row.osm_peak_distance_meters == null ||
    row.osm_peak_distance_meters > 10
  ) {
    throw new Error(
      `OSM peak-distance contract failed for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (blank(row.osm_peak_name) && blank(row.osm_peak_wikidata)) {
    throw new Error(
      `OSM peak identity missing for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    row.probe_status !== "GEOMETRIC_SUPPORT" &&
    row.probe_status !== "VERIFIED"
  ) {
    throw new Error(
      `Unexpected probe status for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }

  if (
    !row.primary_country_code ||
    !row.probe_country_codes.includes(row.primary_country_code) ||
    !row.probe_country_codes.includes(row.candidate_country_code)
  ) {
    throw new Error(
      `Dual-country probe contract failed for ${row.candidate_hash.slice(0, 12)}…`,
    );
  }
}

function main(): void {
  const allPath = arg(
    "--all",
    "data/border-peaks/global-review/geometric-support/named-standard/all.jsonl",
  );
  const strongPath = arg(
    "--strong",
    "data/border-peaks/global-review/geometric-support/named-standard/strong.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  const allRows = readJsonl<NamedRow>(allPath);
  const strongRows = readJsonl<NamedRow>(strongPath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (allRows.length !== 97) {
    throw new Error(`Expected 97 named standard rows, found ${allRows.length}`);
  }
  if (strongRows.length !== 88) {
    throw new Error(`Expected exactly 88 STANDARD_STRONG_REVIEW rows, found ${strongRows.length}`);
  }
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const completed = decisions.filter((row) => row.decision != null);
  const pending = decisions.filter((row) => row.decision == null);
  const approve = decisions.filter((row) => row.decision === "APPROVE");
  const reject = decisions.filter((row) => row.decision === "REJECT");

  if (
    completed.length !== 1275 ||
    pending.length !== 97 ||
    approve.length !== 1223 ||
    reject.length !== 52
  ) {
    throw new Error(
      `Expected current state completed=1275/pending=97/approve=1223/reject=52; found ${completed.length}/${pending.length}/${approve.length}/${reject.length}`,
    );
  }

  const allByHash = new Map(allRows.map((row) => [row.candidate_hash, row]));
  const decisionByHash = new Map(
    decisions.map((row) => [row.candidate_hash, row]),
  );

  const strongHashes = new Set<string>();
  const manualRows = allRows.filter(
    (row) => row.named_review_tier === "STANDARD_MANUAL_REVIEW",
  );

  if (manualRows.length !== 9) {
    throw new Error(
      `Expected exactly 9 STANDARD_MANUAL_REVIEW rows, found ${manualRows.length}`,
    );
  }

  for (const row of strongRows) {
    if (strongHashes.has(row.candidate_hash)) {
      throw new Error(
        `Duplicate strong hash ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    strongHashes.add(row.candidate_hash);

    const fromAll = allByHash.get(row.candidate_hash);
    if (!fromAll) {
      throw new Error(
        `Strong hash missing from all.jsonl: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    for (const field of [
      "mountain_id",
      "mountain_name",
      "latitude",
      "longitude",
      "height",
      "primary_country_code",
      "candidate_country_code",
      "pair",
      "final_machine_status",
      "distance_to_boundary_meters",
      "review_tier",
      "probe_status",
      "osm_peak_distance_meters",
      "osm_peak_name",
      "osm_peak_wikidata",
      "named_review_tier",
    ] as const) {
      if (row[field] !== fromAll[field]) {
        throw new Error(
          `Strong/all field ${field} mismatch for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
    }

    if (
      JSON.stringify(row.probe_country_codes) !==
      JSON.stringify(fromAll.probe_country_codes)
    ) {
      throw new Error(
        `Strong/all probe-country mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    assertStrong(row);

    const decision = decisionByHash.get(row.candidate_hash);
    if (!decision) {
      throw new Error(
        `Strong hash missing from decision manifest: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    for (const field of [
      "mountain_id",
      "mountain_name",
      "latitude",
      "longitude",
      "height",
      "primary_country_code",
      "candidate_country_code",
      "pair",
      "final_machine_status",
      "distance_to_boundary_meters",
    ] as const) {
      if (decision[field] !== row[field]) {
        throw new Error(
          `Strong/decision field ${field} mismatch for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
    }

    if (
      decision.decision != null ||
      decision.reviewed_by != null ||
      decision.reviewed_at != null ||
      decision.review_notes != null ||
      decision.decision_batch_id != null
    ) {
      throw new Error(
        `Refusing to overwrite non-pending decision for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  for (const row of pending) {
    const named = allByHash.get(row.candidate_hash);
    if (!named) {
      throw new Error(
        `Pending decision missing from named-standard all.jsonl: ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
  }

  const now = new Date().toISOString();
  for (const hash of strongHashes) {
    const decision = decisionByHash.get(hash)!;
    decision.decision = "APPROVE";
    decision.reviewed_by =
      "Human reviewer (explicit mass standard-strong approval)";
    decision.reviewed_at = now;
    decision.review_notes =
      "Human reviewer explicitly approved all 88 STANDARD_STRONG_REVIEW candidates. Each remains GEOMETRIC_SUPPORT rather than exact dual-containment, but passed the named summit contract: geoBoundaries <=100m, OSM peak <=10m with name/Wikidata identity, and successful dual-country probe evidence.";
    decision.decision_batch_id = "standard-strong-all-88";
  }

  writeFileSync(
    decisionsPath,
    `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const remaining = decisions.filter((row) => row.decision == null);
  const remainingHashes = new Set(remaining.map((row) => row.candidate_hash));
  const remainingManual = manualRows.filter((row) =>
    remainingHashes.has(row.candidate_hash),
  );

  if (remaining.length !== 9 || remainingManual.length !== 9) {
    throw new Error(
      `Post-write invariant failed: expected 9 pending manual rows, found pending=${remaining.length}, manual=${remainingManual.length}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      approved_standard_strong_rows: strongRows.length,
      remaining_pending_rows: remaining.length,
      remaining_standard_manual_review: remainingManual.length,
      total_approve_rows: decisions.filter((row) => row.decision === "APPROVE").length,
      total_reject_rows: decisions.filter((row) => row.decision === "REJECT").length,
      decision_file: decisionsPath,
      safety:
        "Only the explicitly authorized 88 STANDARD_STRONG_REVIEW candidates were approved. The 9 STANDARD_MANUAL_REVIEW rows remain pending. No SQL or database write is performed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
