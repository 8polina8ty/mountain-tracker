import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  stableJson,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
  type PublicationCandidateRecord,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  createPhase11C1BatchManifest,
  FIRST_PUBLISHED_RELATION_ID,
  MAX_BATCH_SIZE,
  PHASE11C1_BATCH_MANIFEST_NAME,
  PHASE11C1_SELECTION_ORDER,
  PHASE11C1_SEMANTIC_RISK_RELATION_IDS,
  verifyPhase11C1BatchManifest,
  type Phase11BatchManifest,
} from "./phase11-batch.ts";
import { loadPhase11PublicationEnvironment } from "./phase11-live-data.ts";
import {
  sha256Stable,
  mapMountainRoute,
  publicationIdentityMatches,
  createProvenancePayload,
  dryRunCandidate,
  type MountainRoutePayload,
  type PublicationProvenancePayload,
  type Phase11DryRunRecord,
} from "./phase11-publication.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const PUBLICATION_DIRECTORY = resolve("data/osm/alps/publication");
const RPC_NAME = "publish_approved_osm_route";
const DEFAULT_BATCH_MANIFEST = resolve(
  PUBLICATION_DIRECTORY,
  PHASE11C1_BATCH_MANIFEST_NAME,
);

interface CliArguments {
  execute: boolean;
  batchManifestPath: string | null;
}

interface PublishRequest {
  candidateCanonicalJson: string;
  candidateContentHash: string;
  manifestCanonicalJson: string;
  candidateManifestHash: string;
  mountainRouteCanonicalJson: string;
  geometryCanonicalJson: string;
  qaHistoryCanonicalJson: string;
  mountainRoutePayload: MountainRoutePayload;
  provenancePayload: PublicationProvenancePayload;
}

interface RpcResultRow {
  action: string;
  mountain_route_id: number;
}

interface ProvenanceRow extends Record<string, unknown> {
  mountain_route_id: number;
  publication_idempotency_key: string;
}

interface VerifiedCandidate {
  candidate: PublicationCandidateRecord;
  dryRunRecord: Phase11DryRunRecord;
  request: PublishRequest;
}

function parseArguments(argv: string[]): CliArguments {
  const allowed = new Set(["--execute", "--batch-manifest"]);
  let execute = false;
  let batchManifestPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    if (argument === "--execute") {
      if (execute) throw new Error("DUPLICATE_EXECUTE_FLAG");
      execute = true;
      continue;
    }
    if (argument === "--batch-manifest") {
      if (batchManifestPath !== null) throw new Error("DUPLICATE_BATCH_MANIFEST_FLAG");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("BATCH_MANIFEST_PATH_REQUIRED");
      batchManifestPath = resolve(value);
      index += 1;
    }
  }

  if (batchManifestPath === null) throw new Error("BATCH_MANIFEST_REQUIRED");
  return { execute, batchManifestPath };
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Phase 11 service-role Supabase credentials.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function buildRpcRequest(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  candidate: PublicationCandidateRecord;
  qaHistory: ReturnType<typeof loadPublicationGateInput> extends Promise<{ qaHistory: infer Q }> ? Q : never;
}): PublishRequest {
  const { candidateContentHash, ...candidateContent } = input.candidate;
  const { overallDeterministicManifestHash, ...manifestContent } = input.manifest;
  const mountainRoutePayload = mapMountainRoute(input.candidate);
  const provenancePayload = createProvenancePayload({
    artifact: input.artifact,
    manifest: input.manifest,
    candidate: input.candidate,
    qaHistory: input.qaHistory,
  });
  const request: PublishRequest = {
    candidateCanonicalJson: stableJson(candidateContent),
    candidateContentHash,
    manifestCanonicalJson: stableJson(manifestContent),
    candidateManifestHash: overallDeterministicManifestHash,
    mountainRouteCanonicalJson: stableJson(mountainRoutePayload),
    geometryCanonicalJson: stableJson(input.candidate.originalGeometry),
    qaHistoryCanonicalJson: stableJson(provenancePayload.qa_history_snapshot),
    mountainRoutePayload,
    provenancePayload,
  };

  const hashChecks = [
    [sha256Stable(candidateContent), request.candidateContentHash, "CANDIDATE"],
    [sha256Stable(manifestContent), request.candidateManifestHash, "CANDIDATE_MANIFEST"],
    [sha256Stable(mountainRoutePayload), provenancePayload.target_payload_hash, "TARGET_PAYLOAD"],
    [sha256Stable(input.candidate.originalGeometry), provenancePayload.geometry_hash, "GEOMETRY"],
    [sha256Stable(provenancePayload.qa_history_snapshot), provenancePayload.qa_history_hash, "QA_HISTORY"],
  ] as const;
  for (const [actual, expected, label] of hashChecks) {
    if (actual !== expected) throw new Error(`${label}_CANONICAL_HASH_DRIFT`);
  }
  return request;
}

