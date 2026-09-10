import assert from "node:assert/strict";
import test from "node:test";

import {
  sha256Bytes,
  sha256DirectionNeutralGeometryHash,
  sha256GeometryHash,
  sha256Stable,
  stableJson,
} from "./hashing.ts";
import type { NormalizedTrackGeometry } from "./types.ts";

test("stableJson is deterministic without changing object shape", () => {
  const left = { b: 1, a: 2, nested: { z: 3, y: 4 } };
  const right = { nested: { y: 4, z: 3 }, a: 2, b: 1 };
  assert.equal(stableJson(left), stableJson(right));
  assert.equal(stableJson(left), '{"a":2,"b":1,"nested":{"y":4,"z":3}}');
  assert.equal(sha256Stable(left), sha256Stable(right));
});

test("raw byte hashes are deterministic and content-sensitive", () => {
  const hash = sha256Bytes(new Uint8Array([1, 2, 3, 4]));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, sha256Bytes(new Uint8Array([1, 2, 3, 4])));
  assert.notEqual(hash, sha256Bytes(new Uint8Array([1, 2, 3, 5])));
});

test("level 2 geometry identity keeps direction distinct", () => {
  const forward: NormalizedTrackGeometry = {
    type: "LineString",
    coordinates: [[8.5, 47], [8.6, 47.1], [8.7, 47.2]],
  };
  const reverse: NormalizedTrackGeometry = {
    type: "LineString",
    coordinates: [...forward.coordinates].reverse(),
  };
  assert.notEqual(sha256GeometryHash(forward), sha256GeometryHash(reverse));
});

test("level 3 geometry identity recognizes reversed routes", () => {
  const forward: NormalizedTrackGeometry = {
    type: "LineString",
    coordinates: [[8.5, 47], [8.6, 47.1], [8.7, 47.2]],
  };
  const reverse: NormalizedTrackGeometry = {
    type: "LineString",
    coordinates: [...forward.coordinates].reverse(),
  };
  assert.equal(
    sha256DirectionNeutralGeometryHash(forward),
    sha256DirectionNeutralGeometryHash(reverse),
  );
});

test("direction-neutral identity preserves segment topology", () => {
  const line: NormalizedTrackGeometry = {
    type: "LineString",
    coordinates: [[8.5, 47], [8.6, 47.1], [8.7, 47.2]],
  };
  const segmented: NormalizedTrackGeometry = {
    type: "MultiLineString",
    coordinates: [[[8.5, 47], [8.6, 47.1]], [[8.6, 47.1], [8.7, 47.2]]],
  };
  assert.notEqual(
    sha256DirectionNeutralGeometryHash(line),
    sha256DirectionNeutralGeometryHash(segmented),
  );
});

test("canonical JSON rejects non-finite values", () => {
  assert.throws(() => stableJson({ distance: Infinity }), /non-finite/);
});
