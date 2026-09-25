#!/usr/bin/env ts-node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { candidateFingerprint } from "./export-approved.ts";
import type { BorderCandidate } from "./types.ts";

type VerificationStatus =
  | "VERIFIED"
  | "GEOMETRIC_SUPPORT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "ERROR";

type CountryArea = {
  area_id: number;
  country_code: string;
  name: string | null;
  osm_ref: string | null;
};

type VerificationRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string;
  candidate_country_code: string;
  status: VerificationStatus;
  provider: "OpenStreetMap/Overpass";
  queried_at: string;
  endpoint: string;
  center_country_codes: string[];
  probe_country_codes: string[];
  center_areas: CountryArea[];
  probe_areas: CountryArea[];
  osm_peak: {
    type: "node";
    id: number;
    lat: number;
    lon: number;
    distance_meters: number;
    name: string | null;
    wikidata: string | null;
  } | null;
  evidence_reference: string | null;
  notes: string;
};

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

type Args = {
  input: string;
  output: string;
  cacheDir: string;
  endpoints: string[];
  limit: number;
  retriesPerEndpoint: number;
  delayMs: number;
  timeoutMs: number;
  resume: boolean;
  probe: boolean;
};

function parseArgs(): Args {
  const values = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
  };
  const integer = (name: string, fallback: number, min: number): number => {
    const raw = get(name);
    const value = raw == null ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be an integer >= ${min}`);
    }
    return value;
  };

  const rawLimit = get("--limit");
  const limit =
    rawLimit == null || rawLimit === "0"
      ? Number.MAX_SAFE_INTEGER
      : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer or 0");
  }

  return {
    input:
      get("--input") ??
      "data/border-peaks/global-run/candidates.jsonl",
    output:
      get("--output") ??
      "data/border-peaks/global-verification/osm-evidence.jsonl",
    cacheDir:
      get("--cache-dir") ??
      "data/border-peaks/global-verification/cache/overpass",
    endpoints: (
      get("--endpoints") ??
      get("--endpoint") ??
      [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      ].join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    limit,
    retriesPerEndpoint: integer("--retries-per-endpoint", 2, 1),
    delayMs: integer("--delay-ms", 1500, 250),
    timeoutMs: integer("--timeout-ms", 45000, 5000),
    resume: values.includes("--resume"),
    probe: values.includes("--probe"),
  };
}

function uniqueCandidates(path: string): BorderCandidate[] {
  if (!existsSync(path)) {
    throw new Error(`Candidate input does not exist: ${path}`);
  }
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BorderCandidate);

  const byMountain = new Map<number, BorderCandidate[]>();
  for (const row of rows) {
    if (
      !Number.isInteger(row.mountain_id) ||
      !row.primary_country_code ||
      !/^[A-Z]{2}$/.test(row.primary_country_code) ||
      !/^[A-Z]{2}$/.test(row.candidate_country_code)
    ) {
      throw new Error(`Invalid candidate row for mountain ${row.mountain_id}`);
    }
    const list = byMountain.get(row.mountain_id) ?? [];
    list.push(row);
    byMountain.set(row.mountain_id, list);
  }

  return [...byMountain.values()]
    .flatMap((group) =>
      group.sort((a, b) =>
        a.candidate_country_code.localeCompare(b.candidate_country_code),
      ),
    )
    .sort(
      (a, b) =>
        a.mountain_id - b.mountain_id ||
        a.candidate_country_code.localeCompare(b.candidate_country_code),
    );
}

function alreadyProcessed(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const latest = new Map<string, VerificationRow>();
  for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as VerificationRow;
    latest.set(row.candidate_hash, row);
  }
  return new Set(
    [...latest.values()]
      .filter((row) => row.status !== "ERROR")
      .map((row) => row.candidate_hash),
  );
}

function cacheKey(lat: number, lon: number): string {
  return createHash("sha256")
    .update(`${lat.toFixed(7)},${lon.toFixed(7)}`)
    .digest("hex");
}

function overpassQuery(lat: number, lon: number): string {
  return `[out:json][timeout:25];
is_in(${lat.toFixed(7)},${lon.toFixed(7)})->.center;
area.center["boundary"="administrative"]["admin_level"="2"];
out tags;
node(around:75,${lat.toFixed(7)},${lon.toFixed(7)})["natural"="peak"];
out body;`;
}

function metersToLat(meters: number): number {
  return meters / 111000;
}

function metersToLon(meters: number, lat: number): number {
  return meters /
    (111000 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
}

function probes(lat: number, lon: number): Array<[number, number]> {
  const radius = 40;
  const dLat = metersToLat(radius);
  const dLon = metersToLon(radius, lat);
  return [
    [lat + dLat, lon],
    [lat - dLat, lon],
    [lat, lon + dLon],
    [lat, lon - dLon],
  ];
}

function countryCode(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  const code =
    tags["ISO3166-1:alpha2"] ??
    tags["ISO3166-1"] ??
    tags["iso3166-1:alpha2"];
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

function areaRows(elements: OverpassElement[]): CountryArea[] {
  const result: CountryArea[] = [];
  for (const element of elements) {
    if (element.type !== "area") continue;
    const code = countryCode(element.tags);
    if (!code) continue;
    result.push({
      area_id: element.id,
      country_code: code,
      name: element.tags?.name ?? null,
      osm_ref:
        element.tags?.wikidata ??
        element.tags?.["ISO3166-1:alpha2"] ??
        null,
    });
  }
  const seen = new Set<string>();
  return result.filter((row) => {
    const key = `${row.area_id}:${row.country_code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const r = 6371000;
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function nearestPeak(
  elements: OverpassElement[],
  lat: number,
  lon: number,
): VerificationRow["osm_peak"] {
  let best: VerificationRow["osm_peak"] = null;
  for (const element of elements) {
    if (
      element.type !== "node" ||
      !Number.isFinite(element.lat) ||
      !Number.isFinite(element.lon) ||
      element.tags?.natural !== "peak"
    ) {
      continue;
    }
    const distance = haversineMeters(
      lat,
      lon,
      element.lat as number,
      element.lon as number,
    );
    if (!best || distance < best.distance_meters) {
      best = {
        type: "node",
        id: element.id,
        lat: element.lat as number,
        lon: element.lon as number,
        distance_meters: Math.round(distance),
        name: element.tags?.name ?? null,
        wikidata: element.tags?.wikidata ?? null,
      };
    }
  }
  return best;
}

async function fetchOverpass(
  args: Args,
  lat: number,
  lon: number,
): Promise<{ value: OverpassResponse; endpoint: string }> {
  mkdirSync(args.cacheDir, { recursive: true });
  const key = cacheKey(lat, lon);
  const path = resolve(args.cacheDir, `${key}.json`);
  if (existsSync(path)) {
    return {
      value: JSON.parse(readFileSync(path, "utf8")) as OverpassResponse,
      endpoint: "cache",
    };
  }

  const failures: string[] = [];
  for (const endpoint of args.endpoints) {
    for (let attempt = 1; attempt <= args.retriesPerEndpoint; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        const body = new URLSearchParams({ data: overpassQuery(lat, lon) });
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent":
              "MountainTracker-border-verifier/1.0 (read-only research)",
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          failures.push(
            `${endpoint} attempt ${attempt}: HTTP ${response.status} ${detail}`,
          );
          if (response.status === 429 || response.status === 406) {
            await sleep(30_000);
          } else if (attempt < args.retriesPerEndpoint) {
            await sleep(Math.min(15_000, 2_000 * 2 ** (attempt - 1)));
          }
          continue;
        }

        const value = (await response.json()) as OverpassResponse;
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify(value));
        renameSync(temporary, path);
        return { value, endpoint };
      } catch (error) {
        failures.push(
          `${endpoint} attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < args.retriesPerEndpoint) {
          await sleep(Math.min(15_000, 2_000 * 2 ** (attempt - 1)));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  throw new Error(
    `All Overpass endpoints failed: ${failures.join(" | ")}`,
  );
}

async function evidenceForCandidate(
  args: Args,
  candidate: BorderCandidate,
): Promise<VerificationRow> {
  const primary = candidate.primary_country_code as string;
  const secondary = candidate.candidate_country_code;
  const hash = candidateFingerprint(candidate);
  const queriedAt = new Date().toISOString();

  try {
    const centerResult = await fetchOverpass(
      args,
      candidate.latitude,
      candidate.longitude,
    );
    const centerElements = centerResult.value.elements ?? [];
    const centerAreas = areaRows(centerElements);
    const centerCodes = [...new Set(centerAreas.map((row) => row.country_code))].sort();
    const peak = nearestPeak(
      centerElements,
      candidate.latitude,
      candidate.longitude,
    );

    const probeAreas: CountryArea[] = [];
    if (args.probe) {
      for (const [lat, lon] of probes(candidate.latitude, candidate.longitude)) {
        await sleep(args.delayMs);
        const response = await fetchOverpass(args, lat, lon);
        probeAreas.push(...areaRows(response.value.elements ?? []));
      }
    }
    const dedupedProbeAreas = areaRows(
      probeAreas.map((area) => ({
        type: "area",
        id: area.area_id,
        tags: {
          "ISO3166-1:alpha2": area.country_code,
          name: area.name ?? "",
          wikidata: area.osm_ref ?? "",
        },
      })),
    );
    const probeCodes = [
      ...new Set(dedupedProbeAreas.map((row) => row.country_code)),
    ].sort();

    const centerHasPrimary = centerCodes.includes(primary);
    const centerHasSecondary = centerCodes.includes(secondary);
    const probeHasPrimary = probeCodes.includes(primary);
    const probeHasSecondary = probeCodes.includes(secondary);

    let status: VerificationStatus;
    let notes: string;
    if (centerHasPrimary && centerHasSecondary) {
      status = "VERIFIED";
      notes =
        "Independent OSM admin_level=2 containment returns both proposed countries at the summit coordinate.";
    } else if (probeHasPrimary && probeHasSecondary) {
      status = "GEOMETRIC_SUPPORT";
      notes =
        "OSM admin_level=2 probes on opposite sides of the summit see both countries, but the exact summit coordinate is not dual-contained; keep for review.";
    } else if (
      centerCodes.length > 0 &&
      !centerHasPrimary &&
      !centerHasSecondary
    ) {
      status = "CONFLICT";
      notes =
        "OSM country containment at the summit conflicts with both proposed countries.";
    } else if (
      centerCodes.length > 0 &&
      centerHasPrimary &&
      !centerHasSecondary &&
      !probeHasSecondary
    ) {
      status = "INSUFFICIENT";
      notes =
        "OSM supports the primary country but provides no independent evidence for the candidate country near the summit.";
    } else {
      status = "INSUFFICIENT";
      notes =
        "OSM evidence is incomplete or ambiguous; no automatic approval.";
    }

    return {
      candidate_hash: hash,
      mountain_id: candidate.mountain_id,
      mountain_name: candidate.mountain_name,
      primary_country_code: primary,
      candidate_country_code: secondary,
      status,
      provider: "OpenStreetMap/Overpass",
      queried_at: queriedAt,
      endpoint: centerResult.endpoint,
      center_country_codes: centerCodes,
      probe_country_codes: probeCodes,
      center_areas: centerAreas,
      probe_areas: dedupedProbeAreas,
      osm_peak: peak,
      evidence_reference:
        status === "VERIFIED"
          ? `OSM:admin_level=2 dual-country ${primary}+${secondary}`
          : null,
      notes,
    };
  } catch (error) {
    return {
      candidate_hash: hash,
      mountain_id: candidate.mountain_id,
      mountain_name: candidate.mountain_name,
      primary_country_code: primary,
      candidate_country_code: secondary,
      status: "ERROR",
      provider: "OpenStreetMap/Overpass",
      queried_at: queriedAt,
      endpoint: args.endpoints.join(","),
      center_country_codes: [],
      probe_country_codes: [],
      center_areas: [],
      probe_areas: [],
      osm_peak: null,
      evidence_reference: null,
      notes: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(dirname(args.output), { recursive: true });

  if (!args.resume && existsSync(args.output)) {
    throw new Error(
      `Output already exists: ${args.output}. Use --resume or choose a new --output path.`,
    );
  }

  const processed = args.resume
    ? alreadyProcessed(args.output)
    : new Set<string>();
  const candidates = uniqueCandidates(args.input);
  const counts: Record<VerificationStatus, number> = {
    VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
    CONFLICT: 0,
    INSUFFICIENT: 0,
    ERROR: 0,
  };

  let handled = 0;
  for (const candidate of candidates) {
    if (handled >= args.limit) break;
    const hash = candidateFingerprint(candidate);
    if (processed.has(hash)) continue;

    if (handled > 0) await sleep(args.delayMs);
    const row = await evidenceForCandidate(args, candidate);
    appendFileSync(args.output, `${JSON.stringify(row)}\n`);
    counts[row.status] += 1;
    handled += 1;

    process.stdout.write(
      `[${handled}] mountain=${row.mountain_id} ${row.primary_country_code}->${row.candidate_country_code} ${row.status}\n`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        processed_this_run: handled,
        status_counts_this_run: counts,
        output: args.output,
        cache_dir: args.cacheDir,
        endpoints: args.endpoints,
        retries_per_endpoint: args.retriesPerEndpoint,
        probe_mode: args.probe,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
