#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type ReviewTier =
  | "HIGH_CONFIDENCE_REVIEW"
  | "STANDARD_REVIEW"
  | "THIRD_SOURCE_RECOMMENDED";
type NamedTier = "STANDARD_STRONG_REVIEW" | "STANDARD_MANUAL_REVIEW";

type GeoRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  review_tier: ReviewTier;
  review_reasons: string[];
  evidence_source: string;
  probe_status: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
};

type OutputRow = GeoRow & {
  named_review_tier: NamedTier;
  named_review_reasons: string[];
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

function blank(value: string | null): boolean {
  return value == null || value.trim().length === 0;
}

function main(): void {
  const geoPath = arg(
    "--geo-review",
    "data/border-peaks/global-review/geometric-support/all.jsonl",
  );
  const decisionsPath = arg(
    "--decisions",
    "data/border-peaks/global-review/strong-review-decisions.jsonl",
  );
  const outDir = arg(
    "--output-dir",
    "data/border-peaks/global-review/geometric-support/named-standard",
  );

  const geoRows = readJsonl<GeoRow>(geoPath);
  const decisions = readJsonl<DecisionRow>(decisionsPath);

  if (geoRows.length !== 553) {
    throw new Error(`Expected 553 geometric review rows, found ${geoRows.length}`);
  }
  if (decisions.length !== 1372) {
    throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
  }

  const completed = decisions.filter((row) => row.decision != null);
  const pending = decisions.filter((row) => row.decision == null);
  const approve = decisions.filter((row) => row.decision === "APPROVE");
  const reject = decisions.filter((row) => row.decision === "REJECT");

  if (
    completed.length !== 1275 ||
    pending.length !== 97 ||
    approve.length !== 1223 ||
    reject.length !== 52
  ) {
    throw new Error(
      `Expected current state completed=1275, pending=97, approve=1223, reject=52; found ${completed.length}/${pending.length}/${approve.length}/${reject.length}`,
    );
  }

  const geoByHash = new Map(geoRows.map((row) => [row.candidate_hash, row]));
  const outputs: OutputRow[] = [];
  const seen = new Set<string>();

  for (const decision of pending) {
    if (seen.has(decision.candidate_hash)) {
      throw new Error(
        `Duplicate pending decision hash ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }
    seen.add(decision.candidate_hash);

    const geo = geoByHash.get(decision.candidate_hash);
    if (!geo) {
      throw new Error(
        `Pending hash missing from geometric review: ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      geo.mountain_id !== decision.mountain_id ||
      geo.mountain_name !== decision.mountain_name ||
      geo.primary_country_code !== decision.primary_country_code ||
      geo.candidate_country_code !== decision.candidate_country_code ||
      geo.pair !== decision.pair ||
      geo.final_machine_status !== decision.final_machine_status
    ) {
      throw new Error(
        `Geometric/decision identity mismatch for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      decision.final_machine_status !== "GEOMETRIC_SUPPORT" ||
      geo.review_tier !== "STANDARD_REVIEW"
    ) {
      throw new Error(
        `Expected pending STANDARD_REVIEW GEOMETRIC_SUPPORT for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (blank(decision.mountain_name)) {
      throw new Error(
        `Unnamed row remained pending after rejection policy: ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    if (
      decision.reviewed_by != null ||
      decision.reviewed_at != null ||
      decision.review_notes != null ||
      decision.decision_batch_id != null
    ) {
      throw new Error(
        `Pending row has reviewer metadata for ${decision.candidate_hash.slice(0, 12)}…`,
      );
    }

    const hasDualProbe =
      Boolean(geo.primary_country_code) &&
      geo.probe_country_codes.includes(geo.primary_country_code as string) &&
      geo.probe_country_codes.includes(geo.candidate_country_code);
    const hasPeakIdentity =
      !blank(geo.osm_peak_name) || !blank(geo.osm_peak_wikidata);
    const boundaryStrong =
      geo.distance_to_boundary_meters != null &&
      geo.distance_to_boundary_meters <= 100;
    const peakStrong =
      geo.osm_peak_distance_meters != null &&
      geo.osm_peak_distance_meters <= 10;
    const successfulProbe =
      geo.probe_status === "GEOMETRIC_SUPPORT" ||
      geo.probe_status === "VERIFIED";

    const reasons: string[] = [];
    const strong =
      boundaryStrong &&
      peakStrong &&
      hasPeakIdentity &&
      hasDualProbe &&
      successfulProbe;

    if (boundaryStrong) reasons.push("geoBoundaries distance <=100m");
    else reasons.push("geoBoundaries distance >100m or unavailable");

    if (peakStrong) reasons.push("OSM peak identity <=10m");
    else reasons.push("OSM peak identity >10m or unavailable");

    if (hasPeakIdentity) reasons.push("OSM peak has name or Wikidata identity");
    else reasons.push("OSM peak name/Wikidata identity missing");

    if (hasDualProbe && successfulProbe) {
      reasons.push("successful dual-country probe evidence");
    } else {
      reasons.push("dual-country probe evidence incomplete");
    }

    outputs.push({
      ...geo,
      named_review_tier: strong
        ? "STANDARD_STRONG_REVIEW"
        : "STANDARD_MANUAL_REVIEW",
      named_review_reasons: reasons,
    });
  }

  outputs.sort(
    (a, b) =>
      (a.named_review_tier === b.named_review_tier
        ? 0
        : a.named_review_tier === "STANDARD_STRONG_REVIEW"
          ? -1
          : 1) ||
      (a.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) -
        (b.distance_to_boundary_meters ?? Number.POSITIVE_INFINITY) ||
      a.mountain_id - b.mountain_id ||
      a.candidate_country_code.localeCompare(b.candidate_country_code),
  );

  const strong = outputs.filter(
    (row) => row.named_review_tier === "STANDARD_STRONG_REVIEW",
  );
  const manual = outputs.filter(
    (row) => row.named_review_tier === "STANDARD_MANUAL_REVIEW",
  );

  writeJsonl(join(outDir, "all.jsonl"), outputs);
  writeJsonl(join(outDir, "strong.jsonl"), strong);
  writeJsonl(join(outDir, "manual.jsonl"), manual);

  const summary = {
    generated_at: new Date().toISOString(),
    total_pending_named_standard: outputs.length,
    unique_mountains: new Set(outputs.map((row) => row.mountain_id)).size,
    tiers: {
      STANDARD_STRONG_REVIEW: strong.length,
      STANDARD_MANUAL_REVIEW: manual.length,
    },
    outputs: {
      all: join(outDir, "all.jsonl"),
      strong: join(outDir, "strong.jsonl"),
      manual: join(outDir, "manual.jsonl"),
    },
    safety:
      "Read-only triage of the 97 remaining named STANDARD_REVIEW candidates. No APPROVE/REJECT decisions, SQL, or database writes are performed.",
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
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
