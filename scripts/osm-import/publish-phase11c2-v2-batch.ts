import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  stableJson,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  buildPublicationRequestV2,
  PHASE11_PUBLICATION_CONTRACT_V2,
  type Phase11PublicationRequestV2,
} from "./phase11-publication-v2.ts";
import {
  createProvenancePayload,
  mapMountainRoute,
  publicationIdentityMatches,
  sha256Stable,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";
import {
  createPhase11C2ACanaryManifest,
  verifyPhase11C2ACanaryManifest,
  type Phase11C2ACanaryManifest,
} from "./phase11c2a-v2-canary.ts";
import {
  PHASE11C2_BASELINE_ACTIVE_RELATION_IDS,
  PHASE11C2_V2_MANIFEST_PATH,
  createPhase11C2V2BatchManifest,
  decidePhase11C2ExistingPublicationAction,
  parsePhase11C2CliArguments,
  phase11C2EligibilityFailures,
  requirePhase11C2ExecutionAuthorization,
  verifyPhase11C2V2BatchManifest,
  type Phase11C2V2BatchManifest,
} from "./phase11c2-v2-batch.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const V1_RELATION_IDS = ["196164", "20916", "33528", "199145", "207900", "207913"] as const;
const V2_CANARY_RELATION_IDS = ["361148", "140270"] as const;
const V2_CANARY_MANIFEST_PATH = "data/osm/alps/publication/phase11c2a-v2-canary.json";
const RPC_NAME = "publish_approved_osm_route_v2";

type ActiveRow = {
  mountain_route_id: number;
  staging_route_id: string;
  canonical_relation_id: string;
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
};

type MountainRouteRow = {
  id: number;
  source_url: string | null;
  route_type: string;
  is_verified: boolean;
  geojson_url: string | null;
};

type StagingRow = {
  id: string;
  payload_hash: string;
  geometry_geojson: unknown;
};

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

loadEnvironment(await readFile(".env.local", "utf8"));
const configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const configuredServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
if (!configuredSupabaseUrl || !configuredServiceKey) {
  throw new Error("Missing Phase 11 read-only/service credentials.");
}
const supabaseUrl: string = configuredSupabaseUrl;
const serviceKey: string = configuredServiceKey;

async function restGet(path: string): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: serviceKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`READ_ONLY_QUERY_FAILED:${response.status}:${path}`);
  return response.json();
}

async function loadActiveRows(): Promise<ActiveRow[]> {
  return restGet(
    "osm_route_publication_provenance?select=mountain_route_id,staging_route_id,canonical_relation_id,publication_contract_version,publication_status,publication_idempotency_key,staging_payload_hash,candidate_content_hash,candidate_set_content_hash,candidate_manifest_hash,dataset_fingerprint,geometry_hash,qa_decision_version,qa_history_hash,target_payload_hash,activity_classification,activity_classification_hash&publication_status=eq.ACTIVE&order=mountain_route_id.asc",
  ) as Promise<ActiveRow[]>;
}

