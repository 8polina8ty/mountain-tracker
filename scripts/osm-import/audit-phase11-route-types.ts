import { readFile } from "node:fs/promises";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  createProvenancePayload,
  publicationIdentityMatches,
  type ExistingPublicationIdentity,
} from "./phase11-publication.ts";
import {
  MOUNTAIN_ROUTE_TYPES,
  classifyRouteActivity,
  type MountainRouteType,
} from "./route-activity-classifier.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvironment(await readFile(".env.local", "utf8"));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing read-only Supabase credentials.");
const supabaseUrl = url;
const serviceKey = key;

async function restGet(path: string): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: serviceKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`READ_ONLY_QUERY_FAILED:${response.status}`);
  return response.json();
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

const [artifact, manifest, routeText, activeRows, liveInput, activeRouteRows] = await Promise.all([
  readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile("data/osm/alps/routes.jsonl", "utf8"),
  restGet(
    "osm_route_publication_provenance?select=mountain_route_id,canonical_relation_id,publication_contract_version,publication_status,publication_idempotency_key,staging_payload_hash,candidate_content_hash,candidate_set_content_hash,candidate_manifest_hash,dataset_fingerprint,geometry_hash,qa_decision_version,qa_history_hash,target_payload_hash&publication_status=eq.ACTIVE&order=mountain_route_id.asc",
  ) as Promise<ActiveRow[]>,
  loadPublicationGateInput(),
  restGet("mountain_routes?select=id,source_url,route_type&id=in.(2,3,4,5,6,7)&order=id.asc") as Promise<Array<{ id: number; source_url: string; route_type: string }>>,
]);

const liveArtifact = buildPublicationCandidateArtifact(liveInput);
const liveManifest = buildPublicationCandidateManifest(liveArtifact);
verifyPublicationCandidateDocuments({
  expectedArtifact: artifact,
  expectedManifest: manifest,
  liveArtifact,
  liveManifest,
});

const identityChecks = activeRows.map((row) => {
  const candidate = liveArtifact.candidates.find(
    (value) => value.canonicalRouteSourceId === row.canonical_relation_id,
  );
  if (!candidate) throw new Error(`ACTIVE_CANDIDATE_MISSING:${row.canonical_relation_id}`);
  const expected = createProvenancePayload({
    artifact: liveArtifact,
    manifest: liveManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
  });
  const actual: ExistingPublicationIdentity = {
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
  return {
    mountainRouteId: row.mountain_route_id,
    relationId: row.canonical_relation_id,
    contract: row.publication_contract_version,
    identityMatch: publicationIdentityMatches(actual, expected),
  };
});
if (
  identityChecks.length !== 6 ||
  identityChecks.some((value) => !value.identityMatch || value.contract !== "mountain-tracker-osm-publication/v1") ||
  activeRouteRows.length !== 6 ||
  activeRouteRows.some((row) => row.route_type !== "hiking")
) {
  throw new Error("ACTIVE_V1_PUBLICATION_IDENTITY_DRIFT");
}

const activeRelationIds = new Set(activeRows.map((row) => row.canonical_relation_id));
const rawRoutes = new Map(
  routeText.trim().split(/\r?\n/).map((line) => {
    const route = JSON.parse(line) as ClassifiableRoute;
    return [route.sourceId, route] as const;
  }),
);
const groups: Record<MountainRouteType, Array<Record<string, unknown>>> = {
  hiking: [],
  mountaineering: [],
  via_ferrata: [],
  climbing: [],
  ski_touring: [],
  mixed: [],
  other: [],
};

for (const candidate of artifact.candidates) {
  if (activeRelationIds.has(candidate.canonicalRouteSourceId)) continue;
  const route = rawRoutes.get(candidate.sourceRelationId);
  if (!route) throw new Error(`RAW_ROUTE_MISSING:${candidate.sourceRelationId}`);
  const activity = classifyRouteActivity(route);
  groups[activity.routeType].push({
    relationId: candidate.canonicalRouteSourceId,
    name: candidate.routeName,
    mountainId: candidate.summit.mountainId,
    semanticType: candidate.semanticType,
    manualReviewRequired: activity.manualReviewRequired,
    evidence: activity.evidence,
  });
}
for (const values of Object.values(groups)) {
  values.sort((left, right) => Number(left.relationId) - Number(right.relationId));
}

const relation140270 = groups.via_ferrata.find((value) => value.relationId === "140270") ?? null;
console.log(JSON.stringify({
  mode: "READ_ONLY",
  production: {
    activeCount: activeRows.length,
    identityChecks,
    mountainRouteRows: activeRouteRows,
  },
  phase10LiveVerification: {
    candidateCount: liveArtifact.candidateCount,
    reviewed: liveArtifact.totalReviewedRoutes,
    qaHistoryIntegrity: liveArtifact.qaHistoryIntegrity.status,
    qaHistoryEvents: liveArtifact.qaHistoryIntegrity.historyEventCount,
    candidateContentHash: liveArtifact.deterministicContentHash,
    candidateManifestHash: liveManifest.overallDeterministicManifestHash,
  },
  candidateSetCount: artifact.candidates.length,
  unpublishedCount: Object.values(groups).reduce((sum, values) => sum + values.length, 0),
  counts: Object.fromEntries(MOUNTAIN_ROUTE_TYPES.map((type) => [type, groups[type].length])),
  candidates: groups,
  relation140270,
  rpcCalls: 0,
  databaseWrites: 0,
  publicationWrites: 0,
}, null, 2));
