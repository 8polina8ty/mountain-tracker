#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";
type SourceType =
  | "OFFICIAL_NATIONAL_MAPPING"
  | "CADASTRAL"
  | "BORDER_COMMISSION"
  | "GOVERNMENT_GAZETTEER"
  | "OFFICIAL_LEGAL_DOCUMENT"
  | "OTHER_AUTHORITATIVE";

type EvidenceRow = {
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

type Patch = {
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  expected_finding: "AMBIGUOUS";
  finding: Exclude<Finding, "AMBIGUOUS">;
  source_url: string;
  source_type: SourceType;
  source_title: string;
  source_authority: string;
  evidence_notes: string;
};

const PATCHES: Patch[] = [
  {
    mountain_id: 331893,
    primary_country_code: "UG",
    candidate_country_code: "CD",
    expected_finding: "AMBIGUOUS",
    finding: "SUPPORTS",
    source_url:
      "https://greatervirunga.org/strengthening-transboundary-tourism-gvtc-and-uwa-inspect-sabyinyo-trail-rehabilitation-works-in-mgahinga-gorilla-national-park/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Strengthening Transboundary Tourism: GVTC and UWA Inspect Sabyinyo Trail Rehabilitation Works in Mgahinga Gorilla National Park",
    source_authority:
      "Great Virunga Transboundary Collaboration (interstate institution of DRC, Rwanda and Uganda)",
    evidence_notes:
      "GVTC's 2025 joint inspection report with Uganda Wildlife Authority explicitly captions the 3rd peak of Sabyinyo as the place where Uganda, Rwanda and the Democratic Republic of Congo meet. This resolves the previous identity ambiguity for the Mountain Tracker record named Mount Sabyinyo 3rd Peak and supports UG->CD summit membership. Human approval remains separate.",
  },
  {
    mountain_id: 5991,
    primary_country_code: "ES",
    candidate_country_code: "AD",
    expected_finding: "AMBIGUOUS",
    finding: "SUPPORTS",
    source_url:
      "https://agricultura.gencat.cat/ca/ambits/medi-natural/casa/terrenys-cinegetics/reserves-nacionals-casa/cerdanya-alt-urgell/",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title: "Cerdanya - Alt Urgell",
    source_authority:
      "Generalitat de Catalunya, Departament d'Agricultura, Ramaderia, Pesca i Alimentació",
    evidence_notes:
      "The official Generalitat de Catalunya description of the Cerdanya-Alt Urgell National Hunting Reserve states that its northern limit is the border with Andorra and enumerates Tosseta de Vallcivera in the sequence of border summits and passes. This independently supports ES->AD membership for the Tosseta de Vallcivera summit.",
  },
  {
    mountain_id: 2737,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    expected_finding: "AMBIGUOUS",
    finding: "DOES_NOT_SUPPORT",
    source_url:
      "https://apps.vorarlberg.at/archiv/umweltschutz/biotopinventar/Moeggers.pdf",
    source_type: "OFFICIAL_NATIONAL_MAPPING",
    source_title: "Biotopinventar Gemeinde Möggers",
    source_authority: "Land Vorarlberg",
    evidence_notes:
      "The official Vorarlberg municipal biotope inventory describes Möggers' eastern state boundary with Germany as running along the eastern flank of the Tatzen ridge, while separately identifying Tatzen itself as one of the municipality's highest points. That places the summit west of the state line inside Austria rather than on the boundary, so AT->DE summit membership is not supported.",
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
  const updated: Array<{ mountain_id: number; pair: string; finding: Finding }> = [];

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
    if (row.finding !== patch.expected_finding) {
      throw new Error(
        `Expected current finding ${patch.expected_finding} for ${row.candidate_hash.slice(0, 12)}…, found ${row.finding}. Refusing to overwrite evolved evidence.`,
      );
    }

    row.finding = patch.finding;
    row.source_url = patch.source_url;
    row.source_type = patch.source_type;
    row.source_title = patch.source_title;
    row.source_authority = patch.source_authority;
    row.evidence_notes = patch.evidence_notes;
    row.checked_by = "ChatGPT-assisted evidence upgrade; human approval pending";
    row.checked_at = checkedAt;

    updated.push({
      mountain_id: row.mountain_id,
      pair: `${row.primary_country_code}->${row.candidate_country_code}`,
      finding: row.finding,
    });
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      upgraded_rows: updated.length,
      supports_added: updated.filter((row) => row.finding === "SUPPORTS").length,
      does_not_support_added: updated.filter((row) => row.finding === "DOES_NOT_SUPPORT").length,
      remaining_ambiguous_rows: rows.filter((row) => row.finding === "AMBIGUOUS").length,
      updated,
      evidence_file: path,
      safety:
        "Only three previously AMBIGUOUS evidence rows with stronger independent evidence are replaced. Human decisions are not changed and no SQL/database write is performed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
