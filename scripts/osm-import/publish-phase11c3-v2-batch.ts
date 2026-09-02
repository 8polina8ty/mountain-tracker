import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  stableJson,
  verifyPublicationCandidateDocuments,
  type PublicationGateInput,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import { loadPhase11c4PublicationGateInput } from "./phase11c4-live-data.ts";
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
  phase11C2EligibilityFailures,
  verifyPhase11C2V2BatchManifest,
  type Phase11C2V2BatchManifest,
} from "./phase11c2-v2-batch.ts";
import {
  PHASE11C3_BASELINE_ACTIVE_RELATION_IDS,
  PHASE11C3_TARGET_BATCH_SIZE,
  PHASE11C3_V2_MANIFEST_PATH,
  createPhase11C3LockedBatchManifest,
  decidePhase11C3ExistingPublicationAction,
  parsePhase11C3CliArguments,
  requirePhase11C3ExecutionAuthorization,
  verifyPhase11C3LockedBatchManifest,
  v2IdentityMatchesFull,
  type Phase11C3LockedBatchManifest,
} from "./phase11c3-scale-readiness.ts";
import {
  assertFrozenActivePublicationBaseline,
  type ExpectedFrozenPublicationIdentity,
} from "./phase11-active-publication-identity.ts";
import {
  verifyPhase11C9RoadSafetyPublicationGate,
  type Phase11C9RoadSafetyReport,
} from "./phase11c9-road-safety.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const V1_RELATION_IDS = ["196164", "20916", "33528", "199145", "207900", "207913"] as const;
const V2_CANARY_RELATION_IDS = ["361148", "140270"] as const;
const V2_CANARY_MANIFEST_PATH = "data/osm/alps/publication/phase11c2a-v2-canary.json";
const PHASE11C9_ROAD_SAFETY_REPORT_PATH =
  "data/osm/alps/publication/phase11c9-road-safety-batch-100.json";
const RPC_NAME = "publish_approved_osm_route_v2";

type ActiveRow = {
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
};

