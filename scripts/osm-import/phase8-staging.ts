import { createHash } from "node:crypto";

import {
  combineAdminBoundaryResolutions,
  resolvePointAdminBoundary,
  type AdminBoundaryDataset,
  type AdminBoundaryResolution,
} from "./admin-boundary.ts";
import { validateRouteGeometry } from "./alps-audit.ts";
import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type RouteGeometry,
} from "./peak-matcher.ts";
import type { RouteSemanticType } from "./route-classifier.ts";

export const OSM_ROUTE_IMPORT_CONTRACT_VERSION = "mountain-tracker-osm-route/v1";

export const MOUNTAIN_MATCH_THRESHOLDS = Object.freeze({
  spatialSearchRadiusMeters: 75,
  probableMaximumDistanceMeters: 30,
  probableMaximumElevationDifferenceMeters: 75,
  missingElevationMaximumDistanceMeters: 10,
});

export type MountainMatchClassification =
  | "EXACT_MOUNTAIN_MATCH"
  | "PROBABLE_MOUNTAIN_MATCH"
  | "NO_MOUNTAIN_MATCH"
  | "AMBIGUOUS_MOUNTAIN_MATCH";

export type StagingOperation =
  | "READY_FOR_STAGING"
  | "BLOCKED_NO_MOUNTAIN"
  | "BLOCKED_AMBIGUOUS"
  | "BLOCKED_VALIDATION";

export interface MountainCatalogRecord {
  id: number;
  osmId: string | null;
  name: string | null;
  nameDe: string | null;
  heightMeters: number | null;
  coordinates: Coordinate | null;
  countryCode: string | null;
  source: string | null;
}

export interface MountainMatchResult {
  classification: MountainMatchClassification;
  mountainId: number | null;
  mountainName: string | null;
  mountainElevationMeters: number | null;
  distanceMeters: number | null;
  elevationDifferenceMeters: number | null;
  nameSupportingEvidence: boolean;
  candidateMountainIds: number[];
  reasons: string[];
}

export interface Phase7EligibilityRecord {
  canonicalRouteSourceId: string;
  routeName: string | null;
  eligibility: "AUTO_IMPORT_READY" | "MANUAL_REVIEW_REQUIRED" | "EXCLUDE";
  reasons: string[];
  auditFlags: string[];
  qualityScore: number;
  confirmedPeakIds: string[];
  sourceRouteIds: string[];
}

export interface Phase7CanonicalRouteRecord {
  canonicalRouteSourceId: string;
  routeName: string | null;
  semanticType: RouteSemanticType;
  qualityScore: number;
  geometryType: RouteGeometry["type"];
  distanceMeters: number;
  componentCount: number;
  sourceRouteIds: string[];
  removedDuplicateRepresentationIds: string[];
  confirmedSummits: Array<{
    peakSourceId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: Coordinate | null;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    finalConfidence: number;
    reasons: string[];
    provenanceId: string | null;
    sourceRouteIds: string[];
    sourceAssociations: Array<{
      routeSourceId: string;
      routeSourceUrl: string;
      routeProvenanceId: string;
      finalConfidence: number;
      minimumGeometryDistanceMeters: number;
      endpointDistanceMeters: number;
      reasons: string[];
    }>;
  }>;
  auditFlags: string[];
  sourceProvenance: Array<{
    routeSourceId: string;
    sourceUrl: string;
    provenanceId: string;
    license: string;
    attribution: string;
  }>;
  duplicateGroupId: string | null;
}

export interface StagingSourceRouteRecord {
  source: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  provenanceId: string;
  license: string;
  attribution: string;
  name: string | null;
  geometry: RouteGeometry;
  stats: {
    distanceMeters: number;
    coordinatePoints: number;
    componentCount: number;
  };
}

export interface OSMRouteImportContract {
  contractVersion: typeof OSM_ROUTE_IMPORT_CONTRACT_VERSION;
  idempotencyKey: string;
  provider: "openstreetmap";
  source: {
    sourceType: "relation";
    sourceRelationId: string;
    canonicalSourceId: string;
    sourceUrl: string;
    provenanceId: string;
    license: string;
    attribution: string;
  };
  dataset: {
    version: string;
    phase7AuditHash: string;
  };
  route: {
    name: string | null;
    semanticType: RouteSemanticType;
    qualityScore: number;
    geometry: RouteGeometry;
    geometryType: RouteGeometry["type"];
    distanceMeters: number;
    componentCount: number;
    bounds: GeometryBounds;
  };
  confirmedSummits: Array<{
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: Coordinate | null;
    finalAssociation: "CONFIRMED";
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    evidence: string[];
    sourceRouteIds: string[];
    sourceAssociations: Phase7CanonicalRouteRecord["confirmedSummits"][number]["sourceAssociations"];
    mountainMatch: MountainMatchResult;
    administration: AdminBoundaryResolution;
  }>;
  mergedDuplicateProvenance: {
    duplicateGroupId: string | null;
    sourceRouteIds: string[];
    removedDuplicateRepresentationIds: string[];
    sourceProvenance: Phase7CanonicalRouteRecord["sourceProvenance"];
  };
  auditFlags: string[];
  importEligibility: "AUTO_IMPORT_READY";
  routeAdministration: AdminBoundaryResolution;
}

export interface GeometryBounds {
  minimumLongitude: number;
  minimumLatitude: number;
  maximumLongitude: number;
  maximumLatitude: number;
}

export interface ImportPlanRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  routeName: string | null;
  summits: Array<{
    peakOsmId: string;
    peakName: string | null;
    mountainMatch: MountainMatchResult;
  }>;
  intendedDatabaseOperation: "UPSERT_OSM_ROUTE_IMPORT_STAGING";
  operation: StagingOperation;
  reasons: string[];
  warnings: string[];
  validationErrors: string[];
  idempotencyKey: string;
  payloadHash: string;
  contract: OSMRouteImportContract;
}

function round(value: number, places: number): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

function normalizeName(value: string | null): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesSupportMatch(
  peakName: string | null,
  mountain: MountainCatalogRecord,
): boolean {
  const normalizedPeak = normalizeName(peakName);
  if (!normalizedPeak) return false;
  return [mountain.name, mountain.nameDe]
    .map(normalizeName)
    .some(
      (candidate) =>
        candidate.length > 0 &&
        (candidate === normalizedPeak ||
          candidate.includes(normalizedPeak) ||
          normalizedPeak.includes(candidate)),
    );
}

function elevationDifference(
  peakElevation: number | null,
  mountainElevation: number | null,
): number | null {
  return peakElevation === null || mountainElevation === null
    ? null
    : Math.abs(peakElevation - mountainElevation);
}

function mountainDisplayName(mountain: MountainCatalogRecord): string | null {
  return mountain.nameDe ?? mountain.name;
}

function normalizeOsmAttribution(value: string): string {
  return value === "\u00c2\u00a9 OpenStreetMap contributors"
    ? "\u00a9 OpenStreetMap contributors"
    : value;
}

