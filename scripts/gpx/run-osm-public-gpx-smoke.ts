import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { SourceHttpError } from "../../Lib/gpxIngestion/hardenedSourceHttp.ts";
import {
  executeWithRetry,
  normalizeFetchedOsmTrace,
  OpenStreetMapPublicGpxAdapter,
  OsmSourceError,
  type OsmTracePolicyStatus,
} from "../../Lib/gpxIngestion/osmPublicGpxAdapter.ts";
import {
  OSM_PUBLIC_GPX_ADAPTER_VERSION,
  OSM_PUBLIC_GPX_SOURCE_KEY,
} from "../../Lib/gpxIngestion/osmPublicGpxRegistry.ts";
import { ServerGpxError } from "../../Lib/gpxIngestion/parserContract.ts";
import type { SourceDiscoveryRecord } from "../../Lib/gpxIngestion/types.ts";

const MAXIMUM_SEEDS = 5;
const MAXIMUM_RAW_GPX_REQUESTS = 5;
const DEFAULT_SEEDS = 3;
const manifestUrl = new URL(
  "../../data/gpx/phase12c/osm-public-gpx-seeds.json",
  import.meta.url,
);
const artifactUrl = new URL(
  "../../data/gpx/phase12c/osm-public-gpx-smoke-result.json",
  import.meta.url,
);

type Seed = {
  traceId: string;
  sourceUrl: string;
  reasonSelected: string;
};

type SmokeTraceResult = {
  traceId: string;
  metadataStatus: "ACCEPTED" | "FAILED";
  licenseGate: OsmTracePolicyStatus | "NOT_EVALUATED";
  downloadResult: "DOWNLOADED" | "NOT_ATTEMPTED" | "FAILED";
  byteCount: number | null;
  parseResult: "NORMALIZED" | "NOT_ATTEMPTED" | "FAILED";
  pointCount: number | null;
  segmentCount: number | null;
  rawContentHash: string | null;
  normalizedGeometryHash: string | null;
  directionNeutralGeometryHash: string | null;
  errorCode: string | null;
};

const seedLimit = parseSeedLimit(process.argv.slice(2));
const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
  sourceKey?: unknown;
  traces?: unknown;
};
const seeds = validateManifest(manifest).slice(0, seedLimit);
const records: SourceDiscoveryRecord[] = seeds.map((seed) => ({
  sourceNativeId: `osm-gpx:${seed.traceId}`,
  sourceUrl: seed.sourceUrl,
  metadataHint: { selectionReason: seed.reasonSelected },
}));
const adapter = new OpenStreetMapPublicGpxAdapter({ seedRecords: records });
const signal = new AbortController().signal;
const results: SmokeTraceResult[] = [];
let metadataRequests = 0;
let rawGpxRequests = 0;
let nextRequestAt = 0;

async function scheduledRequest<T>(operation: () => Promise<T>): Promise<T> {
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await delay(waitMs);
  nextRequestAt = Date.now() + Math.ceil(1_000 / adapter.descriptor.requestsPerSecond);
  return operation();
}

for (const record of records) {
  const traceId = record.sourceNativeId.slice("osm-gpx:".length);
  const result: SmokeTraceResult = {
    traceId,
    metadataStatus: "FAILED",
    licenseGate: "NOT_EVALUATED",
    downloadResult: "NOT_ATTEMPTED",
    byteCount: null,
    parseResult: "NOT_ATTEMPTED",
    pointCount: null,
    segmentCount: null,
    rawContentHash: null,
    normalizedGeometryHash: null,
    directionNeutralGeometryHash: null,
    errorCode: null,
  };
  try {
    const metadata = await executeWithRetry(
      (attempt) => scheduledRequest(() => {
        metadataRequests += 1;
        return adapter.fetchMetadata(record, { signal, attempt });
      }),
      adapter.descriptor.retryLimit,
      adapter.descriptor.retryBaseDelayMs,
    );
    result.metadataStatus = "ACCEPTED";
    result.licenseGate = metadata.policyEvaluation.status;
    if (metadata.policyEvaluation.status !== "ALLOWED") {
      result.errorCode = metadata.policyEvaluation.status;
      results.push(result);
      continue;
    }
    const fetched = await executeWithRetry(
      (attempt) => scheduledRequest(() => {
        if (rawGpxRequests >= MAXIMUM_RAW_GPX_REQUESTS) {
          throw new OsmSourceError(
            "SOURCE_REQUEST_FAILED",
            "Phase 12C raw GPX request budget is exhausted.",
          );
        }
        rawGpxRequests += 1;
        return adapter.fetchTrack(metadata, { signal, attempt });
      }),
      adapter.descriptor.retryLimit,
      adapter.descriptor.retryBaseDelayMs,
    );
    result.downloadResult = "DOWNLOADED";
    result.byteCount = fetched.bytes.byteLength;
    const normalized = await normalizeFetchedOsmTrace(metadata, fetched);
    result.parseResult = "NORMALIZED";
    result.pointCount = normalized.normalized.pointCount;
    result.segmentCount = normalized.normalized.segmentCount;
    result.rawContentHash = normalized.normalized.rawContentHash;
    result.normalizedGeometryHash = normalized.normalized.normalizedGeometryHash;
    result.directionNeutralGeometryHash =
      normalized.normalized.directionNeutralGeometryHash;
  } catch (error) {
    result.errorCode = stableErrorCode(error);
    if (result.metadataStatus === "ACCEPTED") {
      result.downloadResult = result.byteCount === null ? "FAILED" : "DOWNLOADED";
      result.parseResult = result.downloadResult === "DOWNLOADED" ? "FAILED" : "NOT_ATTEMPTED";
    }
  }
  results.push(result);
}