type MountainRouteRow = {
  id: number;
  mountain_id: number;
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

type MountainSourceRow = Record<string, unknown> & { id: number };

function publicationInputGuardHash(inputs: PublicationGateInput[]): string {
  const byString = <T>(values: T[], selector: (value: T) => string): T[] =>
    [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
  return sha256Stable({
    routes: byString(inputs.flatMap((input) => input.routes), (row) => row.id),
    summits: byString(
      inputs.flatMap((input) => input.summits),
      (row) => `${row.staging_route_id}:${row.peak_osm_id}`,
    ),
    qaDecisions: byString(
      inputs.flatMap((input) => input.qaDecisions),
      (row) => row.stagingRouteId,
    ),
    qaHistory: [...inputs.flatMap((input) => input.qaHistory)].sort(
      (left, right) => left.id - right.id,
    ),
  });
}

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
const configuredServiceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    "osm_route_publication_provenance?select=mountain_route_id,staging_route_id,provider,canonical_relation_id,source_relation_ids,source_url,publication_contract_version,publication_status,publication_idempotency_key,staging_payload_hash,candidate_content_hash,candidate_set_content_hash,candidate_manifest_hash,dataset_fingerprint,geometry_hash,qa_decision_version,qa_history_hash,target_payload_hash,activity_classification,activity_classification_hash&publication_status=eq.ACTIVE&order=mountain_route_id.asc",
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

function assertAllowedActiveSet(activeRows: ActiveRow[], batch: Phase11C3LockedBatchManifest): void {
  const baseline = new Set(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS);
  const batchIds = new Set(batch.records.map((record) => record.canonicalRouteSourceId));
  const seen = new Set<string>();
  for (const row of activeRows) {
    if (seen.has(row.canonical_relation_id)) {
      throw new Error(`DUPLICATE_ACTIVE_RELATION:${row.canonical_relation_id}`);
    }
    seen.add(row.canonical_relation_id);
    if (!baseline.has(row.canonical_relation_id as (typeof PHASE11C3_BASELINE_ACTIVE_RELATION_IDS)[number]) &&
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

const cli = parsePhase11C3CliArguments(process.argv.slice(2));
const [
  storedArtifact,
  storedCandidateManifest,
  providedBatch,
  providedCanary,
  providedPriorV2Batch,
  routeText,
  historicalInput,
  phase11c4Input,
  activeRows,
  schemaSupport,
  roadSafetyReport,
] = await Promise.all([
  readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile(cli.manifestPath, "utf8").then(
    (value) => JSON.parse(value) as Phase11C3LockedBatchManifest,
  ),
  readFile(V2_CANARY_MANIFEST_PATH, "utf8").then(
    (value) => JSON.parse(value) as Phase11C2ACanaryManifest,
  ),
  readFile(PHASE11C2_V2_MANIFEST_PATH, "utf8").then(
    (value) => JSON.parse(value) as Phase11C2V2BatchManifest,
  ),
  readFile("data/osm/alps/routes.jsonl", "utf8"),
  loadPublicationGateInput(),
  loadPhase11c4PublicationGateInput(),
  loadActiveRows(),
  loadSchemaSupport(),
  readFile(PHASE11C9_ROAD_SAFETY_REPORT_PATH, "utf8").then(
    (value) => JSON.parse(value) as Phase11C9RoadSafetyReport,
  ),
]);

const historicalArtifact = buildPublicationCandidateArtifact(historicalInput, { expectedRecordCount: 46 });
const historicalManifest = buildPublicationCandidateManifest(historicalArtifact);
const phase11c4Artifact = buildPublicationCandidateArtifact(phase11c4Input, { expectedRecordCount: 150 });

const combinedArtifact = {
  ...historicalArtifact,
  candidates: [...historicalArtifact.candidates, ...phase11c4Artifact.candidates],
  candidateCount: historicalArtifact.candidateCount + phase11c4Artifact.candidateCount,
  totalReviewedRoutes: historicalArtifact.totalReviewedRoutes + phase11c4Artifact.totalReviewedRoutes,
  qaProgress: {
    total: historicalArtifact.qaProgress.total + phase11c4Artifact.qaProgress.total,
    decided: historicalArtifact.qaProgress.decided + phase11c4Artifact.qaProgress.decided,
    pending: historicalArtifact.qaProgress.pending + phase11c4Artifact.qaProgress.pending,
    visuallyApproved: historicalArtifact.qaProgress.visuallyApproved + phase11c4Artifact.qaProgress.visuallyApproved,
    needsReview: historicalArtifact.qaProgress.needsReview + phase11c4Artifact.qaProgress.needsReview,
    rejected: historicalArtifact.qaProgress.rejected + phase11c4Artifact.qaProgress.rejected,
    warnings: historicalArtifact.qaProgress.warnings + phase11c4Artifact.qaProgress.warnings,
    warningsPending: historicalArtifact.qaProgress.warningsPending + phase11c4Artifact.qaProgress.warningsPending,
  },
  blockedCandidateCount: historicalArtifact.blockedCandidateCount + phase11c4Artifact.blockedCandidateCount,
  blockedCountsByReason: {
    PENDING: historicalArtifact.blockedCountsByReason.PENDING + phase11c4Artifact.blockedCountsByReason.PENDING,
    NEEDS_REVIEW: historicalArtifact.blockedCountsByReason.NEEDS_REVIEW + phase11c4Artifact.blockedCountsByReason.NEEDS_REVIEW,
    REJECTED: historicalArtifact.blockedCountsByReason.REJECTED + phase11c4Artifact.blockedCountsByReason.REJECTED,
  },
};

const combinedManifest = buildPublicationCandidateManifest(combinedArtifact);
const preExecutionPublicationInputGuardHash = publicationInputGuardHash([
  historicalInput,
  phase11c4Input,
]);
verifyPublicationCandidateDocuments({
  expectedArtifact: storedArtifact,
  expectedManifest: storedCandidateManifest,
  liveArtifact: historicalArtifact,
  liveManifest: historicalManifest,
});

const routes = new Map(routeText.trim().split(/\r?\n/).map((line) => {
  const route = JSON.parse(line) as ClassifiableRoute;
  return [route.sourceId, route] as const;
}));

const expectedBatchResult = createPhase11C3LockedBatchManifest({
  artifact: combinedArtifact,
  candidateManifest: combinedManifest,
  qaHistory: [...historicalInput.qaHistory, ...phase11c4Input.qaHistory],
  routes,
  activeRelationIds: new Set(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS),
  targetBatchSize: PHASE11C3_TARGET_BATCH_SIZE,
  baselineSnapshot: providedBatch.baselineSnapshot,
});
const expectedBatch = expectedBatchResult.manifest;
verifyPhase11C3LockedBatchManifest({ provided: providedBatch, expected: expectedBatch });
verifyPhase11C9RoadSafetyPublicationGate({
  report: roadSafetyReport,
  manifestPath: cli.manifestPath,
  manifestHash: providedBatch.deterministicV2ManifestHash,
  manifestRecords: providedBatch.records,
  pipelineDatasetFingerprint: combinedArtifact.datasetFingerprint,
});
requirePhase11C3ExecutionAuthorization({ cli, manifest: providedBatch });

const expectedCanary = createPhase11C2ACanaryManifest({
  artifact: historicalArtifact,
  candidateManifest: historicalManifest,
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
const expectedPriorV2Batch = createPhase11C2V2BatchManifest({
  artifact: historicalArtifact,
  candidateManifest: historicalManifest,
  qaHistory: historicalInput.qaHistory,
  routes,
  activeRelationIds: new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS),
});
verifyPhase11C2V2BatchManifest({
  provided: providedPriorV2Batch,
  expected: expectedPriorV2Batch,
});
assertAllowedActiveSet(activeRows, providedBatch);

const candidateByRelation = new Map(
  combinedArtifact.candidates.map((candidate) => [candidate.canonicalRouteSourceId, candidate]),
);
const candidateByStaging = new Map(
  combinedArtifact.candidates.map((candidate) => [candidate.stagingRouteId, candidate]),
);

const v1IdentityChecks = V1_RELATION_IDS.map((relationId) => {
  const row = activeRows.find((value) => value.canonical_relation_id === relationId);
  const candidate = candidateByRelation.get(relationId);
  if (!row || !candidate) throw new Error(`ACTIVE_V1_INPUT_MISSING:${relationId}`);
  const expected = createProvenancePayload({
    artifact: historicalArtifact,
    manifest: historicalManifest,
    candidate,
    qaHistory: historicalInput.qaHistory,
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
    artifact: combinedArtifact,
    candidateManifest: combinedManifest,
    lockedManifest: providedCanary,
    candidate,
    qaHistory: [...historicalInput.qaHistory, ...phase11c4Input.qaHistory],
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

const priorV2BatchIdentityChecks = providedPriorV2Batch.records.map((record) => {
  const row = activeRows.find((value) => value.canonical_relation_id === record.canonicalRouteSourceId);
  const candidate = candidateByStaging.get(record.stagingRouteId);
  const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
  if (!row || !candidate || !route) throw new Error(`ACTIVE_V2_BATCH_INPUT_MISSING:${record.sourceRelationId}`);
  const request = buildPublicationRequestV2({
    artifact: historicalArtifact,
    candidateManifest: historicalManifest,
    lockedManifest: providedPriorV2Batch,
    candidate,
    qaHistory: historicalInput.qaHistory,
    route,
  });
  return {
    relationId: record.canonicalRouteSourceId,
    mountainRouteId: row.mountain_route_id,
    identityMatch: v2IdentityMatches(row, request),
    request,
  };
});
if (priorV2BatchIdentityChecks.some((check) => !check.identityMatch)) {
  throw new Error("ACTIVE_V2_BATCH_IDENTITY_DRIFT");
}

const [mountainRouteRows, targetMountainRows, baselineStagingRows] = await Promise.all([
  restGet("mountain_routes?select=id,mountain_id,source_url,route_type,is_verified,geojson_url&order=id.asc") as Promise<MountainRouteRow[]>,
  restGet(
    `mountains?select=id&id=in.(${providedBatch.records.map((record) => record.mountainId).join(",")})`,
  ) as Promise<Array<{ id: number }>>,
  restGet(
    `osm_route_import_staging?select=id,payload_hash,geometry_geojson&id=in.(${activeRows
      .filter((row) => PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.some((id) => id === row.canonical_relation_id))
      .map((row) => row.staging_route_id).join(",")})`,
  ) as Promise<StagingRow[]>,
]);
function frozenIdentity(
  candidate: PublicationCandidateArtifact["candidates"][number],
  target: { mountain_id: number; route_type: string; source_url: string; geojson_url: string },
  provenance: ReturnType<typeof createProvenancePayload> | Phase11PublicationRequestV2["provenancePayload"],
): ExpectedFrozenPublicationIdentity {
  return {
    canonicalRelationId: candidate.canonicalRouteSourceId,
    mountainId: target.mountain_id,
    publicationContractVersion: provenance.publication_contract_version,
    publicationIdempotencyKey: provenance.publication_idempotency_key,
    stagingRouteId: candidate.stagingRouteId,
    stagingPayloadHash: provenance.staging_payload_hash,
    candidateContentHash: provenance.candidate_content_hash,
    candidateSetContentHash: provenance.candidate_set_content_hash,
    candidateManifestHash: provenance.candidate_manifest_hash,
    datasetFingerprint: provenance.dataset_fingerprint,
    geometryHash: provenance.geometry_hash,
    qaDecisionVersion: provenance.qa_decision_version,
    qaHistoryHash: provenance.qa_history_hash,
    targetPayloadHash: provenance.target_payload_hash,
    activityClassification: "activity_classification" in provenance
      ? provenance.activity_classification
      : null,
    activityClassificationHash: "activity_classification_hash" in provenance
      ? provenance.activity_classification_hash
      : null,
    sourceRelationIds: provenance.source_relation_ids,
    sourceUrl: provenance.source_url,
    routeType: target.route_type,
    geojsonUrl: target.geojson_url,
    geometry: candidate.originalGeometry,
  };
}

const expectedFrozenBaseline: ExpectedFrozenPublicationIdentity[] = [];
for (const relationId of V1_RELATION_IDS) {
  const candidate = candidateByRelation.get(relationId);
  if (!candidate) throw new Error(`ACTIVE_V1_INPUT_MISSING:${relationId}`);
  expectedFrozenBaseline.push(frozenIdentity(
    candidate,
    mapMountainRoute(candidate),
    createProvenancePayload({
      artifact: historicalArtifact,
      manifest: historicalManifest,
      candidate,
      qaHistory: historicalInput.qaHistory,
    }),
  ));
}
for (const check of [...v2CanaryIdentityChecks, ...priorV2BatchIdentityChecks]) {
  const candidate = candidateByRelation.get(check.relationId);
  if (!candidate) throw new Error(`ACTIVE_V2_INPUT_MISSING:${check.relationId}`);
  expectedFrozenBaseline.push(frozenIdentity(
    candidate,
    check.request.mountainRoutePayload,
    check.request.provenancePayload,
  ));
}
if (
  expectedFrozenBaseline.length !== PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.length ||
  PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.some((relationId) =>
    !expectedFrozenBaseline.some((expected) => expected.canonicalRelationId === relationId))
) {
  throw new Error("FROZEN_ACTIVE_BASELINE_EXPECTATION_INCOMPLETE");
}

let geojsonIdentityChecks;
try {
  geojsonIdentityChecks = assertFrozenActivePublicationBaseline({
    activeRows: activeRows.filter((row) =>
      PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.some((relationId) => relationId === row.canonical_relation_id)),
    mountainRoutes: mountainRouteRows,
    stagingRows: baselineStagingRows,
    expected: expectedFrozenBaseline,
  });
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: "ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE",
    incompatibleActiveRoutes: error instanceof Error && "diagnostics" in error
      ? error.diagnostics
      : [],
    rpcCalls: 0,
    databaseWrites: 0,
    publicationWrites: 0,
  }, null, 2));
  throw error;
}

const existingSourceUrls = new Set(
  mountainRouteRows.flatMap((row) => row.source_url ? [row.source_url] : []),
);
const existingMountainIds = new Set(targetMountainRows.map((row) => row.id));
const batchRequests: Array<{
    candidate: PublicationCandidateArtifact["candidates"][number];
    route: ClassifiableRoute;
    request: Phase11PublicationRequestV2;
    blockers: string[];
    warnings: string[];
    action: "WOULD_CREATE" | "RESUME_MATCH" | "BLOCKED";
  }> = providedBatch.records.map((record) => {
  const candidate = candidateByStaging.get(record.stagingRouteId);
  const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
  if (!candidate || !route) throw new Error(`PHASE11C3_INPUT_MISSING:${record.sourceRelationId}`);
  const request = buildPublicationRequestV2({
    artifact: combinedArtifact,
    candidateManifest: combinedManifest,
    lockedManifest: providedBatch,
    candidate,
    qaHistory: [...historicalInput.qaHistory, ...phase11c4Input.qaHistory],
    route,
  });
  const blockers = phase11C2EligibilityFailures({
    candidate,
    route,
    activeRelationIds: new Set(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS),
  });
  const candidateWarnings = warnings(candidate);
  const relatedActive = activeRows.filter(
    (row) => row.canonical_relation_id === candidate.canonicalRouteSourceId,
  );
  let action = decidePhase11C3ExistingPublicationAction({
    relatedActiveCount: relatedActive.length,
    exactV2IdentityMatch:
      relatedActive.length === 1 && v2IdentityMatchesFull(relatedActive[0], request),
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
const skippedCandidates = combinedArtifact.candidates.flatMap((candidate) => {
  if (selectedIds.has(candidate.canonicalRouteSourceId)) return [];
  const route = routes.get(candidate.sourceRelationId);
  if (!route) throw new Error(`RAW_ROUTE_MISSING:${candidate.sourceRelationId}`);
  const reasons = phase11C2EligibilityFailures({
    candidate,
    route,
    activeRelationIds: new Set(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS),
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
  throw new Error("PHASE11C3_PREFLIGHT_BLOCKED");
}
if (!schemaSupport.v2RpcAvailable || !schemaSupport.v2ColumnsAvailable) {
  throw new Error("V2_PUBLICATION_CONTRACT_NOT_AVAILABLE");
}

const expectedFrozenBatch = batchRequests.map((value) => frozenIdentity(
  value.candidate,
  value.request.mountainRoutePayload,
  value.request.provenancePayload,
));
const expectedFrozenAll = [...expectedFrozenBaseline, ...expectedFrozenBatch];
const currentAllStagingRows = await restGet(
  `osm_route_import_staging?select=id,payload_hash,geometry_geojson&id=in.(${activeRows
    .map((row) => row.staging_route_id).join(",")})`,
) as StagingRow[];
const currentAllIdentityChecks = assertFrozenActivePublicationBaseline({
  activeRows,
  mountainRoutes: mountainRouteRows,
  stagingRows: currentAllStagingRows,
  expected: expectedFrozenAll,
});
const currentV1IdentityCount = currentAllIdentityChecks.filter(
  (check) => check.expectedPublicationGeneration === "mountain-tracker-osm-publication/v1",
).length;
const currentV2IdentityCount = currentAllIdentityChecks.filter(
  (check) => check.expectedPublicationGeneration === PHASE11_PUBLICATION_CONTRACT_V2,
).length;
const currentUniqueRelationIds = new Set(
  activeRows.map((row) => row.canonical_relation_id),
).size;
const currentUniqueSourceUrls = new Set(activeRows.map((row) => row.source_url)).size;
if (
  currentAllIdentityChecks.length !== 118 ||
  currentV1IdentityCount !== 6 ||
  currentV2IdentityCount !== 112 ||
  currentUniqueRelationIds !== 118 ||
  currentUniqueSourceUrls !== 118
) throw new Error("PHASE11D_CURRENT_ACTIVE_IDENTITY_INVARIANT_FAILED");
const guardedMountainIds = [...new Set(
  expectedFrozenAll.map((expected) => expected.mountainId),
)].sort((left, right) => left - right);
const preExecutionMountainSourceRows = await restGet(
  `mountains?select=*&id=in.(${guardedMountainIds.join(",")})&order=id.asc`,
) as MountainSourceRow[];
if (preExecutionMountainSourceRows.length !== guardedMountainIds.length) {
  throw new Error("PHASE11C10_MOUNTAIN_SOURCE_GUARD_INCOMPLETE");
}
const preExecutionMountainSourceHash = sha256Stable(preExecutionMountainSourceRows);

const confirmation = providedBatch.records
  .map((record) => record.canonicalRouteSourceId)
  .join(",");
const futureExecuteCommand =
  `node --experimental-strip-types scripts/osm-import/publish-phase11c3-v2-batch.ts --execute --manifest ${PHASE11C3_V2_MANIFEST_PATH} --confirm-relations ${confirmation}`;

if (cli.execute) {
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let rpcCalls = 0;
  let publicationWrites = 0;
  for (const value of batchRequests) {
    if (value.action === "RESUME_MATCH") continue;
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
      !v2IdentityMatchesFull(created[0], value.request)
    ) {
      throw new Error(`V2_POST_WRITE_VERIFICATION_FAILED:${value.candidate.sourceRelationId}`);
    }
    assertAllowedActiveSet(after, providedBatch);
  }
  const finalRows = await loadActiveRows();
  if (
    finalRows.length !== PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.length + providedBatch.records.length ||
    batchRequests.some((value) => {
      const rows = finalRows.filter(
        (row) => row.canonical_relation_id === value.candidate.canonicalRouteSourceId,
      );
      return rows.length !== 1 || !v2IdentityMatchesFull(rows[0], value.request);
    })
  ) {
    throw new Error("V2_FINAL_BATCH_VERIFICATION_FAILED");
  }
  assertAllowedActiveSet(finalRows, providedBatch);

  const [
    finalMountainRouteRows,
    finalStagingRows,
    postHistoricalInput,
    postPhase11c4Input,
    postMountainSourceRows,
  ] = await Promise.all([
    restGet(
      `mountain_routes?select=id,mountain_id,source_url,route_type,is_verified,geojson_url&id=in.(${finalRows
        .map((row) => row.mountain_route_id).join(",")})&order=id.asc`,
    ) as Promise<MountainRouteRow[]>,
    restGet(
      `osm_route_import_staging?select=id,payload_hash,geometry_geojson&id=in.(${finalRows
        .map((row) => row.staging_route_id).join(",")})`,
    ) as Promise<StagingRow[]>,
    loadPublicationGateInput(),
    loadPhase11c4PublicationGateInput(),
    restGet(
      `mountains?select=*&id=in.(${guardedMountainIds.join(",")})&order=id.asc`,
    ) as Promise<MountainSourceRow[]>,
  ]);
  const allIdentityChecks = assertFrozenActivePublicationBaseline({
    activeRows: finalRows,
    mountainRoutes: finalMountainRouteRows,
    stagingRows: finalStagingRows,
    expected: expectedFrozenAll,
  });
  const baselineRelationIds = new Set<string>(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS);
  const batchRelationIds = new Set(
    providedBatch.records.map((record) => record.canonicalRouteSourceId),
  );
  const safeRelationIds = new Set(
    roadSafetyReport.records
      .filter((record) => record.status === "SAFE")
      .map((record) => record.canonicalRelationId),
  );
  const originalIdentityChecks = allIdentityChecks.filter((check) =>
    baselineRelationIds.has(check.canonicalRelationId));
  const newIdentityChecks = allIdentityChecks.filter((check) =>
    batchRelationIds.has(check.canonicalRelationId));
  const uniqueActiveRelationIds = new Set(
    finalRows.map((row) => row.canonical_relation_id),
  ).size;
  const uniqueActiveSourceUrls = new Set(
    finalRows.map((row) => row.source_url),
  ).size;
  const uniquePublicationIdentities = new Set(
    finalRows.map((row) => row.publication_idempotency_key),
  ).size;
  const roadSafetyMatches = newIdentityChecks.filter((check) =>
    safeRelationIds.has(check.canonicalRelationId)).length;
  if (
    allIdentityChecks.length !== 118 ||
    originalIdentityChecks.length !== 18 ||
    newIdentityChecks.length !== 100 ||
    uniqueActiveRelationIds !== 118 ||
    uniqueActiveSourceUrls !== 118 ||
    uniquePublicationIdentities !== 118 ||
    roadSafetyMatches !== 100 ||
    finalRows.some((row) =>
      !baselineRelationIds.has(row.canonical_relation_id) &&
      !batchRelationIds.has(row.canonical_relation_id))
  ) {
    throw new Error("PHASE11C10_POST_PUBLICATION_INVARIANT_FAILED");
  }
  const postExecutionPublicationInputGuardHash = publicationInputGuardHash([
    postHistoricalInput,
    postPhase11c4Input,
  ]);
  const postExecutionMountainSourceHash = sha256Stable(postMountainSourceRows);
  if (
    postExecutionPublicationInputGuardHash !== preExecutionPublicationInputGuardHash ||
    postExecutionMountainSourceHash !== preExecutionMountainSourceHash
  ) {
    throw new Error("PHASE11C10_UNRELATED_PRODUCTION_MUTATION_DETECTED");
  }
  console.log(JSON.stringify({
    mode: "EXECUTE",
    status: "PASS",
    attempted: batchRequests.length,
    created: publicationWrites,
    unchanged: batchRequests.filter((value) => value.action === "RESUME_MATCH").length,
    blocked: blocked.length,
    roadSafety: roadSafetyReport.summary,
    postPublication: {
      activeBefore: activeRows.length,
      activeAfter: finalRows.length,
      originalActiveIdentity: `${originalIdentityChecks.length}/18`,
      newPublicationIdentity: `${newIdentityChecks.length}/100`,
      geojsonIdentity: `${allIdentityChecks.length}/118`,
      uniqueActiveRelationIds,
      duplicateSourceUrls: finalRows.length - uniqueActiveSourceUrls,
      duplicatePublicationIdentities:
        finalRows.length - uniquePublicationIdentities,
      unexpectedActiveRelations: 0,
      roadSafetyMatch: `${roadSafetyMatches}/100`,
      stagingWrites: 0,
      qaWrites: 0,
      mountainSourceWrites: 0,
    },
    rpcCalls,
    databaseWrites: publicationWrites,
    publicationWrites,
    automaticRollback: false,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    mode: "PREFLIGHT_READ_ONLY",
    status: "PASS",
    combinedLiveVerification: {
      reviewed: combinedArtifact.totalReviewedRoutes,
      visuallyApproved: combinedArtifact.qaProgress.visuallyApproved,
      candidates: combinedArtifact.candidateCount,
      qaHistoryIntegrity: {
        status: "PASS",
        historyEventCount: combinedArtifact.qaHistoryIntegrity.historyEventCount,
        routesWithHistory: combinedArtifact.qaHistoryIntegrity.routesWithHistory,
        routesResetToPending: combinedArtifact.qaHistoryIntegrity.routesResetToPending,
      },
      candidateContentHash: combinedArtifact.deterministicContentHash,
      candidateManifestHash: combinedManifest.overallDeterministicManifestHash,
    },
    historicalPhase10Verification: {
      reviewed: historicalArtifact.totalReviewedRoutes,
      visuallyApproved: historicalArtifact.qaProgress.visuallyApproved,
      candidates: historicalArtifact.candidateCount,
      qaHistoryIntegrity: historicalArtifact.qaHistoryIntegrity.status,
      qaHistoryEvents: historicalArtifact.qaHistoryIntegrity.historyEventCount,
      candidateContentHash: historicalArtifact.deterministicContentHash,
      candidateManifestHash: historicalManifest.overallDeterministicManifestHash,
    },
    productionActive: {
      expectedBaselineCount: PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.length,
      actualCount: activeRows.length,
      relationIds: activeRows.map((row) => row.canonical_relation_id),
      exactBaselineMatch:
        activeRows.length === PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.length &&
        PHASE11C3_BASELINE_ACTIVE_RELATION_IDS.every((id) =>
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
    existingV2BatchIdentityChecks: {
      passed: priorV2BatchIdentityChecks.filter((check) => check.identityMatch).length,
      total: priorV2BatchIdentityChecks.length,
      status: "PASS",
      checks: priorV2BatchIdentityChecks.map((check) => ({
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
    phase11dProductionCheckpoint: {
      active: activeRows.length,
      frozenIdentityPassed: currentAllIdentityChecks.filter(
        (check) => check.identityMatch,
      ).length,
      frozenIdentityTotal: currentAllIdentityChecks.length,
      v1Identity: currentV1IdentityCount,
      v2Identity: currentV2IdentityCount,
      geojsonIdentity: currentAllIdentityChecks.filter(
        (check) => check.geometryContentIdentical,
      ).length,
      geometryIdentity: currentAllIdentityChecks.filter(
        (check) => check.geometryHash === check.canonicalGeometryHash,
      ).length,
      provenanceIdentity: currentAllIdentityChecks.filter(
        (check) => check.identityMatch,
      ).length,
      uniqueRelationIds: currentUniqueRelationIds,
      duplicateRelationIds: activeRows.length - currentUniqueRelationIds,
      duplicateSourceUrls: activeRows.length - currentUniqueSourceUrls,
      unexpectedActiveRelations: 0,
    },
    manifest: {
      path: PHASE11C3_V2_MANIFEST_PATH,
      hash: providedBatch.deterministicV2ManifestHash,
      batchSize: providedBatch.records.length,
      publicationContractVersion: providedBatch.publicationContractVersion,
    },
    roadSafety: {
      status: "PASS",
      reportPath: PHASE11C9_ROAD_SAFETY_REPORT_PATH,
      reportHash: roadSafetyReport.deterministicReportHash,
      total: roadSafetyReport.summary.total,
      safe: roadSafetyReport.summary.safe,
      blocked: roadSafetyReport.summary.blocked,
      manualReviewRequired: roadSafetyReport.summary.manualReviewRequired,
      safeGradeSeparatedCrossings:
        roadSafetyReport.summary.safeGradeSeparatedCrossings,
    },
    preflight: {
      baselineActive: activeRows.length,
      attempted: batchRequests.length,
      wouldCreate: batchRequests.filter((value) => value.action === "WOULD_CREATE").length,
      resumeMatch: batchRequests.filter((value) => value.action === "RESUME_MATCH").length,
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
  console.log(JSON.stringify({
    finalPreflight: {
      status: "PASS",
      baselineActive: activeRows.length,
      attempted: batchRequests.length,
      wouldCreate: batchRequests.filter((value) => value.action === "WOULD_CREATE").length,
      resumeMatch: batchRequests.filter((value) => value.action === "RESUME_MATCH").length,
      blocked: blocked.length,
      roadSafetySafe: roadSafetyReport.summary.safe,
      roadSafetyBlocked: roadSafetyReport.summary.blocked,
      roadSafetyManualReviewRequired:
        roadSafetyReport.summary.manualReviewRequired,
      rpcCalls: 0,
      databaseWrites: 0,
      publicationWrites: 0,
    },
  }, null, 2));
}