export function matchPeakToMountain(
  peak: {
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: Coordinate | null;
  },
  mountains: MountainCatalogRecord[],
): MountainMatchResult {
  const exactOsmMatches = mountains.filter(
    (mountain) => mountain.osmId !== null && mountain.osmId === peak.peakOsmId,
  );
  if (exactOsmMatches.length > 1) {
    return {
      classification: "AMBIGUOUS_MOUNTAIN_MATCH",
      mountainId: null,
      mountainName: null,
      mountainElevationMeters: null,
      distanceMeters: null,
      elevationDifferenceMeters: null,
      nameSupportingEvidence: false,
      candidateMountainIds: exactOsmMatches.map((mountain) => mountain.id).sort((a, b) => a - b),
      reasons: [
        `OSM peak ID ${peak.peakOsmId} resolves to multiple Mountain Tracker rows.`,
      ],
    };
  }
  if (exactOsmMatches.length === 1) {
    const mountain = exactOsmMatches[0];
    const distance =
      peak.peakCoordinates && mountain.coordinates
        ? calculateCoordinateDistanceMeters(peak.peakCoordinates, mountain.coordinates)
        : null;
    return {
      classification: "EXACT_MOUNTAIN_MATCH",
      mountainId: mountain.id,
      mountainName: mountainDisplayName(mountain),
      mountainElevationMeters: mountain.heightMeters,
      distanceMeters: distance === null ? null : round(distance, 1),
      elevationDifferenceMeters: elevationDifference(
        peak.peakElevationMeters,
        mountain.heightMeters,
      ),
      nameSupportingEvidence: namesSupportMatch(peak.peakName, mountain),
      candidateMountainIds: [mountain.id],
      reasons: [
        `Mountain Tracker osm_id exactly matches OSM peak ${peak.peakOsmId}.`,
      ],
    };
  }

  if (!peak.peakCoordinates) {
    return {
      classification: "NO_MOUNTAIN_MATCH",
      mountainId: null,
      mountainName: null,
      mountainElevationMeters: null,
      distanceMeters: null,
      elevationDifferenceMeters: null,
      nameSupportingEvidence: false,
      candidateMountainIds: [],
      reasons: ["Peak coordinates are unavailable; name-only matching is forbidden."],
    };
  }

  const nearby = mountains
    .filter((mountain) => mountain.coordinates !== null)
    .map((mountain) => {
      const distance = calculateCoordinateDistanceMeters(
        peak.peakCoordinates as Coordinate,
        mountain.coordinates as Coordinate,
      );
      return {
        mountain,
        distance,
        elevationDifferenceMeters: elevationDifference(
          peak.peakElevationMeters,
          mountain.heightMeters,
        ),
        nameSupportingEvidence: namesSupportMatch(peak.peakName, mountain),
      };
    })
    .filter(
      (candidate) =>
        candidate.distance <= MOUNTAIN_MATCH_THRESHOLDS.spatialSearchRadiusMeters,
    )
    .sort(
      (left, right) =>
        left.distance - right.distance || left.mountain.id - right.mountain.id,
    );

  const plausible = nearby.filter((candidate) => {
    if (candidate.distance > MOUNTAIN_MATCH_THRESHOLDS.probableMaximumDistanceMeters) {
      return false;
    }
    if (candidate.elevationDifferenceMeters !== null) {
      return (
        candidate.elevationDifferenceMeters <=
        MOUNTAIN_MATCH_THRESHOLDS.probableMaximumElevationDifferenceMeters
      );
    }
    return (
      candidate.distance <=
        MOUNTAIN_MATCH_THRESHOLDS.missingElevationMaximumDistanceMeters &&
      candidate.nameSupportingEvidence
    );
  });

  if (plausible.length > 1) {
    return {
      classification: "AMBIGUOUS_MOUNTAIN_MATCH",
      mountainId: null,
      mountainName: null,
      mountainElevationMeters: null,
      distanceMeters: round(plausible[0].distance, 1),
      elevationDifferenceMeters: plausible[0].elevationDifferenceMeters,
      nameSupportingEvidence: plausible.some((candidate) => candidate.nameSupportingEvidence),
      candidateMountainIds: plausible.map((candidate) => candidate.mountain.id),
      reasons: [
        `${plausible.length} Mountain Tracker mountains pass the conservative spatial/elevation safeguards.`,
      ],
    };
  }
  if (plausible.length === 1) {
    const candidate = plausible[0];
    return {
      classification: "PROBABLE_MOUNTAIN_MATCH",
      mountainId: candidate.mountain.id,
      mountainName: mountainDisplayName(candidate.mountain),
      mountainElevationMeters: candidate.mountain.heightMeters,
      distanceMeters: round(candidate.distance, 1),
      elevationDifferenceMeters: candidate.elevationDifferenceMeters,
      nameSupportingEvidence: candidate.nameSupportingEvidence,
      candidateMountainIds: [candidate.mountain.id],
      reasons: [
        `One mountain is within ${round(candidate.distance, 1)} m and passes the elevation safeguard.`,
        candidate.nameSupportingEvidence
          ? "Normalized name provides supporting evidence."
          : "Name was not required as primary evidence.",
        "PROBABLE matches are diagnostic only and are never attached automatically.",
      ],
    };
  }

  const nearest = nearby[0];
  return {
    classification: "NO_MOUNTAIN_MATCH",
    mountainId: null,
    mountainName: null,
    mountainElevationMeters: null,
    distanceMeters: nearest ? round(nearest.distance, 1) : null,
    elevationDifferenceMeters: nearest?.elevationDifferenceMeters ?? null,
    nameSupportingEvidence: nearest?.nameSupportingEvidence ?? false,
    candidateMountainIds: nearby.map((candidate) => candidate.mountain.id),
    reasons: [
      nearby.length === 0
        ? `No Mountain Tracker mountain is within ${MOUNTAIN_MATCH_THRESHOLDS.spatialSearchRadiusMeters} m.`
        : "Nearby mountains fail the conservative distance/elevation safeguards.",
      "A matching name alone is not sufficient.",
    ],
  };
}

function geometryCoordinates(geometry: RouteGeometry): Coordinate[] {
  return geometry.type === "LineString" ? geometry.coordinates : geometry.coordinates.flat();
}

export function calculateGeometryBounds(geometry: RouteGeometry): GeometryBounds {
  const coordinates = geometryCoordinates(geometry);
  if (coordinates.length === 0) throw new Error("route geometry is empty");
  return {
    minimumLongitude: Math.min(...coordinates.map((coordinate) => coordinate[0])),
    minimumLatitude: Math.min(...coordinates.map((coordinate) => coordinate[1])),
    maximumLongitude: Math.max(...coordinates.map((coordinate) => coordinate[0])),
    maximumLatitude: Math.max(...coordinates.map((coordinate) => coordinate[1])),
  };
}

export function createRouteIdempotencyKey(canonicalSourceId: string): string {
  return `openstreetmap:relation:${canonicalSourceId}:${OSM_ROUTE_IMPORT_CONTRACT_VERSION}`;
}

export function serializeImportContract(contract: OSMRouteImportContract): string {
  return JSON.stringify(contract);
}

export function hashImportContract(contract: OSMRouteImportContract): string {
  return createHash("sha256").update(serializeImportContract(contract)).digest("hex");
}

