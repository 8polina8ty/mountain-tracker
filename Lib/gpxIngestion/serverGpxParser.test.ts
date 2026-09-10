import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Bytes, stableJson } from "./hashing.ts";
import {
  DEFAULT_SERVER_GPX_LIMITS,
  ServerGpxError,
  type ServerGpxErrorCode,
} from "./parserContract.ts";
import {
  parseAndNormalizeServerGpx,
  SaxServerGpxParser,
  SERVER_GPX_PARSER_NAME,
  SERVER_GPX_PARSER_VERSION,
} from "./serverGpxParser.ts";

const encoder = new TextEncoder();

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url));
}

function bytes(xml: string): Uint8Array {
  return encoder.encode(xml);
}

function track(points: string, extras = ""): Uint8Array {
  return bytes(
    `<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${extras}<trk><trkseg>${points}</trkseg></trk></gpx>`,
  );
}

function point(lat: string, lon: string, children = ""): string {
  return `<trkpt lat="${lat}" lon="${lon}">${children}</trkpt>`;
}

async function expectCode(
  operation: () => Promise<unknown>,
  code: ServerGpxErrorCode,
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ServerGpxError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  });
}

test("uses a versioned server parser without browser-only globals", async () => {
  assert.equal(SERVER_GPX_PARSER_NAME, "sax");
  assert.match(SERVER_GPX_PARSER_VERSION, /^sax@1\.6\.1\//);
  assert.equal(typeof DOMParser, "undefined");
  const parser = new SaxServerGpxParser();
  const parsed = await parser.parse(
    await fixture("simple.gpx"),
    { ...DEFAULT_SERVER_GPX_LIMITS },
  );
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].points.length, 2);
});

