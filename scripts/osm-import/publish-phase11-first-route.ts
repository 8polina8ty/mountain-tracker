import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
import { loadPhase11PublicationEnvironment } from "./phase11-live-data.ts";
import {
  createFirstRouteManifest,
  createProvenancePayload,
  dryRunCandidate,
  mapMountainRoute,
  sha256Stable,
  type ExistingPublicationIdentity,
  type MountainRoutePayload,
  type Phase11FirstRouteManifest,
  type PublicationProvenancePayload,
} from "./phase11-publication.ts";

const AUTHORIZED_RELATION_ID = "196164";
const FIRST_ROUTE_MANIFEST_PATH = resolve(
  "data/osm/alps/publication/phase11-first-route.json",
);
const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const EXECUTE_COMMAND =
  "node --experimental-strip-types scripts/osm-import/publish-phase11-first-route.ts --execute --relation 196164";

interface CliArguments {
  execute: boolean;
  relationId: string | null;
}

interface PublishApprovedOsmRouteRequest {
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

interface CandidateRouteRow {
  id: number;
  source_url: string | null;
}

interface ProvenanceRow extends Record<string, unknown> {
  mountain_route_id: number;
  publication_idempotency_key: string;
}

interface VerifiedPreflight {
  liveArtifact: PublicationCandidateArtifact;
  liveManifest: PublicationCandidateManifest;
  candidate: PublicationCandidateRecord;
  request: PublishApprovedOsmRouteRequest;
  phase10Verification: ReturnType<typeof verifyPublicationCandidateDocuments>;
  preexistingPublications: Map<string, ExistingPublicationIdentity>;
}

function parseArguments(argv: string[]): CliArguments {
  const allowed = new Set(["--execute", "--relation"]);
  let execute = false;
  let relationId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    if (argument === "--execute") {
      if (execute) throw new Error("DUPLICATE_EXECUTE_FLAG");
      execute = true;
      continue;
    }
    if (relationId !== null) throw new Error("DUPLICATE_RELATION_FLAG");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("RELATION_ID_REQUIRED");
    relationId = value;
    index += 1;
  }

  if (relationId !== null && relationId !== AUTHORIZED_RELATION_ID) {
    throw new Error(`RELATION_NOT_AUTHORIZED:${relationId}`);
  }
  if (execute && relationId !== AUTHORIZED_RELATION_ID) {
    throw new Error("EXECUTE_REQUIRES_EXPLICIT_RELATION_196164");
  }
  return { execute, relationId };
}

function verifyFirstRouteManifest(
  provided: Phase11FirstRouteManifest,
  expected: Phase11FirstRouteManifest,
): void {
  const { deterministicManifestHash, ...content } = provided;
  if (sha256Stable(content) !== deterministicManifestHash) {
    throw new Error("FIRST_ROUTE_MANIFEST_HASH_DRIFT");
  }
  if (stableJson(provided) !== stableJson(expected)) {
    throw new Error("FIRST_ROUTE_MANIFEST_CONTENT_DRIFT");
  }
}

function buildRpcRequest(input: {
  artifact: PublicationCandidateArtifact;
  manifest: PublicationCandidateManifest;
  candidate: PublicationCandidateRecord;
  qaHistory: Parameters<typeof createProvenancePayload>[0]["qaHistory"];
}): PublishApprovedOsmRouteRequest {
  const { candidateContentHash, ...candidateContent } = input.candidate;
  const { overallDeterministicManifestHash, ...manifestContent } = input.manifest;
  const mountainRoutePayload = mapMountainRoute(input.candidate);
  const provenancePayload = createProvenancePayload(input);
  const request = {
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
    [
      sha256Stable(manifestContent),
      request.candidateManifestHash,
      "CANDIDATE_MANIFEST",
    ],
    [
      sha256Stable(mountainRoutePayload),
      provenancePayload.target_payload_hash,
      "TARGET_PAYLOAD",
    ],
    [
      sha256Stable(input.candidate.originalGeometry),
      provenancePayload.geometry_hash,
      "GEOMETRY",
    ],
    [
      sha256Stable(provenancePayload.qa_history_snapshot),
      provenancePayload.qa_history_hash,
      "QA_HISTORY",
    ],
  ] as const;
  for (const [actual, expected, label] of hashChecks) {
    if (actual !== expected) throw new Error(`${label}_CANONICAL_HASH_DRIFT`);
  }
  return request;
}