export function createImportContract(input: {
  eligibility: Phase7EligibilityRecord;
  canonical: Phase7CanonicalRouteRecord;
  sourceRoute: StagingSourceRouteRecord;
  mountains: MountainCatalogRecord[];
  datasetVersion: string;
  phase7AuditHash: string;
  adminBoundaries: AdminBoundaryDataset | null;
}): OSMRouteImportContract {
  const { eligibility, canonical, sourceRoute } = input;
  const idempotencyKey = createRouteIdempotencyKey(canonical.canonicalRouteSourceId);
  const confirmedSummits: OSMRouteImportContract["confirmedSummits"] =
    canonical.confirmedSummits.map((summit) => ({
      peakOsmId: summit.peakSourceId,
      peakName: summit.peakName,
      peakElevationMeters: summit.peakElevationMeters,
      peakCoordinates: summit.peakCoordinates,
      finalAssociation: "CONFIRMED",
      finalConfidence: summit.finalConfidence,
      minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
      evidence: [...summit.reasons],
      sourceRouteIds: [...summit.sourceRouteIds],
      sourceAssociations: summit.sourceAssociations.map((association) => ({
        ...association,
        reasons: [...association.reasons],
      })),
      mountainMatch: matchPeakToMountain(
        {
          peakOsmId: summit.peakSourceId,
          peakName: summit.peakName,
          peakElevationMeters: summit.peakElevationMeters,
          peakCoordinates: summit.peakCoordinates,
        },
        input.mountains,
      ),
      administration: resolvePointAdminBoundary(
        summit.peakCoordinates ?? [Number.NaN, Number.NaN],
        input.adminBoundaries,
      ),
    }));
  return {
    contractVersion: OSM_ROUTE_IMPORT_CONTRACT_VERSION,
    idempotencyKey,
    provider: "openstreetmap",
    source: {
      sourceType: "relation",
      sourceRelationId: sourceRoute.sourceId,
      canonicalSourceId: canonical.canonicalRouteSourceId,
      sourceUrl: sourceRoute.sourceUrl,
      provenanceId: sourceRoute.provenanceId,
      license: sourceRoute.license,
      attribution: normalizeOsmAttribution(sourceRoute.attribution),
    },
    dataset: {
      version: input.datasetVersion,
      phase7AuditHash: input.phase7AuditHash,
    },
    route: {
      name: canonical.routeName,
      semanticType: canonical.semanticType,
      qualityScore: canonical.qualityScore,
      geometry: sourceRoute.geometry,
      geometryType: sourceRoute.geometry.type,
      distanceMeters: sourceRoute.stats.distanceMeters,
      componentCount: sourceRoute.stats.componentCount,
      bounds: calculateGeometryBounds(sourceRoute.geometry),
    },
    confirmedSummits,
    mergedDuplicateProvenance: {
      duplicateGroupId: canonical.duplicateGroupId,
      sourceRouteIds: [...canonical.sourceRouteIds],
      removedDuplicateRepresentationIds: [
        ...canonical.removedDuplicateRepresentationIds,
      ],
      sourceProvenance: canonical.sourceProvenance.map((provenance) => ({
        ...provenance,
        attribution: normalizeOsmAttribution(provenance.attribution),
      })),
    },
    auditFlags: [...eligibility.auditFlags],
    importEligibility: "AUTO_IMPORT_READY",
    routeAdministration: combineAdminBoundaryResolutions(
      confirmedSummits.map((summit) => summit.administration),
      input.adminBoundaries,
    ),
  };
}

function provenanceComplete(contract: OSMRouteImportContract): boolean {
  return (
    contract.provider === "openstreetmap" &&
    contract.source.provenanceId.length > 0 &&
    contract.source.license === "ODbL-1.0" &&
    contract.source.attribution === "© OpenStreetMap contributors" &&
    contract.source.sourceUrl ===
      `https://www.openstreetmap.org/relation/${contract.source.sourceRelationId}` &&
    contract.mergedDuplicateProvenance.sourceProvenance.every(
      (source) =>
        source.provenanceId.length > 0 &&
        source.license === "ODbL-1.0" &&
        source.attribution === "© OpenStreetMap contributors",
    )
  );
}

export function validateStagingContract(
  contract: OSMRouteImportContract,
  options: { requireExactMountainMatches: boolean } = {
    requireExactMountainMatches: true,
  },
): string[] {
  const errors: string[] = [];
  if (contract.contractVersion !== OSM_ROUTE_IMPORT_CONTRACT_VERSION) {
    errors.push("UNSUPPORTED_CONTRACT_VERSION");
  }
  if (contract.importEligibility !== "AUTO_IMPORT_READY") {
    errors.push("NOT_AUTO_IMPORT_READY");
  }
  if (
    contract.source.sourceRelationId !== contract.source.canonicalSourceId ||
    contract.source.sourceRelationId.length === 0
  ) {
    errors.push("NONCANONICAL_SOURCE_ROUTE");
  }
  if (!provenanceComplete(contract)) errors.push("INCOMPLETE_PROVENANCE");
  const geometry = validateRouteGeometry(contract.route.geometry);
  if (!geometry.geometryValid || !geometry.coordinatesFinite) {
    errors.push("INVALID_GEOMETRY");
  }
  if (!(contract.route.distanceMeters > 0)) errors.push("NON_POSITIVE_DISTANCE");
  if (contract.confirmedSummits.length === 0) errors.push("MISSING_CONFIRMED_SUMMIT");
  for (const summit of contract.confirmedSummits) {
    if (
      summit.finalAssociation !== "CONFIRMED" ||
      !summit.peakOsmId ||
      summit.peakCoordinates === null ||
      !Number.isFinite(summit.peakCoordinates[0]) ||
      !Number.isFinite(summit.peakCoordinates[1])
    ) {
      errors.push(`INVALID_CONFIRMED_SUMMIT:${summit.peakOsmId || "missing"}`);
    }
    if (
      options.requireExactMountainMatches &&
      summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH"
    ) {
      errors.push(`MOUNTAIN_MATCH_NOT_EXACT:${summit.peakOsmId}`);
    }
  }
  const provenanceIds = new Set(
    contract.mergedDuplicateProvenance.sourceProvenance.map(
      (source) => source.routeSourceId,
    ),
  );
  for (const sourceRouteId of contract.mergedDuplicateProvenance.sourceRouteIds) {
    if (!provenanceIds.has(sourceRouteId)) {
      errors.push(`UNRESOLVED_DUPLICATE_PROVENANCE:${sourceRouteId}`);
    }
  }
  if (
    contract.idempotencyKey !==
    createRouteIdempotencyKey(contract.source.canonicalSourceId)
  ) {
    errors.push("UNSTABLE_IDEMPOTENCY_KEY");
  }
  return [...new Set(errors)].sort();
}

