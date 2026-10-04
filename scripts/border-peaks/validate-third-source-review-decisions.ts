#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type Decision = "APPROVE" | "REJECT";

type HumanQueueRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  third_source_finding: Finding;
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  third_source_finding: Finding;
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  decision: Decision | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
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

function assertSameEvidence(expected: HumanQueueRow, row: DecisionRow): void {
  for (const field of [
    "third_source_finding",
    "evidence_url",
    "evidence_type",
    "evidence_title",
    "evidence_authority",
    "evidence_notes",
  ] as const) {
    if (row[field] !== expected[field]) {
      throw new Error(
        `Decision template evidence field ${field} changed for ${row.candidate_hash.slice(0, 12)}…. Update the evidence layer first, then regenerate the decision template.`,
      );
    }
  }
}

function main(): void {
  const queuePath = arg(
    "--queue",
    "data/border-peaks/global-review/third-source-human-review.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );

  const queue = readJsonl<HumanQueueRow>(queuePath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (queue.length !== decisions.length) {
    throw new Error(
      `Human queue/decision row count mismatch: ${queue.length} vs ${decisions.length}`,
    );
  }

  const queueByHash = new Map(queue.map((row) => [row.candidate_hash, row]));
  const seen = new Set<string>();
  let pending = 0;
  let approve = 0;
  let reject = 0;

  for (const row of decisions) {
    if (!/^[a-f0-9]{64}$/.test(row.candidate_hash)) {
      throw new Error("Invalid candidate_hash in human decision file");
    }
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate decision row for ${row.candidate_hash.slice(0, 12)}…`);
    }
    seen.add(row.candidate_hash);

    const expected = queueByHash.get(row.candidate_hash);
    if (!expected) {
      throw new Error(
        `Decision hash ${row.candidate_hash.slice(0, 12)}… is not in the current human-review queue`,
      );
    }
    if (
      row.mountain_id !== expected.mountain_id ||
      row.primary_country_code !== expected.primary_country_code ||
      row.candidate_country_code !== expected.candidate_country_code
    ) {
      throw new Error(
        `Candidate identity mismatch for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    assertSameEvidence(expected, row);

    const reviewerFields = [row.reviewed_by, row.reviewed_at, row.review_notes];
    if (row.decision == null) {
      if (reviewerFields.some((value) => value != null)) {
        throw new Error(
          `Pending decision has partial reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`,
        );
      }
      pending += 1;
      continue;
    }

    if (row.decision !== "APPROVE" && row.decision !== "REJECT") {
      throw new Error(
        `Invalid decision for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      typeof row.reviewed_by !== "string" ||
      row.reviewed_by.trim().length < 2 ||
      typeof row.review_notes !== "string" ||
      row.review_notes.trim().length < 10 ||
      typeof row.reviewed_at !== "string" ||
      !Number.isFinite(Date.parse(row.reviewed_at))
    ) {
      throw new Error(
        `Completed decision requires reviewed_by, reviewed_at, and substantive review_notes for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (row.decision === "APPROVE") {
      if (row.third_source_finding !== "SUPPORTS") {
        throw new Error(
          `APPROVE is not allowed while third-source finding is ${row.third_source_finding} for ${row.candidate_hash.slice(0, 12)}…. Strengthen/update evidence first.`,
        );
      }
      approve += 1;
    } else {
      reject += 1;
    }
  }

  if (seen.size !== queueByHash.size) {
    throw new Error("Decision file does not cover the complete current human-review queue");
  }

  const exportReady = pending === 0;
  process.stdout.write(
    `${JSON.stringify({
      total_rows: decisions.length,
      completed_rows: decisions.length - pending,
      pending_rows: pending,
      approve_rows: approve,
      reject_rows: reject,
      template_valid: true,
      export_ready: exportReady,
      safety: exportReady
        ? "All human decisions are structurally complete. This validates the decision layer only; run the separate SQL-export preflight before generating or applying SQL."
        : "Decision template is valid but not export-ready. Do not pass it to export-approved.ts while pending decisions remain.",
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
