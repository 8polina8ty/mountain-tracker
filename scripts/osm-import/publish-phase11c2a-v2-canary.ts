import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  PHASE11C2A_MANIFEST_NAME,
  createPhase11C2ACanaryManifest,
  verifyPhase11C2ACanaryManifest,
  type Phase11C2ACanaryManifest,
} from "./phase11c2a-v2-canary.ts";
import { buildPublicationRequestV2 } from "./phase11-publication-v2.ts";
import {
  createProvenancePayload,
  publicationIdentityMatches,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const DEFAULT_MANIFEST = resolve("data/osm/alps/publication", PHASE11C2A_MANIFEST_NAME);
const EXPECTED_CONFIRMATION = "361148,140270";
const RPC_NAME = "publish_approved_osm_route_v2";

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function argumentsFrom(argv: string[]): { execute: boolean; manifestPath: string; confirmation: string | null } {
  let execute = false;
  let manifestPath = DEFAULT_MANIFEST;
  let confirmation: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") execute = true;
    else if (value === "--manifest") manifestPath = resolve(argv[++index] ?? "");
    else if (value === "--confirm-relations") confirmation = argv[++index] ?? null;
    else throw new Error(`UNKNOWN_ARGUMENT:${value}`);
  }
  if (execute && confirmation !== EXPECTED_CONFIRMATION) {
    throw new Error(`EXECUTE_REQUIRES_CONFIRM_RELATIONS:${EXPECTED_CONFIRMATION}`);
  }
  if (execute && manifestPath !== DEFAULT_MANIFEST) throw new Error("EXECUTE_REQUIRES_LOCKED_DEFAULT_MANIFEST");
  return { execute, manifestPath, confirmation };
}

type ActiveRow = {
  mountain_route_id: number;
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
};

loadEnvironment(await readFile(".env.local", "utf8"));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Phase 11 read-only/service credentials.");
const supabaseUrl = url;
const serviceKey = key;

async function restGet(path: string): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: serviceKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`READ_ONLY_QUERY_FAILED:${response.status}:${path}`);
  return response.json();
}