async function loadVerifiedBatch(batchManifestPath: string): Promise<{
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  batchManifest: Phase11BatchManifest;
  candidates: VerifiedCandidate[];
  environment: Awaited<ReturnType<typeof loadPhase11PublicationEnvironment>>;
}> {
  const [storedArtifact, storedManifest, batchManifestContent, liveInput] = await Promise.all([
    readFile(resolve(STAGING_DIRECTORY, "publication-candidates.json"), "utf8").then(
      (value) => JSON.parse(value) as PublicationCandidateArtifact,
    ),
    readFile(
      resolve(STAGING_DIRECTORY, "publication-candidate-manifest.json"),
      "utf8",
    ).then((value) => JSON.parse(value) as PublicationCandidateManifest),
    readFile(batchManifestPath, "utf8").then(
      (value) => JSON.parse(value) as Phase11BatchManifest,
    ),
    loadPublicationGateInput(),
  ]);

  const liveArtifact = buildPublicationCandidateArtifact(liveInput);
  const liveManifest = buildPublicationCandidateManifest(liveArtifact);
  verifyPublicationCandidateDocuments({
    expectedArtifact: storedArtifact,
    expectedManifest: storedManifest,
    liveArtifact,
    liveManifest,
  });

  const environment = await loadPhase11PublicationEnvironment({
    mountainIds: liveArtifact.candidates.map((candidate) => candidate.summit.mountainId),
  });
  if (!environment.provenanceSchemaAvailable) {
    throw new Error("PHASE11C1_PROVENANCE_SCHEMA_UNAVAILABLE");
  }
  const firstPublished = liveArtifact.candidates.find(
    (candidate) => candidate.canonicalRouteSourceId === FIRST_PUBLISHED_RELATION_ID,
  );
  if (!firstPublished) throw new Error("PHASE11C1_ACTIVE_RELATION_196164_NOT_IN_CANDIDATES");
  const firstPublishedProvenance = createProvenancePayload({
    artifact: liveArtifact,
    manifest: liveManifest,
    candidate: firstPublished,
    qaHistory: liveInput.qaHistory,
  });
  const firstPublishedIdentity = environment.existingPublications.get(
    firstPublishedProvenance.publication_idempotency_key,
  );
  if (
    !firstPublishedIdentity ||
    !publicationIdentityMatches(firstPublishedIdentity, firstPublishedProvenance)
  ) {
    throw new Error("PHASE11C1_RELATION_196164_NOT_ACTIVE_AND_UNCHANGED");
  }
  const expectedBatchManifest = createPhase11C1BatchManifest({
    artifact: liveArtifact,
    manifest: liveManifest,
    qaHistory: liveInput.qaHistory,
    existingPublications: environment.existingPublications,
  });
  verifyPhase11C1BatchManifest({
    provided: batchManifestContent,
    expected: expectedBatchManifest,
  });
  const candidatesByStagingId = new Map(
    liveArtifact.candidates.map((candidate) => [candidate.stagingRouteId, candidate]),
  );
  const filtered = batchManifestContent.records.map((record) => {
    const candidate = candidatesByStagingId.get(record.stagingRouteId);
    if (!candidate) throw new Error(`BATCH_CANDIDATE_MISSING:${record.stagingRouteId}`);
    if (environment.existingPublications.has(record.publicationIdempotencyKey)) {
      throw new Error(`BATCH_CANDIDATE_ALREADY_ACTIVE:${record.sourceRelationId}`);
    }
    return candidate;
  });
  if (filtered.length !== MAX_BATCH_SIZE) {
    throw new Error(`BATCH_SIZE_MUST_EQUAL:${MAX_BATCH_SIZE}`);
  }

  const dryRunRecords = filtered.map((candidate) =>
    dryRunCandidate({
      artifact: liveArtifact,
      manifest: liveManifest,
      candidate,
      qaHistory: liveInput.qaHistory,
      environment,
    }),
  );

  for (const record of dryRunRecords) {
    if (record.action !== "WOULD_CREATE") {
      throw new Error(`CANDIDATE_NOT_WOULD_CREATE:${record.sourceRelationId}:${record.action}`);
    }
    if (record.blockers.length > 0) {
      throw new Error(`CANDIDATE_BLOCKED:${record.sourceRelationId}:${record.blockers.join(",")}`);
    }
    if (record.warnings.length > 0) {
      throw new Error(`CANDIDATE_HAS_WARNINGS:${record.sourceRelationId}:${record.warnings.join(",")}`);
    }
  }

  const verified: VerifiedCandidate[] = [];
  for (let i = 0; i < filtered.length; i += 1) {
    const candidate = filtered[i];
    const dryRunRecord = dryRunRecords[i];
    const request = buildRpcRequest({
      artifact: liveArtifact,
      manifest: liveManifest,
      candidate,
      qaHistory: liveInput.qaHistory,
    });
    verified.push({ candidate, dryRunRecord, request });
  }

  return {
    artifact: liveArtifact,
    manifest: liveManifest,
    batchManifest: batchManifestContent,
    candidates: verified,
    environment,
  };
}

