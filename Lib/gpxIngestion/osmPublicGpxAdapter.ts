import sax, { type QualifiedAttribute, type QualifiedTag } from "sax";

import {
  fetchBoundedHttps,
  SourceHttpError,
  type SourceFetch,
  type SourceHostResolver,
} from "./hardenedSourceHttp.ts";
import { sanitizeMetadata } from "./metadataSanitization.ts";
import { sha256Bytes } from "./hashing.ts";
import {
  OSM_PUBLIC_GPX_ADAPTER_VERSION,
  OSM_PUBLIC_GPX_ALLOWED_HOSTS,
  OSM_PUBLIC_GPX_API_HOST,
  OSM_PUBLIC_GPX_ATTRIBUTION,
  OSM_PUBLIC_GPX_ATTRIBUTION_URL,
  OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT,
  OSM_PUBLIC_GPX_SOURCE_KEY,
} from "./osmPublicGpxRegistry.ts";
import { DEFAULT_SERVER_GPX_LIMITS } from "./parserContract.ts";
import { parseAndNormalizeServerGpx } from "./serverGpxParser.ts";
import {
  normalizeDescriptor,
  type DiscoveryPage,
  type DiscoveryRequest,
  type GpxSourceAdapter,
  type SourceRequestContext,
} from "./sourceAdapter.ts";
import { buildRecordIdentity } from "./sourceIdentity.ts";
import type {
  FetchedSourceTrack,
  NormalizedServerGpx,
  SourceDiscoveryRecord,
  SourceTrackMetadata,
} from "./types.ts";

export const OSM_METADATA_MAXIMUM_BYTES = 64 * 1024;
export const OSM_REQUEST_TIMEOUT_MS = 15_000;
export const OSM_MAXIMUM_REDIRECTS = 3;
export const OSM_USER_AGENT =
  "MountainTracker/0.1 (Phase12C controlled public-GPX adapter)";

export type OsmTracePolicyStatus =
  | "ALLOWED"
  | "BLOCKED_LEGACY_LICENSE"
  | "REVIEW_REQUIRED_LICENSE"
  | "NOT_PUBLIC"
  | "INVALID_METADATA";

export type OsmSourceErrorCode =
  | "INVALID_TRACE_ID"
  | "INVALID_METADATA"
  | "BLOCKED_LEGACY_LICENSE"
  | "REVIEW_REQUIRED_LICENSE"
  | "NOT_PUBLIC"
  | "SOURCE_ACCESS_DENIED"
  | "SOURCE_WITHDRAWN"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_REQUEST_FAILED"
  | "SOURCE_CONTENT_CHANGED";

export class OsmSourceError extends Error {
  readonly code: OsmSourceErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    code: OsmSourceErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      httpStatus?: number;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "OsmSourceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface OsmTracePolicyEvaluation {
  status: OsmTracePolicyStatus;
  licenseIdentifier: "ODbL-1.0" | null;
  reason: string;
}

export interface OsmTraceMetadata extends SourceTrackMetadata {
  traceId: string;
  uploadTimestamp: string | null;
  visibility: string;
  pending: boolean;
  policyEvaluation: OsmTracePolicyEvaluation;
}

export interface OsmNormalizedSourceTrack {
  schemaVersion: "mountain-tracker/osm-public-gpx-source-track/v1";
  adapterVersion: string;
  sourceKey: string;
  sourceNativeId: string;
  sourceSnapshotKey: string;
  sourceUrl: string;
  retrievedAt: string;
  sourceUploadTimestamp: string;
  sourceState: "AVAILABLE";
  licenseEvaluation: OsmTracePolicyEvaluation;
  attribution: {
    text: string;
    url: string;
  };
  rawRetention: "TEMPORARY_ONLY";
  privacyStatus: "SANITIZED";
  processingState: "NORMALIZED";
  qualityStatus: "PENDING";
  publicationStatus: "WITHHELD";
  canonicalSourceRecordKey: string;
  sourceRecordHash: string;
  recordIdempotencyKey: string;
  normalized: NormalizedServerGpx;
}

