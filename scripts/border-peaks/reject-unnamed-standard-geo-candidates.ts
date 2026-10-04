#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type ReviewTier =
  | "HIGH_CONFIDENCE_REVIEW"
  | "STANDARD_REVIEW"
  | "THIRD_SOURCE_RECOMMENDED";

type GeoRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  review_tier: ReviewTier;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
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

function isBlankName(value: string | null): boolean {
  return value == null || value.trim().length === 0;
}

function main(): void {
  const geoPath = arg(
    "--geo-review",
    "data/border-peaks/global-review/geometric-support/all.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );

  const geoRows = readJsonl<GeoRow>(geoPath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (geoRows.length !== 553) {
    throw new Error(`Expected 553 geometric review rows, found ${geoRows.length}`);
  }
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const completed = decisions.filter((row) => row.decision != null);
  const pending = decisions.filter((row) => row.decision == null);

  if (completed.length !== 1223 || pending.length !== 149) {
    throw new Error(
      `Expected post-high-confidence state completed=1223/pending=149, found ${completed.length}/${pending.length}`,
    );
  }

  const geoByHash = new Map(geoRows.map((row) => [row.candidate_hash, row]));
  const seen = new Set<string>();
  const targets: DecisionRow[] = [];

  for (const decision of pending) {
    if (seen.has(decision.candidate_hash)) {
      throw new Error(
        `Duplicate pending decision hash ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }
    seen.add(decision.candidate_hash);

    const geo = geoByHash.get(decision.candidate_hash);
    if (!geo) {
      throw new Error(
        `Pending hash missing from geometric review: ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      geo.mountain_id !== decision.mountain_id ||
      geo.mountain_name !== decision.mountain_name ||
      geo.primary_country_code !== decision.primary_country_code ||
      geo.candidate_country_code !== decision.candidate_country_code ||
      geo.pair !== decision.pair ||
      geo.final_machine_status !== decision.final_machine_status
    ) {
      throw new Error(
        `Geometric/decision identity mismatch for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      decision.final_machine_status !== "GEOMETRIC_SUPPORT" ||
      geo.review_tier !== "STANDARD_REVIEW"
    ) {
      throw new Error(
        `Expected every pending row to be STANDARD_REVIEW GEOMETRIC_SUPPORT; failed for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      decision.reviewed_by != null ||
      decision.reviewed_at != null ||
      decision.review_notes != null ||
      decision.decision_batch_id != null
    ) {
      throw new Error(
        `Pending row has reviewer metadata for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (isBlankName(decision.mountain_name)) {
      targets.push(decision);
    }
  }

  if (targets.length === 0) {
    throw new Error("No pending unnamed STANDARD_REVIEW candidates found");
  }

  const now = new Date().toISOString();
  for (const decision of targets) {
    decision.decision = "REJECT";
    decision.reviewed_by =
      "Human reviewer (explicit unnamed-mountain rejection policy)";
    decision.reviewed_at = now;
    decision.review_notes =
      "Human reviewer explicitly rejected this additional border-country membership because the mountain record has no usable name. The mountain record itself is preserved; only this proposed secondary-country membership is rejected.";
    decision.decision_batch_id = "standard-unnamed-rejection";
  }

  writeFileSync(
    decisionsPath,
    `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const remaining = decisions.filter((row) => row.decision == null);
  const remainingNamedStandard = remaining.filter((row) => {
    const geo = geoByHash.get(row.candidate_hash);
    return (
      geo?.review_tier === "STANDARD_REVIEW" &&
      !isBlankName(row.mountain_name)
    );
  });

  process.stdout.write(
    `${JSON.stringify({
      rejected_unnamed_rows: targets.length,
      remaining_pending_rows: remaining.length,
      remaining_named_standard_review: remainingNamedStandard.length,
      total_approve_rows: decisions.filter((row) => row.decision === "APPROVE").length,
      total_reject_rows: decisions.filter((row) => row.decision === "REJECT").length,
      decision_file: decisionsPath,
      safety:
        "Only pending unnamed STANDARD_REVIEW GEOMETRIC_SUPPORT country-membership candidates were rejected. Mountain records were not deleted or modified. No SQL or database write is performed.",
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