async function openApi(): Promise<{ v2RpcAvailable: boolean; v2ColumnsAvailable: boolean }> {
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

const cli = argumentsFrom(process.argv.slice(2));
const [storedArtifact, storedCandidateManifest, providedManifest, rawText, liveInput, activeRows, schema] = await Promise.all([
  readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile(cli.manifestPath, "utf8").then((value) => JSON.parse(value) as Phase11C2ACanaryManifest),
  readFile("data/osm/alps/routes.jsonl", "utf8"),
  loadPublicationGateInput(),
  restGet(
    "osm_route_publication_provenance?select=mountain_route_id,canonical_relation_id,publication_contract_version,publication_status,publication_idempotency_key,staging_payload_hash,candidate_content_hash,candidate_set_content_hash,candidate_manifest_hash,dataset_fingerprint,geometry_hash,qa_decision_version,qa_history_hash,target_payload_hash&publication_status=eq.ACTIVE&order=mountain_route_id.asc",
  ) as Promise<ActiveRow[]>,
  openApi(),
]);
const liveArtifact = buildPublicationCandidateArtifact(liveInput);
const liveCandidateManifest = buildPublicationCandidateManifest(liveArtifact);
verifyPublicationCandidateDocuments({
  expectedArtifact: storedArtifact,
  expectedManifest: storedCandidateManifest,
  liveArtifact,
  liveManifest: liveCandidateManifest,
});
const routes = new Map(rawText.trim().split(/\r?\n/).map((line) => {
  const route = JSON.parse(line) as ClassifiableRoute;
  return [route.sourceId, route] as const;
}));
const activeRelationIds = new Set(activeRows.map((row) => row.canonical_relation_id));
const expectedManifest = createPhase11C2ACanaryManifest({
  artifact: liveArtifact,
  candidateManifest: liveCandidateManifest,
  routes,
  activeRelationIds,
});
verifyPhase11C2ACanaryManifest({ provided: providedManifest, expected: expectedManifest });

const v1Rows = activeRows.filter((row) => row.publication_contract_version === "mountain-tracker-osm-publication/v1");
const v1IdentityChecks = v1Rows.map((row) => {
  const candidate = liveArtifact.candidates.find((value) => value.canonicalRouteSourceId === row.canonical_relation_id);
  if (!candidate) throw new Error(`ACTIVE_V1_CANDIDATE_MISSING:${row.canonical_relation_id}`);
  const expected = createProvenancePayload({
    artifact: liveArtifact,
    manifest: liveCandidateManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
  });
  return { relationId: row.canonical_relation_id, mountainRouteId: row.mountain_route_id, identityMatch: publicationIdentityMatches(identity(row), expected) };
});
if (v1Rows.length !== 6 || v1IdentityChecks.some((value) => !value.identityMatch)) {
  throw new Error("ACTIVE_V1_IDENTITY_DRIFT");
}

const candidateRows = new Map(liveArtifact.candidates.map((candidate) => [candidate.stagingRouteId, candidate]));
const [existingRouteRows, targetMountainRows] = await Promise.all([
  restGet("mountain_routes?select=id,source_url&order=id.asc") as Promise<Array<{ id: number; source_url: string | null }>>,
  restGet(
    `mountains?select=id&id=in.(${providedManifest.records.map((record) => record.mountainId).join(",")})`,
  ) as Promise<Array<{ id: number }>>,
]);
const existingSourceUrls = new Set(existingRouteRows.flatMap((row) => row.source_url ? [row.source_url] : []));
const existingMountainIds = new Set(targetMountainRows.map((row) => row.id));
const requests = providedManifest.records.map((record) => {
  const candidate = candidateRows.get(record.stagingRouteId);
  const route = candidate ? routes.get(candidate.sourceRelationId) : undefined;
  if (!candidate || !route) throw new Error(`CANARY_INPUT_MISSING:${record.sourceRelationId}`);
  const request = buildPublicationRequestV2({
    artifact: liveArtifact,
    candidateManifest: liveCandidateManifest,
    lockedManifest: providedManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
    route,
  });
  const warnings = [
    ...candidate.warningState.activeFlags,
    ...candidate.warningState.reviewedFlags,
    ...candidate.auditFlags,
    ...(candidate.topology.endpointSelectionWarning ? [candidate.topology.endpointSelectionWarning] : []),
  ];
  const blockers: string[] = [];
  if (activeRelationIds.has(candidate.canonicalRouteSourceId)) blockers.push("ACTIVE_PUBLICATION_CONFLICT");
  if (existingSourceUrls.has(candidate.provenance.sourceUrl)) blockers.push("LEGACY_SOURCE_DUPLICATE");
  if (!existingMountainIds.has(candidate.summit.mountainId)) blockers.push("TARGET_MOUNTAIN_MISSING");
  if (candidate.qaDecision.status !== "VISUALLY_APPROVED") blockers.push("QA_NOT_APPROVED");
  if (candidate.summit.mountainMatchClassification !== "EXACT_MOUNTAIN_MATCH") blockers.push("MOUNTAIN_MATCH_NOT_EXACT");
  if (candidate.summit.associationClassification !== "CONFIRMED") blockers.push("SUMMIT_NOT_CONFIRMED");
  if (request.provenancePayload.activity_classification.manualReviewRequired) blockers.push("ACTIVITY_MANUAL_REVIEW_REQUIRED");
  return { candidate, request, blockers, warnings, action: blockers.length === 0 ? "WOULD_CREATE" as const : "BLOCKED" as const };
});
if (requests.some((value) => value.action !== "WOULD_CREATE" || value.blockers.length || value.warnings.length)) {
  throw new Error("PHASE11C2A_PREFLIGHT_BLOCKED");
}

const futureCommand =
  "node --experimental-strip-types scripts/osm-import/publish-phase11c2a-v2-canary.ts --execute --manifest data/osm/alps/publication/phase11c2a-v2-canary.json --confirm-relations 361148,140270";

if (cli.execute) {
  if (!schema.v2RpcAvailable || !schema.v2ColumnsAvailable) {
    throw new Error("V2_SQL_NOT_DEPLOYED_OR_NOT_VISIBLE");
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const beforeCount = activeRows.length;
  for (const value of requests) {
    const { data, error } = await client.rpc(RPC_NAME, { p_request: value.request });
    if (error) throw new Error(`V2_RPC_FAILED:${value.candidate.sourceRelationId}:${error.message}`);
    const rows = data as Array<{ action: string; mountain_route_id: number }>;
    if (rows.length !== 1 || rows[0].action !== "CREATED") {
      throw new Error(`V2_RPC_RESULT_INVALID:${value.candidate.sourceRelationId}`);
    }
  }
  const after = await restGet(
    "osm_route_publication_provenance?select=canonical_relation_id,publication_contract_version,publication_status&publication_status=eq.ACTIVE",
  ) as Array<{ canonical_relation_id: string; publication_contract_version: string; publication_status: string }>;
  if (
    after.length !== beforeCount + 2 ||
    !requests.every((value) => after.some((row) =>
      row.canonical_relation_id === value.candidate.canonicalRouteSourceId &&
      row.publication_contract_version === "mountain-tracker-osm-publication/v2" &&
      row.publication_status === "ACTIVE"))
  ) throw new Error("V2_POST_PUBLICATION_VERIFICATION_FAILED");
  console.log(JSON.stringify({ mode: "EXECUTE", status: "PASS", rpcCalls: 2, publicationWrites: 2 }, null, 2));
} else {
  console.log(JSON.stringify({
    mode: "PREFLIGHT_READ_ONLY",
    status: "PASS",
    sqlDeploymentAudit: {
      status: "BLOCKED",
      reason: "Production OpenAPI does not expose the exact mountain_routes.route_type CHECK constraint; repository contains no base mountain_routes DDL. The migration fails closed on any unknown route_type constraint, but successful taxonomy expansion cannot yet be proven.",
      v2RpcAvailable: schema.v2RpcAvailable,
      v2ColumnsAvailable: schema.v2ColumnsAvailable,
    },
    phase10LiveVerification: {
      reviewed: liveArtifact.totalReviewedRoutes,
      candidates: liveArtifact.candidateCount,
      qaHistoryIntegrity: liveArtifact.qaHistoryIntegrity.status,
      qaHistoryEvents: liveArtifact.qaHistoryIntegrity.historyEventCount,
      candidateContentHash: liveArtifact.deterministicContentHash,
      candidateManifestHash: liveCandidateManifest.overallDeterministicManifestHash,
    },
    existingV1: { count: v1Rows.length, identityChecks: v1IdentityChecks },
    manifest: { path: "data/osm/alps/publication/phase11c2a-v2-canary.json", hash: providedManifest.deterministicV2ManifestHash, recordCount: providedManifest.records.length },
    preflight: {
      attempted: requests.length,
      wouldCreate: requests.filter((value) => value.action === "WOULD_CREATE").length,
      unchanged: 0,
      blocked: requests.filter((value) => value.action === "BLOCKED").length,
      warningCandidates: requests.filter((value) => value.warnings.length > 0).length,
      manualReviewRequired: requests.filter((value) => value.request.provenancePayload.activity_classification.manualReviewRequired).length,
      activePublicationConflicts: requests.filter((value) => value.blockers.includes("ACTIVE_PUBLICATION_CONFLICT")).length,
      rpcCalls: 0,
      databaseWrites: 0,
      publicationWrites: 0,
    },
    candidates: requests.map((value) => ({
      sourceRelationId: value.candidate.sourceRelationId,
      routeName: value.candidate.routeName,
      mountainId: value.candidate.summit.mountainId,
      topology: value.candidate.topology.classification,
      quality: value.candidate.qualityScore,
      semanticType: value.candidate.semanticType,
      routeType: value.request.mountainRoutePayload.route_type,
      action: value.action,
      blockers: value.blockers,
      warnings: value.warnings,
      requestFields: Object.keys(value.request).sort(),
      targetPayloadHash: value.request.provenancePayload.target_payload_hash,
      activityClassificationHash: value.request.activityClassificationHash,
    })),
    futureExecuteCommand: futureCommand,
  }, null, 2));
}