export function createImportPlanRecord(
  contract: OSMRouteImportContract,
): ImportPlanRecord {
  const baseValidationErrors = validateStagingContract(contract, {
    requireExactMountainMatches: false,
  });
  const matches = contract.confirmedSummits.map((summit) => summit.mountainMatch);
  let operation: StagingOperation;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let validationErrors = baseValidationErrors;

  if (baseValidationErrors.length > 0) {
    operation = "BLOCKED_VALIDATION";
    reasons.push("The versioned route contract failed staging validation.");
  } else if (
    matches.some((match) => match.classification === "AMBIGUOUS_MOUNTAIN_MATCH")
  ) {
    operation = "BLOCKED_AMBIGUOUS";
    reasons.push("At least one summit has multiple plausible Mountain Tracker matches.");
  } else if (
    matches.some((match) => match.classification !== "EXACT_MOUNTAIN_MATCH")
  ) {
    operation = "BLOCKED_NO_MOUNTAIN";
    reasons.push(
      "Every summit must have an exact OSM-ID mountain match before staging; probable matches are never attached automatically.",
    );
  } else {
    validationErrors = validateStagingContract(contract, {
      requireExactMountainMatches: true,
    });
    operation =
      validationErrors.length === 0 ? "READY_FOR_STAGING" : "BLOCKED_VALIDATION";
    reasons.push(
      validationErrors.length === 0
        ? "Canonical AUTO_IMPORT_READY route passes every staging validation rule."
        : "Exact-match contract failed final staging validation.",
    );
  }

  if (contract.routeAdministration.status !== "ASSIGNED") {
    warnings.push(
      `Offline administrative-boundary enrichment is ${contract.routeAdministration.status.toLowerCase()}: ${contract.routeAdministration.reason}`,
    );
  }
  if (!contract.route.name?.trim()) warnings.push("Route name is missing.");
  return {
    sourceRelationId: contract.source.sourceRelationId,
    canonicalRouteSourceId: contract.source.canonicalSourceId,
    routeName: contract.route.name,
    summits: contract.confirmedSummits.map((summit) => ({
      peakOsmId: summit.peakOsmId,
      peakName: summit.peakName,
      mountainMatch: summit.mountainMatch,
    })),
    intendedDatabaseOperation: "UPSERT_OSM_ROUTE_IMPORT_STAGING",
    operation,
    reasons,
    warnings,
    validationErrors,
    idempotencyKey: contract.idempotencyKey,
    payloadHash: hashImportContract(contract),
    contract,
  };
}

export function buildImportPlan(input: {
  eligibilityRecords: Phase7EligibilityRecord[];
  canonicalRoutes: Phase7CanonicalRouteRecord[];
  sourceRoutes: StagingSourceRouteRecord[];
  mountains: MountainCatalogRecord[];
  datasetVersion: string;
  phase7AuditHash: string;
  adminBoundaries: AdminBoundaryDataset | null;
}): {
  records: ImportPlanRecord[];
  excludedEligibilityCounts: {
    manualReviewRequired: number;
    exclude: number;
    unsupported: number;
  };
} {
  const canonicalById = new Map(
    input.canonicalRoutes.map((route) => [route.canonicalRouteSourceId, route]),
  );
  const sourceById = new Map(input.sourceRoutes.map((route) => [route.sourceId, route]));
  const records: ImportPlanRecord[] = [];
  const excludedEligibilityCounts = {
    manualReviewRequired: 0,
    exclude: 0,
    unsupported: 0,
  };

  for (const eligibility of input.eligibilityRecords) {
    if (eligibility.eligibility === "MANUAL_REVIEW_REQUIRED") {
      excludedEligibilityCounts.manualReviewRequired += 1;
      continue;
    }
    if (eligibility.eligibility === "EXCLUDE") {
      excludedEligibilityCounts.exclude += 1;
      continue;
    }
    if (eligibility.eligibility !== "AUTO_IMPORT_READY") {
      excludedEligibilityCounts.unsupported += 1;
      continue;
    }
    const canonical = canonicalById.get(eligibility.canonicalRouteSourceId);
    const sourceRoute = sourceById.get(eligibility.canonicalRouteSourceId);
    if (!canonical || !sourceRoute) {
      const missing = canonical ? "source route" : "canonical audit record";
      const placeholderId = eligibility.canonicalRouteSourceId;
      const placeholderContract: OSMRouteImportContract = {
        contractVersion: OSM_ROUTE_IMPORT_CONTRACT_VERSION,
        idempotencyKey: createRouteIdempotencyKey(placeholderId),
        provider: "openstreetmap",
        source: {
          sourceType: "relation",
          sourceRelationId: placeholderId,
          canonicalSourceId: placeholderId,
          sourceUrl: `https://www.openstreetmap.org/relation/${placeholderId}`,
          provenanceId: "",
          license: "",
          attribution: "",
        },
        dataset: { version: input.datasetVersion, phase7AuditHash: input.phase7AuditHash },
        route: {
          name: eligibility.routeName,
          semanticType: "unknown",
          qualityScore: eligibility.qualityScore,
          geometry: { type: "LineString", coordinates: [] },
          geometryType: "LineString",
          distanceMeters: 0,
          componentCount: 0,
          bounds: {
            minimumLongitude: 0,
            minimumLatitude: 0,
            maximumLongitude: 0,
            maximumLatitude: 0,
          },
        },
        confirmedSummits: [],
        mergedDuplicateProvenance: {
          duplicateGroupId: null,
          sourceRouteIds: [...eligibility.sourceRouteIds],
          removedDuplicateRepresentationIds: [],
          sourceProvenance: [],
        },
        auditFlags: [...eligibility.auditFlags],
        importEligibility: "AUTO_IMPORT_READY",
        routeAdministration: {
          status: "UNASSIGNED",
          reason: "Canonical/source inputs are missing.",
          boundaryProvenance: input.adminBoundaries
            ? { ...input.adminBoundaries.metadata }
            : null,
        },
      };
      const plan = createImportPlanRecord(placeholderContract);
      plan.reasons.push(`Missing ${missing} for canonical route ${placeholderId}.`);
      plan.operation = "BLOCKED_VALIDATION";
      records.push(plan);
      continue;
    }
    records.push(
      createImportPlanRecord(
        createImportContract({
          eligibility,
          canonical,
          sourceRoute,
          mountains: input.mountains,
          datasetVersion: input.datasetVersion,
          phase7AuditHash: input.phase7AuditHash,
          adminBoundaries: input.adminBoundaries,
        }),
      ),
    );
  }
  records.sort((left, right) =>
    left.canonicalRouteSourceId.localeCompare(right.canonicalRouteSourceId, "en", {
      numeric: true,
    }),
  );
  return { records, excludedEligibilityCounts };
}

export interface ImportPlanSummary {
  totalEligibleRoutes: number;
  operations: Record<StagingOperation, number>;
  mountainMatches: {
    associations: Record<MountainMatchClassification, number>;
    uniquePeaks: Record<MountainMatchClassification, number>;
    uniqueExistingMountainsCovered: number;
  };
}

const STAGING_OPERATIONS: readonly StagingOperation[] = [
  "READY_FOR_STAGING",
  "BLOCKED_NO_MOUNTAIN",
  "BLOCKED_AMBIGUOUS",
  "BLOCKED_VALIDATION",
];

const MATCH_CLASSIFICATIONS: readonly MountainMatchClassification[] = [
  "EXACT_MOUNTAIN_MATCH",
  "PROBABLE_MOUNTAIN_MATCH",
  "NO_MOUNTAIN_MATCH",
  "AMBIGUOUS_MOUNTAIN_MATCH",
];

function zeroOperationCounts(): Record<StagingOperation, number> {
  return Object.fromEntries(
    STAGING_OPERATIONS.map((operation) => [operation, 0]),
  ) as Record<StagingOperation, number>;
}

