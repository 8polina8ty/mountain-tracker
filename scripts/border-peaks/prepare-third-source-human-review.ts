#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";

type InvestigationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  distance_to_boundary_meters: number | null;
  priority: number;
  priority_reasons: string[];
};

type EvidenceRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: Finding;
  source_url: string;
  source_type: string;
  source_title: string;
  source_authority: string;
  evidence_notes: string;
  checked_by: string;
  checked_at: string;
};

type ReviewRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string;
  candidate_country_code: string;
  pair: string;
  distance_to_boundary_meters: number | null;
  priority: number;
  priority_reasons: string[];
  third_source_finding: Finding;
  evidence_url: string;
  evidence_type: string;
  evidence_title: string;
  evidence_authority: string;
  evidence_notes: string;
  evidence_checked_by: string;
  evidence_checked_at: string;
  recommended_human_action: "REVIEW_FOR_APPROVAL" | "REVIEW_FOR_REJECTION" | "MANUAL_RESOLUTION";
  decision: null;
  reviewed_by: null;
  reviewed_at: null;
  review_notes: null;
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );
}

function actionFor(finding: Finding): ReviewRow["recommended_human_action"] {
  if (finding === "SUPPORTS") return "REVIEW_FOR_APPROVAL";
  if (finding === "DOES_NOT_SUPPORT") return "REVIEW_FOR_REJECTION";
  return "MANUAL_RESOLUTION";
}

function main(): void {
  const investigationPath = arg(
    "--investigation",
    "data/border-peaks/global-review/third-source-investigation.jsonl",
  );
  const evidencePath = arg(
    "--evidence",
    "data/border-peaks/global-review/third-source-evidence.jsonl",
  );
  const supportedPath = arg(
    "--supported-output",
    "data/border-peaks/global-review/third-source-supported.jsonl",
  );
  const rejectPath = arg(
    "--reject-output",
    "data/border-peaks/global-review/third-source-reject-candidates.jsonl",
  );
  const ambiguousPath = arg(
    "--ambiguous-output",
    "data/border-peaks/global-review/third-source-ambiguous.jsonl",
  );
  const humanQueuePath = arg(
    "--human-output",
    "data/border-peaks/global-review/third-source-human-review.jsonl",
  );
  const summaryPath = arg(
    "--summary-output",
    "data/border-peaks/global-review/third-source-human-review-summary.json",
  );

  const investigation = readJsonl<InvestigationRow>(investigationPath);
  const evidence = readJsonl<EvidenceRow>(evidencePath);

  if (investigation.length !== evidence.length) {
    throw new Error(
      `Investigation/evidence row count mismatch: ${investigation.length} vs ${evidence.length}`,
    );
  }

  const investigationByHash = new Map(
    investigation.map((row) => [row.candidate_hash, row]),
  );
  const seen = new Set<string>();
  const reviewRows: ReviewRow[] = [];

  for (const entry of evidence) {
    if (!entry.candidate_hash || seen.has(entry.candidate_hash)) {
      throw new Error(
        `Missing or duplicate evidence candidate_hash: ${entry.candidate_hash ?? "<missing>"}`,
      );
    }
    seen.add(entry.candidate_hash);

    const candidate = investigationByHash.get(entry.candidate_hash);
    if (!candidate) {
      throw new Error(
        `Evidence hash ${entry.candidate_hash.slice(0, 12)}… is not present in the current investigation queue`,
      );
    }
    if (!candidate.primary_country_code) {
      throw new Error(`Missing primary country for mountain ${candidate.mountain_id}`);
    }
    if (
      candidate.mountain_id !== entry.mountain_id ||
      candidate.primary_country_code !== entry.primary_country_code ||
      candidate.candidate_country_code !== entry.candidate_country_code
    ) {
      throw new Error(
        `Candidate identity mismatch for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (
      entry.finding !== "SUPPORTS" &&
      entry.finding !== "DOES_NOT_SUPPORT" &&
      entry.finding !== "AMBIGUOUS"
    ) {
      throw new Error(
        `Incomplete/invalid finding for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }
    for (const [field, value] of [
      ["source_url", entry.source_url],
      ["source_type", entry.source_type],
      ["source_title", entry.source_title],
      ["source_authority", entry.source_authority],
      ["evidence_notes", entry.evidence_notes],
      ["checked_by", entry.checked_by],
      ["checked_at", entry.checked_at],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(
          `Incomplete ${field} for ${entry.candidate_hash.slice(0, 12)}…`,
        );
      }
    }

    reviewRows.push({
      candidate_hash: entry.candidate_hash,
      mountain_id: candidate.mountain_id,
      mountain_name: candidate.mountain_name,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      height: candidate.height,
      primary_country_code: candidate.primary_country_code,
      candidate_country_code: candidate.candidate_country_code,
      pair: candidate.pair,
      distance_to_boundary_meters: candidate.distance_to_boundary_meters,
      priority: candidate.priority,
      priority_reasons: candidate.priority_reasons,
      third_source_finding: entry.finding,
      evidence_url: entry.source_url,
      evidence_type: entry.source_type,
      evidence_title: entry.source_title,
      evidence_authority: entry.source_authority,
      evidence_notes: entry.evidence_notes,
      evidence_checked_by: entry.checked_by,
      evidence_checked_at: entry.checked_at,
      recommended_human_action: actionFor(entry.finding),
      decision: null,
      reviewed_by: null,
      reviewed_at: null,
      review_notes: null,
    });
  }

  if (seen.size !== investigationByHash.size) {
    const missing = investigation
      .filter((row) => !seen.has(row.candidate_hash))
      .map((row) => row.candidate_hash.slice(0, 12));
    throw new Error(
      `Missing evidence for current investigation candidates: ${missing.join(", ")}`,
    );
  }

  const sortRows = (a: ReviewRow, b: ReviewRow): number =>
    b.priority - a.priority ||
    (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
      (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
    a.mountain_id - b.mountain_id ||
    a.candidate_country_code.localeCompare(b.candidate_country_code);

  reviewRows.sort(sortRows);
  const supported = reviewRows.filter((row) => row.third_source_finding === "SUPPORTS");
  const rejectCandidates = reviewRows.filter(
    (row) => row.third_source_finding === "DOES_NOT_SUPPORT",
  );
  const ambiguous = reviewRows.filter((row) => row.third_source_finding === "AMBIGUOUS");

  writeJsonl(supportedPath, supported);
  writeJsonl(rejectPath, rejectCandidates);
  writeJsonl(ambiguousPath, ambiguous);
  writeJsonl(humanQueuePath, reviewRows);

  const summary = {
    generated_at: new Date().toISOString(),
    total_rows: reviewRows.length,
    supported_rows: supported.length,
    reject_candidate_rows: rejectCandidates.length,
    ambiguous_rows: ambiguous.length,
    decision_rows_prefilled: 0,
    outputs: {
      supported: supportedPath,
      reject_candidates: rejectPath,
      ambiguous: ambiguousPath,
      human_review: humanQueuePath,
      summary: summaryPath,
    },
    safety:
      "All human decision fields remain null. recommended_human_action is routing metadata only, never an APPROVE/REJECT decision. No SQL is generated or applied.",
  };

  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
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