export interface OsmAdapterOptions {
  seedRecords?: readonly SourceDiscoveryRecord[];
  fetchImplementation?: SourceFetch;
  resolveHost?: SourceHostResolver;
  now?: () => Date;
  requestTimeoutMs?: number;
  metadataMaximumBytes?: number;
  rawMaximumBytes?: number;
  maximumRedirects?: number;
}

export interface IngestOsmTraceOptions {
  signal?: AbortSignal;
  previousRawContentHash?: string | null;
  sleep?: (delayMs: number) => Promise<void>;
}

export class OpenStreetMapPublicGpxAdapter implements GpxSourceAdapter {
  readonly descriptor = normalizeDescriptor({
    sourceKey: OSM_PUBLIC_GPX_SOURCE_KEY,
    sourceName: "OpenStreetMap Public GPS Traces",
    adapterVersion: OSM_PUBLIC_GPX_ADAPTER_VERSION,
    accessMethod: "API",
    allowedDownloadHosts: [...OSM_PUBLIC_GPX_ALLOWED_HOSTS],
    requestsPerSecond: 0.5,
    maximumConcurrency: 1,
    retryLimit: 2,
    retryBaseDelayMs: 1_000,
  });

  private readonly seedRecords: readonly SourceDiscoveryRecord[];
  private readonly dependencies: {
    fetchImplementation?: SourceFetch;
    resolveHost?: SourceHostResolver;
  };
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly metadataMaximumBytes: number;
  private readonly rawMaximumBytes: number;
  private readonly maximumRedirects: number;

