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
    mountain_id: 112439,
    primary_country_code: "SK",
    candidate_country_code: "PL",
    finding: "SUPPORTS",
    source_url:
      "https://tpn.gov.pl/uploads/files/67c42cadd4293950766351.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Charakterystyka środowiska przyrodniczego Tatr Polskich",
    source_authority: "Tatrzański Park Narodowy",
    evidence_notes:
      "Official Tatra National Park material maps Grześ (Lúčna) together with the state boundary in the Western Tatras. The mapped summit lies on the Polish-Slovak boundary context, independently supporting the SK->PL membership for this summit record. Human approval remains separate.",
  },
  {
    mountain_id: 62580,
    primary_country_code: "RU",
    candidate_country_code: "GE",
    finding: "AMBIGUOUS",
    source_url:
      "https://dspace.nplg.gov.ge/bitstream/1234/420344/1/Voprosi_Eko_Evolucii_Gornix_Vodoxranilishch_Gruzii.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Вопросы эко-эволюции горных водохранилищ Грузии",
    source_authority:
      "Georgian scientific publication archived by the National Parliamentary Library of Georgia",
    evidence_notes:
      "The independent Georgian scientific source identifies Chanchakhi in the Racha geographic context, but the available text does not establish that the exact Mountain Tracker summit coordinate belongs to both Georgia and Russia. Because the evidence does not resolve the summit-level boundary placement, the candidate remains ambiguous.",
  },
  {
    mountain_id: 62098,
    primary_country_code: "RU",
    candidate_country_code: "GE",
    finding: "AMBIGUOUS",
    source_url:
      "https://kniiran-vestnik.ru/wp-content/uploads/2022/12/85-93.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Вестник КНИИ РАН. Серия «Естественные и технические науки» № 2 (10), 2022",
    source_authority:
      "Kh. I. Ibragimov Complex Research Institute of the Russian Academy of Sciences",
    evidence_notes:
      "The independent RAS institute publication lists Tsuzun-Kort (3438 m) among peaks of the Itum-Kalinsky district of the Chechen Republic. It does not establish the Georgian side of the exact summit coordinate, so it is insufficient to prove the proposed RU->GE dual membership and the case remains ambiguous.",
  },
  {
    mountain_id: 31117,
    primary_country_code: "HR",
    candidate_country_code: "BA",
    finding: "SUPPORTS",
    source_url:
      "https://fmpvs.gov.ba/wp-content/uploads/2017/Lovstvo/Lovstvo-odluke/Odluka-posebna-lovista-80-12.pdf",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title:
      "Odluka o posebnim lovištima, Službene novine Federacije BiH broj 80/12",
    source_authority:
      "Federalno ministarstvo poljoprivrede, vodoprivrede i šumarstva Federacije Bosne i Hercegovine",
    evidence_notes:
      "The official Federation of Bosnia and Herzegovina decision describes the Plješevica hunting-ground boundary as following the state border with Croatia through a sequence of named summits including Šoputov vrh (kota 1403). This independently supports the HR->BA membership for Šoputov vrh. Human approval remains separate.",
  },
  {
    mountain_id: 319701,
    primary_country_code: "KG",
    candidate_country_code: "KZ",
    finding: "AMBIGUOUS",
    source_url:
      "https://www.tlib.ru/pdf/03/20/032036.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Mountain route report published under the Ministry of Tourism and Sport of the Republic of Kazakhstan",
    source_authority:
      "Ministry of Tourism and Sport of the Republic of Kazakhstan",
    evidence_notes:
      "The independent Kazakhstan ministry-hosted route material documents the Sapozhnikov glacier/pass system on the main Zailiyskiy Alatau ridge and its connection toward the Chon-Kemin basin. It does not explicitly identify the Mountain Tracker peak named Sapozhnikov as a Kazakhstan-Kyrgyzstan boundary summit, so the proposed KG->KZ membership remains ambiguous.",
  },
  {
    mountain_id: 69325,
    primary_country_code: "CH",
    candidate_country_code: "IT",
    finding: "SUPPORTS",
    source_url:
      "https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/piz-chavalatsch-12012/ski-touring/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Piz Chavalatsch 2762 m - Ski tour",
    source_authority: "Swiss Alpine Club SAC",
    evidence_notes:
      "The Swiss Alpine Club describes Piz Chavalatsch as the easternmost point of Switzerland on the border ridge between Val Müstair and the Italian Trafoi valley. This independently supports the CH->IT membership for the summit. Human approval remains separate.",
  },
  {
    mountain_id: 12809,
    primary_country_code: "IT",
    candidate_country_code: "AT",
    finding: "AMBIGUOUS",
    source_url:
      "https://www.almenrausch.at/touren/detail/default-85a9cc27fe/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title:
      "Östlicher Fineilkopf 3413 m - Skihochtour von der Grawandbahn",
    source_authority: "Almenrausch.at alpine tour database",
    evidence_notes:
      "The independent alpine route description places Östlicher Fineilkopf in the border area between the Ötztal and Schnalstal and identifies the exact summit, but it does not explicitly state that the summit point itself lies on the Austria-Italy state boundary. This is insufficient for dual-country approval, so the case remains ambiguous.",
  },
  {
    mountain_id: 61379,
    primary_country_code: "RU",
    candidate_country_code: "GE",
    finding: "AMBIGUOUS",
    source_url:
      "https://www.geonames.org/advanced-search.html?continentCode=AS&q=gora&startRow=100",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "GeoNames geographic feature search",
    source_authority: "GeoNames geographical database",
    evidence_notes:
      "The available independent geographic-name evidence for this unnamed Mountain Tracker record is not sufficiently specific to bind the database coordinate to a named summit and prove a Russia-Georgia dual membership. Because the mountain record lacks a usable name and the third-source identity cannot be established confidently, the case remains ambiguous.",
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

  const findings = {
    SUPPORTS: updated.filter((row) => row.finding === "SUPPORTS").length,
    DOES_NOT_SUPPORT: updated.filter(
      (row) => row.finding === "DOES_NOT_SUPPORT",
    ).length,
    AMBIGUOUS: updated.filter((row) => row.finding === "AMBIGUOUS").length,
  };

  process.stdout.write(
    `${JSON.stringify({
      updated_rows: updated.length,
      findings,
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
