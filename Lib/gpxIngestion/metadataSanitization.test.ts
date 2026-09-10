import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMetadata, METADATA_FIELD_LIMITS } from "./metadataSanitization.ts";

test("trims and collapses whitespace", () => {
  const out = sanitizeMetadata({ name: "  Matterhorn   via   Hornli  " });
  assert.equal(out.name, "Matterhorn via Hornli");
});

test("null and empty become null", () => {
  const out = sanitizeMetadata({ name: null, description: "   " });
  assert.equal(out.name, null);
  assert.equal(out.description, null);
});

test("strips control characters", () => {
  const out = sanitizeMetadata({ name: "a\u0000b\u0007c" });
  assert.equal(out.name, "a b c");
});

test("bounds-overlong fields to the documented DB limits", () => {
  const longName = "x".repeat(1000);
  const out = sanitizeMetadata({ name: longName });
  assert.equal(out.name!.length, METADATA_FIELD_LIMITS.name);
  assert.equal(METADATA_FIELD_LIMITS.name, 200);
});

test("drops unknown keys and fills all typed fields", () => {
  const out = sanitizeMetadata({ name: "r", bogus: "ignored" } as never);
  assert.equal(out.description, null);
  assert.equal(out.activityType, null);
  assert.equal(out.routeType, null);
  assert.equal(out.difficultySystem, null);
  assert.equal(out.difficultyValue, null);
  assert.equal(out.bestSeason, null);
  assert.equal(out.equipment, null);
  assert.equal(out.warnings, null);
  assert.equal(out.attribution, null);
  assert.equal(out.sourceUrl, null);
});

test("does not mutate the input object", () => {
  const input = { name: "  padded  ", sourceUrl: "https://example.com" };
  const snapshot = JSON.stringify(input);
  sanitizeMetadata(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("neutralizes markup, controls, and bidi overrides", () => {
  const out = sanitizeMetadata({
    name: "<script>alert(1)</script>\u202E",
  });
  assert.equal(out.name?.includes("<script>"), false);
  assert.equal(out.name?.includes("\u202E"), false);
});

test("keeps only credential-free HTTP(S) source URLs", () => {
  assert.equal(
    sanitizeMetadata({ sourceUrl: "javascript:alert(1)" }).sourceUrl,
    null,
  );
  assert.equal(
    sanitizeMetadata({ sourceUrl: "https://user:secret@example.com/a" }).sourceUrl,
    null,
  );
  assert.equal(
    sanitizeMetadata({ sourceUrl: "https://example.com/route" }).sourceUrl,
    "https://example.com/route",
  );
});