function zeroMatchCounts(): Record<MountainMatchClassification, number> {
  return Object.fromEntries(
    MATCH_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<MountainMatchClassification, number>;
}

export function summarizeImportPlan(records: ImportPlanRecord[]): ImportPlanSummary {
  const operations = zeroOperationCounts();
  const associations = zeroMatchCounts();
  const uniquePeaks = zeroMatchCounts();
  const peakClassifications = new Map<string, MountainMatchClassification>();
  const exactMountainIds = new Set<number>();

  for (const record of records) {
    operations[record.operation] += 1;
    for (const summit of record.summits) {
      associations[summit.mountainMatch.classification] += 1;
      const existing = peakClassifications.get(summit.peakOsmId);
      if (existing && existing !== summit.mountainMatch.classification) {
        throw new Error(
          `Peak ${summit.peakOsmId} has inconsistent mountain-match classifications.`,
        );
      }
      peakClassifications.set(summit.peakOsmId, summit.mountainMatch.classification);
      if (
        summit.mountainMatch.classification === "EXACT_MOUNTAIN_MATCH" &&
        summit.mountainMatch.mountainId !== null
      ) {
        exactMountainIds.add(summit.mountainMatch.mountainId);
      }
    }
  }
  for (const classification of peakClassifications.values()) {
    uniquePeaks[classification] += 1;
  }
  return {
    totalEligibleRoutes: records.length,
    operations,
    mountainMatches: {
      associations,
      uniquePeaks,
      uniqueExistingMountainsCovered: exactMountainIds.size,
    },
  };
}

export interface AdminEnrichmentSummary {
  peaks: {
    totalUniquePeaks: number;
    assignedToCountry: number;
    assignedToAdmin1: number;
    ambiguous: number;
    unassigned: number;
    byCountry: Record<string, number>;
    byAdmin1: Record<string, number>;
  };
  routes: {
    total: number;
    assigned: number;
    ambiguous: number;
    unassigned: number;
    byCountry: Record<string, number>;
    byAdmin1: Record<string, number>;
  };
}

export function summarizeAdminEnrichment(
  records: ImportPlanRecord[],
): AdminEnrichmentSummary {
  const peaksById = new Map<string, AdminBoundaryResolution>();
  const peakCounts = {
    totalUniquePeaks: 0,
    assignedToCountry: 0,
    assignedToAdmin1: 0,
    ambiguous: 0,
    unassigned: 0,
    byCountry: {} as Record<string, number>,
    byAdmin1: {} as Record<string, number>,
  };
  const routeCounts = {
    total: records.length,
    assigned: 0,
    ambiguous: 0,
    unassigned: 0,
    byCountry: {} as Record<string, number>,
    byAdmin1: {} as Record<string, number>,
  };

  for (const record of records) {
    for (const summit of record.contract.confirmedSummits) {
      const existing = peaksById.get(summit.peakOsmId);
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(summit.administration)
      ) {
        throw new Error(
          `Peak ${summit.peakOsmId} has inconsistent administrative resolutions.`,
        );
      }
      peaksById.set(summit.peakOsmId, summit.administration);
    }
    const routeResolution = record.contract.routeAdministration;
    if (routeResolution.status === "ASSIGNED") {
      routeCounts.assigned += 1;
      incrementRecord(routeCounts.byCountry, routeResolution.countryCode);
      incrementRecord(
        routeCounts.byAdmin1,
        `${routeResolution.countryCode}:${routeResolution.admin1Code}:${routeResolution.admin1Name}`,
      );
    } else if (routeResolution.status === "AMBIGUOUS") {
      routeCounts.ambiguous += 1;
    } else {
      routeCounts.unassigned += 1;
    }
  }

  peakCounts.totalUniquePeaks = peaksById.size;
  for (const resolution of peaksById.values()) {
    if (resolution.status === "ASSIGNED") {
      peakCounts.assignedToCountry += 1;
      peakCounts.assignedToAdmin1 += 1;
      incrementRecord(peakCounts.byCountry, resolution.countryCode);
      incrementRecord(
        peakCounts.byAdmin1,
        `${resolution.countryCode}:${resolution.admin1Code}:${resolution.admin1Name}`,
      );
    } else if (resolution.status === "AMBIGUOUS") {
      peakCounts.ambiguous += 1;
    } else {
      peakCounts.unassigned += 1;
    }
  }
  return { peaks: peakCounts, routes: routeCounts };
}

export interface FirstBatchRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  routeName: string | null;
  operation: StagingOperation;
  semanticType: RouteSemanticType;
  qualityScore: number;
  distanceMeters: number;
  elevationMeters: number | null;
  countryCode: string | null;
  mountainMatchClassifications: MountainMatchClassification[];
  auditFlags: string[];
  idempotencyKey: string;
}

export interface FirstBatchSelection {
  selectionMethod: string;
  selectedCount: number;
  composition: {
    operations: Record<StagingOperation, number>;
    semanticTypes: Record<string, number>;
    mountainMatchClassifications: Record<MountainMatchClassification, number>;
    countries: Record<string, number>;
    qualityBands: Record<string, number>;
    routeLengthBands: Record<string, number>;
    elevationBands: Record<string, number>;
  };
  routes: FirstBatchRecord[];
}

function qualityBand(value: number): string {
  if (value >= 90) return "90-100";
  if (value >= 80) return "80-89";
  if (value >= 70) return "70-79";
  return "<70";
}

function routeLengthBand(value: number): string {
  if (value < 5_000) return "<5km";
  if (value < 15_000) return "5-15km";
  if (value < 30_000) return "15-30km";
  return ">=30km";
}

function elevationBand(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1_500) return "<1500m";
  if (value < 2_500) return "1500-2499m";
  if (value < 3_500) return "2500-3499m";
  return ">=3500m";
}

