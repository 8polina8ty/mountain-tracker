import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGpxGeometry } from "./gpxNormalization.ts";
import {
  matchResolvedPeaks,
  planMountainMatch,
  type MatchableMountain,
  type MountainCandidateIndex,
} from "./mountainMatching.ts";

function geometry(points: Array<[number, number]>) {
  return normalizeGpxGeometry(points).geometry;
}

function fixedIndex(
  candidates: MatchableMountain[],
  limitExceeded = false,
): MountainCandidateIndex {
  return {
    indexVersion: "fixture/v1",
    queryTrackCorridor() {
      return { candidates, limitExceeded };
    },
  };
}

test("matching plan delegates to a reusable offline index contract", () => {
  const summit: MatchableMountain = {
    id: 1,
    coordinates: [8.52, 47],
    name: "Summit",
    height: 4_000,
  };
  const plan = planMountainMatch(
    "track-1",
    geometry([[8.5, 47], [8.52, 47]]),
    fixedIndex([summit]),
  );
  assert.equal(plan.indexVersion, "fixture/v1");
  assert.equal(plan.status, "READY");
  assert.equal(plan.candidateCount, 1);
});

test("candidate overflow is explicit manual review, never silent truncation", () => {
  const plan = planMountainMatch(
    "track-1",
    geometry([[8.5, 47], [8.52, 47]]),
    fixedIndex([], true),
  );
  assert.equal(plan.status, "REVIEW_REQUIRED");
});

test("no candidate is a valid no-summit outcome", () => {
  const result = matchResolvedPeaks(
    geometry([[8.5, 47], [8.51, 47.01]]),
    [],
  );
  assert.equal(result.outcome, "NO_SUMMIT");
  assert.equal(result.candidates.length, 0);
});

test("one direct summit becomes primary", () => {
  const result = matchResolvedPeaks(
    geometry([[8.5, 47], [8.52, 47]]),
    [{ id: 1, coordinates: [8.52, 47], name: "Summit", height: 4_000 }],
  );
  assert.equal(result.outcome, "DIRECT");
  assert.equal(result.candidates[0].classification, "DIRECT");
  assert.equal(result.candidates[0].isPrimary, true);
});

test("equally plausible direct summits are ambiguous with no forced primary", () => {
  const result = matchResolvedPeaks(
    geometry([[8.5, 47], [8.52, 47]]),
    [
      { id: 1, coordinates: [8.52, 47], name: "A", height: 4_000 },
      { id: 2, coordinates: [8.52001, 47], name: "B", height: 4_001 },
    ],
  );
  assert.equal(result.outcome, "AMBIGUOUS");
  assert.equal(result.candidates.some((candidate) => candidate.isPrimary), false);
});

test("multiple direct summit associations are preserved", () => {
  const result = matchResolvedPeaks(
    geometry([[8.5, 47], [8.52, 47], [8.54, 47]]),
    [
      { id: 1, coordinates: [8.52, 47], name: "A", height: 4_000 },
      { id: 2, coordinates: [8.54, 47], name: "B", height: 4_100 },
    ],
    { ambiguityConfidenceMargin: 0 },
  );
  assert.equal(
    result.candidates.filter((candidate) => candidate.classification === "DIRECT").length,
    2,
  );
});