test("normalizes a simple GPX into the exact versioned output contract", async () => {
  const raw = await fixture("simple.gpx");
  const result = await parseAndNormalizeServerGpx(raw);
  assert.equal(result.schemaVersion, "mountain-tracker/external-gpx/v1");
  assert.equal(result.normalizationVersion, "mountain-tracker/gpx-normalization/v1");
  assert.equal(result.elevationAlgorithmVersion, "positive-delta-3m/v1");
  assert.equal(result.rawContentHash, sha256Bytes(raw));
  assert.match(result.normalizedGeometryHash, /^[0-9a-f]{64}$/);
  assert.match(result.directionNeutralGeometryHash, /^[0-9a-f]{64}$/);
  assert.equal(result.geometry.type, "LineString");
  assert.equal(result.pointCount, 2);
  assert.equal(result.segmentCount, 1);
  assert.ok(result.distanceM > 100 && result.distanceM < 150);
  assert.equal(result.elevationGainM, 4);
  assert.equal(result.minimumElevationM, 1000);
  assert.equal(result.maximumElevationM, 1004);
  assert.equal(result.startedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(result.finishedAt, "2026-01-01T10:01:00.000Z");
  assert.equal(result.durationSeconds, 60);
  assert.deepEqual(result.boundingBox, {
    minimumLongitude: 11,
    minimumLatitude: 47,
    maximumLongitude: 11.001,
    maximumLatitude: 47.001,
  });
  assert.deepEqual(result.startCoordinate, [11, 47, 1000]);
  assert.deepEqual(result.endCoordinate, [11.001, 47.001, 1004]);
  assert.deepEqual(result.displayMetadata, { name: "Alpine Test" });
  assert.deepEqual(result.normalizationFlags, []);
});

test("accepts Buffer input and namespace prefixes", async () => {
  const raw = Buffer.from(await fixture("namespaced.gpx"));
  const result = await parseAndNormalizeServerGpx(raw);
  assert.equal(result.pointCount, 2);
  assert.deepEqual(result.normalizationFlags, [
    "MISSING_ELEVATION",
    "MISSING_TIMESTAMPS",
  ]);
});

test("preserves trkseg gaps and never measures distance across them", async () => {
  const result = await parseAndNormalizeServerGpx(await fixture("multi-segment.gpx"));
  assert.equal(result.geometry.type, "MultiLineString");
  assert.equal(result.segmentCount, 2);
  assert.equal(result.pointCount, 4);
  assert.ok(result.distanceM > 200 && result.distanceM < 300);
  assert.deepEqual(result.startCoordinate, [11, 47]);
  assert.deepEqual(result.endCoordinate, [12.001, 48.001]);
});

test("supports multiple tracks without merging their segment boundaries", async () => {
  const result = await parseAndNormalizeServerGpx(await fixture("multiple-tracks.gpx"));
  assert.equal(result.geometry.type, "MultiLineString");
  assert.equal(result.segmentCount, 2);
  assert.equal(result.displayMetadata.name, "First");
  assert.ok(result.normalizationFlags.includes("MULTIPLE_TRACKS"));
});

test("produces deterministic results and three independent hash meanings", async () => {
  const raw = await fixture("simple.gpx");
  const repeated = await Promise.all([
    parseAndNormalizeServerGpx(raw),
    parseAndNormalizeServerGpx(raw),
  ]);
  assert.equal(stableJson(repeated[0]), stableJson(repeated[1]));

  const reversed = await parseAndNormalizeServerGpx(await fixture("reversed.gpx"));
  assert.notEqual(repeated[0].rawContentHash, reversed.rawContentHash);
  assert.notEqual(repeated[0].normalizedGeometryHash, reversed.normalizedGeometryHash);
  assert.equal(
    repeated[0].directionNeutralGeometryHash,
    reversed.directionNeutralGeometryHash,
  );
});

test("keeps MultiLineString reversal direction-neutral", async () => {
  const forward = bytes(`<gpx><trk>
    <trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg>
    <trkseg><trkpt lat="3" lon="3"/><trkpt lat="4" lon="4"/></trkseg>
  </trk></gpx>`);
  const reverse = bytes(`<gpx><trk>
    <trkseg><trkpt lat="4" lon="4"/><trkpt lat="3" lon="3"/></trkseg>
    <trkseg><trkpt lat="2" lon="2"/><trkpt lat="1" lon="1"/></trkseg>
  </trk></gpx>`);
  const [left, right] = await Promise.all([
    parseAndNormalizeServerGpx(forward),
    parseAndNormalizeServerGpx(reverse),
  ]);
  assert.notEqual(left.normalizedGeometryHash, right.normalizedGeometryHash);
  assert.equal(left.directionNeutralGeometryHash, right.directionNeutralGeometryHash);
});

test("raw bytes vary while equivalent geometry hashes remain stable", async () => {
  const [base, metadata, numeric] = await Promise.all([
    parseAndNormalizeServerGpx(await fixture("simple.gpx")),
    parseAndNormalizeServerGpx(await fixture("metadata-variant.gpx")),
    parseAndNormalizeServerGpx(await fixture("numeric-variant.gpx")),
  ]);
  assert.notEqual(base.rawContentHash, metadata.rawContentHash);
  assert.notEqual(base.rawContentHash, numeric.rawContentHash);
  assert.equal(base.normalizedGeometryHash, metadata.normalizedGeometryHash);
  assert.equal(base.normalizedGeometryHash, numeric.normalizedGeometryHash);
  assert.equal(metadata.displayMetadata.name, "Another name");
});

test("XML whitespace alone changes only the raw-content identity", async () => {
  const raw = await fixture("simple.gpx");
  const compact = bytes(new TextDecoder().decode(raw).replace(/>\s+</g, "><"));
  const [formatted, minified] = await Promise.all([
    parseAndNormalizeServerGpx(raw),
    parseAndNormalizeServerGpx(compact),
  ]);
  assert.notEqual(formatted.rawContentHash, minified.rawContentHash);
  assert.equal(formatted.normalizedGeometryHash, minified.normalizedGeometryHash);
  assert.equal(
    formatted.directionNeutralGeometryHash,
    minified.directionNeutralGeometryHash,
  );
});

test("normalizes timestamps to UTC and drops malformed values with explicit flags", async () => {
  const result = await parseAndNormalizeServerGpx(track(
    point("47", "11", "<time>2026-02-29T10:00:00</time>") +
      point("47.1", "11.1", "<time>2026-01-01T11:01:00+01:00</time>"),
  ));
  assert.equal(result.startedAt, "2026-01-01T10:01:00.000Z");
  assert.equal(result.finishedAt, "2026-01-01T10:01:00.000Z");
  assert.equal(result.durationSeconds, 0);
  assert.ok(result.normalizationFlags.includes("MALFORMED_TIMESTAMP_DROPPED"));
  assert.ok(result.normalizationFlags.includes("PARTIAL_TIMESTAMPS"));
});

test("flags non-monotonic retained time ranges", async () => {
  const result = await parseAndNormalizeServerGpx(track(
    point("47", "11", "<time>2026-01-01T10:01:00Z</time>") +
      point("47.1", "11.1", "<time>2026-01-01T10:00:00Z</time>"),
  ));
  assert.equal(result.durationSeconds, null);
  assert.ok(result.normalizationFlags.includes("NON_MONOTONIC_TIME_RANGE"));
});

test("marks partial elevation and uses only adjacent complete elevation pairs", async () => {
  const result = await parseAndNormalizeServerGpx(track(
    point("47", "11", "<ele>1000</ele>") +
      point("47.1", "11.1") +
      point("47.2", "11.2", "<ele>1100</ele>"),
  ));
  assert.equal(result.elevationGainM, null);
  assert.equal(result.minimumElevationM, 1000);
  assert.equal(result.maximumElevationM, 1100);
  assert.ok(result.normalizationFlags.includes("PARTIAL_ELEVATION"));
});

test("retains only bounded sanitized track name metadata", async () => {
  const name = `${"N".repeat(220)}&lt;script&gt;\u202E`;
  const raw = bytes(`<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="private-device"><metadata><author><name>Private Person</name></author></metadata><trk><name>${name}</name><extensions><email>person@example.test</email></extensions><trkseg><trkpt lat="47" lon="11"/><trkpt lat="47.1" lon="11.1"/></trkseg></trk></gpx>`);
  const result = await parseAndNormalizeServerGpx(raw);
  assert.equal(result.displayMetadata.name?.length, 200);
  assert.doesNotMatch(result.displayMetadata.name ?? "", /[<>\u202E]/);
  assert.deepEqual(Object.keys(result.displayMetadata), ["name"]);
  assert.doesNotMatch(stableJson(result), /private-device|Private Person|example\.test/);
});

test("rejects malformed XML, unsupported roots, namespaces, and routes", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(fixtureBytes("malformed.gpx")),
    "INVALID_XML",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes("<html><body/></html>")),
    "UNSUPPORTED_GPX",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<gpx xmlns="urn:not-gpx"><trk/></gpx>')),
    "UNSUPPORTED_GPX",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(fixtureBytes("route-only.gpx")),
    "UNSUPPORTED_GPX",
  );
});

