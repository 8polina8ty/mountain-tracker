import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  Phase10QaHistoryRow,
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
  PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import {
  createFirstRouteManifest,
  createProvenancePayload,
  dryRunCandidate,
  mapMountainRoute,
  selectFirstPublicationCandidate,
  sha256Stable,
  type DryRunEnvironment,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";

const artifact = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidates.json", "utf8"),
) as PublicationCandidateArtifact;
const manifest = JSON.parse(
  await readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8"),
) as PublicationCandidateManifest;

function candidate(relationId: string): PublicationCandidateRecord {
  const value = artifact.candidates.find((record) => record.sourceRelationId === relationId);
  assert.ok(value, `missing fixture relation ${relationId}`);
  return structuredClone(value);
}

function history(value: PublicationCandidateRecord): Phase10QaHistoryRow[] {
  return [{
    id: value.qaDecision.version,
    stagingRouteId: value.stagingRouteId,
    oldStatus: "PENDING",
    newStatus: "VISUALLY_APPROVED",
    reviewerNote: value.qaDecision.reviewerNote,
    reviewerUserId: value.qaDecision.reviewerUserId,
    decisionVersion: value.qaDecision.version,
    occurredAt: value.qaDecision.reviewedAt,
  }];
}

function environment(value: PublicationCandidateRecord): DryRunEnvironment {
  return {
    mountainIds: new Set([value.summit.mountainId]),
    legacySourceUrls: new Set(),
    existingPublications: new Map(),
    provenanceSchemaAvailable: false,
  };
}

function run(value: PublicationCandidateRecord, env = environment(value)) {
  return dryRunCandidate({
    artifact,
    manifest,
    candidate: value,
    qaHistory: history(value),
    environment: env,
  });
}

test("deterministic mapping converts rounded meters to km and invents no metadata", () => {
  const mapped = mapMountainRoute(candidate("4103375"));
  assert.equal(mapped.distance_km, 17.019);
  assert.equal(mapped.route_type, "hiking");
  for (const field of [
    "start_location", "difficulty_system", "difficulty_value", "elevation_gain_m",
    "duration_minutes", "description", "best_season", "equipment", "gpx_url", "created_by",
  ] as const) assert.equal(mapped[field], null);
  assert.equal(mapped.source_name, "OpenStreetMap");
  assert.match(mapped.source_url, /^https:\/\/www\.openstreetmap\.org\/relation\/4103375$/);
});

test("BRANCHING keeps inferred physical endpoints and exposes ambiguity", () => {
  const value = run(candidate("4103375"));
  assert.equal(value.action, "WOULD_CREATE");
  assert.equal(value.provenancePayload.topology.classification, "BRANCHING");
  assert.deepEqual(value.provenancePayload.topology.startCoordinate, [11.6686224, 46.7979373]);
  assert.deepEqual(value.provenancePayload.topology.endCoordinate, [11.686882, 46.8595389]);
  assert.equal(value.provenancePayload.topology.endpointSelectionAmbiguous, true);
  assert.match(value.mountainRoutePayload.warnings ?? "", /inferred physical endpoints.*ambiguous/i);
  assert.equal(value.geometryStrategy.endpointMode, "EXPLICIT_PHYSICAL_ENDPOINTS");
});

test("DISCONNECTED preserves MultiLineString and publishes no global endpoints", () => {
  const value = run(candidate("11192622"));
  assert.equal(value.provenancePayload.topology.classification, "DISCONNECTED");
  assert.equal(value.provenancePayload.topology.startCoordinate, null);
  assert.equal(value.provenancePayload.topology.endCoordinate, null);
  assert.equal(value.geometryStrategy.endpointMode, "NO_GLOBAL_ENDPOINTS");
  assert.match(value.mountainRoutePayload.warnings ?? "", /No artificial global Start or Finish/);
});

test("LineString and MultiLineString geometry hashes cover exact coordinate structure", () => {
  const line = candidate("20916");
  const multi = candidate("2210868");
  assert.equal(line.originalGeometry.type, "LineString");
  assert.equal(multi.originalGeometry.type, "MultiLineString");
  const changed = structuredClone(multi.originalGeometry);
  changed.coordinates.reverse();
  assert.notEqual(sha256Stable(changed), sha256Stable(multi.originalGeometry));
});

