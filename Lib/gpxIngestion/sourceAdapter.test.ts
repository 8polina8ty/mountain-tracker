import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAdapterMayRun,
  defaultNormalizeSourceIdentity,
  normalizeDescriptor,
  type GpxSourceAdapter,
} from "./sourceAdapter.ts";
import type { SourceRightsPolicy } from "./types.ts";

test("descriptor supplies finite retry and concurrency defaults", () => {
  const descriptor = normalizeDescriptor({
    sourceKey: "example-open-data",
    sourceName: "Example Open Data",
    accessMethod: "API",
    allowedDownloadHosts: ["DATA.EXAMPLE.COM", "data.example.com"],
  });
  assert.equal(descriptor.maximumConcurrency, 2);
  assert.equal(descriptor.retryLimit, 3);
  assert.deepEqual(descriptor.allowedDownloadHosts, ["data.example.com"]);
});

test("descriptor rejects unbounded concurrency and malformed hosts", () => {
  assert.throws(
    () =>
      normalizeDescriptor({
        sourceKey: "example",
        sourceName: "Example",
        accessMethod: "API",
        maximumConcurrency: 100,
      }),
    /maximumConcurrency/,
  );
  assert.throws(
    () =>
      normalizeDescriptor({
        sourceKey: "example",
        sourceName: "Example",
        accessMethod: "API",
        allowedDownloadHosts: ["https://example.com/path"],
      }),
    /allowedDownloadHosts/,
  );
});

test("adapter contract separates discover, metadata, and track fetching", () => {
  const adapter = {
    descriptor: normalizeDescriptor({
      sourceKey: "example",
      sourceName: "Example",
      accessMethod: "MANUAL_SNAPSHOT",
    }),
    normalizeSourceIdentity: defaultNormalizeSourceIdentity,
    async discover() {
      return { records: [], nextCursor: null };
    },
    async fetchMetadata(record) {
      return {
        sourceNativeId: record.sourceNativeId,
        sourceUrl: record.sourceUrl,
        downloadUrl: null,
        metadata: {},
      };
    },
    async fetchTrack(metadata) {
      return {
        sourceNativeId: metadata.sourceNativeId,
        sourceUrl: metadata.sourceUrl,
        bytes: new Uint8Array(),
        retrievedAt: new Date(0).toISOString(),
        responseMetadata: {},
      };
    },
  } satisfies GpxSourceAdapter;
  assert.equal(adapter.descriptor.accessMethod, "MANUAL_SNAPSHOT");
  assert.equal(typeof adapter.fetchTrack, "function");
});

test("source adapter is blocked unless every required registry gate is allowed", () => {
  const policy: SourceRightsPolicy = {
    licenseStatus: "ALLOWED",
    accessPermissionStatus: "ALLOWED",
    redistributionPermissionStatus: "REVIEW_REQUIRED",
    rawGpxRetentionPermission: "BLOCKED",
    normalizedGeometryPublicationPermission: "ALLOWED",
    attributionRequired: false,
    attributionText: null,
    lastVerifiedAt: "2026-09-01T00:00:00Z",
  };
  assert.throws(() => assertAdapterMayRun(policy), /blocked by policy/);
});

test("source identity comes from a source-native id, not a filename", () => {
  assert.equal(
    defaultNormalizeSourceIdentity({
      sourceNativeId: "route:123",
      sourceUrl: "https://example.com/routes/123",
      metadataHint: {},
    }),
    "route:123",
  );
});
