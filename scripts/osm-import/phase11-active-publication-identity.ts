import { stableJson } from "./phase10-publication-gate.ts";
import { PHASE11_PUBLICATION_CONTRACT, sha256Stable } from "./phase11-publication.ts";
import { PHASE11_PUBLICATION_CONTRACT_V2 } from "./phase11-publication-v2.ts";

export type SupportedPublicationContract =
  | typeof PHASE11_PUBLICATION_CONTRACT
  | typeof PHASE11_PUBLICATION_CONTRACT_V2;

export interface ActivePublicationIdentityRow {
  mountain_route_id: number;
  staging_route_id: string;
  provider: string;
  canonical_relation_id: string;
  source_relation_ids: unknown;
  source_url: string;
  publication_contract_version: string;
  publication_status: string;
  publication_idempotency_key: string;
  staging_payload_hash: string;
  candidate_content_hash: string;
  candidate_set_content_hash: string;
  candidate_manifest_hash: string;
  dataset_fingerprint: string;
  geometry_hash: string;
  qa_decision_version: number;
  qa_history_hash: string;
  target_payload_hash: string;
  activity_classification: unknown | null;
  activity_classification_hash: string | null;
}

export interface ActiveMountainRouteIdentityRow {
  id: number;
  mountain_id: number;
  source_url: string | null;
  route_type: string;
  is_verified: boolean;
  geojson_url: string | null;
}

export interface ActiveStagingGeometryIdentityRow {
  id: string;
  payload_hash: string;
  geometry_geojson: unknown;
}

export interface ExpectedFrozenPublicationIdentity {
  canonicalRelationId: string;
  mountainId: number;
  publicationContractVersion: SupportedPublicationContract;
  publicationIdempotencyKey: string;
  stagingRouteId: string;
  stagingPayloadHash: string;
  candidateContentHash: string;
  candidateSetContentHash: string;
  candidateManifestHash: string;
  datasetFingerprint: string;
  geometryHash: string;
  qaDecisionVersion: number;
  qaHistoryHash: string;
  targetPayloadHash: string;
  activityClassification: unknown | null;
  activityClassificationHash: string | null;
  sourceRelationIds: string[];
  sourceUrl: string;
  routeType: string;
  geojsonUrl: string;
  geometry: unknown;
}

export interface ActivePublicationIdentityDiagnostic {
  canonicalRelationId: string;
  mountainRouteId: number | null;
  mountainId: number | null;
  expectedMountainId: number;
  publicationGeneration: string | null;
  expectedPublicationGeneration: SupportedPublicationContract;
  storedActiveGeojsonIdentityHash: string | null;
  expectedGeojsonIdentityHash: string;
  geometryHash: string | null;
  canonicalGeometryHash: string | null;
  sourceProvenanceIdentity: {
    provider: string;
    canonicalRelationId: string;
    sourceRelationIds: unknown;
    sourceUrl: string;
    stagingRouteId: string;
    publicationIdempotencyKey: string;
  } | null;
  expectedSourceProvenanceIdentity: {
    provider: "openstreetmap";
    canonicalRelationId: string;
    sourceRelationIds: string[];
    sourceUrl: string;
    stagingRouteId: string;
    publicationIdempotencyKey: string;
  };
  geometryContentIdentical: boolean;
  reasons: string[];
  identityMatch: boolean;
}

function compareReason(
  reasons: string[],
  actual: unknown,
  expected: unknown,
  reason: string,
): void {
  if (stableJson(actual) !== stableJson(expected)) reasons.push(reason);
}

