import type { ImportPlanRecord } from "./phase8-staging.ts";
import { sha256Stable } from "./phase11-publication.ts";

export type Phase11c4StagingConflictCategory =
  | "C_SOURCE_URL_COLLISION"
  | "D_RELATION_IDENTITY_COLLISION"
  | "E_MOUNTAIN_TARGET_CONFLICT"
  | "F_ACTUAL_DATA_DRIFT"
  | "G_CONTRACT_VIOLATION";

export interface Phase11c4StagingIdentity {
  stagingRouteId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  geometryHash: string | null;
  geometryType: string | null;
  componentCount: number | null;
  sourceRelationId: string;
  canonicalSourceId: string;
  contractVersion: string;
  importEligibility: string;
  matchedPrimaryMountainId: number | null;
  summitIdentities: Array<{
    peakOsmId: string;
    mountainId: number;
    mountainMatchClassification: string;
    finalAssociation: string;
  }>;
}

export interface Phase11c4StagingRouteRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  contract_version: string;
  import_eligibility: string;
  matched_primary_mountain_id: number | null;
  geometry_geojson?: unknown;
}

export interface Phase11c4StagingSummitRow {
  staging_route_id: string;
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: string;
  final_association: string;
}

export interface Phase11c4MountainIdentityRow {
  id: number;
  osm_id: number | string | null;
}

export interface Phase11c4ProductionRouteRow {
  id: number | string;
  source_url: string;
}

export interface Phase11c4StagingPreflightResult {
  wouldCreate: number;
  unchanged: number;
  blocked: number;
  records: Array<{
    sourceRelationId: string;
    action: "WOULD_CREATE" | "UNCHANGED" | "BLOCKED";
    reason: string | null;
    stagingRouteId: string | null;
    conflictCategory: Phase11c4StagingConflictCategory | null;
    mismatchFields: string[];
    sourceUrl: string;
    mountainIdentity: Array<{ peakOsmId: string; mountainId: number }>;
    existingIdentity: Phase11c4StagingIdentity | null;
    plannedIdentity: Phase11c4StagingIdentity;
  }>;
  databaseWrites: 0;
}

function expectedProductionSourceUrls(record: ImportPlanRecord): string[] {
  return [
    record.contract.source.sourceUrl,
    `/api/osm-route-publications/openstreetmap/relation/${record.canonicalRouteSourceId}/geojson`,
  ];
}

function geometryIdentity(value: unknown): { geometryType: string | null; componentCount: number | null } {
  if (!value || typeof value !== "object") return { geometryType: null, componentCount: null };
  const geometry = value as { type?: unknown; coordinates?: unknown };
  const geometryType = typeof geometry.type === "string" ? geometry.type : null;
  if (!Array.isArray(geometry.coordinates)) return { geometryType, componentCount: null };
  return {
    geometryType,
    componentCount: geometryType === "LineString" ? 1 : geometry.coordinates.length,
  };
}

