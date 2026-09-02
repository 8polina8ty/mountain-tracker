import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import {
  createPhase11C2ACanaryManifest,
  selectPhase11C2ACanary,
  verifyPhase11C2ACanaryManifest,
  type Phase11C2ACanaryManifest,
} from "./phase11c2a-v2-canary.ts";
import { sha256Stable } from "./phase11-publication.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const artifact = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidates.json", "utf8"),
) as PublicationCandidateArtifact;
const candidateManifest = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8"),
) as PublicationCandidateManifest;
const routes = new Map((await readFile("data/osm/alps/routes.jsonl", "utf8"))
  .trim().split(/\r?\n/).map((line) => {
    const route = JSON.parse(line) as ClassifiableRoute;
    return [route.sourceId, route] as const;
  }));
const activeRelationIds = new Set(["196164", "20916", "33528", "199145", "207900", "207913"]);

test("v2 canary deterministically selects one hiking and one via ferrata route", () => {
  const selected = selectPhase11C2ACanary({ artifact, routes, activeRelationIds });
  assert.deepEqual(selected.map((value) => value.candidate.sourceRelationId), ["361148", "140270"]);
  assert.ok(selected.every((value) => value.candidate.topology.classification === "SIMPLE"));
  assert.ok(selected.every((value) => value.candidate.qualityScore === 100));
});

test("locked v2 canary contains exact required identity and deterministic hash", () => {
  const manifest = createPhase11C2ACanaryManifest({ artifact, candidateManifest, routes, activeRelationIds });
  const { deterministicV2ManifestHash, ...content } = manifest;
  assert.equal(manifest.records.length, 2);
  assert.equal(deterministicV2ManifestHash, sha256Stable(content));
  assert.deepEqual(manifest.records.map((record) => record.routeType), ["hiking", "via_ferrata"]);
  assert.deepEqual(Object.keys(manifest.records[0]).sort(), [
    "activityCanonicalJson", "activityClassificationHash", "candidateContentHash",
    "canonicalRouteSourceId", "geometryHash", "mountainId", "publicationContractVersion",
    "publicationIdempotencyKey", "qaDecisionVersion", "routeName", "routeType",
    "semanticType", "sourceEvidenceHash", "sourceRelationId", "stagingPayloadHash",
    "stagingRouteId", "targetPayloadHash",
  ]);
  verifyPhase11C2ACanaryManifest({ provided: manifest, expected: structuredClone(manifest) });
});

test("stored v2 canary equals live deterministic local reconstruction", async () => {
  const provided = JSON.parse(
    await readFile("data/osm/alps/publication/phase11c2a-v2-canary.json", "utf8"),
  ) as Phase11C2ACanaryManifest;
  const expected = createPhase11C2ACanaryManifest({ artifact, candidateManifest, routes, activeRelationIds });
  verifyPhase11C2ACanaryManifest({ provided, expected });
});

test("manifest drift and candidate-count drift fail closed", () => {
  const expected = createPhase11C2ACanaryManifest({ artifact, candidateManifest, routes, activeRelationIds });
  const hashDrift = structuredClone(expected);
  hashDrift.deterministicV2ManifestHash = "0".repeat(64);
  assert.throws(() => verifyPhase11C2ACanaryManifest({ provided: hashDrift, expected }), /MANIFEST_HASH_DRIFT/);
  const countDrift = structuredClone(expected);
  countDrift.records.pop();
  const content = Object.fromEntries(
    Object.entries(countDrift).filter(([key]) => key !== "deterministicV2ManifestHash"),
  );
  countDrift.deterministicV2ManifestHash = sha256Stable(content);
  assert.throws(() => verifyPhase11C2ACanaryManifest({ provided: countDrift, expected }), /EXACTLY_TWO/);
});