test("rejects DTD, ENTITY, and XXE input before document parsing", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<!DOCTYPE gpx><gpx/>')),
    "DOCTYPE_NOT_ALLOWED",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(fixtureBytes("xxe.gpx")),
    "ENTITY_NOT_ALLOWED",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<!ENTITY x "boom"><gpx/>')),
    "ENTITY_NOT_ALLOWED",
  );
});

test("rejects invalid coordinates and special numeric spellings", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(fixtureBytes("invalid-coordinates.gpx")),
    "INVALID_COORDINATE",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(track(point("47", "181") + point("47", "11"))),
    "INVALID_COORDINATE",
  );
  for (const [lat, lon] of [["NaN", "11"], ["47", "Infinity"], ["", "11"]]) {
    await expectCode(
      () => parseAndNormalizeServerGpx(track(point(lat, lon) + point("47", "11"))),
      "INVALID_COORDINATE",
    );
  }
});

test("rejects missing coordinates and malformed elevations", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(track('<trkpt lat="47"/><trkpt lat="47.1" lon="11.1"/>')),
    "INVALID_COORDINATE",
  );
  for (const elevation of ["", "NaN", "Infinity", "0x10"]) {
    await expectCode(
      () => parseAndNormalizeServerGpx(track(
        point("47", "11", `<ele>${elevation}</ele>`) + point("47.1", "11.1"),
      )),
      "INVALID_ELEVATION",
    );
  }
});

test("enforces raw byte, point, segment, and metadata limits", async () => {
  const simple = await fixture("simple.gpx");
  await expectCode(
    () => parseAndNormalizeServerGpx(simple, { maximumRawBytes: simple.length - 1 }),
    "INPUT_TOO_LARGE",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(track(
      point("47", "11") + point("47.1", "11.1") + point("47.2", "11.2"),
    ), { maximumTrackPoints: 2 }),
    "TOO_MANY_POINTS",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg><trkseg><trkpt lat="2" lon="2"/></trkseg></trk></gpx>'), { maximumSegments: 1 }),
    "TOO_MANY_SEGMENTS",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes(`<gpx><trk><name>${"x".repeat(11)}</name><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk></gpx>`), { maximumMetadataCharacters: 10 }),
    "METADATA_TOO_LARGE",
  );
});

test("enforces nesting and per-element attribute limits", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes("<gpx><a><b/></a></gpx>"), { maximumElementDepth: 2 }),
    "NESTING_LIMIT_EXCEEDED",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk></gpx>'), { maximumAttributesPerElement: 1 }),
    "ATTRIBUTE_LIMIT_EXCEEDED",
  );
});

test("rejects empty and one-point track geometry with stable error codes", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes("<gpx><trk><trkseg/></trk></gpx>")),
    "NO_TRACK_POINTS",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(track(point("47", "11"))),
    "INSUFFICIENT_GEOMETRY",
  );
});

test("rejects invalid UTF-8 and non-UTF-8 declarations", async () => {
  await expectCode(
    () => parseAndNormalizeServerGpx(new Uint8Array([0xc3, 0x28])),
    "INVALID_XML",
  );
  await expectCode(
    () => parseAndNormalizeServerGpx(bytes('<?xml version="1.0" encoding="ISO-8859-1"?><gpx/>')),
    "INVALID_XML",
  );
});

function fixtureBytes(name: string): Uint8Array {
  // The fixture promises are deliberately resolved outside parser internals;
  // this helper keeps rejection-call sites synchronous and network-free.
  const cached = fixtureCache.get(name);
  if (!cached) throw new Error(`Fixture ${name} was not preloaded.`);
  return cached;
}

const fixtureCache = new Map<string, Uint8Array>();
await Promise.all(
  ["malformed.gpx", "invalid-coordinates.gpx", "xxe.gpx", "route-only.gpx"].map(
    async (name) => fixtureCache.set(name, await fixture(name)),
  ),
);