  constructor(options: OsmAdapterOptions = {}) {
    this.seedRecords = options.seedRecords ?? [];
    this.dependencies = {
      fetchImplementation: options.fetchImplementation,
      resolveHost: options.resolveHost,
    };
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? OSM_REQUEST_TIMEOUT_MS,
      120_000,
      "requestTimeoutMs",
    );
    this.metadataMaximumBytes = boundedPositiveInteger(
      options.metadataMaximumBytes ?? OSM_METADATA_MAXIMUM_BYTES,
      OSM_METADATA_MAXIMUM_BYTES,
      "metadataMaximumBytes",
    );
    this.rawMaximumBytes = boundedPositiveInteger(
      options.rawMaximumBytes ?? DEFAULT_SERVER_GPX_LIMITS.maximumRawBytes,
      DEFAULT_SERVER_GPX_LIMITS.maximumRawBytes,
      "rawMaximumBytes",
    );
    this.maximumRedirects = boundedNonNegativeInteger(
      options.maximumRedirects ?? OSM_MAXIMUM_REDIRECTS,
      10,
      "maximumRedirects",
    );
  }

  normalizeSourceIdentity(record: SourceDiscoveryRecord): string {
    return normalizeOsmTraceNativeId(record.sourceNativeId);
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryPage> {
    if (request.signal.aborted) throw request.signal.reason;
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 10) {
      throw new Error("OSM seed discovery pageSize must be between 1 and 10.");
    }
    const offset = request.cursor === null ? 0 : parseDiscoveryCursor(request.cursor);
    const records = this.seedRecords.slice(offset, offset + request.pageSize);
    const nextOffset = offset + records.length;
    return {
      records: records.map((record) => ({
        sourceNativeId: this.normalizeSourceIdentity(record),
        sourceUrl: canonicalOsmTraceUrl(parseOsmTraceId(record.sourceNativeId)),
        metadataHint: { selectionReason: record.metadataHint.selectionReason ?? null },
      })),
      nextCursor: nextOffset < this.seedRecords.length ? String(nextOffset) : null,
    };
  }

  async fetchMetadata(
    record: SourceDiscoveryRecord,
    context: SourceRequestContext,
  ): Promise<OsmTraceMetadata> {
    const traceId = parseOsmTraceId(record.sourceNativeId);
    const sourceUrl = canonicalOsmTraceUrl(traceId);
    if (record.sourceUrl !== sourceUrl) {
      throw new OsmSourceError(
        "INVALID_METADATA",
        "OSM discovery record does not use its canonical trace URL.",
      );
    }
    const response = await fetchBoundedHttps(
      sourceUrl,
      context.signal,
      {
        allowedHosts: [OSM_PUBLIC_GPX_API_HOST],
        timeoutMs: this.requestTimeoutMs,
        maximumResponseBytes: this.metadataMaximumBytes,
        maximumRedirects: this.maximumRedirects,
        userAgent: OSM_USER_AGENT,
        accept: "application/xml, text/xml;q=0.9",
      },
      this.dependencies,
    );
    assertSuccessfulOsmResponse(response.status, response.headers);
    const parsed = parseOsmMetadataXml(response.bytes, traceId);
    const policyEvaluation = evaluateOsmTracePolicy(parsed);
    return {
      sourceNativeId: canonicalOsmNativeId(traceId),
      sourceUrl,
      downloadUrl: canonicalOsmTraceDownloadUrl(traceId),
      traceId,
      uploadTimestamp: parsed.uploadTimestamp,
      visibility: parsed.visibility,
      pending: parsed.pending,
      policyEvaluation,
      metadata: {
        traceId,
        uploadTimestamp: parsed.uploadTimestamp,
        visibility: parsed.visibility,
        pending: parsed.pending,
        licenseStatus: policyEvaluation.status,
        licenseIdentifier: policyEvaluation.licenseIdentifier,
      },
    };
  }

  async fetchTrack(
    metadata: SourceTrackMetadata,
    context: SourceRequestContext,
  ): Promise<FetchedSourceTrack> {
    const osmMetadata = requireOsmTraceMetadata(metadata);
    assertOsmTraceMayDownload(osmMetadata.policyEvaluation);
    const expectedDownloadUrl = canonicalOsmTraceDownloadUrl(osmMetadata.traceId);
    if (osmMetadata.downloadUrl !== expectedDownloadUrl) {
      throw new OsmSourceError(
        "INVALID_METADATA",
        "OSM metadata does not use its canonical GPX download URL.",
      );
    }
    const response = await fetchBoundedHttps(
      expectedDownloadUrl,
      context.signal,
      {
        allowedHosts: this.descriptor.allowedDownloadHosts,
        timeoutMs: this.requestTimeoutMs,
        maximumResponseBytes: this.rawMaximumBytes,
        maximumRedirects: this.maximumRedirects,
        userAgent: OSM_USER_AGENT,
        accept: "application/gpx+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
      this.dependencies,
    );
    assertSuccessfulOsmResponse(response.status, response.headers);
    return {
      sourceNativeId: osmMetadata.sourceNativeId,
      sourceUrl: osmMetadata.sourceUrl,
      bytes: response.bytes,
      retrievedAt: this.now().toISOString(),
      responseMetadata: boundedResponseMetadata(response.headers),
    };
  }
}

export async function ingestOsmTrace(
  adapter: OpenStreetMapPublicGpxAdapter,
  record: SourceDiscoveryRecord,
  options: IngestOsmTraceOptions = {},
): Promise<OsmNormalizedSourceTrack> {
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? delay;
  const metadata = await executeWithRetry(
    (attempt) => adapter.fetchMetadata(record, { signal, attempt }),
    adapter.descriptor.retryLimit,
    adapter.descriptor.retryBaseDelayMs,
    sleep,
  );
  assertOsmTraceMayDownload(metadata.policyEvaluation);
  await sleep(Math.ceil(1_000 / adapter.descriptor.requestsPerSecond));
  const fetched = await executeWithRetry(
    (attempt) => adapter.fetchTrack(metadata, { signal, attempt }),
    adapter.descriptor.retryLimit,
    adapter.descriptor.retryBaseDelayMs,
    sleep,
  );
  return normalizeFetchedOsmTrace(
    metadata,
    fetched,
    options.previousRawContentHash ?? null,
  );
}