async function loadSchemaSupport(): Promise<{ v2RpcAvailable: boolean; v2ColumnsAvailable: boolean }> {
  const response = await fetch(`${supabaseUrl}/rest/v1/`, {
    method: "GET",
    headers: { Accept: "application/openapi+json", apikey: serviceKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OPENAPI_QUERY_FAILED:${response.status}`);
  const value = await response.json() as {
    paths?: Record<string, unknown>;
    definitions?: Record<string, { properties?: Record<string, unknown> }>;
  };
  const properties = value.definitions?.osm_route_publication_provenance?.properties ?? {};
  return {
    v2RpcAvailable: value.paths?.["/rpc/publish_approved_osm_route_v2"] !== undefined,
    v2ColumnsAvailable:
      properties.activity_classification !== undefined &&
      properties.activity_classification_hash !== undefined,
  };
}

function identity(row: ActiveRow): ExistingPublicationIdentity {
  return {
    publicationIdempotencyKey: row.publication_idempotency_key,
    stagingPayloadHash: row.staging_payload_hash,
    candidateContentHash: row.candidate_content_hash,
    candidateSetContentHash: row.candidate_set_content_hash,
    candidateManifestHash: row.candidate_manifest_hash,
    datasetFingerprint: row.dataset_fingerprint,
    geometryHash: row.geometry_hash,
    qaDecisionVersion: row.qa_decision_version,
    qaHistoryHash: row.qa_history_hash,
    targetPayloadHash: row.target_payload_hash,
  };
}

function v2IdentityMatches(row: ActiveRow, request: Phase11PublicationRequestV2): boolean {
  const expected = request.provenancePayload;
  return row.publication_contract_version === PHASE11_PUBLICATION_CONTRACT_V2 &&
    row.publication_status === "ACTIVE" &&
    row.publication_idempotency_key === expected.publication_idempotency_key &&
    row.staging_payload_hash === expected.staging_payload_hash &&
    row.candidate_content_hash === expected.candidate_content_hash &&
    row.candidate_set_content_hash === expected.candidate_set_content_hash &&
    row.candidate_manifest_hash === expected.candidate_manifest_hash &&
    row.dataset_fingerprint === expected.dataset_fingerprint &&
    row.geometry_hash === expected.geometry_hash &&
    row.qa_decision_version === expected.qa_decision_version &&
    row.qa_history_hash === expected.qa_history_hash &&
    row.target_payload_hash === expected.target_payload_hash &&
    row.activity_classification_hash === expected.activity_classification_hash &&
    stableJson(row.activity_classification) === stableJson(expected.activity_classification);
}

function assertAllowedActiveSet(activeRows: ActiveRow[], batch: Phase11C2V2BatchManifest): void {
  const baseline = new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS);
  const batchIds = new Set(batch.records.map((record) => record.canonicalRouteSourceId));
  const seen = new Set<string>();
  for (const row of activeRows) {
    if (seen.has(row.canonical_relation_id)) {
      throw new Error(`DUPLICATE_ACTIVE_RELATION:${row.canonical_relation_id}`);
    }
    seen.add(row.canonical_relation_id);
    if (!baseline.has(row.canonical_relation_id as (typeof PHASE11C2_BASELINE_ACTIVE_RELATION_IDS)[number]) &&
        !batchIds.has(row.canonical_relation_id)) {
      throw new Error(`UNEXPECTED_ACTIVE_RELATION:${row.canonical_relation_id}`);
    }
  }
  for (const relationId of baseline) {
    if (!seen.has(relationId)) throw new Error(`BASELINE_ACTIVE_RELATION_MISSING:${relationId}`);
  }
}

function warnings(candidate: PublicationCandidateArtifact["candidates"][number]): string[] {
  return [
    ...candidate.warningState.activeFlags,
    ...candidate.warningState.reviewedFlags,
    ...candidate.auditFlags,
    ...(candidate.topology.endpointSelectionWarning
      ? [candidate.topology.endpointSelectionWarning]
      : []),
  ];
}

const cli = parsePhase11C2CliArguments(process.argv.slice(2));
const [
  storedArtifact,
  storedCandidateManifest,
  providedBatch,
  providedCanary,
  routeText,
  liveInput,
  activeRows,
  schemaSupport,
] = await Promise.all([
  readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile(cli.manifestPath, "utf8").then(
    (value) => JSON.parse(value) as Phase11C2V2BatchManifest,
  ),
  readFile(V2_CANARY_MANIFEST_PATH, "utf8").then(
    (value) => JSON.parse(value) as Phase11C2ACanaryManifest,
  ),
  readFile("data/osm/alps/routes.jsonl", "utf8"),
  loadPublicationGateInput(),
  loadActiveRows(),
  loadSchemaSupport(),
]);

const liveArtifact = buildPublicationCandidateArtifact(liveInput);
const liveCandidateManifest = buildPublicationCandidateManifest(liveArtifact);
verifyPublicationCandidateDocuments({
  expectedArtifact: storedArtifact,
  expectedManifest: storedCandidateManifest,
  liveArtifact,
  liveManifest: liveCandidateManifest,
});
const routes = new Map(routeText.trim().split(/\r?\n/).map((line) => {
  const route = JSON.parse(line) as ClassifiableRoute;
  return [route.sourceId, route] as const;
}));

const expectedBatch = createPhase11C2V2BatchManifest({
  artifact: liveArtifact,
  candidateManifest: liveCandidateManifest,
  qaHistory: liveInput.qaHistory,
  routes,
  activeRelationIds: new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS),
});
verifyPhase11C2V2BatchManifest({ provided: providedBatch, expected: expectedBatch });
requirePhase11C2ExecutionAuthorization({ cli, manifest: providedBatch });

const expectedCanary = createPhase11C2ACanaryManifest({
  artifact: liveArtifact,
  candidateManifest: liveCandidateManifest,
  routes,
  activeRelationIds: new Set(V1_RELATION_IDS),
});
verifyPhase11C2ACanaryManifest({ provided: providedCanary, expected: expectedCanary });
if (
  providedCanary.records.length !== V2_CANARY_RELATION_IDS.length ||
  V2_CANARY_RELATION_IDS.some((relationId) =>
    !providedCanary.records.some((record) => record.canonicalRouteSourceId === relationId))
) {
  throw new Error("V2_CANARY_RELATION_SET_DRIFT");
}
assertAllowedActiveSet(activeRows, providedBatch);

const candidateByRelation = new Map(
  liveArtifact.candidates.map((candidate) => [candidate.canonicalRouteSourceId, candidate]),
);
const candidateByStaging = new Map(
  liveArtifact.candidates.map((candidate) => [candidate.stagingRouteId, candidate]),
);

const v1IdentityChecks = V1_RELATION_IDS.map((relationId) => {
  const row = activeRows.find((value) => value.canonical_relation_id === relationId);
  const candidate = candidateByRelation.get(relationId);
  if (!row || !candidate) throw new Error(`ACTIVE_V1_INPUT_MISSING:${relationId}`);
  const expected = createProvenancePayload({
    artifact: liveArtifact,
    manifest: liveCandidateManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
  });
  const identityMatch =
    row.publication_contract_version === "mountain-tracker-osm-publication/v1" &&
    row.publication_idempotency_key === expected.publication_idempotency_key &&
    row.activity_classification === null &&
    row.activity_classification_hash === null &&
    publicationIdentityMatches(identity(row), expected);
  return { relationId, mountainRouteId: row.mountain_route_id, identityMatch };
});
if (v1IdentityChecks.some((check) => !check.identityMatch)) {
  throw new Error("ACTIVE_V1_IDENTITY_DRIFT");
}

const v2CanaryIdentityChecks = providedCanary.records.map((record) => {
  const row = activeRows.find((value) => value.canonical_relation_id === record.canonicalRouteSourceId);
  const candidate = candidateByStaging.get(record.stagingRouteId);
  const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
  if (!row || !candidate || !route) throw new Error(`ACTIVE_V2_CANARY_INPUT_MISSING:${record.sourceRelationId}`);
  const request = buildPublicationRequestV2({
    artifact: liveArtifact,
    candidateManifest: liveCandidateManifest,
    lockedManifest: providedCanary,
    candidate,
    qaHistory: liveInput.qaHistory,
    route,
  });
  return {
    relationId: record.canonicalRouteSourceId,
    mountainRouteId: row.mountain_route_id,
    identityMatch: v2IdentityMatches(row, request),
    request,
  };
});
if (v2CanaryIdentityChecks.some((check) => !check.identityMatch)) {
  throw new Error("ACTIVE_V2_CANARY_IDENTITY_DRIFT");
}

const [mountainRouteRows, targetMountainRows, baselineStagingRows] = await Promise.all([
  restGet("mountain_routes?select=id,source_url,route_type,is_verified,geojson_url&order=id.asc") as Promise<MountainRouteRow[]>,
  restGet(
    `mountains?select=id&id=in.(${providedBatch.records.map((record) => record.mountainId).join(",")})`,
  ) as Promise<Array<{ id: number }>>,
  restGet(
    `osm_route_import_staging?select=id,payload_hash,geometry_geojson&id=in.(${activeRows
      .filter((row) => PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.some((id) => id === row.canonical_relation_id))
      .map((row) => row.staging_route_id).join(",")})`,
  ) as Promise<StagingRow[]>,
]);
const mountainRouteById = new Map(mountainRouteRows.map((row) => [row.id, row]));
const stagingById = new Map(baselineStagingRows.map((row) => [row.id, row]));

const baselineTargetByRelation = new Map<string, { route_type: string; source_url: string; geojson_url: string }>();
for (const relationId of V1_RELATION_IDS) {
  const candidate = candidateByRelation.get(relationId)!;
  baselineTargetByRelation.set(relationId, mapMountainRoute(candidate));
}
for (const check of v2CanaryIdentityChecks) {
  baselineTargetByRelation.set(check.relationId, check.request.mountainRoutePayload);
}
const geojsonIdentityChecks = PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.map((relationId) => {
  const active = activeRows.find((row) => row.canonical_relation_id === relationId);
  const target = baselineTargetByRelation.get(relationId);
  const mountainRoute = active ? mountainRouteById.get(active.mountain_route_id) : undefined;
  const staging = active ? stagingById.get(active.staging_route_id) : undefined;
  const identityMatch = Boolean(
    active && target && mountainRoute && staging &&
    mountainRoute.id === active.mountain_route_id &&
    mountainRoute.source_url === target.source_url &&
    mountainRoute.route_type === target.route_type &&
    mountainRoute.is_verified === true &&
    mountainRoute.geojson_url === target.geojson_url &&
    staging.id === active.staging_route_id &&
    staging.payload_hash === active.staging_payload_hash &&
    sha256Stable(staging.geometry_geojson) === active.geometry_hash
  );
  return { relationId, mountainRouteId: active?.mountain_route_id ?? null, identityMatch };
});
if (geojsonIdentityChecks.some((check) => !check.identityMatch)) {
  throw new Error("ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE");
}

const existingSourceUrls = new Set(
  mountainRouteRows.flatMap((row) => row.source_url ? [row.source_url] : []),
);
const existingMountainIds = new Set(targetMountainRows.map((row) => row.id));
const batchRequests = providedBatch.records.map((record) => {
  const candidate = candidateByStaging.get(record.stagingRouteId);
  const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
  if (!candidate || !route) throw new Error(`PHASE11C2_INPUT_MISSING:${record.sourceRelationId}`);
  const request = buildPublicationRequestV2({
    artifact: liveArtifact,
    candidateManifest: liveCandidateManifest,
    lockedManifest: providedBatch,
    candidate,
    qaHistory: liveInput.qaHistory,
    route,
  });
  const blockers = phase11C2EligibilityFailures({
    candidate,
    route,
    activeRelationIds: new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS),
  });
  const candidateWarnings = warnings(candidate);
  const relatedActive = activeRows.filter(
    (row) => row.canonical_relation_id === candidate.canonicalRouteSourceId,
  );
  let action = decidePhase11C2ExistingPublicationAction({
    relatedActiveCount: relatedActive.length,
    exactV2IdentityMatch:
      relatedActive.length === 1 && v2IdentityMatches(relatedActive[0], request),
  });
  if (action === "BLOCKED") blockers.push("ACTIVE_PUBLICATION_CONFLICT");
  if (action === "WOULD_CREATE" && existingSourceUrls.has(candidate.provenance.sourceUrl)) {
    blockers.push("LEGACY_SOURCE_DUPLICATE");
  }
  if (!existingMountainIds.has(candidate.summit.mountainId)) blockers.push("TARGET_MOUNTAIN_MISSING");
  if (request.mountainRoutePayload.route_type !== "hiking") blockers.push("TARGET_ROUTE_TYPE_NOT_HIKING");
  if (request.provenancePayload.activity_classification.manualReviewRequired) {
    blockers.push("ACTIVITY_MANUAL_REVIEW_REQUIRED");
  }
  if (blockers.length > 0) action = "BLOCKED";
  return {
    candidate,
    route,
    request,
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(candidateWarnings)].sort(),
    action,
  };
});

const selectedIds = new Set(providedBatch.records.map((record) => record.canonicalRouteSourceId));
const skippedCandidates = liveArtifact.candidates.flatMap((candidate) => {
  if (selectedIds.has(candidate.canonicalRouteSourceId)) return [];
  const route = routes.get(candidate.sourceRelationId);
  if (!route) throw new Error(`RAW_ROUTE_MISSING:${candidate.sourceRelationId}`);
  const reasons = phase11C2EligibilityFailures({
    candidate,
    route,
    activeRelationIds: new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS),
  });
  if (reasons.length === 0) reasons.push("LOWER_DETERMINISTIC_PRIORITY");
  return [{
    relationId: candidate.canonicalRouteSourceId,
    routeName: candidate.routeName,
    topology: candidate.topology.classification,
    quality: candidate.qualityScore,
    reasons,
  }];
});

const blocked = batchRequests.filter((value) => value.action === "BLOCKED");
const warningCandidates = batchRequests.filter((value) => value.warnings.length > 0);
if (blocked.length > 0 || warningCandidates.length > 0) {
  throw new Error("PHASE11C2_PREFLIGHT_BLOCKED");
}
if (!schemaSupport.v2RpcAvailable || !schemaSupport.v2ColumnsAvailable) {
  throw new Error("V2_PUBLICATION_CONTRACT_NOT_AVAILABLE");
}

const confirmation = providedBatch.records
  .map((record) => record.canonicalRouteSourceId)
  .join(",");
const futureExecuteCommand =
  `node --experimental-strip-types scripts/osm-import/publish-phase11c2-v2-batch.ts --execute --manifest ${PHASE11C2_V2_MANIFEST_PATH} --confirm-relations ${confirmation}`;

if (cli.execute) {
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let rpcCalls = 0;
  let publicationWrites = 0;
  for (const value of batchRequests) {
    if (value.action === "UNCHANGED") continue;
    const before = await loadActiveRows();
    const { data, error } = await client.rpc(RPC_NAME, { p_request: value.request });
    rpcCalls += 1;
    if (error) throw new Error(`V2_RPC_FAILED:${value.candidate.sourceRelationId}:${error.message}`);
    const result = data as Array<{ action: string; mountain_route_id: number }>;
    if (result.length !== 1 || result[0].action !== "CREATED") {
      throw new Error(`V2_RPC_RESULT_INVALID:${value.candidate.sourceRelationId}`);
    }
    publicationWrites += 1;
    const after = await loadActiveRows();
    const created = after.filter(
      (row) => row.canonical_relation_id === value.candidate.canonicalRouteSourceId,
    );
    if (
      after.length !== before.length + 1 ||
      created.length !== 1 ||
      created[0].mountain_route_id !== result[0].mountain_route_id ||
      !v2IdentityMatches(created[0], value.request)
    ) {
      throw new Error(`V2_POST_WRITE_VERIFICATION_FAILED:${value.candidate.sourceRelationId}`);
    }
    assertAllowedActiveSet(after, providedBatch);
  }
  const finalRows = await loadActiveRows();
  if (
    finalRows.length !== PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.length + providedBatch.records.length ||
    batchRequests.some((value) => {
      const rows = finalRows.filter(
        (row) => row.canonical_relation_id === value.candidate.canonicalRouteSourceId,
      );
      return rows.length !== 1 || !v2IdentityMatches(rows[0], value.request);
    })
  ) {
    throw new Error("V2_FINAL_BATCH_VERIFICATION_FAILED");
  }
  console.log(JSON.stringify({
    mode: "EXECUTE",
    status: "PASS",
    attempted: batchRequests.length,
    unchanged: batchRequests.filter((value) => value.action === "UNCHANGED").length,
    rpcCalls,
    databaseWrites: publicationWrites,
    publicationWrites,
    automaticRollback: false,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    mode: "PREFLIGHT_READ_ONLY",
    status: "PASS",
    phase10LiveVerification: {
      reviewed: liveArtifact.totalReviewedRoutes,
      visuallyApproved: liveArtifact.qaProgress.visuallyApproved,
      candidates: liveArtifact.candidateCount,
      qaHistoryIntegrity: liveArtifact.qaHistoryIntegrity.status,
      qaHistoryEvents: liveArtifact.qaHistoryIntegrity.historyEventCount,
      candidateContentHash: liveArtifact.deterministicContentHash,
      candidateManifestHash: liveCandidateManifest.overallDeterministicManifestHash,
    },
    productionActive: {
      expectedBaselineCount: PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.length,
      actualCount: activeRows.length,
      relationIds: activeRows.map((row) => row.canonical_relation_id),
      exactBaselineMatch:
        activeRows.length === PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.length &&
        PHASE11C2_BASELINE_ACTIVE_RELATION_IDS.every((id) =>
          activeRows.some((row) => row.canonical_relation_id === id)),
    },
    existingV1IdentityChecks: {
      passed: v1IdentityChecks.filter((check) => check.identityMatch).length,
      total: v1IdentityChecks.length,
      status: "PASS",
      checks: v1IdentityChecks,
    },
    existingV2CanaryIdentityChecks: {
      passed: v2CanaryIdentityChecks.filter((check) => check.identityMatch).length,
      total: v2CanaryIdentityChecks.length,
      status: "PASS",
      checks: v2CanaryIdentityChecks.map((check) => ({
        relationId: check.relationId,
        mountainRouteId: check.mountainRouteId,
        identityMatch: check.identityMatch,
      })),
    },
    geojsonIdentityCompatibility: {
      passed: geojsonIdentityChecks.filter((check) => check.identityMatch).length,
      total: geojsonIdentityChecks.length,
      status: "PASS",
      checks: geojsonIdentityChecks,
    },
    manifest: {
      path: PHASE11C2_V2_MANIFEST_PATH,
      hash: providedBatch.deterministicV2ManifestHash,
      batchSize: providedBatch.records.length,
      publicationContractVersion: providedBatch.publicationContractVersion,
    },
    preflight: {
      attempted: batchRequests.length,
      wouldCreate: batchRequests.filter((value) => value.action === "WOULD_CREATE").length,
      unchanged: batchRequests.filter((value) => value.action === "UNCHANGED").length,
      blocked: blocked.length,
      warningCandidates: warningCandidates.length,
      manualReviewRequired: batchRequests.filter(
        (value) => value.request.provenancePayload.activity_classification.manualReviewRequired,
      ).length,
      activePublicationConflicts: batchRequests.filter(
        (value) => value.blockers.includes("ACTIVE_PUBLICATION_CONFLICT"),
      ).length,
      rpcCalls: 0,
      databaseWrites: 0,
      publicationWrites: 0,
    },
    candidates: batchRequests.map((value) => ({
      relationId: value.candidate.canonicalRouteSourceId,
      routeName: value.candidate.routeName,
      mountainId: value.candidate.summit.mountainId,
      semanticType: value.candidate.semanticType,
      routeType: value.request.mountainRoutePayload.route_type,
      topology: value.candidate.topology.classification,
      quality: value.candidate.qualityScore,
      action: value.action,
      blockers: value.blockers,
      warnings: value.warnings,
    })),
    skippedCandidates,
    futureExecuteCommand,
    automaticRollback: false,
  }, null, 2));
}