export function validateFrozenActivePublicationIdentity(input: {
  active: ActivePublicationIdentityRow | undefined;
  mountainRoute: ActiveMountainRouteIdentityRow | undefined;
  staging: ActiveStagingGeometryIdentityRow | undefined;
  expected: ExpectedFrozenPublicationIdentity;
}): ActivePublicationIdentityDiagnostic {
  const { active, mountainRoute, staging, expected } = input;
  const storedCanonicalGeometryHash = staging
    ? sha256Stable(staging.geometry_geojson)
    : null;
  const expectedGeometryHash = sha256Stable(expected.geometry);
  const geometryContentIdentical = Boolean(
    staging && stableJson(staging.geometry_geojson) === stableJson(expected.geometry),
  );
  const reasons: string[] = [];

  if (!active) reasons.push("ACTIVE_ROW_MISSING");
  if (!mountainRoute) reasons.push("MOUNTAIN_ROUTE_MISSING");
  if (!staging) reasons.push("STAGING_ROW_MISSING");

  if (active) {
    compareReason(reasons, active.publication_contract_version, expected.publicationContractVersion, "PUBLICATION_GENERATION_MISMATCH");
    compareReason(reasons, active.publication_status, "ACTIVE", "PUBLICATION_STATUS_MISMATCH");
    compareReason(reasons, active.publication_idempotency_key, expected.publicationIdempotencyKey, "PUBLICATION_IDEMPOTENCY_KEY_MISMATCH");
    compareReason(reasons, active.provider, "openstreetmap", "PROVIDER_MISMATCH");
    compareReason(reasons, active.canonical_relation_id, expected.canonicalRelationId, "CANONICAL_RELATION_ID_MISMATCH");
    compareReason(reasons, active.source_relation_ids, expected.sourceRelationIds, "SOURCE_RELATION_IDS_MISMATCH");
    compareReason(reasons, active.source_url, expected.sourceUrl, "PROVENANCE_SOURCE_URL_MISMATCH");
    compareReason(reasons, active.staging_route_id, expected.stagingRouteId, "STAGING_ROUTE_ID_MISMATCH");
    compareReason(reasons, active.staging_payload_hash, expected.stagingPayloadHash, "STAGING_PAYLOAD_HASH_MISMATCH");
    compareReason(reasons, active.candidate_content_hash, expected.candidateContentHash, "CANDIDATE_CONTENT_HASH_MISMATCH");
    compareReason(reasons, active.candidate_set_content_hash, expected.candidateSetContentHash, "CANDIDATE_SET_CONTENT_HASH_MISMATCH");
    compareReason(reasons, active.candidate_manifest_hash, expected.candidateManifestHash, "CANDIDATE_MANIFEST_HASH_MISMATCH");
    compareReason(reasons, active.dataset_fingerprint, expected.datasetFingerprint, "DATASET_FINGERPRINT_MISMATCH");
    compareReason(reasons, active.geometry_hash, expected.geometryHash, "FROZEN_GEOMETRY_HASH_MISMATCH");
    compareReason(reasons, active.qa_decision_version, expected.qaDecisionVersion, "QA_DECISION_VERSION_MISMATCH");
    compareReason(reasons, active.qa_history_hash, expected.qaHistoryHash, "QA_HISTORY_HASH_MISMATCH");
    compareReason(reasons, active.target_payload_hash, expected.targetPayloadHash, "TARGET_PAYLOAD_HASH_MISMATCH");
    compareReason(reasons, active.activity_classification, expected.activityClassification, "ACTIVITY_CLASSIFICATION_MISMATCH");
    compareReason(reasons, active.activity_classification_hash, expected.activityClassificationHash, "ACTIVITY_CLASSIFICATION_HASH_MISMATCH");
  }

  if (active && mountainRoute) {
    compareReason(reasons, mountainRoute.id, active.mountain_route_id, "MOUNTAIN_ROUTE_ID_MISMATCH");
  }
  if (mountainRoute) {
    compareReason(reasons, mountainRoute.mountain_id, expected.mountainId, "MOUNTAIN_ID_MISMATCH");
    compareReason(reasons, mountainRoute.source_url, expected.sourceUrl, "MOUNTAIN_ROUTE_SOURCE_URL_MISMATCH");
    compareReason(reasons, mountainRoute.route_type, expected.routeType, "MOUNTAIN_ROUTE_TYPE_MISMATCH");
    compareReason(reasons, mountainRoute.is_verified, true, "MOUNTAIN_ROUTE_NOT_VERIFIED");
    compareReason(reasons, mountainRoute.geojson_url, expected.geojsonUrl, "MOUNTAIN_ROUTE_GEOJSON_URL_MISMATCH");
  }
  if (active && staging) {
    compareReason(reasons, staging.id, active.staging_route_id, "ACTIVE_STAGING_ROUTE_ID_MISMATCH");
    compareReason(reasons, staging.payload_hash, active.staging_payload_hash, "ACTIVE_STAGING_PAYLOAD_HASH_MISMATCH");
    compareReason(reasons, storedCanonicalGeometryHash, active.geometry_hash, "STORED_GEOJSON_HASH_DIFFERS_FROM_FROZEN_GEOMETRY_HASH");
  }
  compareReason(reasons, expectedGeometryHash, expected.geometryHash, "EXPECTED_GEOMETRY_HASH_DIFFERS_FROM_FROZEN_GEOMETRY_HASH");
  if (staging && !geometryContentIdentical) reasons.push("GEOMETRY_CONTENT_MISMATCH");

  return {
    canonicalRelationId: expected.canonicalRelationId,
    mountainRouteId: active?.mountain_route_id ?? null,
    mountainId: mountainRoute?.mountain_id ?? null,
    expectedMountainId: expected.mountainId,
    publicationGeneration: active?.publication_contract_version ?? null,
    expectedPublicationGeneration: expected.publicationContractVersion,
    storedActiveGeojsonIdentityHash: storedCanonicalGeometryHash,
    expectedGeojsonIdentityHash: expectedGeometryHash,
    geometryHash: active?.geometry_hash ?? null,
    canonicalGeometryHash: storedCanonicalGeometryHash,
    sourceProvenanceIdentity: active ? {
      provider: active.provider,
      canonicalRelationId: active.canonical_relation_id,
      sourceRelationIds: active.source_relation_ids,
      sourceUrl: active.source_url,
      stagingRouteId: active.staging_route_id,
      publicationIdempotencyKey: active.publication_idempotency_key,
    } : null,
    expectedSourceProvenanceIdentity: {
      provider: "openstreetmap",
      canonicalRelationId: expected.canonicalRelationId,
      sourceRelationIds: expected.sourceRelationIds,
      sourceUrl: expected.sourceUrl,
      stagingRouteId: expected.stagingRouteId,
      publicationIdempotencyKey: expected.publicationIdempotencyKey,
    },
    geometryContentIdentical,
    reasons,
    identityMatch: reasons.length === 0,
  };
}

