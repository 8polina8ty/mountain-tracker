#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type VerificationRow = {
  candidate_hash: string;
  status: "VERIFIED" | "GEOMETRIC_SUPPORT" | "CONFLICT" | "INSUFFICIENT" | "ERROR";
  mode?: "CENTER" | "PROBE";
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function main(): void {
  const candidatesPath = arg("--candidates", "data/border-peaks/global-verification/v2-delta-to-verify.jsonl");
  const evidencePath = arg("--evidence", "data/border-peaks/global-verification/osm-evidence-v2-delta.jsonl");
  const outputPath = arg("--output", "data/border-peaks/global-verification/v2-delta-probe-queue.jsonl");

  const candidates = readJsonl<BorderCandidate>(candidatesPath);
  const evidence = readJsonl<VerificationRow>(evidencePath);
  const latestCenter = new Map<string, VerificationRow>();

  for (const row of evidence) {
    if ((row.mode ?? "CENTER") !== "CENTER") continue;
    latestCenter.set(row.candidate_hash, row);
  }

  const queue = candidates.filter((candidate) => {
    const row = latestCenter.get(candidateFingerprint(candidate));
    return row?.status === "INSUFFICIENT";
  });

  writeFileSync(
    outputPath,
    queue.length ? `${queue.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(`${JSON.stringify({
    candidate_rows: candidates.length,
    latest_center_rows: latestCenter.size,
    probe_queue_rows: queue.length,
    unique_mountains: new Set(queue.map((row) => row.mountain_id)).size,
    output: outputPath,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
