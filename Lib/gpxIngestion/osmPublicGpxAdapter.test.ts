import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SourceHttpError, type SourceFetch } from "./hardenedSourceHttp.ts";
import {
  canonicalOsmNativeId,
  canonicalOsmTraceDownloadUrl,
  canonicalOsmTraceUrl,
  executeWithRetry,
  ingestOsmTrace,
  normalizeFetchedOsmTrace,
  normalizeOsmTraceNativeId,
  OpenStreetMapPublicGpxAdapter,
  OsmSourceError,
  type OsmTraceMetadata,
} from "./osmPublicGpxAdapter.ts";
import {
  OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT,
  OSM_PUBLIC_GPX_RIGHTS_POLICY,
  OSM_PUBLIC_GPX_SOURCE_REGISTRY,
} from "./osmPublicGpxRegistry.ts";
import type { SourceDiscoveryRecord } from "./types.ts";

const encoder = new TextEncoder();
const traceId = "11906368";
const record: SourceDiscoveryRecord = {
  sourceNativeId: `osm-gpx:${traceId}`,
  sourceUrl: canonicalOsmTraceUrl(traceId),
  metadataHint: { selectionReason: "unit fixture" },
};
const publicResolver = async () => ["8.8.8.8"];

function metadataXml(options: {
  id?: string;
  timestamp?: string | null;
  visibility?: string;
  pending?: string;
  user?: string;
} = {}): string {
  const timestamp = options.timestamp === undefined
    ? "2025-03-17T10:00:00Z"
    : options.timestamp;
  return `<?xml version="1.0"?><osm version="0.6"><gpx_file id="${options.id ?? traceId}" visibility="${options.visibility ?? "identifiable"}" pending="${options.pending ?? "false"}"${timestamp === null ? "" : ` timestamp="${timestamp}"`} user="${options.user ?? "private-display-name"}" name="private-file.gpx"><description>private description</description><tag>private tag</tag></gpx_file></osm>`;
}

function queueFetch(responses: Response[]): {
  fetchImplementation: SourceFetch;
  calls: Array<{ url: string; headers: Headers }>;
} {
  const calls: Array<{ url: string; headers: Headers }> = [];
  return {
    calls,
    async fetchImplementation(input, init) {
      calls.push({ url: input.toString(), headers: new Headers(init?.headers) });
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected mock fetch.");
      return response;
    },
  };
}

function response(body: string | Uint8Array, status = 200, headers?: HeadersInit): Response {
  const responseBody = typeof body === "string" ? body : Uint8Array.from(body).buffer;
  return new Response(responseBody, { status, headers });
}

function adapterWith(
  responses: Response[],
  options: Partial<ConstructorParameters<typeof OpenStreetMapPublicGpxAdapter>[0]> = {},
): { adapter: OpenStreetMapPublicGpxAdapter; calls: Array<{ url: string; headers: Headers }> } {
  const mock = queueFetch(responses);
  return {
    adapter: new OpenStreetMapPublicGpxAdapter({
      ...options,
      fetchImplementation: mock.fetchImplementation,
      resolveHost: publicResolver,
      now: () => new Date("2026-09-04T10:00:00Z"),
    }),
    calls: mock.calls,
  };
}

async function simpleGpx(): Promise<Uint8Array> {
  return readFile(new URL("./fixtures/simple.gpx", import.meta.url));
}

async function expectOsmCode(
  operation: () => Promise<unknown>,
  code: OsmSourceError["code"],
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof OsmSourceError);
    assert.equal(error.code, code);
    return true;
  });
}

test("registry freezes the reviewed source, date gate, retention, and attribution", () => {
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.sourceKey, "openstreetmap-public-gpx");
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.licensePolicy, "ALLOWED_WITH_DATE_GATE");
  assert.equal(OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT, "2012-09-12T00:00:00.000Z");
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.rawRetention, "TEMPORARY_ONLY");
  assert.equal(OSM_PUBLIC_GPX_RIGHTS_POLICY.rawGpxRetentionPermission, "BLOCKED");
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.attribution.text, "© OpenStreetMap contributors");
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.authentication, "NONE_FOR_PHASE12C_PUBLIC_ACCESS");
  assert.equal(OSM_PUBLIC_GPX_SOURCE_REGISTRY.liveAccessValidation.status, "SOURCE_ACCESS_BLOCKED");
  assert.ok(OSM_PUBLIC_GPX_SOURCE_REGISTRY.policyEvidence.length >= 6);
});