const normalizedCount = results.filter(
  (result) => result.parseResult === "NORMALIZED",
).length;
const networkUnavailable = results.every((result) =>
  new Set(["NETWORK_ERROR", "REQUEST_TIMEOUT"]).has(result.errorCode ?? ""),
);
const artifact = {
  schemaVersion: "mountain-tracker/osm-public-gpx-smoke-result/v1",
  sourceKey: OSM_PUBLIC_GPX_SOURCE_KEY,
  adapterVersion: OSM_PUBLIC_GPX_ADAPTER_VERSION,
  runTimestamp: new Date().toISOString(),
  runStatus:
    normalizedCount > 0
      ? "COMPLETED"
      : networkUnavailable
        ? "MANUAL_NETWORK_SMOKE_REQUIRED"
        : "SOURCE_ACCESS_BLOCKED",
  seedTraceIds: seeds.map((seed) => seed.traceId),
  attemptCounts: {
    seedCandidates: seeds.length,
    metadataRequests,
    rawGpxRequests,
  },
  outcomeCounts: {
    accepted: results.filter((result) => result.licenseGate === "ALLOWED").length,
    licenseBlocked: results.filter((result) =>
      new Set(["BLOCKED_LEGACY_LICENSE", "REVIEW_REQUIRED_LICENSE"]).has(
        result.licenseGate,
      )).length,
    normalized: normalizedCount,
    parserFailures: results.filter((result) => result.parseResult === "FAILED").length,
  },
  results,
  attestations: {
    concurrency: 1,
    maximumRawGpxRequests: MAXIMUM_RAW_GPX_REQUESTS,
    discovery: "BOUNDED_SEED_MANIFEST",
    authenticationUsed: false,
    rawGpxPersisted: false,
    databaseWrites: 0,
    storageWrites: 0,
    publicationWrites: 0,
    mountainMatchingQueries: 0,
  },
};
const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
await writeFile(artifactUrl, artifactText, "utf8");
const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");

for (const result of results) {
  console.log("[phase12c-smoke]", {
    traceId: result.traceId,
    metadataStatus: result.metadataStatus,
    licenseGate: result.licenseGate,
    downloadResult: result.downloadResult,
    byteCount: result.byteCount,
    parseResult: result.parseResult,
    pointCount: result.pointCount,
    segmentCount: result.segmentCount,
    rawHashPrefix: result.rawContentHash?.slice(0, 12) ?? null,
    errorCode: result.errorCode,
  });
}
console.log("[phase12c-smoke-summary]", {
  runStatus: artifact.runStatus,
  metadataRequests,
  rawGpxRequests,
  normalizedCount,
  artifactSha256,
});
if (normalizedCount === 0) process.exitCode = 2;

function parseSeedLimit(arguments_: string[]): number {
  const option = arguments_.find((value) => value.startsWith("--max="));
  const value = option === undefined ? DEFAULT_SEEDS : Number(option.slice(6));
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_SEEDS) {
    throw new Error(`--max must be an integer from 1 to ${MAXIMUM_SEEDS}.`);
  }
  return value;
}

function validateManifest(manifestValue: {
  sourceKey?: unknown;
  traces?: unknown;
}): Seed[] {
  if (
    manifestValue.sourceKey !== OSM_PUBLIC_GPX_SOURCE_KEY ||
    !Array.isArray(manifestValue.traces) ||
    manifestValue.traces.length > 10
  ) {
    throw new Error("Phase 12C OSM seed manifest is invalid.");
  }
  return manifestValue.traces.map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("traceId" in value) ||
      !("sourceUrl" in value) ||
      !("reasonSelected" in value) ||
      typeof value.traceId !== "string" ||
      typeof value.sourceUrl !== "string" ||
      typeof value.reasonSelected !== "string"
    ) {
      throw new Error("Phase 12C OSM seed entry is invalid.");
    }
    return {
      traceId: value.traceId,
      sourceUrl: value.sourceUrl,
      reasonSelected: value.reasonSelected,
    };
  });
}

function stableErrorCode(error: unknown): string {
  if (
    error instanceof OsmSourceError ||
    error instanceof SourceHttpError ||
    error instanceof ServerGpxError
  ) {
    return error.code;
  }
  return "UNEXPECTED_ERROR";
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