async function loadVerifiedPreflight(): Promise<VerifiedPreflight> {
  const [storedArtifact, storedManifest, providedFirstManifest, liveInput] =
    await Promise.all([
      readFile(resolve(STAGING_DIRECTORY, "publication-candidates.json"), "utf8").then(
        (value) => JSON.parse(value) as PublicationCandidateArtifact,
      ),
      readFile(
        resolve(STAGING_DIRECTORY, "publication-candidate-manifest.json"),
        "utf8",
      ).then((value) => JSON.parse(value) as PublicationCandidateManifest),
      readFile(FIRST_ROUTE_MANIFEST_PATH, "utf8").then(
        (value) => JSON.parse(value) as Phase11FirstRouteManifest,
      ),
      loadPublicationGateInput(),
    ]);

  const liveArtifact = buildPublicationCandidateArtifact(liveInput);
  const liveManifest = buildPublicationCandidateManifest(liveArtifact);
  const phase10Verification = verifyPublicationCandidateDocuments({
    expectedArtifact: storedArtifact,
    expectedManifest: storedManifest,
    liveArtifact,
    liveManifest,
  });
  const expectedFirstManifest = createFirstRouteManifest({
    artifact: liveArtifact,
    manifest: liveManifest,
    qaHistory: liveInput.qaHistory,
  });
  verifyFirstRouteManifest(providedFirstManifest, expectedFirstManifest);

  if (providedFirstManifest.canonicalRelationId !== AUTHORIZED_RELATION_ID) {
    throw new Error("FIRST_ROUTE_MANIFEST_RELATION_NOT_AUTHORIZED");
  }
  if (
    providedFirstManifest.sourceRelationIds.length !== 1 ||
    providedFirstManifest.sourceRelationIds[0] !== AUTHORIZED_RELATION_ID
  ) {
    throw new Error("FIRST_ROUTE_MANIFEST_SOURCE_SCOPE_NOT_EXACT");
  }
  const candidates = liveArtifact.candidates.filter(
    (candidate) => candidate.canonicalRouteSourceId === AUTHORIZED_RELATION_ID,
  );
  if (candidates.length > 1) throw new Error("MULTIPLE_CANDIDATES_NOT_AUTHORIZED");
  if (candidates.length !== 1) throw new Error("AUTHORIZED_CANDIDATE_NOT_FOUND");
  const [candidate] = candidates;
  if (
    candidate.stagingRouteId !== providedFirstManifest.stagingRouteId ||
    candidate.sourceRelationId !== AUTHORIZED_RELATION_ID ||
    candidate.duplicateProvenance.sourceRouteIds.length !== 1 ||
    candidate.duplicateProvenance.sourceRouteIds[0] !== AUTHORIZED_RELATION_ID
  ) {
    throw new Error("AUTHORIZED_CANDIDATE_SOURCE_SCOPE_NOT_EXACT");
  }

  const environment = await loadPhase11PublicationEnvironment({
    mountainIds: [candidate.summit.mountainId],
  });
  const records = [
    dryRunCandidate({
      artifact: liveArtifact,
      manifest: liveManifest,
      candidate,
      qaHistory: liveInput.qaHistory,
      environment,
    }),
  ];
  if (records.length !== 1) throw new Error("PREFLIGHT_ATTEMPT_COUNT_NOT_ONE");
  const [record] = records;
  if (record.action !== "WOULD_CREATE") {
    throw new Error(`PREFLIGHT_ACTION_NOT_WOULD_CREATE:${record.action}`);
  }
  if (record.blockers.length !== 0) {
    throw new Error(`PREFLIGHT_BLOCKERS:${record.blockers.join(",")}`);
  }
  if (record.warnings.length !== 0) {
    throw new Error(`PREFLIGHT_WARNINGS:${record.warnings.join(",")}`);
  }
  if (!environment.provenanceSchemaAvailable) {
    throw new Error("PUBLICATION_PROVENANCE_SCHEMA_UNAVAILABLE");
  }

  const request = buildRpcRequest({
    artifact: liveArtifact,
    manifest: liveManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
  });
  if (
    request.provenancePayload.canonical_relation_id !== AUTHORIZED_RELATION_ID ||
    request.provenancePayload.publication_idempotency_key !==
      `openstreetmap:relation:${AUTHORIZED_RELATION_ID}:mountain-tracker-osm-route/v1:mountain-tracker-osm-publication/v1`
  ) {
    throw new Error("RPC_REQUEST_IDENTITY_NOT_AUTHORIZED");
  }

  return {
    liveArtifact,
    liveManifest,
    candidate,
    request,
    phase10Verification,
    preexistingPublications: environment.existingPublications,
  };
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Phase 11 service-role Supabase credentials.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

async function loadCandidateRouteRows(
  client: SupabaseClient,
  artifact: PublicationCandidateArtifact,
): Promise<CandidateRouteRow[]> {
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
    [
      row.publication_contract_version,
      expected.publication_contract_version,
      "PUBLICATION_CONTRACT",
    ],
    [
      row.publication_idempotency_key,
      expected.publication_idempotency_key,
      "IDEMPOTENCY_KEY",
    ],
    [row.publication_status, "ACTIVE", "PUBLICATION_STATUS"],
    [row.provider, expected.provider, "PROVIDER"],
    [row.canonical_relation_id, expected.canonical_relation_id, "CANONICAL_RELATION"],
    [row.source_relation_ids, expected.source_relation_ids, "SOURCE_RELATIONS"],
    [row.staging_payload_hash, expected.staging_payload_hash, "STAGING_HASH"],
    [row.candidate_content_hash, expected.candidate_content_hash, "CANDIDATE_HASH"],
    [
      row.candidate_set_content_hash,
      expected.candidate_set_content_hash,
      "CANDIDATE_SET_HASH",
    ],
    [
      row.candidate_manifest_hash,
      expected.candidate_manifest_hash,
      "CANDIDATE_MANIFEST_HASH",
    ],
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

function verifyNoSecondCandidate(input: {
  before: CandidateRouteRow[];
  after: CandidateRouteRow[];
  createdRouteId: number;
  expectedSourceUrl: string;
}): void {
  const expectedAfter = [
    ...input.before,
    { id: input.createdRouteId, source_url: input.expectedSourceUrl },
  ].sort((left, right) => left.id - right.id);
  assertSameValue(input.after, expectedAfter, "CANDIDATE_ROUTE_SCOPE");
}

async function executeSinglePublication(preflight: VerifiedPreflight): Promise<void> {
  const client = serviceClient();
  const beforeCandidateRoutes = await loadCandidateRouteRows(client, preflight.liveArtifact);
  let rpcSucceeded = false;
  let mountainRouteId: number | null = null;

  try {
    const rpcResult = await client.rpc("publish_approved_osm_route", {
      p_request: preflight.request,
    });
    if (rpcResult.error) throw new Error(`PUBLICATION_RPC_FAILED:${rpcResult.error.message}`);
    rpcSucceeded = true;
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

    const [provenanceResult, routeResult, activeResult, afterCandidateRoutes] =
      await Promise.all([
        client
          .from("osm_route_publication_provenance")
          .select(PROVENANCE_SELECT)
          .eq(
            "publication_idempotency_key",
            preflight.request.provenancePayload.publication_idempotency_key,
          )
          .eq("publication_status", "ACTIVE"),
        client.from("mountain_routes").select(MOUNTAIN_ROUTE_SELECT).eq("id", mountainRouteId),
        client
          .from("osm_route_publication_provenance")
          .select(PROVENANCE_SELECT)
          .eq("publication_status", "ACTIVE"),
        loadCandidateRouteRows(client, preflight.liveArtifact),
      ]);
    if (provenanceResult.error) {
      throw new Error(`POST_WRITE_PROVENANCE_QUERY_FAILED:${provenanceResult.error.message}`);
    }
    if (routeResult.error) {
      throw new Error(`POST_WRITE_ROUTE_QUERY_FAILED:${routeResult.error.message}`);
    }
    if (activeResult.error) {
      throw new Error(`POST_WRITE_ACTIVE_SET_QUERY_FAILED:${activeResult.error.message}`);
    }
    const provenanceRows = (provenanceResult.data ?? []) as unknown as ProvenanceRow[];
    if (provenanceRows.length !== 1) {
      throw new Error("POST_WRITE_ACTIVE_PROVENANCE_COUNT_NOT_ONE");
    }
    verifyProvenanceRow(
      provenanceRows[0],
      mountainRouteId,
      preflight.request.provenancePayload,
    );

    const routeRows = (routeResult.data ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    if (routeRows.length !== 1) throw new Error("POST_WRITE_MOUNTAIN_ROUTE_COUNT_NOT_ONE");
    const { id: returnedId, ...routePayload } = routeRows[0];
    if (Number(returnedId) !== mountainRouteId) {
      throw new Error("POST_WRITE_RETURNED_ROUTE_ID_MISMATCH");
    }
    const normalizedRoutePayload = {
      ...routePayload,
      distance_km: Number(routePayload.distance_km),
    };
    const expectedPayloadForDbComparison = {
      ...preflight.request.mountainRoutePayload,
      distance_km: Math.round(preflight.request.mountainRoutePayload.distance_km * 100) / 100,
    };
    assertSameValue(
      normalizedRoutePayload,
      expectedPayloadForDbComparison,
      "MOUNTAIN_ROUTE_PAYLOAD",
    );
    if (
      sha256Stable(preflight.request.mountainRoutePayload) !==
      preflight.request.provenancePayload.target_payload_hash
    ) {
      throw new Error("POST_WRITE_TARGET_PAYLOAD_HASH_MISMATCH");
    }

    const activeRows = (activeResult.data ?? []) as unknown as ProvenanceRow[];
    const beforeKeys = [...preflight.preexistingPublications.keys()].sort();
    const afterKeys = activeRows
      .map((activeRow) => String(activeRow.publication_idempotency_key))
      .sort();
    assertSameValue(
      afterKeys,
      [...beforeKeys, preflight.request.provenancePayload.publication_idempotency_key].sort(),
      "ACTIVE_PROVENANCE_SCOPE",
    );
    verifyNoSecondCandidate({
      before: beforeCandidateRoutes,
      after: afterCandidateRoutes,
      createdRouteId: mountainRouteId,
      expectedSourceUrl: preflight.request.mountainRoutePayload.source_url,
    });

    console.log(
      JSON.stringify(
        {
          mode: "EXECUTE",
          status: "PASS",
          rpcCalls: 1,
          action: row.action,
          canonicalRelationId: AUTHORIZED_RELATION_ID,
          mountainRouteId,
          publicationIdempotencyKey:
            preflight.request.provenancePayload.publication_idempotency_key,
          targetPayloadHash: preflight.request.provenancePayload.target_payload_hash,
          postWriteVerification: "PASS",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (rpcSucceeded) {
      if (mountainRouteId === null) {
        const recovery = await client
          .from("osm_route_publication_provenance")
          .select("mountain_route_id")
          .eq(
            "publication_idempotency_key",
            preflight.request.provenancePayload.publication_idempotency_key,
          )
          .eq("publication_status", "ACTIVE");
        if (!recovery.error && recovery.data?.length === 1) {
          const recoveredRouteId = Number(recovery.data[0].mountain_route_id);
          if (Number.isSafeInteger(recoveredRouteId) && recoveredRouteId > 0) {
            mountainRouteId = recoveredRouteId;
          }
        }
      }
      console.error(
        JSON.stringify(
          {
            postWriteVerification: "FAILED",
            automaticRollback: false,
            rollbackIdentity: {
              publication_idempotency_key:
                preflight.request.provenancePayload.publication_idempotency_key,
              mountain_route_id: mountainRouteId,
              expected_target_payload_hash:
                preflight.request.provenancePayload.target_payload_hash,
            },
          },
          null,
          2,
        ),
      );
    }
    throw error;
  }
}

function printPreflight(preflight: VerifiedPreflight): void {
  const { request, candidate, phase10Verification, liveArtifact, liveManifest } = preflight;
  console.log(
    JSON.stringify(
      {
        mode: "PREFLIGHT_READ_ONLY",
        status: "PASS",
        authorizedScope: {
          provider: "openstreetmap",
          sourceType: "relation",
          canonicalRelationId: AUTHORIZED_RELATION_ID,
          maximumCandidates: 1,
          maximumRpcCalls: 1,
        },
        phase10LiveVerification: {
          ...phase10Verification,
          totalReviewedRoutes: liveArtifact.totalReviewedRoutes,
          qaHistoryIntegrity: liveArtifact.qaHistoryIntegrity.status,
          qaHistoryEvents: liveArtifact.qaHistoryIntegrity.historyEventCount,
        },
        phase11DryRun: {
          attempted: 1,
          action: "WOULD_CREATE",
          blockers: 0,
          warnings: 0,
          provenanceSchemaAvailable: true,
        },
        selectedCandidate: {
          sourceRelationId: candidate.sourceRelationId,
          canonicalRelationId: candidate.canonicalRouteSourceId,
          stagingRouteId: candidate.stagingRouteId,
          mountainId: candidate.summit.mountainId,
        },
        rpcRequest: {
          function: "public.publish_approved_osm_route(jsonb)",
          argument: "p_request",
          fields: Object.keys(request),
          hashes: {
            candidateContentHash: request.candidateContentHash,
            candidateManifestHash: request.candidateManifestHash,
            candidateSetContentHash: liveArtifact.deterministicContentHash,
            geometryHash: request.provenancePayload.geometry_hash,
            qaHistoryHash: request.provenancePayload.qa_history_hash,
            targetPayloadHash: request.provenancePayload.target_payload_hash,
          },
          canonicalJsonBytes: {
            candidate: Buffer.byteLength(request.candidateCanonicalJson, "utf8"),
            manifest: Buffer.byteLength(request.manifestCanonicalJson, "utf8"),
            mountainRoute: Buffer.byteLength(request.mountainRouteCanonicalJson, "utf8"),
            geometry: Buffer.byteLength(request.geometryCanonicalJson, "utf8"),
            qaHistory: Buffer.byteLength(request.qaHistoryCanonicalJson, "utf8"),
          },
          publicationIdempotencyKey:
            request.provenancePayload.publication_idempotency_key,
          liveManifestHash: liveManifest.overallDeterministicManifestHash,
          payloadsRedacted: true,
        },
        writes: { rpcCalls: 0, databaseWrites: 0, publicationWrites: 0 },
        executeCommand: EXECUTE_COMMAND,
      },
      null,
      2,
    ),
  );
}

const arguments_ = parseArguments(process.argv.slice(2));
const preflight = await loadVerifiedPreflight();
if (arguments_.execute) await executeSinglePublication(preflight);
else printPreflight(preflight);