test("strict trace identity never depends on filenames or arbitrary paths", () => {
  assert.equal(canonicalOsmNativeId(traceId), `osm-gpx:${traceId}`);
  assert.equal(normalizeOsmTraceNativeId(`osm-gpx:${traceId}`), `osm-gpx:${traceId}`);
  for (const value of ["0", "-1", "1.5", "NaN", "../../etc/passwd", "osm-gpx:01", "osm-gpx:0"]) {
    assert.throws(() => normalizeOsmTraceNativeId(value), (error) =>
      error instanceof OsmSourceError && error.code === "INVALID_TRACE_ID");
  }
});

test("seed discovery is local, bounded, cursor-based, and canonical", async () => {
  const adapter = new OpenStreetMapPublicGpxAdapter({
    seedRecords: [record, {
      sourceNativeId: "osm-gpx:2",
      sourceUrl: canonicalOsmTraceUrl("2"),
      metadataHint: { selectionReason: "second" },
    }],
  });
  const signal = new AbortController().signal;
  const first = await adapter.discover({ signal, attempt: 1, cursor: null, pageSize: 1 });
  const second = await adapter.discover({ signal, attempt: 1, cursor: first.nextCursor, pageSize: 1 });
  assert.equal(first.records[0].sourceNativeId, `osm-gpx:${traceId}`);
  assert.equal(first.nextCursor, "1");
  assert.equal(second.records[0].sourceNativeId, "osm-gpx:2");
  assert.equal(second.nextCursor, null);
});

test("valid anonymous metadata passes the post-2012 ODbL gate without retaining user text", async () => {
  const setup = adapterWith([response(metadataXml({ user: "Never Retain Me" }))]);
  const metadata = await setup.adapter.fetchMetadata(record, {
    signal: new AbortController().signal,
    attempt: 1,
  });
  assert.equal(metadata.policyEvaluation.status, "ALLOWED");
  assert.equal(metadata.policyEvaluation.licenseIdentifier, "ODbL-1.0");
  assert.equal(metadata.downloadUrl, canonicalOsmTraceDownloadUrl(traceId));
  assert.doesNotMatch(JSON.stringify(metadata), /Never Retain Me|private description|private-file/);
  assert.match(setup.calls[0].headers.get("user-agent") ?? "", /MountainTracker/);
  assert.match(setup.calls[0].headers.get("accept") ?? "", /xml/);
});

test("legacy, missing timestamp, non-public, and pending metadata fail closed before GPX fetch", async () => {
  const cases = [
    [metadataXml({ timestamp: "2012-09-11T23:59:59Z" }), "BLOCKED_LEGACY_LICENSE"],
    [metadataXml({ timestamp: null }), "REVIEW_REQUIRED_LICENSE"],
    [metadataXml({ timestamp: "not-a-date" }), "REVIEW_REQUIRED_LICENSE"],
    [metadataXml({ timestamp: "2025-02-30T10:00:00Z" }), "REVIEW_REQUIRED_LICENSE"],
    [metadataXml({ visibility: "trackable" }), "NOT_PUBLIC"],
    [metadataXml({ visibility: "private" }), "NOT_PUBLIC"],
    [metadataXml({ pending: "true" }), "INVALID_METADATA"],
  ] as const;
  for (const [xml, expectedCode] of cases) {
    const setup = adapterWith([response(xml)]);
    await expectOsmCode(
      () => ingestOsmTrace(setup.adapter, record, { sleep: async () => undefined }),
      expectedCode,
    );
    assert.equal(setup.calls.length, 1);
  }
});

