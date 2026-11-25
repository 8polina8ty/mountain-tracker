#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type Decision = "APPROVE" | "REJECT";

type QueueRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  pair: string;
  third_source_finding: Finding;
  recommended_human_action:
    | "REVIEW_FOR_APPROVAL"
    | "REVIEW_FOR_REJECTION"
    | "MANUAL_RESOLUTION";
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
};

type DecisionRow = QueueRow & {
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

function main(): void {
  const queuePath = arg(
    "--queue",
    "data/border-peaks/global-review/third-source-human-review.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/third-source-review-decisions.jsonl",
  );

  const queue = readJsonl<QueueRow>(queuePath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);
  if (queue.length !== decisions.length) {
    throw new Error(`Queue/decision row count mismatch: ${queue.length} vs ${decisions.length}`);
  }

  const queueByHash = new Map(queue.map((row) => [row.candidate_hash, row]));
  const seen = new Set<string>();
  let refreshedPending = 0;
  let preservedCompleted = 0;

  for (const row of decisions) {
    if (seen.has(row.candidate_hash)) {
      throw new Error(`Duplicate decision hash ${row.candidate_hash.slice(0, 12)}…`);
    }
    seen.add(row.candidate_hash);
    const current = queueByHash.get(row.candidate_hash);
    if (!current) {
      throw new Error(`Decision hash missing from current queue: ${row.candidate_hash.slice(0, 12)}…`);
    }
    if (
      row.mountain_id !== current.mountain_id ||
      row.primary_country_code !== current.primary_country_code ||
      row.candidate_country_code !== current.candidate_country_code
    ) {
      throw new Error(`Candidate identity mismatch for ${row.candidate_hash.slice(0, 12)}…`);
    }

    if (row.decision != null) {
      for (const field of [
        "third_source_finding",
        "evidence_url",
        "evidence_type",
        "evidence_title",
        "evidence_authority",
        "evidence_notes",
      ] as const) {
        if (row[field] !== current[field]) {
          throw new Error(
            `Completed decision evidence changed for ${row.candidate_hash.slice(0, 12)}…; manual reconciliation required.`,
          );
        }
      }
      preservedCompleted += 1;
      continue;
    }

    if (row.reviewed_by != null || row.reviewed_at != null || row.review_notes != null) {
      throw new Error(
        `Pending decision has reviewer metadata for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    row.mountain_name = current.mountain_name;
    row.pair = current.pair;
    row.third_source_finding = current.third_source_finding;
    row.recommended_human_action = current.recommended_human_action;
    row.evidence_url = current.evidence_url;
    row.evidence_type = current.evidence_type;
    row.evidence_title = current.evidence_title;
    row.evidence_authority = current.evidence_authority;
    row.evidence_notes = current.evidence_notes;
    refreshedPending += 1;
  }

  if (seen.size !== queueByHash.size) {
    throw new Error("Decision file does not cover the current queue exactly");
  }

  writeFileSync(
    decisionsPath,
    decisions.length ? `${decisions.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      total_rows: decisions.length,
      preserved_completed_rows: preservedCompleted,
      refreshed_pending_rows: refreshedPending,
      decision_file: decisionsPath,
      safety:
        "Completed human decisions are preserved only if their evidence is unchanged. Only pending rows receive refreshed evidence/routing metadata. No decision is auto-created and no SQL/database write is performed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