function recordElevation(record: ImportPlanRecord): number | null {
  const values = record.contract.confirmedSummits
    .map((summit) => summit.peakElevationMeters)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

function recordCountryCode(record: ImportPlanRecord): string {
  return record.contract.routeAdministration.status === "ASSIGNED"
    ? record.contract.routeAdministration.countryCode
    : record.contract.routeAdministration.status.toLowerCase();
}

function recordFeatures(record: ImportPlanRecord): string[] {
  const country = recordCountryCode(record);
  const elevation = recordElevation(record);
  return [
    `operation:${record.operation}`,
    `semantic:${record.contract.route.semanticType}`,
    `quality:${qualityBand(record.contract.route.qualityScore)}`,
    `length:${routeLengthBand(record.contract.route.distanceMeters)}`,
    `elevation:${elevationBand(elevation)}`,
    `country:${country}`,
    ...new Set(
      record.summits.map(
        (summit) => `match:${summit.mountainMatch.classification}`,
      ),
    ),
  ];
}

function compareSourceIds(left: ImportPlanRecord, right: ImportPlanRecord): number {
  return left.canonicalRouteSourceId.localeCompare(
    right.canonicalRouteSourceId,
    "en",
    { numeric: true },
  );
}

export function selectDeterministicValidationBatch(
  records: ImportPlanRecord[],
  limit = 50,
): ImportPlanRecord[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be non-negative");
  const remaining = [...records];
  const selected: ImportPlanRecord[] = [];
  const coveredFeatures = new Set<string>();

  while (remaining.length > 0 && selected.length < limit) {
    remaining.sort((left, right) => {
      const leftNovelty = recordFeatures(left).filter(
        (feature) => !coveredFeatures.has(feature),
      ).length;
      const rightNovelty = recordFeatures(right).filter(
        (feature) => !coveredFeatures.has(feature),
      ).length;
      if (leftNovelty !== rightNovelty) return rightNovelty - leftNovelty;
      const leftNamed = left.routeName?.trim() ? 1 : 0;
      const rightNamed = right.routeName?.trim() ? 1 : 0;
      if (leftNamed !== rightNamed) return rightNamed - leftNamed;
      if (left.contract.route.qualityScore !== right.contract.route.qualityScore) {
        return right.contract.route.qualityScore - left.contract.route.qualityScore;
      }
      return compareSourceIds(left, right);
    });
    const chosen = remaining.shift() as ImportPlanRecord;
    selected.push(chosen);
    for (const feature of recordFeatures(chosen)) coveredFeatures.add(feature);
  }
  return selected;
}

function incrementRecord(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function buildFirstBatchSelection(
  records: ImportPlanRecord[],
  limit = 50,
): FirstBatchSelection {
  const selected = selectDeterministicValidationBatch(records, limit);
  const operations = zeroOperationCounts();
  const matchCounts = zeroMatchCounts();
  const semanticTypes: Record<string, number> = {};
  const countries: Record<string, number> = {};
  const qualityBands: Record<string, number> = {};
  const routeLengthBands: Record<string, number> = {};
  const elevationBands: Record<string, number> = {};
  const routes = selected.map((record): FirstBatchRecord => {
    const country = recordCountryCode(record);
    const elevation = recordElevation(record);
    operations[record.operation] += 1;
    incrementRecord(semanticTypes, record.contract.route.semanticType);
    incrementRecord(countries, country);
    incrementRecord(qualityBands, qualityBand(record.contract.route.qualityScore));
    incrementRecord(routeLengthBands, routeLengthBand(record.contract.route.distanceMeters));
    incrementRecord(elevationBands, elevationBand(elevation));
    const classifications = [
      ...new Set(record.summits.map((summit) => summit.mountainMatch.classification)),
    ].sort();
    for (const classification of classifications) matchCounts[classification] += 1;
    return {
      sourceRelationId: record.sourceRelationId,
      canonicalRouteSourceId: record.canonicalRouteSourceId,
      routeName: record.routeName,
      operation: record.operation,
      semanticType: record.contract.route.semanticType,
      qualityScore: record.contract.route.qualityScore,
      distanceMeters: record.contract.route.distanceMeters,
      elevationMeters: elevation,
      countryCode:
        record.contract.routeAdministration.status === "ASSIGNED"
          ? record.contract.routeAdministration.countryCode
          : null,
      mountainMatchClassifications: classifications,
      auditFlags: [...record.contract.auditFlags],
      idempotencyKey: record.idempotencyKey,
    };
  });
  return {
    selectionMethod:
      "Greedy deterministic coverage of operation, match, semantic, quality, length, elevation, and available country strata; then named/high-quality routes; numeric source ID tie-break.",
    selectedCount: routes.length,
    composition: {
      operations,
      semanticTypes,
      mountainMatchClassifications: matchCounts,
      countries,
      qualityBands,
      routeLengthBands,
      elevationBands,
    },
    routes,
  };
}

export interface FirstBatchQaRecord {
  sourceRelationId: string;
  routeName: string | null;
  operation: StagingOperation;
  semanticType: RouteSemanticType;
  qualityScore: number;
  distanceMeters: number;
  peakElevationMeters: number | null;
  geometryBounds: GeometryBounds;
  summits: Array<{
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    mountainMatch: MountainMatchResult;
    associationConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    evidence: string[];
  }>;
  warnings: string[];
  inspection: {
    osmRouteUrl: string;
    osmPeakUrls: string[];
    localMountainPaths: string[];
  };
}

export function buildFirstBatchQa(
  records: ImportPlanRecord[],
  limit = 50,
): FirstBatchQaRecord[] {
  return selectDeterministicValidationBatch(records, limit).map((record) => ({
    sourceRelationId: record.sourceRelationId,
    routeName: record.routeName,
    operation: record.operation,
    semanticType: record.contract.route.semanticType,
    qualityScore: record.contract.route.qualityScore,
    distanceMeters: record.contract.route.distanceMeters,
    peakElevationMeters: recordElevation(record),
    geometryBounds: record.contract.route.bounds,
    summits: record.contract.confirmedSummits.map((summit) => ({
      peakOsmId: summit.peakOsmId,
      peakName: summit.peakName,
      peakElevationMeters: summit.peakElevationMeters,
      mountainMatch: summit.mountainMatch,
      associationConfidence: summit.finalConfidence,
      minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
      evidence: [...summit.evidence],
    })),
    warnings: [...record.warnings],
    inspection: {
      osmRouteUrl: record.contract.source.sourceUrl,
      osmPeakUrls: record.contract.confirmedSummits.map(
        (summit) => `https://www.openstreetmap.org/node/${summit.peakOsmId}`,
      ),
      localMountainPaths: [
        ...new Set(
          record.contract.confirmedSummits
            .map((summit) => summit.mountainMatch.mountainId)
            .filter((mountainId): mountainId is number => mountainId !== null)
            .map((mountainId) => `/mountain/${mountainId}`),
        ),
      ],
    },
  }));
}

export interface Phase8CliOptions {
  mode: "dry-run" | "apply-staging";
  limit: number | null;
  confirmAll: boolean;
  adminBoundariesPath: string | null;
  mountainCatalogPath: string | null;
  manifestPath: string | null;
}

export function parsePhase8CliOptions(argv: string[]): Phase8CliOptions {
  let mode: Phase8CliOptions["mode"] = "dry-run";
  let explicitlyDryRun = false;
  let limit: number | null = null;
  let confirmAll = false;
  let adminBoundariesPath: string | null = null;
  let mountainCatalogPath: string | null = null;
  let manifestPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      explicitlyDryRun = true;
    } else if (argument === "--apply-staging") {
      mode = "apply-staging";
    } else if (argument === "--confirm-all") {
      confirmAll = true;
    } else if (
      ["--limit", "--admin-boundaries", "--mountain-catalog", "--manifest"].includes(
        argument,
      )
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--limit") {
        limit = Number(value);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error("--limit must be a positive integer");
        }
      } else if (argument === "--admin-boundaries") {
        adminBoundariesPath = value;
      } else if (argument === "--mountain-catalog") {
        mountainCatalogPath = value;
      } else {
        manifestPath = value;
      }
    } else {
      throw new Error(`Unknown Phase 8 argument: ${argument}`);
    }
  }
  if (explicitlyDryRun && mode === "apply-staging") {
    throw new Error("--dry-run and --apply-staging are mutually exclusive");
  }
  if (limit !== null && manifestPath !== null) {
    throw new Error("--limit and --manifest are mutually exclusive");
  }
  if (mode === "apply-staging" && limit === null && !confirmAll && manifestPath === null) {
    throw new Error("Unlimited staging writes require --confirm-all");
  }
  if (mode === "dry-run" && confirmAll) {
    throw new Error("--confirm-all is only valid with --apply-staging");
  }
  return {
    mode,
    limit,
    confirmAll,
    adminBoundariesPath,
    mountainCatalogPath,
    manifestPath,
  };
}

export interface FirstWriteManifestMountainMatch {
  peakOsmId: string;
  mountainId: number;
  classification: "EXACT_MOUNTAIN_MATCH";
}

export interface FirstWriteManifestRecord {
  idempotencyKey: string;
  payloadHash: string;
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  expectedSummitAssociationCount: number;
  mountainMatches: FirstWriteManifestMountainMatch[];
  lockedEvidence?: FirstWriteManifestLockedEvidence;
}