export async function normalizeFetchedOsmTrace(
  metadata: OsmTraceMetadata,
  fetched: FetchedSourceTrack,
  previousRawContentHash: string | null = null,
): Promise<OsmNormalizedSourceTrack> {
  assertOsmTraceMayDownload(metadata.policyEvaluation);
  if (metadata.uploadTimestamp === null) {
    throw new OsmSourceError(
      "REVIEW_REQUIRED_LICENSE",
      "OSM trace upload timestamp requires review.",
    );
  }
  if (
    fetched.sourceNativeId !== metadata.sourceNativeId ||
    fetched.sourceUrl !== metadata.sourceUrl
  ) {
    throw new OsmSourceError(
      "INVALID_METADATA",
      "Fetched OSM trace provenance does not match its metadata.",
    );
  }
  const fetchedRawContentHash = sha256Bytes(fetched.bytes);
  if (
    previousRawContentHash !== null &&
    previousRawContentHash !== fetchedRawContentHash
  ) {
    throw new OsmSourceError(
      "SOURCE_CONTENT_CHANGED",
      "OSM trace bytes changed for an existing source identity.",
    );
  }
  const normalized = await parseAndNormalizeServerGpx(fetched.bytes);
  const sourceSnapshotKey = `osm-upload:${metadata.uploadTimestamp}`;
  const identityMetadata = sanitizeMetadata({
    name: normalized.displayMetadata.name,
    attribution: OSM_PUBLIC_GPX_ATTRIBUTION,
    sourceUrl: metadata.sourceUrl,
  });
  const identity = buildRecordIdentity({
    sourceKey: OSM_PUBLIC_GPX_SOURCE_KEY,
    sourceSnapshotKey,
    sourceNativeId: metadata.sourceNativeId,
    metadata: identityMetadata,
    rawContentHash: normalized.rawContentHash,
    normalizedGeometryHash: normalized.normalizedGeometryHash,
  });
  return {
    schemaVersion: "mountain-tracker/osm-public-gpx-source-track/v1",
    adapterVersion: OSM_PUBLIC_GPX_ADAPTER_VERSION,
    sourceKey: OSM_PUBLIC_GPX_SOURCE_KEY,
    sourceNativeId: metadata.sourceNativeId,
    sourceSnapshotKey,
    sourceUrl: metadata.sourceUrl,
    retrievedAt: fetched.retrievedAt,
    sourceUploadTimestamp: metadata.uploadTimestamp,
    sourceState: "AVAILABLE",
    licenseEvaluation: metadata.policyEvaluation,
    attribution: {
      text: OSM_PUBLIC_GPX_ATTRIBUTION,
      url: OSM_PUBLIC_GPX_ATTRIBUTION_URL,
    },
    rawRetention: "TEMPORARY_ONLY",
    privacyStatus: "SANITIZED",
    processingState: "NORMALIZED",
    qualityStatus: "PENDING",
    publicationStatus: "WITHHELD",
    canonicalSourceRecordKey: identity.canonicalSourceRecordKey,
    sourceRecordHash: identity.sourceRecordHash,
    recordIdempotencyKey: identity.recordIdempotencyKey,
    normalized,
  };
}

export function canonicalOsmNativeId(traceId: string): string {
  return `osm-gpx:${parseOsmTraceId(traceId)}`;
}

export function normalizeOsmTraceNativeId(value: string): string {
  const match = /^osm-gpx:([1-9]\d*)$/.exec(value);
  if (match === null) {
    throw new OsmSourceError(
      "INVALID_TRACE_ID",
      "OSM source identity must be osm-gpx:<positive-integer>.",
    );
  }
  return canonicalOsmNativeId(match[1]);
}

