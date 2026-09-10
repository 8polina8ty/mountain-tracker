import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVER_GPX_LIMITS,
  validateServerGpxParserLimits,
  type ServerGpxParser,
} from "./parserContract.ts";

test("server parser defaults are bounded", () => {
  const limits = validateServerGpxParserLimits({ ...DEFAULT_SERVER_GPX_LIMITS });
  assert.equal(limits.maximumTrackPoints, 250_000);
  assert.equal(limits.maximumSegments, 10_000);
  assert.equal(limits.maximumMetadataCharacters, 64_000);
  assert.equal(limits.maximumElementDepth, 128);
  assert.equal(limits.maximumAttributesPerElement, 64);
  assert.ok(limits.maximumRawBytes <= 100 * 1024 * 1024);
});

test("unsafe parser ceilings are rejected", () => {
  assert.throws(
    () =>
      validateServerGpxParserLimits({
        ...DEFAULT_SERVER_GPX_LIMITS,
        maximumTrackPoints: 2_000_000,
      }),
    /maximumTrackPoints/,
  );
});

test("parser contract consumes bytes and emits segment boundaries", async () => {
  const parser: ServerGpxParser = {
    parserName: "fixture",
    parserVersion: "1",
    async parse() {
      return {
        segments: [{
          points: [
            { coordinate: [8.5, 47], time: null },
            { coordinate: [8.6, 47.1], time: null },
          ],
        }],
        trackName: null,
        flags: [],
      };
    },
  };
  const result = await parser.parse(new Uint8Array(), {
    ...DEFAULT_SERVER_GPX_LIMITS,
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].points.length, 2);
});
