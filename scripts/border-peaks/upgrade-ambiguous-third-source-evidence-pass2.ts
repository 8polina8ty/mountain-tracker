#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Finding = "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS";

type EvidenceRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: Finding;
  source_url: string;
  source_type:
    | "OFFICIAL_NATIONAL_MAPPING"
    | "CADASTRAL"
    | "BORDER_COMMISSION"
    | "GOVERNMENT_GAZETTEER"
    | "OFFICIAL_LEGAL_DOCUMENT"
    | "OTHER_AUTHORITATIVE";
  source_title: string;
  source_authority: string;
  evidence_notes: string;
  checked_by: string;
  checked_at: string;
};

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

  const matches = rows.filter(
    (row) =>
      row.mountain_id === 12809 &&
      row.primary_country_code === "IT" &&
      row.candidate_country_code === "AT",
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one 12809 IT->AT evidence row, found ${matches.length}`);
  }

  const row = matches[0];
  if (row.finding !== "AMBIGUOUS") {
    throw new Error(
      `Expected 12809 IT->AT to still be AMBIGUOUS, found ${row.finding}. Refusing stale evidence upgrade.`,
    );
  }

  row.finding = "SUPPORTS";
  row.source_url =
    "https://hoehle.org/downloads/Gebirgsgruppen_Beschreibung.pdf";
  row.source_type = "OTHER_AUTHORITATIVE";
  row.source_title = "Verbale Beschreibung der Umgrenzung der Gebirgsgruppen";
  row.source_authority =
    "Verband Österreichischer Höhlenforscher; boundary description compiled with Austrian regional survey/cave-register contributors";
  row.evidence_notes =
    "The technical Austrian mountain-group boundary description for group 2223 Fineilspitze explicitly states that the state border runs westward over the Fineilköpfe. The Tiroler Landesarchiv separately identifies the Fineilköpfe as two adjacent summits around 3415 m in Sölden, matching the Mountain Tracker Östlicher Fineilkopf record. Together this resolves the prior border-context ambiguity and supports IT->AT summit membership; human approval remains separate.";
  row.checked_by = "ChatGPT-assisted evidence upgrade; human approval pending";
  row.checked_at = new Date().toISOString();

  writeFileSync(
    path,
    rows.length ? `${rows.map((item) => JSON.stringify(item)).join("\n")}\n` : "",
  );

  process.stdout.write(
    `${JSON.stringify({
      upgraded_rows: 1,
      mountain_id: row.mountain_id,
      pair: "IT->AT",
      finding: row.finding,
      remaining_ambiguous_rows: rows.filter((item) => item.finding === "AMBIGUOUS").length,
      evidence_file: path,
      safety:
        "Only the still-pending Östlicher Fineilkopf evidence row is upgraded from AMBIGUOUS to SUPPORTS. No human decision, SQL, or database state is changed.",
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