const PROVENANCE_SELECT = [
  "mountain_route_id",
  "staging_route_id",
  "publication_contract_version",
  "publication_idempotency_key",
  "publication_status",
  "provider",
  "canonical_relation_id",
  "source_relation_ids",
  "staging_payload_hash",
  "candidate_content_hash",
  "candidate_set_content_hash",
  "candidate_manifest_hash",
  "dataset_fingerprint",
  "geometry_hash",
  "target_payload_hash",
  "qa_status",
  "qa_decision_version",
  "qa_reviewer_user_id",
  "qa_reviewed_at",
  "qa_reviewer_note",
  "qa_history_snapshot",
  "qa_history_hash",
  "source_url",
  "source_license",
  "source_attribution",
  "topology",
  "audit_evidence",
].join(",");

const MOUNTAIN_ROUTE_SELECT = [
  "id",
  "mountain_id",
  "name",
  "start_location",
  "route_type",
  "difficulty_system",
  "difficulty_value",
  "distance_km",
  "elevation_gain_m",
  "duration_minutes",
  "description",
  "best_season",
  "equipment",
  "warnings",
  "gpx_url",
  "source_name",
  "source_url",
  "is_verified",
  "created_by",
  "geojson_url",
].join(",");

function assertSameValue(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`POST_WRITE_${label}_MISMATCH`);
  }
}