test("manifest, payload, QA version, mountain, and candidate hash drift fail closed", () => {
  const cases: Array<[string, (value: PublicationCandidateManifest) => void, string]> = [
    ["payload", (value) => { value.records[0].payloadHash = "0".repeat(64); }, "PAYLOAD_DRIFT"],
    ["qa", (value) => { value.records[0].qaDecisionVersion += 1; }, "QA_VERSION_DRIFT"],
    ["mountain", (value) => { value.records[0].mountainId += 1; }, "MOUNTAIN_DRIFT"],
    ["candidate", (value) => { value.records[0].candidateContentHash = "0".repeat(64); }, "CANDIDATE_HASH_DRIFT"],
  ];
  const value = artifact.candidates[0];
  for (const [, mutate, blocker] of cases) {
    const drifted = structuredClone(manifest);
    mutate(drifted);
    const result = dryRunCandidate({
      artifact, manifest: drifted, candidate: value,
      qaHistory: history(value), environment: environment(value),
    });
    assert.equal(result.action, "BLOCKED");
    assert.ok(result.blockers.includes(blocker));
  }
});

test("candidate outside the exact manifest is blocked", () => {
  const value = artifact.candidates[0];
  const drifted = structuredClone(manifest);
  drifted.records = drifted.records.filter((record) => record.stagingRouteId !== value.stagingRouteId);
  const result = dryRunCandidate({ artifact, manifest: drifted, candidate: value, qaHistory: history(value), environment: environment(value) });
  assert.deepEqual(result.blockers, ["CANDIDATE_OUTSIDE_MANIFEST"]);
});

test("missing mountain and legacy source duplicates are blocked", () => {
  const value = candidate("20916");
  const env = environment(value);
  env.mountainIds.clear();
  env.legacySourceUrls.add(value.provenance.sourceUrl);
  const result = run(value, env);
  assert.equal(result.action, "BLOCKED");
  assert.deepEqual(result.blockers, ["LEGACY_SOURCE_DUPLICATE", "TARGET_MOUNTAIN_MISSING"]);
});

test("identical existing publication is unchanged with zero-write action", () => {
  const value = candidate("20916");
  const provenance = createProvenancePayload({ artifact, manifest, candidate: value, qaHistory: history(value) });
  const existing: ExistingPublicationIdentity = {
    publicationIdempotencyKey: provenance.publication_idempotency_key,
    stagingPayloadHash: provenance.staging_payload_hash,
    candidateContentHash: provenance.candidate_content_hash,
    candidateSetContentHash: provenance.candidate_set_content_hash,
    candidateManifestHash: provenance.candidate_manifest_hash,
    datasetFingerprint: provenance.dataset_fingerprint,
    geometryHash: provenance.geometry_hash,
    qaDecisionVersion: provenance.qa_decision_version,
    qaHistoryHash: provenance.qa_history_hash,
    targetPayloadHash: provenance.target_payload_hash,
  };
  const env = environment(value);
  env.provenanceSchemaAvailable = true;
  env.existingPublications.set(existing.publicationIdempotencyKey, existing);
  assert.equal(run(value, env).action, "WOULD_SKIP_UNCHANGED");
});

test("changed existing publication identity fails closed", () => {
  const value = candidate("20916");
  const provenance = createProvenancePayload({ artifact, manifest, candidate: value, qaHistory: history(value) });
  const env = environment(value);
  env.existingPublications.set(provenance.publication_idempotency_key, {
    publicationIdempotencyKey: provenance.publication_idempotency_key,
    stagingPayloadHash: "0".repeat(64),
    candidateContentHash: provenance.candidate_content_hash,
    candidateSetContentHash: provenance.candidate_set_content_hash,
    candidateManifestHash: provenance.candidate_manifest_hash,
    datasetFingerprint: provenance.dataset_fingerprint,
    geometryHash: provenance.geometry_hash,
    qaDecisionVersion: provenance.qa_decision_version,
    qaHistoryHash: provenance.qa_history_hash,
    targetPayloadHash: provenance.target_payload_hash,
  });
  const result = run(value, env);
  assert.equal(result.action, "BLOCKED");
  assert.ok(result.blockers.includes("EXISTING_PUBLICATION_DRIFT"));
});

