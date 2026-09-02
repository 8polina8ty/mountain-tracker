import assert from "node:assert/strict";
import test from "node:test";

import { PHASE11_PUBLICATION_CONTRACT } from "./phase11-publication.ts";
import { PHASE11_PUBLICATION_CONTRACT_V2 } from "./phase11-publication-v2.ts";
import {
  assertFrozenActivePublicationBaseline,
  validateFrozenActivePublicationIdentity,
  type ActiveMountainRouteIdentityRow,
  type ActivePublicationIdentityRow,
  type ActiveStagingGeometryIdentityRow,
  type ExpectedFrozenPublicationIdentity,
  type SupportedPublicationContract,
} from "./phase11-active-publication-identity.ts";
import { sha256Stable } from "./phase11-publication.ts";

function fixture(
  publicationContractVersion: SupportedPublicationContract,
  index = 1,
): {
  active: ActivePublicationIdentityRow;
  mountainRoute: ActiveMountainRouteIdentityRow;
  staging: ActiveStagingGeometryIdentityRow;
  expected: ExpectedFrozenPublicationIdentity;
} {
  const canonicalRelationId = String(100_000 + index);
  const mountainRouteId = 1_000 + index;
  const mountainId = 2_000 + index;
  const stagingRouteId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const sourceUrl = `https://www.openstreetmap.org/relation/${canonicalRelationId}`;
  const geojsonUrl = `/api/osm-route-publications/openstreetmap/relation/${canonicalRelationId}/geojson`;
  const geometry = {
    type: "LineString",
    coordinates: [[10 + index / 1_000, 46], [10.5, 46.5]],
  };
  const geometryHash = sha256Stable(geometry);
  const isV2 = publicationContractVersion === PHASE11_PUBLICATION_CONTRACT_V2;
  const activityClassification = isV2
    ? { schemaVersion: 1, routeType: "hiking", manualReviewRequired: false }
    : null;
  const activityClassificationHash = isV2
    ? sha256Stable(activityClassification)
    : null;
  const publicationIdempotencyKey =
    `openstreetmap:relation:${canonicalRelationId}:mountain-tracker-osm-route/v1:${publicationContractVersion}`;
  const expected: ExpectedFrozenPublicationIdentity = {
    canonicalRelationId,
    mountainId,
    publicationContractVersion,
    publicationIdempotencyKey,
    stagingRouteId,
    stagingPayloadHash: `staging-${index}`,
    candidateContentHash: `candidate-${index}`,
    candidateSetContentHash: `candidate-set-${index}`,
    candidateManifestHash: `manifest-${index}`,
    datasetFingerprint: `dataset-${index}`,
    geometryHash,
    qaDecisionVersion: 1,
    qaHistoryHash: `qa-history-${index}`,
    targetPayloadHash: `target-${index}`,
    activityClassification,
    activityClassificationHash,
    sourceRelationIds: [canonicalRelationId],
    sourceUrl,
    routeType: "hiking",
    geojsonUrl,
    geometry,
  };
  return {
    expected,
    active: {
      mountain_route_id: mountainRouteId,
      staging_route_id: stagingRouteId,
      provider: "openstreetmap",
      canonical_relation_id: canonicalRelationId,
      source_relation_ids: [canonicalRelationId],
      source_url: sourceUrl,
      publication_contract_version: publicationContractVersion,
      publication_status: "ACTIVE",
      publication_idempotency_key: publicationIdempotencyKey,
      staging_payload_hash: expected.stagingPayloadHash,
      candidate_content_hash: expected.candidateContentHash,
      candidate_set_content_hash: expected.candidateSetContentHash,
      candidate_manifest_hash: expected.candidateManifestHash,
      dataset_fingerprint: expected.datasetFingerprint,
      geometry_hash: geometryHash,
      qa_decision_version: expected.qaDecisionVersion,
      qa_history_hash: expected.qaHistoryHash,
      target_payload_hash: expected.targetPayloadHash,
      activity_classification: activityClassification,
      activity_classification_hash: activityClassificationHash,
    },
    mountainRoute: {
      id: mountainRouteId,
      mountain_id: mountainId,
      source_url: sourceUrl,
      route_type: "hiking",
      is_verified: true,
      geojson_url: geojsonUrl,
    },
    staging: {
      id: stagingRouteId,
      payload_hash: expected.stagingPayloadHash,
      geometry_geojson: structuredClone(geometry),
    },
  };
}