export function buildPhase11c4StagingPreflight(input: {
  records: ImportPlanRecord[];
  stagingRoutes: Phase11c4StagingRouteRow[];
  stagingSummits: Phase11c4StagingSummitRow[];
  mountains: Phase11c4MountainIdentityRow[];
  productionRoutes: Phase11c4ProductionRouteRow[];
}): Phase11c4StagingPreflightResult {
  const mountainById = new Map(
    input.mountains.map((row) => [row.id, row.osm_id === null ? null : String(row.osm_id)]),
  );
  const productionUrls = new Set(input.productionRoutes.map((row) => row.source_url));
  const summitsByRoute = new Map<string, Phase11c4StagingSummitRow[]>();
  for (const summit of input.stagingSummits) {
    const values = summitsByRoute.get(summit.staging_route_id) ?? [];
    values.push(summit);
    summitsByRoute.set(summit.staging_route_id, values);
  }
  const records: Phase11c4StagingPreflightResult["records"] = [];
  for (const record of input.records) {
    const expectedSummits = record.contract.confirmedSummits;
    const mountainIdentity = expectedSummits.flatMap((summit) =>
      summit.mountainMatch.mountainId === null
        ? []
        : [{ peakOsmId: summit.peakOsmId, mountainId: summit.mountainMatch.mountainId }],
    );
    const plannedGeometryIdentity = geometryIdentity(record.contract.route.geometry);
    const plannedIdentity: Phase11c4StagingIdentity = {
      stagingRouteId: null,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      geometryHash: sha256Stable(record.contract.route.geometry),
      ...plannedGeometryIdentity,
      sourceRelationId: record.sourceRelationId,
      canonicalSourceId: record.canonicalRouteSourceId,
      contractVersion: record.contract.contractVersion,
      importEligibility: record.contract.importEligibility,
      matchedPrimaryMountainId: [...mountainIdentity]
        .sort((left, right) => left.mountainId - right.mountainId)[0]?.mountainId ?? null,
      summitIdentities: expectedSummits.flatMap((summit) =>
        summit.mountainMatch.mountainId === null
          ? []
          : [{
              peakOsmId: summit.peakOsmId,
              mountainId: summit.mountainMatch.mountainId,
              mountainMatchClassification: summit.mountainMatch.classification,
              finalAssociation: summit.finalAssociation,
            }],
      ),
    };
    const badMountain = expectedSummits.find(
      (summit) =>
        summit.mountainMatch.mountainId === null ||
        mountainById.get(summit.mountainMatch.mountainId) !== summit.peakOsmId,
    );
    if (badMountain) {
      records.push({
        sourceRelationId: record.sourceRelationId,
        action: "BLOCKED",
        reason: `MOUNTAIN_IDENTITY_DRIFT:${badMountain.peakOsmId}`,
        stagingRouteId: null,
        conflictCategory: "E_MOUNTAIN_TARGET_CONFLICT",
        mismatchFields: ["mountainIdentity"],
        sourceUrl: record.contract.source.sourceUrl,
        mountainIdentity,
        existingIdentity: null,
        plannedIdentity,
      });
      continue;
    }
    if (expectedProductionSourceUrls(record).some((url) => productionUrls.has(url))) {
      records.push({
        sourceRelationId: record.sourceRelationId,
        action: "BLOCKED",
        reason: "PRODUCTION_SOURCE_URL_CONFLICT",
        stagingRouteId: null,
        conflictCategory: "C_SOURCE_URL_COLLISION",
        mismatchFields: ["sourceUrl"],
        sourceUrl: record.contract.source.sourceUrl,
        mountainIdentity,
        existingIdentity: null,
        plannedIdentity,
      });
      continue;
    }
    const matches = input.stagingRoutes.filter(
      (route) =>
        route.idempotency_key === record.idempotencyKey ||
        route.source_relation_id === record.sourceRelationId ||
        route.canonical_source_id === record.canonicalRouteSourceId,
    );
    const uniqueMatches = [...new Map(matches.map((row) => [row.id, row])).values()];
    if (uniqueMatches.length === 0) {
      records.push({
        sourceRelationId: record.sourceRelationId,
        action: "WOULD_CREATE",
        reason: null,
        stagingRouteId: null,
        conflictCategory: null,
        mismatchFields: [],
        sourceUrl: record.contract.source.sourceUrl,
        mountainIdentity,
        existingIdentity: null,
        plannedIdentity,
      });
      continue;
    }
    if (uniqueMatches.length !== 1) {
      records.push({
        sourceRelationId: record.sourceRelationId,
        action: "BLOCKED",
        reason: "MULTIPLE_STAGING_IDENTITY_CONFLICTS",
        stagingRouteId: null,
        conflictCategory: "D_RELATION_IDENTITY_COLLISION",
        mismatchFields: ["stagingIdentityUniqueness"],
        sourceUrl: record.contract.source.sourceUrl,
        mountainIdentity,
        existingIdentity: null,
        plannedIdentity,
      });
      continue;
    }
    const route = uniqueMatches[0];
    const mountainIds = expectedSummits
      .map((summit) => summit.mountainMatch.mountainId as number)
      .sort((left, right) => left - right);
    const actualSummits = summitsByRoute.get(route.id) ?? [];
    const existingGeometryIdentity = geometryIdentity(route.geometry_geojson);
    const existingIdentity: Phase11c4StagingIdentity = {
      stagingRouteId: route.id,
      idempotencyKey: route.idempotency_key,
      payloadHash: route.payload_hash,
      geometryHash: route.geometry_geojson === undefined ? null : sha256Stable(route.geometry_geojson),
      ...existingGeometryIdentity,
      sourceRelationId: route.source_relation_id,
      canonicalSourceId: route.canonical_source_id,
      contractVersion: route.contract_version,
      importEligibility: route.import_eligibility,
      matchedPrimaryMountainId: route.matched_primary_mountain_id,
      summitIdentities: actualSummits.map((summit) => ({
        peakOsmId: summit.peak_osm_id,
        mountainId: summit.mountain_id,
        mountainMatchClassification: summit.mountain_match_classification,
        finalAssociation: summit.final_association,
      })),
    };
    const geometryMatches =
      existingIdentity.geometryHash === null || existingIdentity.geometryHash === plannedIdentity.geometryHash;
    const routeMatches =
      route.idempotency_key === record.idempotencyKey &&
      route.payload_hash === record.payloadHash &&
      geometryMatches &&
      route.source_relation_id === record.sourceRelationId &&
      route.canonical_source_id === record.canonicalRouteSourceId &&
      route.contract_version === record.contract.contractVersion &&
      route.import_eligibility === "AUTO_IMPORT_READY" &&
      route.matched_primary_mountain_id === (mountainIds[0] ?? null);
    const summitsMatch =
      actualSummits.length === expectedSummits.length &&
      actualSummits.every((actual) =>
        expectedSummits.some(
          (expected) =>
            actual.peak_osm_id === expected.peakOsmId &&
            actual.mountain_id === expected.mountainMatch.mountainId &&
            actual.mountain_match_classification === "EXACT_MOUNTAIN_MATCH" &&
            actual.final_association === "CONFIRMED",
        ),
      );
    const mismatchFields = [
      route.idempotency_key === record.idempotencyKey ? null : "idempotencyKey",
      route.payload_hash === record.payloadHash ? null : "payloadHash",
      geometryMatches ? null : "geometryHash",
      route.source_relation_id === record.sourceRelationId ? null : "sourceRelationId",
      route.canonical_source_id === record.canonicalRouteSourceId ? null : "canonicalSourceId",
      route.contract_version === record.contract.contractVersion ? null : "contractVersion",
      route.import_eligibility === "AUTO_IMPORT_READY" ? null : "importEligibility",
      route.matched_primary_mountain_id === (mountainIds[0] ?? null) ? null : "matchedPrimaryMountainId",
      summitsMatch ? null : "summitIdentities",
    ].filter((value): value is string => value !== null);
    const conflictCategory: Phase11c4StagingConflictCategory | null = routeMatches && summitsMatch
      ? null
      : mismatchFields.some((field) => ["idempotencyKey", "sourceRelationId", "canonicalSourceId"].includes(field))
        ? "D_RELATION_IDENTITY_COLLISION"
        : mismatchFields.some((field) => ["matchedPrimaryMountainId", "summitIdentities"].includes(field))
          ? "E_MOUNTAIN_TARGET_CONFLICT"
          : mismatchFields.some((field) => ["payloadHash", "geometryHash"].includes(field))
            ? "F_ACTUAL_DATA_DRIFT"
            : "G_CONTRACT_VIOLATION";
    records.push({
      sourceRelationId: record.sourceRelationId,
      action: routeMatches && summitsMatch ? "UNCHANGED" : "BLOCKED",
      reason: routeMatches && summitsMatch ? null : "EXISTING_STAGING_DRIFT",
      stagingRouteId: route.id,
      conflictCategory,
      mismatchFields,
      sourceUrl: record.contract.source.sourceUrl,
      mountainIdentity,
      existingIdentity,
      plannedIdentity,
    });
  }
  return {
    wouldCreate: records.filter((record) => record.action === "WOULD_CREATE").length,
    unchanged: records.filter((record) => record.action === "UNCHANGED").length,
    blocked: records.filter((record) => record.action === "BLOCKED").length,
    records,
    databaseWrites: 0,
  };
}
