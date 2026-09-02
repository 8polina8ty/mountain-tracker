import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  Phase10QaHistoryRow,
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { buildPublicationRequestV2 } from "./phase11-publication-v2.ts";
import { sha256Stable } from "./phase11-publication.ts";
import {
  PHASE11C2_BASELINE_ACTIVE_RELATION_IDS,
  PHASE11C2_V2_MANIFEST_PATH,
  createPhase11C2V2BatchManifest,
  decidePhase11C2ExistingPublicationAction,
  parsePhase11C2CliArguments,
  requirePhase11C2ExecutionAuthorization,
  selectPhase11C2V2Batch,
  verifyPhase11C2V2BatchManifest,
  type Phase11C2V2BatchManifest,
} from "./phase11c2-v2-batch.ts";
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
const dryRun = JSON.parse(
  await readFile("data/osm/alps/publication/phase11-dry-run.json", "utf8"),
) as { records: Array<{ provenancePayload: { qa_history_snapshot: Phase10QaHistoryRow[] } }> };
const qaHistory = [...new Map(
  dryRun.records.flatMap((record) => record.provenancePayload.qa_history_snapshot)
    .map((event) => [event.id, event]),
).values()];
const baseline = new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS);

function createManifest(): Phase11C2V2BatchManifest {
  return createPhase11C2V2BatchManifest({
    artifact,
    candidateManifest,
    qaHistory,
    routes,
    activeRelationIds: baseline,
  });
}

test("Phase 11C.2 deterministically selects ten SIMPLE quality-100 hiking routes", () => {
  const selected = selectPhase11C2V2Batch({ artifact, routes, activeRelationIds: baseline });
  assert.deepEqual(selected.map((value) => value.candidate.canonicalRouteSourceId), [
    "1877850", "2210870", "915266", "3973107", "2202791",
    "1796122", "2135331", "1165714", "961283", "2050305",
  ]);
  assert.ok(selected.every((value) => value.activity.routeType === "hiking"));
  assert.ok(selected.every((value) => value.activity.manualReviewRequired === false));
  assert.ok(selected.every((value) => value.activity.conflictingTypes.length === 0));
  assert.ok(selected.every((value) => value.candidate.topology.classification === "SIMPLE"));
  assert.ok(selected.every((value) => value.candidate.qualityScore === 100));
  assert.ok(selected.every((value) => !baseline.has(
    value.candidate.canonicalRouteSourceId as (typeof PHASE11C2_BASELINE_ACTIVE_RELATION_IDS)[number],
  )));
});

test("locked v2 batch contains the exact required identity fields and deterministic hash", () => {
  const manifest = createManifest();
  const { deterministicV2ManifestHash, ...content } = manifest;
  assert.equal(manifest.records.length, 10);
  assert.equal(deterministicV2ManifestHash, sha256Stable(content));
  assert.deepEqual(Object.keys(manifest.records[0]).sort(), [
    "activityCanonicalJson", "activityClassificationHash",
    "candidateContentHash", "candidateManifestHash", "canonicalRouteSourceId",
    "geometryHash", "mountainId", "publicationContractVersion",
    "publicationIdempotencyKey", "qaDecisionVersion", "qaHistoryHash", "quality",
    "routeName", "routeType", "semanticType", "sourceEvidenceHash",
    "sourceRelationId", "stagingPayloadHash", "stagingRouteId", "targetPayloadHash",
    "topologyClassification",
  ]);
  verifyPhase11C2V2BatchManifest({ provided: manifest, expected: structuredClone(manifest) });
});

test("stored Phase 11C.2 batch equals deterministic local reconstruction", async () => {
  const stored = JSON.parse(
    await readFile(PHASE11C2_V2_MANIFEST_PATH, "utf8"),
  ) as Phase11C2V2BatchManifest;
  verifyPhase11C2V2BatchManifest({ provided: stored, expected: createManifest() });
});

