import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRouteDiscoverySignal,
  DISCOVERY_SOURCE_POLICIES,
  validateDiscoveryAdapter,
} from "./routeDiscovery.ts";
import { resolveOsmAnchor, type OsmAnchorFeature } from "./osmAnchorResolution.ts";

function semanticSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signalId: "manual:zugspitze-hoellental",
    sourceKey: "manual-research",
    sourceReference: "phase12c:zugspitze-hoellental",
    observedAt: "2026-09-04T00:00:00.000Z",
    mountainIdentity: { name: "Zugspitze", regionName: "Bayern", countryCode: "DE" },
    routeVariantName: "Höllental",
    activityType: "MOUNTAINEERING",
    startHint: { name: "Hammersbach", expectedTypes: ["SETTLEMENT"], regionName: "Bayern" },
    viaHints: [
      { name: "Höllentalangerhütte", expectedTypes: ["HUT"], regionName: "Bayern" },
    ],
    summitHint: { name: "Zugspitze", expectedTypes: ["SUMMIT"], regionName: "Bayern" },
    terminalHint: null,
    routeShapeHint: "OUT_AND_BACK",
    directionHint: "ascent",
    sourcePolicyStatus: "ALLOWED",
    signalConfidence: 0.9,
    ...overrides,
  };
}

test("semantic-only manual discovery signal is accepted and keeps provenance separate", () => {
  const signal = createRouteDiscoverySignal(semanticSignal());
  assert.equal(signal.startHint.name, "Hammersbach");
  assert.equal(signal.viaHints[0].name, "Höllentalangerhütte");
  assert.deepEqual(signal.discoveryProvenance, {
    sourceKey: "manual-research",
    sourceReference: "phase12c:zugspitze-hoellental",
    role: "ROUTE_EXISTENCE_SIGNAL",
  });
  assert.equal("geometry" in signal, false);
});

test("restricted providers cannot automatically supply discovery signals", () => {
  for (const [sourceKey, status] of [
    ["wikiloc", "REQUIRES_PROVIDER_PERMISSION"],
    ["komoot", "REQUIRES_PROVIDER_PERMISSION"],
    ["hikr", "REVIEW_REQUIRED"],
  ] as const) {
    assert.throws(
      () =>
        createRouteDiscoverySignal(
          semanticSignal({ sourceKey, sourcePolicyStatus: status }),
        ),
      new RegExp(status),
    );
  }
});

test("provider capability records block proprietary geometry", () => {
  for (const sourceKey of ["wikiloc", "komoot", "hikr"] as const) {
    const policy = DISCOVERY_SOURCE_POLICIES[sourceKey];
    assert.equal(policy.geometryStatus, "BLOCKED");
    assert.deepEqual(policy.geometryCapabilities, []);
  }
  assert.equal(DISCOVERY_SOURCE_POLICIES.openstreetmap.geometryStatus, "ALLOWED");
  assert.deepEqual(DISCOVERY_SOURCE_POLICIES.openstreetmap.geometryCapabilities, [
    "GEOMETRY_ALLOWED",
  ]);
  assert.equal(DISCOVERY_SOURCE_POLICIES["manual-research"].discoveryStatus, "ALLOWED");
  assert.equal(DISCOVERY_SOURCE_POLICIES["manual-research"].geometryStatus, "BLOCKED");
});

test("discovery signals reject GPX, GeoJSON, polylines, hashes, and coordinate sequences", () => {
  for (const prohibited of [
    { gpx: "<gpx/>" },
    { geoJson: { type: "LineString" } },
    { encodedPolyline: "abc" },
    { geometryHash: "abc" },
    { route: { coordinates: [[11, 47], [11.1, 47.1]] } },
  ]) {
    assert.throws(() => createRouteDiscoverySignal({ ...semanticSignal(), ...prohibited }), /prohibited/i);
  }
});

test("untrusted discovery strings are bounded and reject markup and path traversal", () => {
  assert.throws(
    () => createRouteDiscoverySignal(semanticSignal({ routeVariantName: "<script>x</script>" })),
    /unsafe markup/i,
  );
  assert.throws(
    () => createRouteDiscoverySignal(semanticSignal({ sourceReference: "../../secret" })),
    /path traversal/i,
  );
  assert.throws(
    () =>
      createRouteDiscoverySignal(
        semanticSignal({ viaHints: Array.from({ length: 9 }, () => ({ name: "Hut" })) }),
      ),
    /at most 8/i,
  );
});

test("a discovery adapter cannot run under a permission-gated policy", () => {
  assert.throws(
    () =>
      validateDiscoveryAdapter({
        policy: DISCOVERY_SOURCE_POLICIES.wikiloc,
        async discover() {
          return { signals: [], nextCursor: null };
        },
      }),
    /REQUIRES_PROVIDER_PERMISSION/,
  );
});

function feature(
  osmId: number,
  tags: Record<string, string>,
  coordinate: [number, number] = [11, 47],
): OsmAnchorFeature {
  return { sourceKey: "openstreetmap", osmObjectType: "node", osmId, coordinate, tags };
}

test("OSM anchor resolution returns an independently sourced exact semantic match", () => {
  const result = resolveOsmAnchor(
    { name: "Zugspitze", expectedTypes: ["SUMMIT"], regionName: "Bayern" },
    [
      feature(1, { name: "Zugspitze", natural: "peak", "addr:state": "Bayern" }),
      feature(2, { name: "Zugspitze", place: "hamlet", "addr:state": "Bayern" }),
    ],
  );
  assert.equal(result.status, "RESOLVED");
  if (result.status !== "RESOLVED") return;
  assert.equal(result.anchor.osmId, 1);
  assert.equal(result.anchor.geometrySource, "OPENSTREETMAP");
  assert.deepEqual(result.anchor.coordinate, [11, 47]);
});

test("ambiguous exact names fail closed instead of selecting a random feature", () => {
  const result = resolveOsmAnchor(
    { name: "Alpenhütte", expectedTypes: ["HUT"], regionName: null },
    [
      feature(10, { name: "Alpenhütte", tourism: "alpine_hut" }),
      feature(11, { name: "Alpenhütte", tourism: "alpine_hut" }, [11.01, 47]),
    ],
  );
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.anchor, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.osmId), [10, 11]);
});

test("missing and type-incompatible anchor names fail closed", () => {
  assert.equal(
    resolveOsmAnchor(
      { name: "Missing", expectedTypes: ["SUMMIT"], regionName: null },
      [feature(1, { name: "Other", natural: "peak" })],
    ).status,
    "NOT_FOUND",
  );
  assert.equal(
    resolveOsmAnchor(
      { name: "Zugspitze", expectedTypes: ["HUT"], regionName: null },
      [feature(1, { name: "Zugspitze", natural: "peak" })],
    ).status,
    "NOT_FOUND",
  );
});

test("versioned manual fixture contains semantic facts and no proprietary geometry", async () => {
  const raw = await readFile(
    new URL("../../data/gpx/phase12c/manual-route-discovery-signals.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(raw, /coordinates|polyline|geometry|trackpoints|uploader|user/i);
  const parsed = JSON.parse(raw) as unknown[];
  assert.equal(parsed.length, 4);
  const signalIds = parsed.map((signal) => createRouteDiscoverySignal(signal).signalId);
  assert.deepStrictEqual([...signalIds].sort(), [
    "manual:zugspitze-hoellental",
    "manual:zugspitze-hoellental-halt",
    "manual:zugspitze-hoellentalsteig",
    "manual:zugspitze-jubilaeumsgrat",
  ]);
});