export interface FirstWriteManifestLockedEvidence {
  datasetFingerprint: string;
  sourceUrl: string;
  geometryHash: string;
  importEligibility: "AUTO_IMPORT_READY";
  routeMetadata: {
    semanticType: RouteSemanticType;
    qualityScore: number;
    geometryType: RouteGeometry["type"];
    distanceMeters: number;
    componentCount: number;
    auditFlags: string[];
    warnings: string[];
  };
  summitAssociations: Array<{
    peakOsmId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: Coordinate | null;
    finalAssociation: "CONFIRMED";
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    associationEvidence: string[];
    mountainId: number;
    mountainName: string | null;
    mountainElevationMeters: number | null;
    mountainMatchClassification: "EXACT_MOUNTAIN_MATCH";
    exactMatchEvidence: string[];
  }>;
}

export interface FirstWriteManifest {
  schemaVersion: 1;
  contractVersion: typeof OSM_ROUTE_IMPORT_CONTRACT_VERSION;
  datasetFingerprint: string;
  recordCount: number;
  expectedSummitAssociationCount: number;
  records: FirstWriteManifestRecord[];
  manifestHash: string;
}

export function createPhase8DatasetFingerprint(input: {
  datasetVersion: string;
  phase7AuditHash: string;
  mountainCatalogFingerprint: string;
  adminBoundaryVersion: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function manifestMountainMatches(
  record: ImportPlanRecord,
): FirstWriteManifestMountainMatch[] {
  return record.contract.confirmedSummits
    .map((summit) => {
      if (
        summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
        summit.mountainMatch.mountainId === null
      ) {
        throw new Error(
          `Manifest record ${record.idempotencyKey} does not have exact mountain resolution.`,
        );
      }
      return {
        peakOsmId: summit.peakOsmId,
        mountainId: summit.mountainMatch.mountainId,
        classification: summit.mountainMatch.classification,
      };
    })
    .sort(
      (left, right) =>
        left.peakOsmId.localeCompare(right.peakOsmId, "en", { numeric: true }) ||
        left.mountainId - right.mountainId,
    );
}

function manifestContentHash(
  manifest: Omit<FirstWriteManifest, "manifestHash">,
): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function lockedManifestEvidence(
  record: ImportPlanRecord,
  datasetFingerprint: string,
): FirstWriteManifestLockedEvidence {
  const summitAssociations = record.contract.confirmedSummits
    .map((summit) => {
      if (
        summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
        summit.mountainMatch.mountainId === null
      ) {
        throw new Error(`Cannot lock non-exact summit ${summit.peakOsmId}.`);
      }
      return {
        peakOsmId: summit.peakOsmId,
        peakName: summit.peakName,
        peakElevationMeters: summit.peakElevationMeters,
        peakCoordinates: summit.peakCoordinates,
        finalAssociation: summit.finalAssociation,
        finalConfidence: summit.finalConfidence,
        minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
        endpointDistanceMeters: summit.endpointDistanceMeters,
        associationEvidence: [...summit.evidence],
        mountainId: summit.mountainMatch.mountainId,
        mountainName: summit.mountainMatch.mountainName,
        mountainElevationMeters: summit.mountainMatch.mountainElevationMeters,
        mountainMatchClassification: summit.mountainMatch.classification,
        exactMatchEvidence: [...summit.mountainMatch.reasons],
      };
    })
    .sort((left, right) =>
      left.peakOsmId.localeCompare(right.peakOsmId, "en", { numeric: true }),
    );
  return {
    datasetFingerprint,
    sourceUrl: record.contract.source.sourceUrl,
    geometryHash: createHash("sha256")
      .update(JSON.stringify(record.contract.route.geometry))
      .digest("hex"),
    importEligibility: record.contract.importEligibility,
    routeMetadata: {
      semanticType: record.contract.route.semanticType,
      qualityScore: record.contract.route.qualityScore,
      geometryType: record.contract.route.geometryType,
      distanceMeters: record.contract.route.distanceMeters,
      componentCount: record.contract.route.componentCount,
      auditFlags: [...record.contract.auditFlags],
      warnings: [...record.warnings],
    },
    summitAssociations,
  };
}

export function createFirstWriteManifest(
  approvedRecords: ImportPlanRecord[],
  datasetFingerprint: string,
): FirstWriteManifest {
  const records = [...approvedRecords]
    .sort(compareSourceIds)
    .map((record): FirstWriteManifestRecord => {
      if (record.operation !== "READY_FOR_STAGING") {
        throw new Error(
          `Cannot approve ${record.idempotencyKey}: record is ${record.operation}.`,
        );
      }
      return {
        idempotencyKey: record.idempotencyKey,
        payloadHash: record.payloadHash,
        sourceRelationId: record.sourceRelationId,
        canonicalRouteSourceId: record.canonicalRouteSourceId,
        expectedSummitAssociationCount: record.contract.confirmedSummits.length,
        mountainMatches: manifestMountainMatches(record),
      };
    });
  if (new Set(records.map((record) => record.idempotencyKey)).size !== records.length) {
    throw new Error("Approved records contain duplicate idempotency keys.");
  }
  const content: Omit<FirstWriteManifest, "manifestHash"> = {
    schemaVersion: 1,
    contractVersion: OSM_ROUTE_IMPORT_CONTRACT_VERSION,
    datasetFingerprint,
    recordCount: records.length,
    expectedSummitAssociationCount: records.reduce(
      (sum, record) => sum + record.expectedSummitAssociationCount,
      0,
    ),
    records,
  };
  return { ...content, manifestHash: manifestContentHash(content) };
}

export function createLockedFirstWriteManifest(
  approvedRecords: ImportPlanRecord[],
  datasetFingerprint: string,
): FirstWriteManifest {
  const base = createFirstWriteManifest(approvedRecords, datasetFingerprint);
  const byKey = new Map(approvedRecords.map((record) => [record.idempotencyKey, record]));
  const records = base.records.map((manifestRecord) => {
    const record = byKey.get(manifestRecord.idempotencyKey);
    if (!record) throw new Error(`Missing locked record ${manifestRecord.idempotencyKey}.`);
    return {
      ...manifestRecord,
      lockedEvidence: lockedManifestEvidence(record, datasetFingerprint),
    };
  });
  const { manifestHash: ignoredManifestHash, ...baseContent } = base;
  void ignoredManifestHash;
  const content: Omit<FirstWriteManifest, "manifestHash"> = {
    ...baseContent,
    records,
  };
  return { ...content, manifestHash: manifestContentHash(content) };
}

export function validateFirstWriteManifest(
  planRecords: ImportPlanRecord[],
  manifest: FirstWriteManifest,
  expectedDatasetFingerprint: string,
): ImportPlanRecord[] {
  if (manifest.schemaVersion !== 1) throw new Error("Manifest schema version mismatch.");
  if (manifest.contractVersion !== OSM_ROUTE_IMPORT_CONTRACT_VERSION) {
    throw new Error("Manifest contract version mismatch.");
  }
  if (manifest.datasetFingerprint !== expectedDatasetFingerprint) {
    throw new Error("Manifest dataset fingerprint mismatch.");
  }
  if (manifest.recordCount !== manifest.records.length) {
    throw new Error("Manifest record count mismatch.");
  }
  const keys = manifest.records.map((record) => record.idempotencyKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Manifest contains a duplicate idempotency key.");
  }
  const { manifestHash: ignoredManifestHash, ...content } = manifest;
  void ignoredManifestHash;
  if (manifest.manifestHash !== manifestContentHash(content)) {
    throw new Error("Manifest content hash mismatch.");
  }
  const byKey = new Map(planRecords.map((record) => [record.idempotencyKey, record]));
  const selected = manifest.records.map((manifestRecord) => {
    const record = byKey.get(manifestRecord.idempotencyKey);
    if (!record) {
      throw new Error(`Manifest key is missing from the current plan: ${manifestRecord.idempotencyKey}`);
    }
    if (record.contract.contractVersion !== manifest.contractVersion) {
      throw new Error(`Contract version changed for ${manifestRecord.idempotencyKey}.`);
    }
    if (record.operation !== "READY_FOR_STAGING") {
      throw new Error(
        `Manifest record is no longer READY_FOR_STAGING: ${manifestRecord.idempotencyKey}`,
      );
    }
    const currentMatches = manifestMountainMatches(record);
    if (JSON.stringify(currentMatches) !== JSON.stringify(manifestRecord.mountainMatches)) {
      throw new Error(`Mountain resolution changed for ${manifestRecord.idempotencyKey}.`);
    }
    if (record.payloadHash !== manifestRecord.payloadHash) {
      throw new Error(`Payload hash changed for ${manifestRecord.idempotencyKey}.`);
    }
    if (
      record.sourceRelationId !== manifestRecord.sourceRelationId ||
      record.canonicalRouteSourceId !== manifestRecord.canonicalRouteSourceId
    ) {
      throw new Error(`Source identity changed for ${manifestRecord.idempotencyKey}.`);
    }
    if (
      record.contract.confirmedSummits.length !==
      manifestRecord.expectedSummitAssociationCount
    ) {
      throw new Error(`Summit association count changed for ${manifestRecord.idempotencyKey}.`);
    }
    if (
      manifestRecord.lockedEvidence !== undefined &&
      JSON.stringify(lockedManifestEvidence(record, expectedDatasetFingerprint)) !==
        JSON.stringify(manifestRecord.lockedEvidence)
    ) {
      throw new Error(`Locked staging evidence changed for ${manifestRecord.idempotencyKey}.`);
    }
    return record;
  });
  if (
    selected.reduce(
      (sum, record) => sum + record.contract.confirmedSummits.length,
      0,
    ) !== manifest.expectedSummitAssociationCount
  ) {
    throw new Error("Manifest total summit association count mismatch.");
  }
  return selected;
}

export interface ExistingStagingRecord {
  id: string;
  payloadHash: string;
}

export type StagingInspection =
  | { status: "MISSING" }
  | { status: "UNCHANGED"; id: string }
  | { status: "DRIFT"; reason: string }
  | { status: "CONFLICT"; reason: string };

export interface StagingWriter {
  findByIdempotencyKey(idempotencyKey: string): Promise<ExistingStagingRecord | null>;
  inspectRecord?(record: ImportPlanRecord): Promise<StagingInspection>;
  upsertRouteWithSummits(record: ImportPlanRecord): Promise<{ id: string }>;
}

export interface StagingPreflightResult {
  wouldCreate: number;
  wouldUpdate: number;
  unchanged: number;
  blocked: number;
  records: Array<{
    sourceRelationId: string;
    action: "WOULD_CREATE" | "WOULD_UPDATE" | "UNCHANGED" | "BLOCKED";
    reason: string | null;
  }>;
  databaseWrites: 0;
}

export interface StagingApplyResult {
  attempted: number;
  createdOrUpdated: number;
  unchanged: number;
  databaseWrites: number;
}

export function selectReadyStagingRecords(
  records: ImportPlanRecord[],
  limit: number | null,
): ImportPlanRecord[] {
  const ready = records.filter((record) => record.operation === "READY_FOR_STAGING");
  return selectDeterministicValidationBatch(ready, limit ?? ready.length);
}

export async function preflightStagingPlan(
  records: ImportPlanRecord[],
  writer: StagingWriter,
  options: { blockExistingDrift: boolean },
): Promise<StagingPreflightResult> {
  const results: StagingPreflightResult["records"] = [];
  for (const record of records) {
    const inspection = writer.inspectRecord
      ? await writer.inspectRecord(record)
      : await writer.findByIdempotencyKey(record.idempotencyKey).then((existing): StagingInspection => {
          if (!existing) return { status: "MISSING" };
          return existing.payloadHash === record.payloadHash
            ? { status: "UNCHANGED", id: existing.id }
            : { status: "DRIFT", reason: "Existing staging payload hash differs." };
        });
    if (inspection.status === "MISSING") {
      results.push({ sourceRelationId: record.sourceRelationId, action: "WOULD_CREATE", reason: null });
    } else if (inspection.status === "UNCHANGED") {
      results.push({ sourceRelationId: record.sourceRelationId, action: "UNCHANGED", reason: null });
    } else if (inspection.status === "DRIFT" && !options.blockExistingDrift) {
      results.push({ sourceRelationId: record.sourceRelationId, action: "WOULD_UPDATE", reason: inspection.reason });
    } else {
      results.push({ sourceRelationId: record.sourceRelationId, action: "BLOCKED", reason: inspection.reason });
    }
  }
  return {
    wouldCreate: results.filter((record) => record.action === "WOULD_CREATE").length,
    wouldUpdate: results.filter((record) => record.action === "WOULD_UPDATE").length,
    unchanged: results.filter((record) => record.action === "UNCHANGED").length,
    blocked: results.filter((record) => record.action === "BLOCKED").length,
    records: results,
    databaseWrites: 0,
  };
}

export async function applyStagingPlan(
  records: ImportPlanRecord[],
  options: Pick<Phase8CliOptions, "mode" | "limit" | "confirmAll">,
  writer?: StagingWriter,
  manifestGuard?: {
    manifest: FirstWriteManifest;
    datasetFingerprint: string;
  },
): Promise<StagingApplyResult> {
  if (options.mode !== "apply-staging") {
    return { attempted: 0, createdOrUpdated: 0, unchanged: 0, databaseWrites: 0 };
  }
  if (options.limit === null && !options.confirmAll && !manifestGuard) {
    throw new Error("Unlimited staging writes require --confirm-all");
  }
  if (!writer) throw new Error("A staging writer is required for --apply-staging");
  const selected = manifestGuard
    ? validateFirstWriteManifest(
        records,
        manifestGuard.manifest,
        manifestGuard.datasetFingerprint,
      )
    : selectReadyStagingRecords(records, options.limit);
  const preflight = await preflightStagingPlan(selected, writer, {
    blockExistingDrift: manifestGuard !== undefined,
  });
  if (preflight.blocked > 0) {
    const first = preflight.records.find((record) => record.action === "BLOCKED");
    throw new Error(
      `Staging preflight blocked ${preflight.blocked} record(s); first ${first?.sourceRelationId}: ${first?.reason}`,
    );
  }
  let createdOrUpdated = 0;
  const unchanged = preflight.unchanged;
  let databaseWrites = 0;
  const actionByRelation = new Map(
    preflight.records.map((record) => [record.sourceRelationId, record.action]),
  );
  for (const record of selected) {
    if (actionByRelation.get(record.sourceRelationId) === "UNCHANGED") continue;
    await writer.upsertRouteWithSummits(record);
    createdOrUpdated += 1;
    databaseWrites += 1;
  }
  return {
    attempted: selected.length,
    createdOrUpdated,
    unchanged,
    databaseWrites,
  };
}
