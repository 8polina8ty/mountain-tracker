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

type TechnicalErrorType =
  | "NETWORK_ERROR"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "HTTP_5XX"
  | "HTTP_4XX"
  | "UNKNOWN";

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
  mode: "CENTER" | "PROBE";
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
  technical_error_type: TechnicalErrorType | null;
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

type EndpointHealth = {
  consecutiveFailures: number;
  cooldownUntil: number;
};

class OverpassAggregateError extends Error {
  technicalErrorType: TechnicalErrorType;

  constructor(technicalErrorType: TechnicalErrorType, message: string) {
    super(message);
    this.name = "OverpassAggregateError";
    this.technicalErrorType = technicalErrorType;
  }
}

const endpointHealth = new Map<string, EndpointHealth>();

type Args = {
  input: string;
  output: string;
  cacheDir: string;
  endpoints: string[];
  limit: number;
  retriesPerEndpoint: number;
  delayMs: number;
  timeoutMs: number;
  concurrency: number;
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
  const concurrency = integer("--concurrency", 2, 1);
  if (concurrency > 4) {
    throw new Error("--concurrency must be between 1 and 4");
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
    concurrency,
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

function evidenceTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function alreadyProcessed(path: string, probe: boolean): Set<string> {
  if (!existsSync(path)) return new Set();

  const latest = new Map<string, VerificationRow>();
  for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as VerificationRow;
    if (probe && row.mode !== "PROBE") continue;

    const previous = latest.get(row.candidate_hash);
    if (
      !previous ||
      evidenceTimestamp(row.queried_at) > evidenceTimestamp(previous.queried_at)
    ) {
      latest.set(row.candidate_hash, row);
    }
  }

  return new Set(
    [...latest.values()]
      .filter((row) => row.status !== "ERROR" && row.status !== "CONFLICT")
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

function probeBatchQuery(lat: number, lon: number): string {
  const points = probes(lat, lon);
  const statements = points
    .map(
      ([probeLat, probeLon], index) =>
        `is_in(${probeLat.toFixed(7)},${probeLon.toFixed(7)})->.probe${index};
area.probe${index}["boundary"="administrative"]["admin_level"="2"]->.probeAreas${index};`,
    )
    .join("\n");
  const union = points.map((_, index) => `.probeAreas${index};`).join("");
  return `[out:json][timeout:25];
${statements}
(${union});
out tags;`;
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

function classifyHttpStatus(status: number): TechnicalErrorType {
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "HTTP_5XX";
  if (status >= 400) return "HTTP_4XX";
  return "UNKNOWN";
}

function classifyThrownError(error: unknown): TechnicalErrorType {
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  if (
    error instanceof Error &&
    /fetch failed|network|socket|ECONN|ENET|EAI_AGAIN/i.test(error.message)
  ) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

function cooldownMs(type: TechnicalErrorType, consecutiveFailures: number): number {
  const multiplier = Math.min(4, Math.max(1, consecutiveFailures));
  if (type === "RATE_LIMIT") return 60_000 * multiplier;
  if (type === "HTTP_5XX" || type === "TIMEOUT") return 20_000 * multiplier;
  if (type === "NETWORK_ERROR") return 15_000 * multiplier;
  return 10_000 * multiplier;
}

function recordEndpointFailure(endpoint: string, type: TechnicalErrorType): void {
  const previous = endpointHealth.get(endpoint) ?? {
    consecutiveFailures: 0,
    cooldownUntil: 0,
  };
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const shouldOpenCircuit =
    type === "RATE_LIMIT" || consecutiveFailures >= 2;
  endpointHealth.set(endpoint, {
    consecutiveFailures,
    cooldownUntil: shouldOpenCircuit
      ? Date.now() + cooldownMs(type, consecutiveFailures)
      : previous.cooldownUntil,
  });
}

function recordEndpointSuccess(endpoint: string): void {
  endpointHealth.set(endpoint, {
    consecutiveFailures: 0,
    cooldownUntil: 0,
  });
}

function dominantErrorType(types: TechnicalErrorType[]): TechnicalErrorType {
  const order: TechnicalErrorType[] = [
    "RATE_LIMIT",
    "TIMEOUT",
    "HTTP_5XX",
    "NETWORK_ERROR",
    "HTTP_4XX",
    "UNKNOWN",
  ];
  return (
    order.find((type) => types.includes(type)) ??
    "UNKNOWN"
  );
}

async function fetchOverpassQuery(
  args: Args,
  query: string,
  cachePath: string,
): Promise<{ value: OverpassResponse; endpoint: string }> {
  mkdirSync(args.cacheDir, { recursive: true });
  if (existsSync(cachePath)) {
    return {
      value: JSON.parse(readFileSync(cachePath, "utf8")) as OverpassResponse,
      endpoint: "cache",
    };
  }

  const failures: string[] = [];
  const failureTypes: TechnicalErrorType[] = [];
  const attemptsByEndpoint = new Map(
    args.endpoints.map((endpoint) => [endpoint, 0]),
  );
  let cursor = 0;

  while (
    args.endpoints.some(
      (endpoint) =>
        (attemptsByEndpoint.get(endpoint) ?? 0) < args.retriesPerEndpoint,
    )
  ) {
    const now = Date.now();
    const eligible = args.endpoints.filter((endpoint) => {
      const attempts = attemptsByEndpoint.get(endpoint) ?? 0;
      const health = endpointHealth.get(endpoint);
      return (
        attempts < args.retriesPerEndpoint &&
        (!health || health.cooldownUntil <= now)
      );
    });

    if (eligible.length === 0) {
      const waiting = args.endpoints
        .filter(
          (endpoint) =>
            (attemptsByEndpoint.get(endpoint) ?? 0) <
            args.retriesPerEndpoint,
        )
        .map((endpoint) => ({
          endpoint,
          cooldownUntil:
            endpointHealth.get(endpoint)?.cooldownUntil ?? now,
        }))
        .filter((entry) => entry.cooldownUntil > now)
        .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

      if (waiting.length === 0) break;

      const next = waiting[0];
      const waitMs = Math.max(0, next.cooldownUntil - Date.now());
      failures.push(
        `ALL_CIRCUITS_OPEN waiting until ${new Date(next.cooldownUntil).toISOString()} before half-open probe of ${next.endpoint}`,
      );
      await sleep(waitMs + Math.floor(Math.random() * 1_000));
      continue;
    }

    const endpoint =
      eligible.find(
        (value) =>
          args.endpoints.indexOf(value) >= cursor,
      ) ?? eligible[0];
    cursor = (args.endpoints.indexOf(endpoint) + 1) % args.endpoints.length;

    const attempt = (attemptsByEndpoint.get(endpoint) ?? 0) + 1;
    attemptsByEndpoint.set(endpoint, attempt);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const body = new URLSearchParams({ data: query });
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
        const type = classifyHttpStatus(response.status);
        const detail = (await response.text()).slice(0, 300);
        failures.push(
          `${endpoint} attempt ${attempt}/${args.retriesPerEndpoint}: ${type} HTTP ${response.status} ${detail}`,
        );
        failureTypes.push(type);
        recordEndpointFailure(endpoint, type);
      } else {
        const value = (await response.json()) as OverpassResponse;
        recordEndpointSuccess(endpoint);
        const temporary = `${cachePath}.tmp`;
        writeFileSync(temporary, JSON.stringify(value));
        renameSync(temporary, cachePath);
        return { value, endpoint };
      }
    } catch (error) {
      const type = classifyThrownError(error);
      failures.push(
        `${endpoint} attempt ${attempt}/${args.retriesPerEndpoint}: ${type} ${error instanceof Error ? error.message : String(error)}`,
      );
      failureTypes.push(type);
      recordEndpointFailure(endpoint, type);
    } finally {
      clearTimeout(timeout);
    }

    // Small jitter avoids synchronizing retries with an overloaded endpoint.
    await sleep(250 + Math.floor(Math.random() * 500));
  }

  const type = dominantErrorType(failureTypes);
  throw new OverpassAggregateError(
    type,
    `All Overpass endpoints failed [${type}]: ${failures.join(" | ")}`,
  );
}

async function fetchOverpass(
  args: Args,
  lat: number,
  lon: number,
): Promise<{ value: OverpassResponse; endpoint: string }> {
  const key = cacheKey(lat, lon);
  const path = resolve(args.cacheDir, `${key}.json`);
  return fetchOverpassQuery(args, overpassQuery(lat, lon), path);
}

async function fetchProbeBatch(
  args: Args,
  lat: number,
  lon: number,
): Promise<{ value: OverpassResponse; endpoint: string }> {
  const key = createHash("sha256")
    .update(`probe-batch-v1:${lat.toFixed(7)},${lon.toFixed(7)}`)
    .digest("hex");
  const path = resolve(args.cacheDir, `${key}-probe-batch.json`);
  return fetchOverpassQuery(args, probeBatchQuery(lat, lon), path);
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
      const response = await fetchProbeBatch(
        args,
        candidate.latitude,
        candidate.longitude,
      );
      probeAreas.push(...areaRows(response.value.elements ?? []));
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
      status = "INSUFFICIENT";
      notes =
        peak && peak.distance_meters <= 25
          ? "OSM exact/near-exact peak identity is present, but point containment returns a different admin_level=2 country. Treat as boundary/trifinio ambiguity, not a conflict; independent boundary evidence is required."
          : "OSM point containment returns a different admin_level=2 country, but is_in() alone is insufficient to reject a near-border candidate; independent boundary evidence is required.";
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
      mode: args.probe ? "PROBE" : "CENTER",
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
      technical_error_type: null,
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
      mode: args.probe ? "PROBE" : "CENTER",
      provider: "OpenStreetMap/Overpass",
      queried_at: queriedAt,
      endpoint: args.endpoints.join(","),
      center_country_codes: [],
      probe_country_codes: [],
      center_areas: [],
      probe_areas: [],
      osm_peak: null,
      evidence_reference: null,
      technical_error_type:
        error instanceof OverpassAggregateError
          ? error.technicalErrorType
          : classifyThrownError(error),
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
    ? alreadyProcessed(args.output, args.probe)
    : new Set<string>();
  const candidates = uniqueCandidates(args.input);
  const counts: Record<VerificationStatus, number> = {
    VERIFIED: 0,
    GEOMETRIC_SUPPORT: 0,
    CONFLICT: 0,
    INSUFFICIENT: 0,
    ERROR: 0,
  };

  const pending = candidates
    .filter((candidate) => !processed.has(candidateFingerprint(candidate)))
    .slice(0, args.limit);

  let handled = 0;
  let nextIndex = 0;

  async function worker(workerIndex: number): Promise<void> {
    if (workerIndex > 0) {
      await sleep(Math.ceil((args.delayMs * workerIndex) / args.concurrency));
    }

    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;

      const candidate = pending[index];
      const row = await evidenceForCandidate(args, candidate);
      appendFileSync(args.output, `${JSON.stringify(row)}\n`);
      counts[row.status] += 1;
      handled += 1;

      process.stdout.write(
        `[${handled}/${pending.length}] mountain=${row.mountain_id} ${row.primary_country_code}->${row.candidate_country_code} ${row.status}\n`,
      );

      if (nextIndex < pending.length) {
        await sleep(row.status === "ERROR" ? Math.max(5_000, args.delayMs) : args.delayMs);
      }
    }
  }

  const workerCount = Math.min(args.concurrency, pending.length || 1);
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => worker(index)),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        processed_this_run: handled,
        status_counts_this_run: counts,
        output: args.output,
        cache_dir: args.cacheDir,
        endpoints: args.endpoints,
        retries_per_endpoint: args.retriesPerEndpoint,
        endpoint_strategy: "per_endpoint_budget_with_waiting_circuit_breaker",
        probe_mode: args.probe,
        concurrency: args.concurrency,
        probe_requests_per_candidate: args.probe ? 1 : 0,
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
