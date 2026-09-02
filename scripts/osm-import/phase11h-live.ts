import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface Phase11hStagingRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  contract_version: string;
  import_eligibility: string;
}

export interface Phase11hPublishedUrlRow {
  source_url: string;
}

export interface Phase11hBeforeState {
  stagingRowsByRelation: Map<string, Phase11hStagingRow>;
  publishedRelationIds: Set<string>;
  provenanceByRelation: Map<
    string,
    { mountain_route_id: number; publication_status: string; source_url: string | null }
  >;
  summitRows: Array<{ staging_route_id: string; peak_osm_id: string; mountain_id: number }>;
  qaRows: Array<{ staging_route_id: string; status: string }>;
  qaHistoryRows: Array<{ staging_route_id: string }>;
  qaStagingIds: Set<string>;
  qaHistoryStagingIds: Set<string>;
}

export interface Phase11hStandingRecord {
  canonicalRelationId: string;
  action: "WOULD_CREATE" | "BLOCKED_OTHER";
  reason: string | null;
  downstreamHits: {
    staging: boolean;
    provenance: boolean;
    provenanceStatus: string | null;
    published: boolean;
    qa: boolean;
  };
}

export interface Phase11hStandingSummary {
  total: number;
  wouldCreate: number;
  unchanged: 0;
  conflicts: number;
  blocked: number;
  stagingRowsPresent: number;
  qaDecisionRowsPresent: number;
  qaHistoryRowsPresent: number;
  summitAssociationRowsForFoundStaging: number;
  publicationProvenanceHits: number;
  activeProvenanceHits: number;
  activeOverlap: number;
  publishedUrlOverlap: number;
}

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export async function createPhase11hAdminClient(): Promise<SupabaseClient> {
  try {
    loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("PHASE11H_SUPABASE_READ_CREDENTIALS_REQUIRED");
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function chunks<T>(
  values: string[],
  load: (chunk: string[]) => PromiseLike<T[]>,
  size = 40,
): Promise<T[]> {
  const result: T[] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(...(await load(values.slice(index, index + size))));
  }
  return result;
}

function relationIdsFromPublishedUrl(url: string): string | null {
  const match = url.match(/(?:\/|\/relation\/)(\d+)$/);
  return match ? match[1] : null;
}

export async function loadPhase11hBeforeState(
  client: SupabaseClient,
  relationIds: string[],
): Promise<Phase11hBeforeState> {
  const [stagingByCanonical, stagingBySource, provenance, publishedRoutes] = await Promise.all([
    chunks<Record<string, unknown>>(relationIds, (ids) =>
      client
        .from("osm_route_import_staging")
        .select(
          "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,staged_at",
        )
        .in("canonical_source_id", ids)
        .then((result) => {
          if (result.error) throw new Error(`PHASE11H_CANONICAL_STAGING_QUERY:${result.error.message}`);
          return ((result.data ?? []) as Record<string, unknown>[]);
        }),
    ),
    chunks<Record<string, unknown>>(relationIds, (ids) =>
      client
        .from("osm_route_import_staging")
        .select("id,source_relation_id,canonical_source_id,import_eligibility")
        .in("source_relation_id", ids)
        .then((result) => {
          if (result.error) throw new Error(`PHASE11H_SOURCE_STAGING_QUERY:${result.error.message}`);
          return ((result.data ?? []) as Record<string, unknown>[]);
        }),
    ),
    chunks<Record<string, unknown>>(relationIds, (ids) =>
      client
        .from("osm_route_publication_provenance")
        .select(
          "mountain_route_id,staging_route_id,canonical_relation_id,source_url,publication_status",
        )
        .in("canonical_relation_id", ids)
        .then((result) => {
          if (result.error) throw new Error(`PHASE11H_PROVENANCE_QUERY:${result.error.message}`);
          return ((result.data ?? []) as Record<string, unknown>[]);
        }),
    ),
    Promise.all([
      client
        .from("mountain_routes")
        .select("id,source_url")
        .like("source_url", "https://www.openstreetmap.org/relation/%"),
      client
        .from("mountain_routes")
        .select("id,source_url")
        .like("source_url", "/api/osm-route-publications/openstreetmap/relation/%/geojson"),
    ]).then((responses) => {
      for (const result of responses) {
        if (result.error) throw new Error(`PHASE11H_PUBLISHED_QUERY:${result.error.message}`);
      }
      return responses.flatMap((result) => (result.data ?? []) as Phase11hPublishedUrlRow[]);
    }),
  ]);

  const stagingRowsByRelation = new Map<string, Phase11hStagingRow>();
  for (const row of [...stagingByCanonical, ...stagingBySource]) {
    for (const key of ["canonical_source_id", "source_relation_id"] as const) {
      const relation = String(row[key] ?? "");
      if (relation && relationIds.includes(relation)) {
        stagingRowsByRelation.set(relation, row as unknown as Phase11hStagingRow);
      }
    }
  }

  const stagingRouteIds = [...new Set(stagingRowsByRelation.values().map((row) => row.id))];
  const [summitResponses, qaResponses, historyResponses] =
    stagingRouteIds.length === 0
      ? [[] as Record<string, unknown>[], [] as Record<string, unknown>[], [] as Record<string, unknown>[]]
      : await Promise.all([
          chunks<Record<string, unknown>>(stagingRouteIds, (ids) =>
            client
              .from("osm_route_import_summit_staging")
              .select("staging_route_id,peak_osm_id,mountain_id,final_association")
              .in("staging_route_id", ids)
              .then((result) => {
                if (result.error) throw new Error(`PHASE11H_SUMMIT_QUERY:${result.error.message}`);
                return ((result.data ?? []) as Record<string, unknown>[]);
              }),
          ),
          chunks<Record<string, unknown>>(stagingRouteIds, (ids) =>
            client
              .from("osm_staging_route_visual_qa")
              .select("staging_route_id,status,version")
              .in("staging_route_id", ids)
              .then((result) => {
                if (result.error) throw new Error(`PHASE11H_QA_QUERY:${result.error.message}`);
                return ((result.data ?? []) as Record<string, unknown>[]);
              }),
          ),
          chunks<Record<string, unknown>>(stagingRouteIds, (ids) =>
            client
              .from("osm_staging_route_visual_qa_history")
              .select("staging_route_id,old_status,new_status,decision_version")
              .in("staging_route_id", ids)
              .then((result) => {
                if (result.error) throw new Error(`PHASE11H_QA_HISTORY_QUERY:${result.error.message}`);
                return ((result.data ?? []) as Record<string, unknown>[]);
              }),
          ),
        ]);
  const summitRows = summitResponses.flatMap(
    (rows) => rows as unknown as Phase11hBeforeState["summitRows"],
  );
  const qaRows = qaResponses.flatMap(
    (rows) => rows as unknown as Phase11hBeforeState["qaRows"],
  );
  const qaHistoryRows = historyResponses.flatMap(
    (rows) => rows as unknown as Phase11hBeforeState["qaHistoryRows"],
  );

  const publishedRelationIds = new Set(
    publishedRoutes.map((row) => relationIdsFromPublishedUrl(row.source_url)).filter(
      (value): value is string => value !== null,
    ),
  );

  const provenanceByRelation = new Map<
    string,
    { mountain_route_id: number; publication_status: string; source_url: string | null }
  >();
  for (const row of provenance as unknown as Array<Record<string, unknown>>) {
    const relation = String(row.canonical_relation_id ?? "");
    if (!relation) continue;
    const existing = provenanceByRelation.get(relation);
    if (!existing || String(existing.publication_status).toUpperCase() === "ACTIVE") {
      provenanceByRelation.set(relation, {
        mountain_route_id: Number(row.mountain_route_id),
        publication_status: String(row.publication_status),
        source_url: row.source_url === null ? null : String(row.source_url),
      });
    }
  }

  const qaStagingIds = new Set(qaRows.map((row) => row.staging_route_id));
  const qaHistoryStagingIds = new Set(qaHistoryRows.map((row) => row.staging_route_id));

  return {
    stagingRowsByRelation,
    publishedRelationIds,
    provenanceByRelation,
    summitRows,
    qaRows,
    qaHistoryRows,
    qaStagingIds,
    qaHistoryStagingIds,
  };
}

export function classifyPhase11hStanding(input: {
  state: Phase11hBeforeState;
  relationIds: string[];
}): { records: Phase11hStandingRecord[]; summary: Phase11hStandingSummary } {
  const { state, relationIds } = input;
  const records = relationIds.map((relation) => {
    const stagingRow = state.stagingRowsByRelation.get(relation);
    const provenanceHit = state.provenanceByRelation.get(relation);
    const published = Boolean(provenanceHit) || state.publishedRelationIds.has(relation);
    const qaHits = Boolean(
      stagingRow &&
        (state.qaStagingIds.has(stagingRow.id) || state.qaHistoryStagingIds.has(stagingRow.id)),
    );
    const action: "WOULD_CREATE" | "BLOCKED_OTHER" =
      stagingRow || published || qaHits ? "BLOCKED_OTHER" : "WOULD_CREATE";
    const reason = (() => {
      if (stagingRow) return "STAGING_ROW_ALREADY_PRESENT";
      if (published) return "ALREADY_PUBLISHED";
      if (qaHits) return "QA_DECISION_OR_HISTORY_PRESENT";
      return null;
    })();
    return {
      canonicalRelationId: relation,
      action,
      reason,
      downstreamHits: {
        staging: Boolean(stagingRow),
        provenance: Boolean(provenanceHit),
        provenanceStatus: provenanceHit?.publication_status ?? null,
        published,
        qa: qaHits,
      },
    };
  });
  const wouldCreate = records.filter((record) => record.action === "WOULD_CREATE").length;
  const blocked = records.length - wouldCreate;
  const summary: Phase11hStandingSummary = {
    total: relationIds.length,
    wouldCreate,
    unchanged: 0,
    conflicts: blocked,
    blocked,
    stagingRowsPresent: state.stagingRowsByRelation.size,
    qaDecisionRowsPresent: state.qaRows.length,
    qaHistoryRowsPresent: state.qaHistoryRows.length,
    summitAssociationRowsForFoundStaging: state.summitRows.length,
    publicationProvenanceHits: state.provenanceByRelation.size,
    activeProvenanceHits: records.filter(
      (record) => record.downstreamHits.provenanceStatus === "ACTIVE",
    ).length,
    activeOverlap: records.filter(
      (record) => record.downstreamHits.provenanceStatus === "ACTIVE",
    ).length,
    publishedUrlOverlap: records.filter((record) => record.downstreamHits.published).length,
  };
  return { records, summary };
}