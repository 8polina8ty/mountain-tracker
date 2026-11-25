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

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  status: VerificationStatus;
  mode?: "CENTER" | "PROBE";
  queried_at?: string;
  notes?: string;
};

type Tier2BRetry = BorderCandidate & {
  tier2b_action: "RETRY_PROBE";
  tier2b_reason: "NO_TIER2_RESULT" | "ERROR";
  tier2_last_status: VerificationStatus | null;
};

type Tier2BReview = BorderCandidate & {
  tier2b_action: "THIRD_SOURCE_OR_MANUAL_REVIEW";
  tier2b_reason: "INSUFFICIENT" | "CONFLICT";
  tier2_last_status: VerificationStatus;
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

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function main(): void {
  const tier2QueuePath = arg(
    "--tier2-queue",
    "data/border-peaks/global-verification/tier2-queue.jsonl",
  );
  const tier2EvidencePath = arg(
    "--tier2-evidence",
    "data/border-peaks/global-verification/osm-evidence-tier2.jsonl",
  );
  const retryOutputPath = arg(
    "--retry-output",
    "data/border-peaks/global-verification/tier2b-retry-probe.jsonl",
  );
  const reviewOutputPath = arg(
    "--review-output",
    "data/border-peaks/global-verification/tier2b-review.jsonl",
  );
  const summaryOutputPath = arg(
    "--summary-output",
    "data/border-peaks/global-verification/tier2b-summary.json",
  );

  const queue = readJsonl<BorderCandidate>(tier2QueuePath);
  const evidence = readJsonl<VerificationRow>(tier2EvidencePath);

  const latestProbe = new Map<string, VerificationRow>();
  for (const row of evidence) {
    // Tier 2 evidence files are probe-only. Preserve compatibility with
    // early rows written before the explicit mode field existed.
    if (row.mode && row.mode !== "PROBE") continue;
    latestProbe.set(row.candidate_hash, row);
  }

  const retry: Tier2BRetry[] = [];
  const review: Tier2BReview[] = [];
  const resolved = {
    VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
  };

  for (const candidate of queue) {
    const hash = candidateFingerprint(candidate);
    const row = latestProbe.get(hash);

    if (!row) {
      retry.push({
        ...candidate,
        tier2b_action: "RETRY_PROBE",
        tier2b_reason: "NO_TIER2_RESULT",
        tier2_last_status: null,
      });
      continue;
    }

    if (row.status === "ERROR") {
      retry.push({
        ...candidate,
        tier2b_action: "RETRY_PROBE",
        tier2b_reason: "ERROR",
        tier2_last_status: row.status,
      });
      continue;
    }

    if (row.status === "INSUFFICIENT" || row.status === "CONFLICT") {
      review.push({
        ...candidate,
        tier2b_action: "THIRD_SOURCE_OR_MANUAL_REVIEW",
        tier2b_reason: row.status,
        tier2_last_status: row.status,
      });
      continue;
    }

    if (row.status === "VERIFIED") resolved.VERIFIED += 1;
    if (row.status === "GEOMETRIC_SUPPORT") resolved.GEOMETRIC_SUPPORT += 1;
  }

  const sortCandidates = <T extends BorderCandidate>(rows: T[]): T[] =>
    rows.sort(
      (a, b) =>
        ((b as BorderCandidate & { tier2_priority?: number }).tier2_priority ?? 0) -
          ((a as BorderCandidate & { tier2_priority?: number }).tier2_priority ?? 0) ||
        (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
          (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
        a.mountain_id - b.mountain_id ||
        a.candidate_country_code.localeCompare(b.candidate_country_code),
    );

  sortCandidates(retry);
  sortCandidates(review);

  writeJsonl(retryOutputPath, retry);
  writeJsonl(reviewOutputPath, review);

  const summary = {
    generated_at: new Date().toISOString(),
    tier2_queue_rows: queue.length,
    latest_probe_results: latestProbe.size,
    resolved,
    retry_probe_rows: retry.length,
    retry_probe_unique_mountains: new Set(retry.map((row) => row.mountain_id)).size,
    review_rows: review.length,
    review_unique_mountains: new Set(review.map((row) => row.mountain_id)).size,
    retry_breakdown: {
      NO_TIER2_RESULT: retry.filter((row) => row.tier2b_reason === "NO_TIER2_RESULT").length,
      ERROR: retry.filter((row) => row.tier2b_reason === "ERROR").length,
    },
    review_breakdown: {
      INSUFFICIENT: review.filter((row) => row.tier2b_reason === "INSUFFICIENT").length,
      CONFLICT: review.filter((row) => row.tier2b_reason === "CONFLICT").length,
    },
    retry_output: retryOutputPath,
    review_output: reviewOutputPath,
    safety:
      "Only NO_TIER2_RESULT/ERROR rows are eligible for another probe pass. INSUFFICIENT/CONFLICT rows are intentionally not re-probed and require a third source or manual review.",
  };

  writeFileSync(summaryOutputPath, JSON.stringify(summary, null, 2));
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
