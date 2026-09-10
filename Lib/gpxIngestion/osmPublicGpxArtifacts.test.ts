import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalOsmTraceUrl, parseOsmTraceId } from "./osmPublicGpxAdapter.ts";

test("OSM seed manifest is tiny, canonical, and contains no uploader identity", async () => {
  const source = await readFile(
    new URL("../../data/gpx/phase12c/osm-public-gpx-seeds.json", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(source) as {
    sourceKey: string;
    traces: Array<Record<string, unknown>>;
  };
  assert.equal(manifest.sourceKey, "openstreetmap-public-gpx");
  assert.ok(manifest.traces.length > 0 && manifest.traces.length <= 10);
  for (const seed of manifest.traces) {
    assert.deepEqual(Object.keys(seed).sort(), [
      "reasonSelected",
      "sourceUrl",
      "traceId",
    ]);
    const traceId = parseOsmTraceId(String(seed.traceId));
    assert.equal(seed.sourceUrl, canonicalOsmTraceUrl(traceId));
  }
  assert.doesNotMatch(source, /user(name)?|display.?name|author/i);
});

test("smoke artifact is summary-only and attests every zero-write boundary", async () => {
  const source = await readFile(
    new URL(
      "../../data/gpx/phase12c/osm-public-gpx-smoke-result.json",
      import.meta.url,
    ),
    "utf8",
  );
  const artifact = JSON.parse(source) as {
    runStatus: string;
    attemptCounts: { rawGpxRequests: number };
    results: Array<Record<string, unknown>>;
    attestations: Record<string, unknown>;
  };
  assert.ok(
    new Set(["COMPLETED", "MANUAL_NETWORK_SMOKE_REQUIRED", "SOURCE_ACCESS_BLOCKED"])
      .has(artifact.runStatus),
  );
  assert.ok(artifact.attemptCounts.rawGpxRequests <= 5);
  for (const result of artifact.results) {
    assert.equal("geometry" in result, false);
    assert.equal("coordinates" in result, false);
    assert.equal("uploader" in result, false);
  }
  assert.equal(artifact.attestations.authenticationUsed, false);
  assert.equal(artifact.attestations.rawGpxPersisted, false);
  assert.equal(artifact.attestations.databaseWrites, 0);
  assert.equal(artifact.attestations.storageWrites, 0);
  assert.equal(artifact.attestations.publicationWrites, 0);
  assert.equal(artifact.attestations.mountainMatchingQueries, 0);
});
