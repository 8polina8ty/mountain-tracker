#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type SourceType =
  | "OFFICIAL_NATIONAL_MAPPING"
  | "CADASTRAL"
  | "BORDER_COMMISSION"
  | "GOVERNMENT_GAZETTEER"
  | "OFFICIAL_LEGAL_DOCUMENT"
  | "OTHER_AUTHORITATIVE";

type InvestigationRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string | null;
  candidate_country_code: string;
};

type EvidenceEntry = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: Finding;
  source_url: string;
  source_type: SourceType;
  source_title: string;
  source_authority: string;
  evidence_notes: string;
  checked_by: string;
  checked_at: string;
};

const FINDINGS = new Set<Finding>([
  "SUPPORTS",
  "DOES_NOT_SUPPORT",
  "AMBIGUOUS",
]);

const SOURCE_TYPES = new Set<SourceType>([
  "OFFICIAL_NATIONAL_MAPPING",
  "CADASTRAL",
  "BORDER_COMMISSION",
  "GOVERNMENT_GAZETTEER",
  "OFFICIAL_LEGAL_DOCUMENT",
  "OTHER_AUTHORITATIVE",
]);

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

function assertIso(value: string, field: string, hash: string): void {
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${field} for ${hash.slice(0, 12)}…`);
  }
}

function assertIndependentSource(entry: EvidenceEntry): void {
  let url: URL;
  try {
    url = new URL(entry.source_url);
  } catch {
    throw new Error(
      `Invalid source_url for ${entry.candidate_hash.slice(0, 12)}…`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `source_url must be http(s) for ${entry.candidate_hash.slice(0, 12)}…`,
    );
  }

  const forbidden = [
    "openstreetmap.org",
    "overpass-api.de",
    "overpass.private.coffee",
    "maps.mail.ru",
    "geoboundaries.org",
    "geolab.wm.edu",
  ];
  const host = url.hostname.toLowerCase();
  if (forbidden.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(
      `Source ${host} is already used by the pipeline and is not an independent third source`,
    );
  }

  const authority = entry.source_authority.toLowerCase();
  if (
    authority.includes("openstreetmap") ||
    authority.includes("geoboundaries") ||
    authority.includes("william & mary geolab")
  ) {
    throw new Error(
      `source_authority is not independent for ${entry.candidate_hash.slice(0, 12)}…`,
    );
  }
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

  const investigation = readJsonl<InvestigationRow>(investigationPath);
  const evidenceRaw = readJsonl<Record<string, unknown>>(evidencePath);

  const investigationByHash = new Map(
    investigation.map((row) => [row.candidate_hash, row]),
  );
  const seen = new Set<string>();
  const validated: EvidenceEntry[] = [];

  for (const raw of evidenceRaw) {
    if (
      raw.finding == null &&
      raw.source_url == null &&
      raw.source_type == null &&
      raw.source_title == null &&
      raw.source_authority == null &&
      raw.evidence_notes == null &&
      raw.checked_by == null &&
      raw.checked_at == null
    ) {
      continue;
    }

    const entry = raw as unknown as EvidenceEntry;
    if (!entry.candidate_hash || !/^[a-f0-9]{64}$/.test(entry.candidate_hash)) {
      throw new Error("Evidence row has invalid candidate_hash");
    }
    if (seen.has(entry.candidate_hash)) {
      throw new Error(
        `Duplicate evidence decision for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }
    seen.add(entry.candidate_hash);

    const expected = investigationByHash.get(entry.candidate_hash);
    if (!expected) {
      throw new Error(
        `candidate_hash ${entry.candidate_hash.slice(0, 12)}… is not present in the current third-source investigation queue`,
      );
    }

    if (
      entry.mountain_id !== expected.mountain_id ||
      entry.primary_country_code !== expected.primary_country_code ||
      entry.candidate_country_code !== expected.candidate_country_code
    ) {
      throw new Error(
        `Candidate identity mismatch for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (!FINDINGS.has(entry.finding)) {
      throw new Error(
        `Invalid finding for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }
    if (!SOURCE_TYPES.has(entry.source_type)) {
      throw new Error(
        `Invalid source_type for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }

    for (const [field, value] of [
      ["source_title", entry.source_title],
      ["source_authority", entry.source_authority],
      ["evidence_notes", entry.evidence_notes],
      ["checked_by", entry.checked_by],
    ] as const) {
      if (typeof value !== "string" || value.trim().length < 3) {
        throw new Error(
          `${field} is required for ${entry.candidate_hash.slice(0, 12)}…`,
        );
      }
    }

    if (
      entry.finding === "SUPPORTS" &&
      entry.evidence_notes.trim().length < 20
    ) {
      throw new Error(
        `SUPPORTS requires specific evidence_notes for ${entry.candidate_hash.slice(0, 12)}…`,
      );
    }

    assertIso(entry.checked_at, "checked_at", entry.candidate_hash);
    assertIndependentSource(entry);
    validated.push(entry);
  }

  const counts = {
    SUPPORTS: validated.filter((row) => row.finding === "SUPPORTS").length,
    DOES_NOT_SUPPORT: validated.filter(
      (row) => row.finding === "DOES_NOT_SUPPORT",
    ).length,
    AMBIGUOUS: validated.filter((row) => row.finding === "AMBIGUOUS").length,
  };

  process.stdout.write(
    `${JSON.stringify({
      investigation_rows: investigation.length,
      evidence_rows_present: evidenceRaw.length,
      completed_evidence_rows: validated.length,
      pending_rows: investigation.length - validated.length,
      finding_counts: counts,
      valid: true,
      safety:
        "Validated third-source evidence remains evidence only. SUPPORTS does not equal APPROVE; a separate human review decision manifest is still required before SQL export.",
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
