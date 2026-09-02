import type { ExistingPublicationIdentity } from "./phase11-publication.ts";

interface RestError {
  code?: string;
  message?: string;
}

function credentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing read-only Supabase credentials.");
  return { url, key };
}

async function restGet(path: string): Promise<Response> {
  const { url, key } = credentials();
  return fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: key },
    signal: AbortSignal.timeout(20_000),
  });
}

export async function loadPhase11PublicationEnvironment(input: {
  mountainIds: number[];
}): Promise<{
  mountainIds: Set<number>;
  legacySourceUrls: Set<string>;
  existingPublications: Map<string, ExistingPublicationIdentity>;
  provenanceSchemaAvailable: boolean;
}> {
  const uniqueMountainIds = [...new Set(input.mountainIds)].sort((a, b) => a - b);
  const mountainFilter = `(${uniqueMountainIds.join(",")})`;
  const [mountainsResponse, routesResponse, provenanceResponse] = await Promise.all([
    restGet(`mountains?select=id&id=in.${mountainFilter}`),
    restGet("mountain_routes?select=id,source_url&order=id.asc"),
    restGet(
      "osm_route_publication_provenance?select=publication_idempotency_key,staging_payload_hash,candidate_content_hash,candidate_set_content_hash,candidate_manifest_hash,dataset_fingerprint,geometry_hash,qa_decision_version,qa_history_hash,target_payload_hash,publication_status&publication_status=eq.ACTIVE",
    ),
  ]);
  if (!mountainsResponse.ok) {
    throw new Error(`Mountain validation query failed: ${mountainsResponse.status}`);
  }
  if (!routesResponse.ok) {
    throw new Error(`Existing route query failed: ${routesResponse.status}`);
  }
  const mountainRows = (await mountainsResponse.json()) as Array<{ id: number }>;
  const routeRows = (await routesResponse.json()) as Array<{
    id: number;
    source_url: string | null;
  }>;
  let provenanceSchemaAvailable = provenanceResponse.ok;
  let provenanceRows: Array<Record<string, unknown>> = [];
  if (provenanceResponse.ok) {
    provenanceRows = (await provenanceResponse.json()) as Array<Record<string, unknown>>;
  } else {
    const error = (await provenanceResponse.json().catch(() => ({}))) as RestError;
    if (provenanceResponse.status !== 404 && error.code !== "PGRST205") {
      throw new Error(
        `Publication provenance query failed: ${error.message ?? provenanceResponse.status}`,
      );
    }
    provenanceSchemaAvailable = false;
  }
  return {
    mountainIds: new Set(mountainRows.map((row) => Number(row.id))),
    legacySourceUrls: new Set(
      routeRows.flatMap((row) => (row.source_url ? [row.source_url] : [])),
    ),
    existingPublications: new Map(
      provenanceRows.map((row) => {
        const value: ExistingPublicationIdentity = {
          publicationIdempotencyKey: String(row.publication_idempotency_key),
          stagingPayloadHash: String(row.staging_payload_hash),
          candidateContentHash: String(row.candidate_content_hash),
          candidateSetContentHash: String(row.candidate_set_content_hash),
          candidateManifestHash: String(row.candidate_manifest_hash),
          datasetFingerprint: String(row.dataset_fingerprint),
          geometryHash: String(row.geometry_hash),
          qaDecisionVersion: Number(row.qa_decision_version),
          qaHistoryHash: String(row.qa_history_hash),
          targetPayloadHash: String(row.target_payload_hash),
        };
        return [value.publicationIdempotencyKey, value];
      }),
    ),
    provenanceSchemaAvailable,
  };
}