function validate(value: ReturnType<typeof fixture>) {
  return validateFrozenActivePublicationIdentity(value);
}

test("valid legacy v1 ACTIVE route passes its frozen v1 identity contract", () => {
  const result = validate(fixture(PHASE11_PUBLICATION_CONTRACT));
  assert.equal(result.identityMatch, true);
  assert.deepEqual(result.reasons, []);
});

test("modified legacy v1 coordinates fail closed", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT);
  value.staging.geometry_geojson = { type: "LineString", coordinates: [[10.001, 46], [10.6, 46.5]] };
  const result = validate(value);
  assert.equal(result.identityMatch, false);
  assert.equal(result.geometryContentIdentical, false);
  assert.ok(result.reasons.includes("GEOMETRY_CONTENT_MISMATCH"));
  assert.ok(result.reasons.includes("STORED_GEOJSON_HASH_DIFFERS_FROM_FROZEN_GEOMETRY_HASH"));
});

test("valid v2 ACTIVE route passes its frozen v2 identity contract", () => {
  const result = validate(fixture(PHASE11_PUBLICATION_CONTRACT_V2));
  assert.equal(result.identityMatch, true);
  assert.deepEqual(result.reasons, []);
});

test("modified v2 coordinates fail closed", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT_V2);
  value.staging.geometry_geojson = { type: "LineString", coordinates: [[10.001, 46], [10.5, 46.6]] };
  const result = validate(value);
  assert.equal(result.identityMatch, false);
  assert.equal(result.geometryContentIdentical, false);
  assert.ok(result.reasons.includes("GEOMETRY_CONTENT_MISMATCH"));
});

test("GeoJSON property ordering alone does not create a false mismatch", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT_V2);
  const coordinates = (value.expected.geometry as { coordinates: number[][] }).coordinates;
  value.expected.geometry = { coordinates, type: "LineString" };
  const result = validate(value);
  assert.equal(result.identityMatch, true);
  assert.equal(result.geometryContentIdentical, true);
});

test("wrong canonical relation ID fails", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT);
  value.active.canonical_relation_id = "999999";
  const result = validate(value);
  assert.equal(result.identityMatch, false);
  assert.ok(result.reasons.includes("CANONICAL_RELATION_ID_MISMATCH"));
});

test("wrong mountain ID fails", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT_V2);
  value.mountainRoute.mountain_id += 1;
  const result = validate(value);
  assert.equal(result.identityMatch, false);
  assert.ok(result.reasons.includes("MOUNTAIN_ID_MISMATCH"));
});

test("wrong frozen geometry hash fails", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT_V2);
  value.active.geometry_hash = "0".repeat(64);
  const result = validate(value);
  assert.equal(result.identityMatch, false);
  assert.ok(result.reasons.includes("FROZEN_GEOMETRY_HASH_MISMATCH"));
  assert.ok(result.reasons.includes("STORED_GEOJSON_HASH_DIFFERS_FROM_FROZEN_GEOMETRY_HASH"));
});

test("mixed six-v1 plus twelve-v2 ACTIVE baseline validates all 18 routes", () => {
  const values = Array.from({ length: 18 }, (_, index) =>
    fixture(index < 6 ? PHASE11_PUBLICATION_CONTRACT : PHASE11_PUBLICATION_CONTRACT_V2, index + 1));
  const diagnostics = assertFrozenActivePublicationBaseline({
    activeRows: values.map((value) => value.active),
    mountainRoutes: values.map((value) => value.mountainRoute),
    stagingRows: values.map((value) => value.staging),
    expected: values.map((value) => value.expected),
  });
  assert.equal(diagnostics.length, 18);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.identityMatch));
});

test("real baseline drift remains fail-closed with ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE", () => {
  const value = fixture(PHASE11_PUBLICATION_CONTRACT_V2);
  value.staging.geometry_geojson = { type: "LineString", coordinates: [[0, 0], [1, 1]] };
  assert.throws(
    () => assertFrozenActivePublicationBaseline({
      activeRows: [value.active],
      mountainRoutes: [value.mountainRoute],
      stagingRows: [value.staging],
      expected: [value.expected],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE");
      assert.ok("diagnostics" in error);
      return true;
    },
  );
});