export function parseOsmTraceId(value: string): string {
  const candidate = value.startsWith("osm-gpx:")
    ? value.slice("osm-gpx:".length)
    : value;
  if (!/^[1-9]\d*$/.test(candidate)) {
    throw new OsmSourceError(
      "INVALID_TRACE_ID",
      "OSM trace ID must be a positive integer.",
    );
  }
  const numeric = Number(candidate);
  if (!Number.isSafeInteger(numeric)) {
    throw new OsmSourceError(
      "INVALID_TRACE_ID",
      "OSM trace ID exceeds the safe integer range.",
    );
  }
  return String(numeric);
}

export function canonicalOsmTraceUrl(traceId: string): string {
  return `https://api.openstreetmap.org/api/0.6/gpx/${parseOsmTraceId(traceId)}`;
}

export function canonicalOsmTraceDownloadUrl(traceId: string): string {
  return `${canonicalOsmTraceUrl(traceId)}/data.gpx`;
}

export function evaluateOsmTracePolicy(metadata: {
  uploadTimestamp: string | null;
  visibility: string;
  pending: boolean;
}): OsmTracePolicyEvaluation {
  if (!new Set(["public", "identifiable"]).has(metadata.visibility)) {
    return {
      status: "NOT_PUBLIC",
      licenseIdentifier: null,
      reason: "Trace is not publicly listed and anonymously downloadable.",
    };
  }
  if (metadata.pending) {
    return {
      status: "INVALID_METADATA",
      licenseIdentifier: null,
      reason: "Trace import is pending or failed.",
    };
  }
  if (metadata.uploadTimestamp === null) {
    return {
      status: "REVIEW_REQUIRED_LICENSE",
      licenseIdentifier: null,
      reason: "Trace upload timestamp is missing or invalid.",
    };
  }
  if (
    new Date(metadata.uploadTimestamp).getTime() <
    new Date(OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT).getTime()
  ) {
    return {
      status: "BLOCKED_LEGACY_LICENSE",
      licenseIdentifier: null,
      reason: "Trace predates the Phase 12C ODbL cutoff.",
    };
  }
  return {
    status: "ALLOWED",
    licenseIdentifier: "ODbL-1.0",
    reason: "Public post-cutoff trace accepted under the Phase 12C source policy.",
  };
}

export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  retryLimit: number,
  retryBaseDelayMs: number,
  sleep: (delayMs: number) => Promise<void> = delay,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryable(error) || attempt > retryLimit) throw error;
      const retryAfterMs =
        error instanceof OsmSourceError ? error.retryAfterMs : null;
      const backoffMs = retryBaseDelayMs * 2 ** (attempt - 1);
      const requestedDelay = retryAfterMs ?? backoffMs;
      const boundedDelay = Math.min(Math.max(requestedDelay, 0), 30_000);
      await sleep(boundedDelay);
    }
  }
}

function parseOsmMetadataXml(
  rawBytes: Uint8Array,
  expectedTraceId: string,
): {
  uploadTimestamp: string | null;
  visibility: string;
  pending: boolean;
} {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    throw new OsmSourceError("INVALID_METADATA", "OSM metadata is not valid UTF-8.");
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new OsmSourceError(
      "INVALID_METADATA",
      "OSM metadata contains a forbidden XML declaration.",
    );
  }

  let parsed: {
    uploadTimestamp: string | null;
    visibility: string;
    pending: boolean;
  } | null = null;
  const parser = sax.parser(true, {
    xmlns: true,
    position: false,
    strictEntities: true,
    maxEntityCount: 16,
    maxEntityDepth: 1,
  });
  parser.onerror = () => {
    throw new OsmSourceError("INVALID_METADATA", "OSM metadata XML is malformed.");
  };
  parser.ondoctype = () => {
    throw new OsmSourceError("INVALID_METADATA", "OSM metadata DOCTYPE is forbidden.");
  };
  parser.onopentag = (tag) => {
    const local = tag.local || tag.name.split(":").at(-1) || "";
    if (local !== "gpx_file") return;
    if (parsed !== null || Object.keys(tag.attributes).length > 32) {
      throw new OsmSourceError("INVALID_METADATA", "OSM metadata structure is invalid.");
    }
    const id = attribute(tag, "id");
    const visibility = attribute(tag, "visibility")?.toLowerCase() ?? "";
    const pendingRaw = attribute(tag, "pending");
    if (id === null || parseOsmTraceId(id) !== expectedTraceId) {
      throw new OsmSourceError("INVALID_METADATA", "OSM metadata trace ID does not match.");
    }
    if (pendingRaw !== "true" && pendingRaw !== "false") {
      throw new OsmSourceError("INVALID_METADATA", "OSM metadata pending state is invalid.");
    }
    parsed = {
      uploadTimestamp: normalizeOsmUploadTimestamp(attribute(tag, "timestamp")),
      visibility,
      pending: pendingRaw === "true",
    };
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof OsmSourceError) throw error;
    throw new OsmSourceError("INVALID_METADATA", "OSM metadata XML is malformed.");
  }
  if (parsed === null) {
    throw new OsmSourceError("INVALID_METADATA", "OSM metadata has no gpx_file record.");
  }
  return parsed;
}