test("403 is access denied while 404 and 410 retain a withdrawal state", async () => {
  for (const [status, code] of [
    [403, "SOURCE_ACCESS_DENIED"],
    [404, "SOURCE_WITHDRAWN"],
    [410, "SOURCE_WITHDRAWN"],
  ] as const) {
    const setup = adapterWith([response("", status)]);
    await expectOsmCode(
      () => setup.adapter.fetchMetadata(record, {
        signal: new AbortController().signal,
        attempt: 1,
      }),
      code,
    );
    assert.equal(setup.calls.length, 1);
  }
});

test("429 retries once, respects Retry-After, stays serial, then normalizes", async () => {
  const setup = adapterWith([
    response("", 429, { "retry-after": "2" }),
    response(metadataXml()),
    response(await simpleGpx()),
  ]);
  const delays: number[] = [];
  const result = await ingestOsmTrace(setup.adapter, record, {
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  assert.equal(result.processingState, "NORMALIZED");
  assert.equal(setup.calls.length, 3);
  assert.deepEqual(delays, [2_000, 2_000]);
});

test("non-transient status codes are never retried", async () => {
  const setup = adapterWith([response("", 400)]);
  await expectOsmCode(
    () => ingestOsmTrace(setup.adapter, record, { sleep: async () => undefined }),
    "SOURCE_REQUEST_FAILED",
  );
  assert.equal(setup.calls.length, 1);
});

test("502, 503, and 504 are the only retryable server responses", async () => {
  for (const status of [502, 503, 504]) {
    const setup = adapterWith([response("", status), response(metadataXml())]);
    const attempts: number[] = [];
    const metadata = await executeWithRetry(
      (attempt) => {
        attempts.push(attempt);
        return setup.adapter.fetchMetadata(record, {
          signal: new AbortController().signal,
          attempt,
        });
      },
      1,
      100,
      async () => undefined,
    );
    assert.equal(metadata.policyEvaluation.status, "ALLOWED");
    assert.deepEqual(attempts, [1, 2]);
  }
});

test("metadata and GPX byte limits are independently enforced", async () => {
  const metadataSetup = adapterWith([response(metadataXml())], {
    metadataMaximumBytes: 10,
  });
  await assert.rejects(
    () => metadataSetup.adapter.fetchMetadata(record, {
      signal: new AbortController().signal,
      attempt: 1,
    }),
    (error) => error instanceof SourceHttpError && error.code === "RESPONSE_TOO_LARGE",
  );

  const rawSetup = adapterWith([
    response(metadataXml()),
    response("12345678901"),
  ], { rawMaximumBytes: 10 });
  await assert.rejects(
    () => ingestOsmTrace(rawSetup.adapter, record, { sleep: async () => undefined }),
    (error) => error instanceof SourceHttpError && error.code === "RESPONSE_TOO_LARGE",
  );
});

test("malformed metadata and malformed GPX are not retried", async () => {
  const metadataSetup = adapterWith([response("<osm><gpx_file")]);
  await expectOsmCode(
    () => ingestOsmTrace(metadataSetup.adapter, record, { sleep: async () => undefined }),
    "INVALID_METADATA",
  );
  assert.equal(metadataSetup.calls.length, 1);

  const gpxSetup = adapterWith([
    response(metadataXml()),
    response("<gpx><trk>"),
  ]);
  await assert.rejects(
    () => ingestOsmTrace(gpxSetup.adapter, record, { sleep: async () => undefined }),
    /malformed XML/,
  );
  assert.equal(gpxSetup.calls.length, 2);
});

test("accepted bytes immediately produce a sanitized future-staging object", async () => {
  const privateLookingGpx = encoder.encode(`<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="Private Device"><metadata><author><name>Private User</name></author></metadata><trk><name>&lt;script&gt;safe text&lt;/script&gt;</name><extensions><email>private@example.test</email></extensions><trkseg><trkpt lat="47" lon="11"/><trkpt lat="47.1" lon="11.1"/></trkseg></trk></gpx>`);
  const setup = adapterWith([
    response(metadataXml({ user: "Private User" })),
    response(privateLookingGpx),
  ]);
  const result = await ingestOsmTrace(setup.adapter, record, {
    sleep: async () => undefined,
  });
  assert.equal(result.sourceNativeId, `osm-gpx:${traceId}`);
  assert.equal(result.licenseEvaluation.status, "ALLOWED");
  assert.equal(result.attribution.text, "© OpenStreetMap contributors");
  assert.equal(result.rawRetention, "TEMPORARY_ONLY");
  assert.equal(result.privacyStatus, "SANITIZED");
  assert.equal(result.normalized.pointCount, 2);
  assert.equal(result.normalized.displayMetadata.name, "script safe text /script");
  assert.doesNotMatch(JSON.stringify(result), /Private User|Private Device|example\.test/);
  assert.equal("userId" in result, false);
  assert.equal("mountainId" in result, false);
});

test("same trace and bytes are idempotent while changed bytes fail explicitly", async () => {
  const raw = await simpleGpx();
  const setup = adapterWith([response(metadataXml())]);
  const metadata = await setup.adapter.fetchMetadata(record, {
    signal: new AbortController().signal,
    attempt: 1,
  });
  const fetched = {
    sourceNativeId: metadata.sourceNativeId,
    sourceUrl: metadata.sourceUrl,
    bytes: raw,
    retrievedAt: "2026-09-04T10:00:00.000Z",
    responseMetadata: {},
  };
  const first = await normalizeFetchedOsmTrace(metadata, fetched);
  const second = await normalizeFetchedOsmTrace(metadata, {
    ...fetched,
    retrievedAt: "2026-09-05T10:00:00.000Z",
  });
  assert.equal(first.normalized.rawContentHash, second.normalized.rawContentHash);
  assert.equal(first.canonicalSourceRecordKey, second.canonicalSourceRecordKey);
  assert.equal(first.recordIdempotencyKey, second.recordIdempotencyKey);
  assert.equal(first.sourceRecordHash, second.sourceRecordHash);

  const changedFetched = {
    ...fetched,
    bytes: encoder.encode(new TextDecoder().decode(raw).replace("1004", "1005")),
  };
  await expectOsmCode(
    () => normalizeFetchedOsmTrace(metadata, changedFetched, first.normalized.rawContentHash),
    "SOURCE_CONTENT_CHANGED",
  );
});

test("metadata identity mismatch and invalid canonical record URL are rejected", async () => {
  const wrongId = adapterWith([response(metadataXml({ id: "2" }))]);
  await expectOsmCode(
    () => wrongId.adapter.fetchMetadata(record, {
      signal: new AbortController().signal,
      attempt: 1,
    }),
    "INVALID_METADATA",
  );
  const wrongUrl = { ...record, sourceUrl: "https://api.openstreetmap.org/api/0.6/gpx/2" };
  const noFetch = adapterWith([]);
  await expectOsmCode(
    () => noFetch.adapter.fetchMetadata(wrongUrl, {
      signal: new AbortController().signal,
      attempt: 1,
    }),
    "INVALID_METADATA",
  );
  assert.equal(noFetch.calls.length, 0);
});

test("fetchTrack cannot be called before an ALLOWED metadata gate", async () => {
  const blocked: OsmTraceMetadata = {
    sourceNativeId: `osm-gpx:${traceId}`,
    sourceUrl: canonicalOsmTraceUrl(traceId),
    downloadUrl: canonicalOsmTraceDownloadUrl(traceId),
    traceId,
    uploadTimestamp: null,
    visibility: "identifiable",
    pending: false,
    policyEvaluation: {
      status: "REVIEW_REQUIRED_LICENSE",
      licenseIdentifier: null,
      reason: "missing timestamp",
    },
    metadata: {},
  };
  const setup = adapterWith([]);
  await expectOsmCode(
    () => setup.adapter.fetchTrack(blocked, {
      signal: new AbortController().signal,
      attempt: 1,
    }),
    "REVIEW_REQUIRED_LICENSE",
  );
  assert.equal(setup.calls.length, 0);
});
