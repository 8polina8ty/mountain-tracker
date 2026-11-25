#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type EvidenceRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS" | null;
  source_url: string | null;
  source_type:
    | "OFFICIAL_NATIONAL_MAPPING"
    | "CADASTRAL"
    | "BORDER_COMMISSION"
    | "GOVERNMENT_GAZETTEER"
    | "OFFICIAL_LEGAL_DOCUMENT"
    | "OTHER_AUTHORITATIVE"
    | null;
  source_title: string | null;
  source_authority: string | null;
  evidence_notes: string | null;
  checked_by: string | null;
  checked_at: string | null;
};

type Patch = {
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: Exclude<EvidenceRow["finding"], null>;
  source_url: string;
  source_type: Exclude<EvidenceRow["source_type"], null>;
  source_title: string;
  source_authority: string;
  evidence_notes: string;
};

const PATCHES: Patch[] = [
  {
    mountain_id: 11763,
    primary_country_code: "ME",
    candidate_country_code: "XK",
    finding: "SUPPORTS",
    source_url:
      "https://wapi.gov.me/download/098b7ba6-90a4-4e01-a394-4c5cc3ec6306?version=1.0",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Informacija o realizaciji zimske turističke sezone 2023/2024",
    source_authority:
      "Ministarstvo turizma, ekologije, održivog razvoja i razvoja sjevera Crne Gore",
    evidence_notes:
      "Official Montenegro ministry report describes Tromeđa at 2,366 m as one summit involving three states in one day: Kosovo, Montenegro and Albania. This independently supports the ME->XK membership for the Tromeđa summit candidate. Human approval remains separate.",
  },
  {
    mountain_id: 11763,
    primary_country_code: "ME",
    candidate_country_code: "AL",
    finding: "SUPPORTS",
    source_url:
      "https://wapi.gov.me/download/098b7ba6-90a4-4e01-a394-4c5cc3ec6306?version=1.0",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Informacija o realizaciji zimske turističke sezone 2023/2024",
    source_authority:
      "Ministarstvo turizma, ekologije, održivog razvoja i razvoja sjevera Crne Gore",
    evidence_notes:
      "Official Montenegro ministry report describes Tromeđa at 2,366 m as one summit involving three states in one day: Kosovo, Montenegro and Albania. This independently supports the ME->AL membership for the Tromeđa summit candidate. Human approval remains separate.",
  },
  {
    mountain_id: 331893,
    primary_country_code: "UG",
    candidate_country_code: "CD",
    finding: "AMBIGUOUS",
    source_url:
      "https://ugandawildlife.org/wp-content/uploads/2024/05/MGNP-2018-4.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Mgahinga Gorilla National Park",
    source_authority: "Uganda Wildlife Authority",
    evidence_notes:
      "Official Uganda Wildlife Authority material states that Sabinyo has several summits and that the summit reached on the climb gives the rare privilege of standing in three countries at once. However, it does not explicitly identify that tripoint summit as the Mountain Tracker record named 'Mount Sabyinyo 3rd Peak', so the exact candidate identity remains ambiguous and must not be auto-approved.",
  },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main(): void {
  const path = arg(
    "--evidence",
    "data/border-peaks/global-review/third-source-evidence.jsonl",
  );
  if (!existsSync(path)) throw new Error(`Required file is missing: ${path}`);

  const raw = readFileSync(path, "utf8").trim();
  const rows = raw
    ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvidenceRow)
    : [];

  const checkedAt = new Date().toISOString();
  const updated: Array<{
    mountain_id: number;
    pair: string;
    finding: string;
    candidate_hash: string;
  }> = [];

  for (const patch of PATCHES) {
    const matches = rows.filter(
      (row) =>
        row.mountain_id === patch.mountain_id &&
        row.primary_country_code === patch.primary_country_code &&
        row.candidate_country_code === patch.candidate_country_code,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one evidence row for ${patch.mountain_id} ${patch.primary_country_code}->${patch.candidate_country_code}, found ${matches.length}`,
      );
    }

    const row = matches[0];
    const evidenceFields = [
      row.finding,
      row.source_url,
      row.source_type,
      row.source_title,
      row.source_authority,
      row.evidence_notes,
      row.checked_by,
      row.checked_at,
    ];
    if (evidenceFields.some((value) => value != null)) {
      throw new Error(
        `Refusing to overwrite existing evidence for ${row.candidate_hash.slice(0, 12)}…`,
      );
    }

    row.finding = patch.finding;
    row.source_url = patch.source_url;
    row.source_type = patch.source_type;
    row.source_title = patch.source_title;
    row.source_authority = patch.source_authority;
    row.evidence_notes = patch.evidence_notes;
    row.checked_by = "ChatGPT-assisted research; human approval pending";
    row.checked_at = checkedAt;

    updated.push({
      mountain_id: row.mountain_id,
      pair: `${row.primary_country_code}->${row.candidate_country_code}`,
      finding: patch.finding,
      candidate_hash: row.candidate_hash,
    });
  }

  writeFileSync(
    path,
    rows.length
      ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      updated_rows: updated.length,
      findings: {
        SUPPORTS: updated.filter((row) => row.finding === "SUPPORTS").length,
        AMBIGUOUS: updated.filter((row) => row.finding === "AMBIGUOUS").length,
      },
      updated,
      evidence_file: path,
      safety:
        "This records third-source evidence only. It does not create APPROVE decisions or SQL. Existing non-null evidence is never overwritten.",
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
