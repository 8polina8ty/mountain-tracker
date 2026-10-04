#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type DiffRow = {
  key: string;
  old_hash: string | null;
  new_hash: string | null;
  old_candidate: BorderCandidate | null;
  new_candidate: BorderCandidate | null;
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

function logicalKey(candidate: BorderCandidate): string {
  return `${candidate.mountain_id}:${candidate.primary_country_code}:${candidate.candidate_country_code}`;
}

function main(): void {
  const oldPath = arg(
    "--old",
    "data/border-peaks/global-run/candidates.jsonl",
  );
  const newPath = arg(
    "--new",
    "data/border-peaks/global-run-v2/candidates.jsonl",
  );
  const verifyOutput = arg(
    "--verify-output",
    "data/border-peaks/global-verification/v2-delta-to-verify.jsonl",
  );
  const changedOutput = arg(
    "--changed-output",
    "data/border-peaks/global-verification/v2-changed.jsonl",
  );
  const removedOutput = arg(
    "--removed-output",
    "data/border-peaks/global-verification/v2-removed.jsonl",
  );
  const summaryOutput = arg(
    "--summary-output",
    "data/border-peaks/global-verification/v2-diff-summary.json",
  );

  const oldRows = readJsonl<BorderCandidate>(oldPath);
  const newRows = readJsonl<BorderCandidate>(newPath);

  const oldByKey = new Map(oldRows.map((row) => [logicalKey(row), row]));
  const newByKey = new Map(newRows.map((row) => [logicalKey(row), row]));

  if (oldByKey.size !== oldRows.length) {
    throw new Error("Old candidate file contains duplicate logical mountain/country pairs");
  }
  if (newByKey.size !== newRows.length) {
    throw new Error("New candidate file contains duplicate logical mountain/country pairs");
  }

  const added: BorderCandidate[] = [];
  const removed: BorderCandidate[] = [];
  const changed: DiffRow[] = [];
  const unchanged: BorderCandidate[] = [];

  for (const [key, row] of newByKey) {
    const old = oldByKey.get(key);
    if (!old) {
      added.push(row);
      continue;
    }
    const oldHash = candidateFingerprint(old);
    const newHash = candidateFingerprint(row);
    if (oldHash === newHash) {
      unchanged.push(row);
    } else {
      changed.push({
        key,
        old_hash: oldHash,
        new_hash: newHash,
        old_candidate: old,
        new_candidate: row,
      });
    }
  }

  for (const [key, row] of oldByKey) {
    if (!newByKey.has(key)) removed.push(row);
  }

  const deltaToVerify = [
    ...added,
    ...changed.map((row) => row.new_candidate as BorderCandidate),
  ].sort(
    (a, b) =>
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  changed.sort((a, b) => a.key.localeCompare(b.key));
  removed.sort(
    (a, b) =>
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  writeJsonl(verifyOutput, deltaToVerify);
  writeJsonl(changedOutput, changed);
  writeJsonl(removedOutput, removed);

  const summary = {
    generated_at: new Date().toISOString(),
    old_rows: oldRows.length,
    new_rows: newRows.length,
    unchanged_rows: unchanged.length,
    added_rows: added.length,
    changed_rows: changed.length,
    removed_rows: removed.length,
    delta_to_verify_rows: deltaToVerify.length,
    added_unique_mountains: new Set(added.map((row) => row.mountain_id)).size,
    changed_unique_mountains: new Set(
      changed.map((row) => row.new_candidate?.mountain_id).filter(Boolean),
    ).size,
    removed_unique_mountains: new Set(removed.map((row) => row.mountain_id)).size,
    outputs: {
      verify_delta: verifyOutput,
      changed: changedOutput,
      removed: removedOutput,
      summary: summaryOutput,
    },
    safety:
      "Only added or hash-changed v2 candidates are queued for fresh verification. Unchanged candidates retain their existing evidence. Removed candidates must not be exported from the v2 discovery set.",
  };

  writeFileSync(summaryOutput, JSON.stringify(summary, null, 2));
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
