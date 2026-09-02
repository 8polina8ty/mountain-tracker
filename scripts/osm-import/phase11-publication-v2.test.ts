import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  Phase10QaHistoryRow,
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import {
  buildPublicationRequestV2,
  createActivityClassificationSnapshot,
  createProvenancePayloadV2,
  mapMountainRouteV2,
  PHASE11_PUBLICATION_CONTRACT_V2,
} from "./phase11-publication-v2.ts";
import {
  createProvenancePayload,
  mapMountainRoute,
  PHASE11_PUBLICATION_CONTRACT,
} from "./phase11-publication.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import { createPhase11C2ACanaryManifest } from "./phase11c2a-v2-canary.ts";

const artifact = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidates.json", "utf8"),
) as PublicationCandidateArtifact;
const manifest = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8"),
) as PublicationCandidateManifest;
const routes = (await readFile("data/osm/alps/routes.jsonl", "utf8"))
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line) as ClassifiableRoute);
const routeMap = new Map(routes.map((value) => [value.sourceId, value]));
const lockedManifest = createPhase11C2ACanaryManifest({
  artifact,
  candidateManifest: manifest,
  routes: routeMap,
  activeRelationIds: new Set(["196164", "20916", "33528", "199145", "207900", "207913"]),
});

const candidate = artifact.candidates.find((value) => value.sourceRelationId === "140270");
const route = routes.find((value) => value.sourceId === "140270");
assert.ok(candidate);
assert.ok(route);
const qaHistory: Phase10QaHistoryRow[] = [{
  id: candidate.qaDecision.version,
  stagingRouteId: candidate.stagingRouteId,
  oldStatus: "PENDING",
  newStatus: "VISUALLY_APPROVED",
  reviewerNote: candidate.qaDecision.reviewerNote,
  reviewerUserId: candidate.qaDecision.reviewerUserId,
  decisionVersion: candidate.qaDecision.version,
  occurredAt: candidate.qaDecision.reviewedAt,
}];

test("relation 140270 keeps summit role and maps activity to via_ferrata", () => {
  const activity = createActivityClassificationSnapshot({ candidate, route });
  assert.equal(candidate.semanticType, "summit_route");
  assert.equal(activity.semanticType, "summit_route");
  assert.equal(activity.routeType, "via_ferrata");
  assert.equal(mapMountainRouteV2(candidate, activity).route_type, "via_ferrata");
});

test("v2 identity is isolated while the deployed v1 mapping remains unchanged", () => {
  const legacy = createProvenancePayload({ artifact, manifest, candidate, qaHistory });
  const next = createProvenancePayloadV2({
    artifact, candidateManifest: manifest, lockedManifest, candidate, qaHistory, route,
  });
  assert.equal(mapMountainRoute(candidate).route_type, "hiking");
  assert.equal(legacy.publication_contract_version, PHASE11_PUBLICATION_CONTRACT);
  assert.equal(next.publication_contract_version, PHASE11_PUBLICATION_CONTRACT_V2);
  assert.notEqual(next.publication_idempotency_key, legacy.publication_idempotency_key);
  assert.notEqual(next.target_payload_hash, legacy.target_payload_hash);
});

test("v2 request carries separately canonicalized activity evidence", () => {
  const request = buildPublicationRequestV2({
    artifact, candidateManifest: manifest, lockedManifest, candidate, qaHistory, route,
  });
  assert.equal(request.mountainRoutePayload.route_type, "via_ferrata");
  assert.equal(
    request.activityClassificationHash,
    request.provenancePayload.activity_classification_hash,
  );
  assert.deepEqual(
    JSON.parse(request.activityClassificationCanonicalJson),
    request.provenancePayload.activity_classification,
  );
});

test("unreviewed mixed activity is blocked from v2 mapping", () => {
  const activity = createActivityClassificationSnapshot({ candidate, route });
  activity.routeType = "mixed";
  activity.manualReviewRequired = true;
  assert.throws(() => mapMountainRouteV2(candidate, activity), /ACTIVITY_MANUAL_REVIEW_REQUIRED/);
});

test("review-only SQL adds v2 without replacing the deployed v1 RPC", async () => {
  const sql = await readFile("database/osm_route_publication_v2.sql", "utf8");
  assert.match(sql, /publish_approved_osm_route_v2\(p_request jsonb\)/);
  assert.match(sql, /v_route_type := v_activity ->> 'routeType'/);
  assert.match(sql, /activity_classification_hash/);
  assert.match(sql, /'hiking', 'mountaineering', 'via_ferrata', 'climbing',[\s\S]*'ski_touring', 'mixed', 'other'/);
  assert.match(sql, /mountain-tracker-osm-publication\/v1[\s\S]*mountain-tracker-osm-publication\/v2/);
  assert.doesNotMatch(sql, /create or replace function public\.publish_approved_osm_route\(p_request jsonb\)/);
  assert.doesNotMatch(sql, /update public\.mountain_routes|delete from public\.mountain_routes/i);
  assert.doesNotMatch(sql, /alter table public\.mountain_routes|alter column route_type|drop constraint mountain_routes/i);
  assert.match(sql, /begin;[\s\S]*commit;/i);
  assert.match(sql, /revoke all on function public\.publish_approved_osm_route_v2[\s\S]*grant execute[\s\S]*to service_role/i);
});

test("v2 SQL matches the authoritative production constraint identities and fails closed", async () => {
  const sql = await readFile("database/osm_route_publication_v2.sql", "utf8");
  assert.match(sql, /constraints\.conname = 'mountain_routes_route_type_check'/);
  assert.match(sql, /v_route_type_constraint_count <> 1/);
  assert.match(sql, /v_route_type_default is distinct from '''hiking''::text'/);
  assert.match(sql, /'climbing', 'hiking', 'mixed', 'mountaineering',[\s\S]*'other', 'ski_touring', 'via_ferrata'/);
  assert.doesNotMatch(sql, /add constraint mountain_routes_route_type|drop constraint mountain_routes_route_type/i);
  assert.match(sql, /drop constraint osm_route_publication_proven_publication_contract_version_check/);
  assert.match(sql, /add constraint osm_route_publication_proven_publication_contract_version_check/);
  assert.equal(
    sql.match(/b83896065baea27a5baf3500ff9934df4a50e41866fc4584f95f206ea1afa391/g)?.length,
    2,
  );
  assert.match(sql, /PHASE11C_CAT_V1_RPC_HASH_DRIFT:/);
  assert.match(sql, /PHASE11C_CAT_V1_RPC_HASH_DRIFT_POST:/);
  assert.match(sql, /publication_contract_version = 'mountain-tracker-osm-publication\/v1'[\s\S]*activity_classification is null[\s\S]*activity_classification_hash is null/);
  assert.match(sql, /activity_classification ->> 'routeType' in \([\s\S]*'ski_touring', 'mixed', 'other'/);
});

test("schema diagnostic is read-only", async () => {
  const sql = await readFile("database/osm_route_publication_v2_preflight.sql", "utf8");
  assert.match(sql, /pg_get_constraintdef/);
  assert.match(sql, /publish_approved_osm_route/);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
});