export function validateFrozenActivePublicationBaseline(input: {
  activeRows: ActivePublicationIdentityRow[];
  mountainRoutes: ActiveMountainRouteIdentityRow[];
  stagingRows: ActiveStagingGeometryIdentityRow[];
  expected: ExpectedFrozenPublicationIdentity[];
}): ActivePublicationIdentityDiagnostic[] {
  const activeByRelation = new Map<string, ActivePublicationIdentityRow>();
  for (const row of input.activeRows) {
    if (activeByRelation.has(row.canonical_relation_id)) {
      throw new Error(`DUPLICATE_ACTIVE_RELATION:${row.canonical_relation_id}`);
    }
    activeByRelation.set(row.canonical_relation_id, row);
  }
  const mountainRouteById = new Map(input.mountainRoutes.map((row) => [row.id, row]));
  const stagingById = new Map(input.stagingRows.map((row) => [row.id, row]));
  const expectedRelations = new Set<string>();
  return input.expected.map((expected) => {
    if (expectedRelations.has(expected.canonicalRelationId)) {
      throw new Error(`DUPLICATE_EXPECTED_RELATION:${expected.canonicalRelationId}`);
    }
    expectedRelations.add(expected.canonicalRelationId);
    const active = activeByRelation.get(expected.canonicalRelationId);
    return validateFrozenActivePublicationIdentity({
      active,
      mountainRoute: active ? mountainRouteById.get(active.mountain_route_id) : undefined,
      staging: active ? stagingById.get(active.staging_route_id) : undefined,
      expected,
    });
  });
}

export function assertFrozenActivePublicationBaseline(input: Parameters<typeof validateFrozenActivePublicationBaseline>[0]): ActivePublicationIdentityDiagnostic[] {
  const diagnostics = validateFrozenActivePublicationBaseline(input);
  const incompatible = diagnostics.filter((diagnostic) => !diagnostic.identityMatch);
  if (incompatible.length > 0) {
    const error = new Error("ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE");
    Object.assign(error, { diagnostics: incompatible });
    throw error;
  }
  return diagnostics;
}
