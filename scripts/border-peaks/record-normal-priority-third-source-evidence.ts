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
  finding: Finding | null;
  source_url: string | null;
  source_type: SourceType | null;
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
  finding: Finding;
  source_url: string;
  source_type: SourceType;
  source_title: string;
  source_authority: string;
  evidence_notes: string;
};

const PATCHES: Patch[] = [
  {
    mountain_id: 12993,
    primary_country_code: "IT",
    candidate_country_code: "AT",
    finding: "SUPPORTS",
    source_url: "https://de.wikipedia.org/wiki/Nauderer_Hennesiglspitze",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Nauderer Hennesiglspitze",
    source_authority: "Wikipedia with cited alpine literature",
    evidence_notes:
      "The source places the Nauderer Hennesiglspitze summit on the main Alpine ridge that forms the Austria-Italy border at this point and lists both Tyrol and South Tyrol. This independently supports IT->AT summit membership; final human approval remains separate.",
  },
  {
    mountain_id: 12606,
    primary_country_code: "IT",
    candidate_country_code: "AT",
    finding: "SUPPORTS",
    source_url: "https://www.wanderdoerfer.at/kaernten/wanderweg/poludnig-1-999-m/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Poludnig (1.999 m)",
    source_authority: "Österreichs Wanderdörfer",
    evidence_notes:
      "The Austrian tourism source states that in the summit area one can stand for a summit photo on Austrian or Italian territory and that the international border runs immediately near the summit cross. This supports the IT->AT membership for Poludnig while leaving final approval to human review.",
  },
  {
    mountain_id: 1026,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://www.achental.com/ort/breitenstein/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Breitenstein",
    source_authority: "Achental Tourismus / Ferienregion Chiemsee-Chiemgau",
    evidence_notes:
      "The regional tourism source explicitly states that the border between Bavaria and Tyrol runs through the summit of Breitenstein. This independently supports AT->DE summit membership. Human approval remains separate.",
  },
  {
    mountain_id: 5978,
    primary_country_code: "ES",
    candidate_country_code: "AD",
    finding: "SUPPORTS",
    source_url: "https://www.ign.es/resources/acercaDe/libDigPub/FronterasPirineosbaja.pdf",
    source_type: "OFFICIAL_NATIONAL_MAPPING",
    source_title: "Historia del deslinde de la frontera Hispano-Francesa",
    source_authority: "Instituto Geográfico Nacional de España",
    evidence_notes:
      "The Spanish IGN publication describes the southern Andorra-Spain boundary as following the watershed to Pic de la Bassera / Pic dels Llacs and turning at that peak. This independently supports ES->AD membership for the summit candidate.",
  },
  {
    mountain_id: 459,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://mapcarta.com/N11564844001",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Ponten Nebengipfel",
    source_authority: "Mapcarta geographic reference",
    evidence_notes:
      "The independent geographic reference identifies the exact Ponten Nebengipfel coordinate in the Bad Hindelang area, but does not establish that this secondary summit point itself lies on the Austria-Germany state line. The candidate therefore remains ambiguous.",
  },
  {
    mountain_id: 3046,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://wiki.postl.cc/content/wikipedia_de_all_maxi_2024-03/A/Liste_von_Bergen_im_Erzgebirge",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Liste von Bergen im Erzgebirge",
    source_authority: "Compiled geographic reference",
    evidence_notes:
      "The source places Jeřábí vrch / Stangenhöhe in the Czech part of the Ore Mountains and describes the summit as just south of the Czech-German border, rather than on it. This does not support adding Germany as a summit membership for the CZ primary candidate.",
  },
  {
    mountain_id: 1737,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://www.sumava-modravsko.cz/hory/v-hranicnich-horach/mala-mokruvka.html",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Malá Mokrůvka",
    source_authority: "Šumava-Modravsko regional geographic reference",
    evidence_notes:
      "The source states that the state boundary bends across the summit plateau of Malá Mokrůvka / Moorkopf, while most of the summit plateau and the geodetic point lie on the Czech side. It does not resolve whether the exact Mountain Tracker peak coordinate is dual-country, so the row remains ambiguous.",
  },
  {
    mountain_id: 1722,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://de.wikipedia.org/wiki/Lackenberg_%28Bayerischer_Wald%29",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Lackenberg / Plesná",
    source_authority: "Wikipedia with cited geographic literature",
    evidence_notes:
      "The source explicitly states that the Germany-Czech Republic border runs over the flat summit of Lackenberg / Plesná. This independently supports CZ->DE summit membership; final human approval remains separate.",
  },
  {
    mountain_id: 5684,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://de.wikipedia.org/wiki/Weberberg_%28Lausitzer_Gebirge%29",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Weberberg / Vyhlídka",
    source_authority: "Wikipedia with geographic references",
    evidence_notes:
      "The source places the Weberberg summit about 60 metres west of the German-Czech border on Czech territory. This matches the near-border geometry but does not support Germany as a summit membership for the CZ primary record.",
  },
  {
    mountain_id: 78,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://www.tirol.gv.at/sicherheit/geoinformation/vermessung-monitoring/landesgrenze/landesgrenze-zur-bundesrepublik-deutschland/",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title: "Landesgrenze zur Bundesrepublik Deutschland",
    source_authority: "Land Tirol, Abteilung Geoinformation",
    evidence_notes:
      "The official Tyrol source documents the legally defined Austria-Germany border and its detailed treaty/cartographic records. The Mountain Tracker row itself is unnamed, so the record cannot be bound confidently to a named border summit from this source; the candidate remains ambiguous.",
  },
  {
    mountain_id: 47,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://hochvogel.tirol/sommer/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Der Hochvogel",
    source_authority: "Tourismus information Hinterhornbach / Hochvogel Tirol",
    evidence_notes:
      "The local Tyrol tourism source explicitly states that the border between Germany and Austria runs over the summit of Hochvogel. This independently supports AT->DE summit membership.",
  },
  {
    mountain_id: 2737,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrVbg&Gesetzesnummer=20000008",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title: "Verlauf der Landesgrenze zwischen Vorarlberg und der Bundesrepublik Deutschland",
    source_authority: "Rechtsinformationssystem des Bundes / Land Vorarlberg",
    evidence_notes:
      "The official legal source defines the Bavaria-Vorarlberg border by treaty maps and coordinates, but the available text does not name the Tatzen summit or prove that the exact Mountain Tracker summit coordinate is a boundary point. The row remains ambiguous.",
  },
  {
    mountain_id: 461,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://de.wikipedia.org/wiki/S%C3%A4uling",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Säuling",
    source_authority: "Wikipedia with cited alpine literature",
    evidence_notes:
      "The source identifies Säuling as a mountain on the Germany-Austria border and lists both Bavaria and Tyrol. This supports AT->DE membership for the named summit candidate, with final approval still requiring human review.",
  },
  {
    mountain_id: 6208,
    primary_country_code: "GR",
    candidate_country_code: "AL",
    finding: "AMBIGUOUS",
    source_url: "https://geonames.nga.mil/geonames/GNSHome/welcome.html",
    source_type: "GOVERNMENT_GAZETTEER",
    source_title: "GEOnet Names Server",
    source_authority: "US National Geospatial-Intelligence Agency",
    evidence_notes:
      "An independent government gazetteer is suitable for geographic-name identity checks, but the available evidence did not establish that the exact Ourinda summit coordinate lies on the Greece-Albania boundary. The candidate remains ambiguous rather than being inferred from proximity alone.",
  },
  {
    mountain_id: 11815,
    primary_country_code: "XK",
    candidate_country_code: "AL",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://en.wikipedia.org/wiki/Murg%C3%AB_%28mountain%29",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Murgë (mountain)",
    source_authority: "Wikipedia citing NGA GEOnet Names Server",
    evidence_notes:
      "The independent geographic reference identifies Murgë as a 2025 m peak in Kosovo, in Dragash municipality, and does not place the summit in Albania. This does not support the proposed XK->AL summit membership.",
  },
  {
    mountain_id: 539,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://de.wikipedia.org/wiki/Gro%C3%9Fer_Weitschartenkopf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Großer Weitschartenkopf",
    source_authority: "Wikipedia with alpine references",
    evidence_notes:
      "The source places Großer Weitschartenkopf in Salzburg, Austria, near the Bavarian border; it does not describe the summit itself as a border point and locates the nearby Kleine Weitschartenkopf on the German side. This does not support DE as a summit membership.",
  },
  {
    mountain_id: 5991,
    primary_country_code: "ES",
    candidate_country_code: "AD",
    finding: "AMBIGUOUS",
    source_url: "https://visitandorra.com/de/natur-und-sport/recreation-trail-vall-de-madriu-long-distance-route/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Vall de Madriu long-distance route",
    source_authority: "Visit Andorra",
    evidence_notes:
      "The official Andorra tourism route places Port de Vallcivera on the Catalan-Andorran border and continues from there toward Tosseta de Vallcivera. It does not explicitly state that the exact Tosseta summit point itself is on the state line, so the candidate remains ambiguous.",
  },
  {
    mountain_id: 1509,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://www.vonrosenheimnachsalzburg.de/100-etappen/etappe-28/natur-landschaft/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Etappe 28 - Natur & Landschaft",
    source_authority: "Von Rosenheim nach Salzburg regional route project",
    evidence_notes:
      "The regional route reference explicitly states that Rudersburg lies exactly on the border between Germany and Austria. This supports AT->DE summit membership for the named candidate.",
  },
  {
    mountain_id: 105,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://www.tirol.gv.at/sicherheit/geoinformation/vermessung-monitoring/landesgrenze/landesgrenze-zur-bundesrepublik-deutschland/",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title: "Landesgrenze zur Bundesrepublik Deutschland",
    source_authority: "Land Tirol, Abteilung Geoinformation",
    evidence_notes:
      "The official Tyrol border source provides the controlling treaty and mapping framework, but this Mountain Tracker record is unnamed and cannot be matched confidently to a named summit/border point from the textual evidence. The candidate remains ambiguous.",
  },
  {
    mountain_id: 1230,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://de.wikipedia.org/wiki/Falken_%28Allg%C3%A4uer_Alpen%29",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Falken (Allgäuer Alpen)",
    source_authority: "Wikipedia with geographic references",
    evidence_notes:
      "The source describes Falken as lying at the Germany-Austria boundary but explicitly states that the highest point is just inside Austrian territory. Because this workflow requires summit-level membership, that evidence does not support adding Germany for the exact summit record.",
  },
  {
    mountain_id: 6403,
    primary_country_code: "XK",
    candidate_country_code: "AL",
    finding: "SUPPORTS",
    source_url: "https://en.wikipedia.org/wiki/Gusani",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Gusani / Maja e Gusanit",
    source_authority: "Wikipedia citing Military Geographical Institute topographic map",
    evidence_notes:
      "The source explicitly identifies Gusan / Maja e Gusanit as a summit on the Albania-Kosovo border and cites a military topographic map. This independently supports XK->AL summit membership.",
  },
  {
    mountain_id: 3249,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://de.wikipedia.org/wiki/Aschberg_%28Vogtland%29",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Aschberg / Kamenáč",
    source_authority: "Wikipedia with geographic references",
    evidence_notes:
      "The source states that the Aschberg summit lies in the Czech Republic, while the border is lower on the mountain and German facilities are near but not on the summit. This does not support Germany as a summit membership for the CZ primary record.",
  },
  {
    mountain_id: 543,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "AMBIGUOUS",
    source_url: "https://commons.wikimedia.org/wiki/Category%3AAggenstein?uselang=de",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Aggenstein",
    source_authority: "Wikimedia Commons structured geographic metadata",
    evidence_notes:
      "The source identifies the Aggenstein massif as lying on the Bavaria-Tyrol border and lists the southern fore-summit as a component, but it does not establish that the exact Aggenstein Südlicher Vorgipfel coordinate itself is on the state line. The row remains ambiguous.",
  },
  {
    mountain_id: 1686,
    primary_country_code: "CZ",
    candidate_country_code: "DE",
    finding: "DOES_NOT_SUPPORT",
    source_url: "https://web.natur.cuni.cz/~ksgrrsek/acta/2003/AUC_2003_38_Hais_Changes_in_land.pdf",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Changes in land use in the Šumava Mountains",
    source_authority: "Charles University academic publication",
    evidence_notes:
      "The academic source treats Špičník (1351 m) among the highest peaks in the Czech part of the study area, while separately describing the state-border line. This does not support Germany as a summit membership for the CZ primary Großer Spitzberg / Špičník record.",
  },
  {
    mountain_id: 1435,
    primary_country_code: "AT",
    candidate_country_code: "DE",
    finding: "SUPPORTS",
    source_url: "https://www.ris.bka.gv.at/eli/bgbl/1975/490/A1/NOR12008166",
    source_type: "OFFICIAL_LEGAL_DOCUMENT",
    source_title: "Staatsgrenze Österreich - Deutschland",
    source_authority: "Rechtsinformationssystem des Bundes",
    evidence_notes:
      "The official Austria-Germany border treaty defines the border section Saalach-Scheibelberg as ending at Scheibelberg and the following Scheibelberg-Bodensee section as beginning there. This independently supports the named Scheibelberg as a state-border point and therefore AT->DE membership.",
  },
  {
    mountain_id: 118594,
    primary_country_code: "UA",
    candidate_country_code: "RO",
    finding: "AMBIGUOUS",
    source_url: "https://www.karpaty.info/en/uk/if/vh/zelene/routes/",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Zelene routes in the Chyvchyn Mountains",
    source_authority: "Karpaty.info regional geographic guide",
    evidence_notes:
      "The regional geographic material documents the Chyvchyn border-ridge environment, but the Mountain Tracker row is unnamed and the available source cannot bind this exact coordinate to a specific Romania-Ukraine border summit. The row remains ambiguous.",
  },
  {
    mountain_id: 116901,
    primary_country_code: "UA",
    candidate_country_code: "RO",
    finding: "SUPPORTS",
    source_url: "https://karpaty.rocks/en/mount-kernychny",
    source_type: "OTHER_AUTHORITATIVE",
    source_title: "Mount Kernychny",
    source_authority: "Karpaty.rocks regional geographic reference",
    evidence_notes:
      "The source explicitly states that the Romania-Ukraine border stretches across the very top of Mount Kernychnyi from northwest to southeast. This independently supports UA->RO summit membership for the named candidate.",
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
    if (
      [
        row.finding,
        row.source_url,
        row.source_type,
        row.source_title,
        row.source_authority,
        row.evidence_notes,
        row.checked_by,
        row.checked_at,
      ].some((value) => value != null)
    ) {
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
    });
  }

  writeFileSync(
    path,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  );

  const findings = {
    SUPPORTS: updated.filter((row) => row.finding === "SUPPORTS").length,
    DOES_NOT_SUPPORT: updated.filter((row) => row.finding === "DOES_NOT_SUPPORT").length,
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