function attribute(tag: QualifiedTag, name: string): string | null {
  for (const value of Object.values(tag.attributes) as QualifiedAttribute[]) {
    if ((value.local || value.name) === name && !value.uri) return value.value;
  }
  return null;
}

function normalizeOsmUploadTimestamp(value: string | null): string | null {
  const match = value?.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (value === null || match === undefined || match === null) {
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return null;
    }
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function requireOsmTraceMetadata(metadata: SourceTrackMetadata): OsmTraceMetadata {
  const candidate = metadata as Partial<OsmTraceMetadata>;
  if (
    typeof candidate.traceId !== "string" ||
    typeof candidate.visibility !== "string" ||
    typeof candidate.pending !== "boolean" ||
    candidate.policyEvaluation === undefined
  ) {
    throw new OsmSourceError("INVALID_METADATA", "OSM trace metadata contract is invalid.");
  }
  return candidate as OsmTraceMetadata;
}

function assertOsmTraceMayDownload(evaluation: OsmTracePolicyEvaluation): void {
  if (evaluation.status === "ALLOWED") return;
  const code: OsmSourceErrorCode = evaluation.status;
  throw new OsmSourceError(code, evaluation.reason);
}

function assertSuccessfulOsmResponse(status: number, headers: Headers): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) {
    throw new OsmSourceError(
      "SOURCE_ACCESS_DENIED",
      "OSM trace is not anonymously accessible.",
      { httpStatus: status },
    );
  }
  if (status === 404 || status === 410) {
    throw new OsmSourceError(
      "SOURCE_WITHDRAWN",
      "OSM trace is missing, withdrawn, or no longer public.",
      { httpStatus: status },
    );
  }
  if (new Set([429, 502, 503, 504]).has(status)) {
    throw new OsmSourceError(
      "SOURCE_UNAVAILABLE",
      "OSM trace endpoint is temporarily unavailable.",
      {
        retryable: true,
        httpStatus: status,
        retryAfterMs: parseRetryAfter(headers.get("retry-after")),
      },
    );
  }
  throw new OsmSourceError(
    "SOURCE_REQUEST_FAILED",
    "OSM trace endpoint returned a non-success response.",
    { httpStatus: status },
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
}

function boundedResponseMetadata(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "etag", "last-modified"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value.slice(0, 500);
  }
  return result;
}

function parseDiscoveryCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) throw new Error("OSM seed discovery cursor is invalid.");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error("OSM seed discovery cursor is invalid.");
  return value;
}

function isRetryable(error: unknown): boolean {
  return (
    (error instanceof OsmSourceError && error.retryable) ||
    (error instanceof SourceHttpError && error.retryable)
  );
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function boundedNonNegativeInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 0 to ${maximum}.`);
  }
  return value;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
