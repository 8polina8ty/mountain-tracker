import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMetadata } from "./metadataSanitization.ts";
import { buildRecordIdentity, normalizeSourceKey } from "./sourceIdentity.ts";

const BASE_INPUT = {
  sourceKey: "approved-source",
  sourceSnapshotKey: "2026-09-01",
  sourceNativeId: "routes/123",
  metadata: sanitizeMetadata({ name: "Hörnli Ridge" }),
  rawContentHash: "a".repeat(64),
  normalizedGeometryHash: "b".repeat(64),
};

test("builds deterministic source-record and idempotency identities", () => {
  const left = buildRecordIdentity(BASE_INPUT);
  const right = buildRecordIdentity(BASE_INPUT);
  assert.deepEqual(left, right);
  assert.match(left.sourceRecordHash, /^[0-9a-f]{64}$/);
  assert.match(left.recordIdempotencyKey, /^[0-9a-f]{64}$/);
  assert.match(left.canonicalSourceRecordKey, /^approved-source:[0-9a-f]{64}$/);
});

test("identity changes on source content drift", () => {
  const left = buildRecordIdentity(BASE_INPUT);
  const right = buildRecordIdentity({
    ...BASE_INPUT,
    rawContentHash: "c".repeat(64),
  });
  assert.notEqual(left.sourceRecordHash, right.sourceRecordHash);
  assert.equal(left.recordIdempotencyKey, right.recordIdempotencyKey);
});

test("snapshot changes idempotency while preserving content hash", () => {
  const left = buildRecordIdentity(BASE_INPUT);
  const right = buildRecordIdentity({
    ...BASE_INPUT,
    sourceSnapshotKey: "2026-09-02",
  });
  assert.equal(left.sourceRecordHash, right.sourceRecordHash);
  assert.notEqual(left.recordIdempotencyKey, right.recordIdempotencyKey);
});

test("source keys are explicit stable slugs", () => {
  assert.equal(normalizeSourceKey(" Approved.Source "), "approved.source");
  assert.throws(() => normalizeSourceKey("spaces are unsafe"), /sourceKey/);
});

test("file name alone is not an identity", () => {
  const left = buildRecordIdentity(BASE_INPUT);
  const right = buildRecordIdentity({
    ...BASE_INPUT,
    sourceNativeId: "another/path/123.gpx",
  });
  assert.notEqual(left.canonicalSourceRecordKey, right.canonicalSourceRecordKey);
});