function verifyProvenanceRow(
  row: ProvenanceRow,
  routeId: number,
  expected: PublicationProvenancePayload,
): void {
  const comparisons: Array<[unknown, unknown, string]> = [
    [Number(row.mountain_route_id), routeId, "MOUNTAIN_ROUTE_ID"],
    [row.staging_route_id, expected.staging_route_id, "STAGING_ROUTE_ID"],
    [row.publication_contract_version, expected.publication_contract_version, "PUBLICATION_CONTRACT"],
    [row.publication_idempotency_key, expected.publication_idempotency_key, "IDEMPOTENCY_KEY"],
    [row.publication_status, "ACTIVE", "PUBLICATION_STATUS"],
    [row.provider, expected.provider, "PROVIDER"],
    [row.canonical_relation_id, expected.canonical_relation_id, "CANONICAL_RELATION"],
    [row.source_relation_ids, expected.source_relation_ids, "SOURCE_RELATIONS"],
    [row.staging_payload_hash, expected.staging_payload_hash, "STAGING_HASH"],
    [row.candidate_content_hash, expected.candidate_content_hash, "CANDIDATE_HASH"],
    [row.candidate_set_content_hash, expected.candidate_set_content_hash, "CANDIDATE_SET_HASH"],
    [row.candidate_manifest_hash, expected.candidate_manifest_hash, "CANDIDATE_MANIFEST_HASH"],
    [row.dataset_fingerprint, expected.dataset_fingerprint, "DATASET_FINGERPRINT"],
    [row.geometry_hash, expected.geometry_hash, "GEOMETRY_HASH"],
    [row.target_payload_hash, expected.target_payload_hash, "TARGET_HASH"],
    [row.qa_status, expected.qa_status, "QA_STATUS"],
    [Number(row.qa_decision_version), expected.qa_decision_version, "QA_VERSION"],
    [row.qa_reviewer_user_id, expected.qa_reviewer_user_id, "QA_REVIEWER"],
    [row.qa_reviewer_note, expected.qa_reviewer_note, "QA_NOTE"],
    [row.qa_history_snapshot, expected.qa_history_snapshot, "QA_HISTORY"],
    [row.qa_history_hash, expected.qa_history_hash, "QA_HISTORY_HASH"],
    [row.source_url, expected.source_url, "SOURCE_URL"],
    [row.source_license, expected.source_license, "SOURCE_LICENSE"],
    [row.source_attribution, expected.source_attribution, "SOURCE_ATTRIBUTION"],
    [row.topology, expected.topology, "TOPOLOGY"],
    [row.audit_evidence, expected.audit_evidence, "AUDIT_EVIDENCE"],
  ];
  for (const [actual, expectedValue, label] of comparisons) {
    assertSameValue(actual, expectedValue, label);
  }
  if (
    new Date(String(row.qa_reviewed_at)).getTime() !==
    new Date(expected.qa_reviewed_at).getTime()
  ) {
    throw new Error("POST_WRITE_QA_REVIEWED_AT_MISMATCH");
  }
}

async function loadCandidateRouteRows(
  client: SupabaseClient,
  artifact: PublicationCandidateArtifact,
): Promise<Array<{ id: number; source_url: string | null }>> {
  const sourceUrls = artifact.candidates.map((candidate) => candidate.provenance.sourceUrl);
  const result = await client
    .from("mountain_routes")
    .select("id,source_url")
    .in("source_url", sourceUrls)
    .order("id", { ascending: true });
  if (result.error) {
    throw new Error(`CANDIDATE_ROUTE_SNAPSHOT_FAILED:${result.error.message}`);
  }
  return (result.data ?? []).map((row) => ({
    id: Number(row.id),
    source_url: row.source_url === null ? null : String(row.source_url),
  }));
}