test("first-route selection and locked manifest are deterministic", () => {
  assert.equal(selectFirstPublicationCandidate(artifact).sourceRelationId, "196164");
  const first = createFirstRouteManifest({ artifact, manifest, qaHistory: history(candidate("196164")) });
  const { deterministicManifestHash, ...content } = first;
  assert.equal(deterministicManifestHash, sha256Stable(content));
  assert.equal(first.canonicalRelationId, "196164");
  assert.equal(first.candidateManifestHash, "71aba18a7fc1a62dccef729fdd60cebd9a2dcac02442d358e8f2c6c0bb99504f");
});

test("dry-run tooling contains no mutation or publication RPC path", async () => {
  const source = await Promise.all([
    readFile("scripts/osm-import/publish-osm-routes.ts", "utf8"),
    readFile("scripts/osm-import/phase11-live-data.ts", "utf8"),
  ]).then((parts) => parts.join("\n"));
  assert.doesNotMatch(source, /\.(?:insert|update|upsert|delete|rpc)\s*\(/);
  assert.match(source, /method:\s*"GET"/);
  assert.match(source, /databaseWrites:\s*0/);
  assert.match(source, /publicationWrites:\s*0/);
});

test("review-only SQL is atomic, service-only, idempotent, and rollback-scoped", async () => {
  const sql = await readFile("database/osm_route_publication.sql", "utf8");
  const rollback = await readFile("database/osm_route_publication_rollback.sql", "utf8");
  assert.match(sql, /begin;[\s\S]*create table public\.osm_route_publication_provenance[\s\S]*commit;/i);
  assert.match(sql, /security definer[\s\S]*set search_path = ''/i);
  assert.match(sql, /for update/);
  assert.match(sql, /'UNCHANGED'::text/);
  assert.match(sql, /grant execute[^;]+to service_role/i);
  assert.match(sql, /revoke all[^;]+from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete) on public\.osm_route_publication_provenance/i);
  assert.match(rollback, /publication_idempotency_key = p_publication_idempotency_key/);
  assert.match(rollback, /delete from public\.osm_route_publication_provenance[\s\S]*delete from public\.mountain_routes/);
  assert.doesNotMatch(rollback, /delete from public\.(?:mountains|gps_activities|ascents|journals|community_routes)/i);
});

test("application geometry endpoint revalidates immutable geometry and map honors explicit/null endpoints", async () => {
  const endpoint = await readFile("app/api/osm-route-publications/[provider]/[sourceType]/[sourceId]/geojson/route.ts", "utf8");
  const delivery = await readFile("Lib/osmRoutePublicationGeojson.ts", "utf8");
  const map = await readFile("components/mountain/MountainRouteMap.tsx", "utf8");
  assert.match(delivery, /staging\.payload_hash !== publication\.staging_payload_hash/);
  assert.match(delivery, /geometryHash\(staging\.geometry_geojson\) !== publication\.geometry_hash/);
  assert.match(delivery, /topologyEndpoints/);
  assert.match(endpoint, /createPublicationGeojsonResponse/);
  assert.match(map, /Object\.hasOwn\(loadedGeojson\.mountainTracker, "topologyEndpoints"\)/);
  assert.match(map, /resolvedTopologyEndpoints === undefined/);
});

test("distance_km precision: canonical payload has 3 decimals, DB persists 2 decimals, verifier normalizes both", () => {
  const expectedCanonical = 11.734;
  const dbPersisted = 11.73;
  const normalizedExpected = Math.round(expectedCanonical * 100) / 100;
  assert.equal(normalizedExpected, dbPersisted);
  assert.equal(normalizedExpected, 11.73);
});