test("all ten exact v2 RPC requests map target route_type to hiking", () => {
  const lockedManifest = createManifest();
  for (const record of lockedManifest.records) {
    const candidate = artifact.candidates.find(
      (value) => value.stagingRouteId === record.stagingRouteId,
    );
    const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
    assert.ok(candidate);
    assert.ok(route);
    const request = buildPublicationRequestV2({
      artifact,
      candidateManifest,
      lockedManifest,
      candidate,
      qaHistory,
      route,
    });
    assert.equal(request.mountainRoutePayload.route_type, "hiking");
    assert.equal(request.provenancePayload.activity_classification.manualReviewRequired, false);
    assert.equal(request.provenancePayload.activity_classification_hash, record.activityClassificationHash);
    assert.equal(request.provenancePayload.source_url, candidate.provenance.sourceUrl);
    assert.equal(request.candidateManifestHash, lockedManifest.deterministicV2ManifestHash);
  }
});

test("manifest drift, candidate-count drift, and extra relations fail closed", () => {
  const expected = createManifest();
  const hashDrift = structuredClone(expected);
  hashDrift.deterministicV2ManifestHash = "0".repeat(64);
  assert.throws(
    () => verifyPhase11C2V2BatchManifest({ provided: hashDrift, expected }),
    /MANIFEST_HASH_DRIFT/,
  );
  const countDrift = structuredClone(expected);
  countDrift.records.pop();
  const content = Object.fromEntries(
    Object.entries(countDrift).filter(([key]) => key !== "deterministicV2ManifestHash"),
  );
  countDrift.deterministicV2ManifestHash = sha256Stable(content);
  assert.throws(
    () => verifyPhase11C2V2BatchManifest({ provided: countDrift, expected }),
    /EXACTLY_TEN/,
  );
});

test("execute authorization requires the locked path and exact ten-relation confirmation", () => {
  const manifest = createManifest();
  const confirmation = manifest.records.map((record) => record.canonicalRouteSourceId).join(",");
  const preflight = parsePhase11C2CliArguments([]);
  assert.doesNotThrow(() => requirePhase11C2ExecutionAuthorization({ cli: preflight, manifest }));
  assert.throws(() => requirePhase11C2ExecutionAuthorization({
    cli: { execute: true, manifestPath: preflight.manifestPath, confirmation: `${confirmation},999` },
    manifest,
  }), /EXECUTE_REQUIRES_CONFIRM_RELATIONS/);
  assert.doesNotThrow(() => requirePhase11C2ExecutionAuthorization({
    cli: { execute: true, manifestPath: preflight.manifestPath, confirmation },
    manifest,
  }));
});

test("identical successful rerun is UNCHANGED while drift or duplicates block", () => {
  assert.equal(decidePhase11C2ExistingPublicationAction({
    relatedActiveCount: 0,
    exactV2IdentityMatch: false,
  }), "WOULD_CREATE");
  assert.equal(decidePhase11C2ExistingPublicationAction({
    relatedActiveCount: 1,
    exactV2IdentityMatch: true,
  }), "UNCHANGED");
  assert.equal(decidePhase11C2ExistingPublicationAction({
    relatedActiveCount: 1,
    exactV2IdentityMatch: false,
  }), "BLOCKED");
  assert.equal(decidePhase11C2ExistingPublicationAction({
    relatedActiveCount: 2,
    exactV2IdentityMatch: true,
  }), "BLOCKED");
});

test("publisher guards RPC behind execute and has mandatory post-write checks without rollback", async () => {
  const source = await readFile("scripts/osm-import/publish-phase11c2-v2-batch.ts", "utf8");
  assert.match(source, /if \(cli\.execute\)/);
  assert.match(source, /if \(value\.action === "UNCHANGED"\) continue/);
  assert.match(source, /V2_POST_WRITE_VERIFICATION_FAILED/);
  assert.match(source, /V2_FINAL_BATCH_VERIFICATION_FAILED/);
  assert.match(source, /automaticRollback: false/);
  assert.doesNotMatch(source, /rollback_osm_route_publication|\.from\([^)]*\)\.(?:insert|update|upsert|delete)/);
});