async function executeBatch(
  client: SupabaseClient,
  preflight: {
    artifact: PublicationCandidateArtifact;
    manifest: PublicationCandidateManifest;
    candidates: VerifiedCandidate[];
    environment: Awaited<ReturnType<typeof loadPhase11PublicationEnvironment>>;
  },
): Promise<void> {
  let expectedCandidateRoutes = await loadCandidateRouteRows(client, preflight.artifact);
  const results: Array<{
    sourceRelationId: string;
    stagingRouteId: string;
    action: string;
    mountainRouteId: number | null;
    rollbackIdentity?: {
      publication_idempotency_key: string;
      mountain_route_id: number | null;
      expected_target_payload_hash: string;
    };
    success: boolean;
  }> = [];

  for (const verified of preflight.candidates) {
    const { candidate, request } = verified;
    let mountainRouteId: number | null = null;

    try {
      const rpcResult = await client.rpc(RPC_NAME, { p_request: request });
      if (rpcResult.error) throw new Error(`PUBLICATION_RPC_FAILED:${rpcResult.error.message}`);
      const rows = (rpcResult.data ?? []) as RpcResultRow[];
      if (rows.length !== 1) throw new Error("PUBLICATION_RPC_RESULT_COUNT_NOT_ONE");
      const [row] = rows;
      const returnedRouteId = Number(row.mountain_route_id);
      if (Number.isSafeInteger(returnedRouteId) && returnedRouteId > 0) {
        mountainRouteId = returnedRouteId;
      }
      if (row.action !== "CREATED" || mountainRouteId === null) {
        throw new Error("PUBLICATION_RPC_RESULT_INVALID");
      }

      const [provenanceResult, routeResult, afterCandidateRoutes] = await Promise.all([
        client
          .from("osm_route_publication_provenance")
          .select(PROVENANCE_SELECT)
          .eq("publication_idempotency_key", request.provenancePayload.publication_idempotency_key)
          .eq("publication_status", "ACTIVE"),
        client.from("mountain_routes").select(MOUNTAIN_ROUTE_SELECT).eq("id", mountainRouteId ?? -1),
        loadCandidateRouteRows(client, preflight.artifact),
      ]);

      if (provenanceResult.error) throw new Error(`POST_WRITE_PROVENANCE_FAILED:${provenanceResult.error.message}`);
      if (routeResult.error) throw new Error(`POST_WRITE_ROUTE_FAILED:${routeResult.error.message}`);

      const provenanceRows = (provenanceResult.data ?? []) as unknown as ProvenanceRow[];
      if (provenanceRows.length !== 1) throw new Error("POST_WRITE_ACTIVE_PROVENANCE_COUNT_NOT_ONE");
      verifyProvenanceRow(provenanceRows[0], mountainRouteId!, request.provenancePayload);

      const routeRows = (routeResult.data ?? []) as unknown as Array<Record<string, unknown>>;
      if (routeRows.length !== 1) throw new Error("POST_WRITE_MOUNTAIN_ROUTE_COUNT_NOT_ONE");
      const { id: returnedId, ...routePayload } = routeRows[0];
      if (Number(returnedId) !== mountainRouteId) throw new Error("POST_WRITE_RETURNED_ROUTE_ID_MISMATCH");

      const normalizedRoutePayload = {
        ...routePayload,
        distance_km: Number(routePayload.distance_km),
      };
      const expectedForDbComparison = {
        ...request.mountainRoutePayload,
        distance_km: Math.round(request.mountainRoutePayload.distance_km * 100) / 100,
      };
      assertSameValue(normalizedRoutePayload, expectedForDbComparison, "MOUNTAIN_ROUTE_PAYLOAD");

      if (
        sha256Stable(request.mountainRoutePayload) !==
        request.provenancePayload.target_payload_hash
      ) {
        throw new Error("POST_WRITE_TARGET_PAYLOAD_HASH_MISMATCH");
      }

      const expectedSourceUrl = request.mountainRoutePayload.source_url ?? "";
      verifyNoSecondCandidate({
        before: expectedCandidateRoutes,
        after: afterCandidateRoutes,
        createdRouteId: mountainRouteId,
        expectedSourceUrl,
      });
      expectedCandidateRoutes = afterCandidateRoutes;

      results.push({
        sourceRelationId: candidate.sourceRelationId,
        stagingRouteId: candidate.stagingRouteId,
        action: row.action,
        mountainRouteId,
        success: true,
      });
    } catch (error) {
      const rollbackIdentity = {
        publication_idempotency_key: request.provenancePayload.publication_idempotency_key,
        mountain_route_id: mountainRouteId,
        expected_target_payload_hash: request.provenancePayload.target_payload_hash,
      };
      results.push({
        sourceRelationId: candidate.sourceRelationId,
        stagingRouteId: candidate.stagingRouteId,
        action: "FAILED",
        mountainRouteId,
        rollbackIdentity,
        success: false,
      });

      console.error(
        JSON.stringify(
          {
            batchStatus: "STOPPED",
            failedRoute: candidate.sourceRelationId,
            automaticRollback: false,
            rollbackIdentity,
          },
          null,
          2,
        ),
      );
      throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: "EXECUTE",
        status: "PASS",
        rpcCalls: results.length,
        results: results.map((r) => ({
          sourceRelationId: r.sourceRelationId,
          action: r.action,
          mountainRouteId: r.mountainRouteId,
        })),
        batchVerification: "PASS",
      },
      null,
      2,
    ),
  );
}

function verifyNoSecondCandidate(input: {
  before: Array<{ id: number; source_url: string | null }>;
  after: Array<{ id: number; source_url: string | null }>;
  createdRouteId: number;
  expectedSourceUrl: string;
}): void {
  const expectedAfter = [
    ...input.before,
    { id: input.createdRouteId, source_url: input.expectedSourceUrl },
  ].sort((left, right) => left.id - right.id);
  assertSameValue(input.after, expectedAfter, "CANDIDATE_ROUTE_SCOPE");
}

function printPreflight(preflight: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  batchManifest: Phase11BatchManifest;
  candidates: VerifiedCandidate[];
  environment: Awaited<ReturnType<typeof loadPhase11PublicationEnvironment>>;
}, batchManifestPath: string): void {
  const wouldCreate = preflight.candidates.filter((c) => c.dryRunRecord.action === "WOULD_CREATE").length;
  const unchanged = preflight.candidates.filter(
    (candidate) => candidate.dryRunRecord.action === "WOULD_SKIP_UNCHANGED",
  ).length;
  const blocked = preflight.candidates.filter(
    (candidate) => candidate.dryRunRecord.action === "BLOCKED",
  ).length;
  const warningCandidates = preflight.candidates.filter(
    (candidate) => candidate.dryRunRecord.warnings.length > 0,
  ).length;
  const manifestArgument =
    batchManifestPath === DEFAULT_BATCH_MANIFEST
      ? `data/osm/alps/publication/${PHASE11C1_BATCH_MANIFEST_NAME}`
      : batchManifestPath;

  console.log(
    JSON.stringify(
      {
        mode: "PREFLIGHT_READ_ONLY",
        status: "PASS",
        authorizedScope: {
          provider: "openstreetmap",
          sourceType: "relation",
          maxBatchSize: MAX_BATCH_SIZE,
          batchSize: preflight.candidates.length,
          excludedActiveRelationId: FIRST_PUBLISHED_RELATION_ID,
          excludedSemanticRiskRelationIds: PHASE11C1_SEMANTIC_RISK_RELATION_IDS,
        },
        phase10LiveVerification: {
          candidateCount: preflight.artifact.candidateCount,
          blockedCandidateCount: preflight.artifact.blockedCandidateCount,
          totalReviewedRoutes: preflight.artifact.totalReviewedRoutes,
          qaHistoryIntegrity: preflight.artifact.qaHistoryIntegrity.status,
          qaHistoryEvents: preflight.artifact.qaHistoryIntegrity.historyEventCount,
          artifactHash: preflight.artifact.deterministicContentHash,
          manifestHash: preflight.manifest.overallDeterministicManifestHash,
        },
        excludedExistingPublication: {
          canonicalRelationId: FIRST_PUBLISHED_RELATION_ID,
          publicationStatus: "ACTIVE",
          identityMatch: "PASS",
        },
        batchDryRun: {
          attempted: preflight.candidates.length,
          wouldCreate,
          unchanged,
          blocked,
          warningCandidates,
          provenanceSchemaAvailable: preflight.environment.provenanceSchemaAvailable,
          activePublicationConflicts: 0,
          rpcCalls: 0,
          databaseWrites: 0,
          publicationWrites: 0,
        },
        batchManifest: {
          path: manifestArgument,
          deterministicBatchManifestHash:
            preflight.batchManifest.deterministicBatchManifestHash,
          selectionOrder: PHASE11C1_SELECTION_ORDER,
          selectionReason: preflight.batchManifest.selectionReason,
        },
        candidates: preflight.candidates.map((c) => ({
          sourceRelationId: c.candidate.sourceRelationId,
          canonicalRelationId: c.candidate.canonicalRouteSourceId,
          stagingRouteId: c.candidate.stagingRouteId,
          mountainId: c.candidate.summit.mountainId,
          routeName: c.candidate.routeName,
          dryRunAction: c.dryRunRecord.action,
        })),
        writes: { rpcCalls: 0, databaseWrites: 0, publicationWrites: 0 },
        executeCommand:
          `node --experimental-strip-types scripts/osm-import/publish-batch.ts --execute --batch-manifest ${manifestArgument}`,
      },
      null,
      2,
    ),
  );
}

const arguments_ = parseArguments(process.argv.slice(2));
const preflight = await loadVerifiedBatch(arguments_.batchManifestPath!);
if (arguments_.execute) await executeBatch(serviceClient(), preflight);
else printPreflight(preflight, arguments_.batchManifestPath!);
