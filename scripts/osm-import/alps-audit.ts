import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { Coordinate, RouteGeometry } from "./peak-matcher.ts";
import type {
  FinalAssociationResult,
  FinalSummitAssociation,
} from "./route-analysis.ts";
import type { DuplicateGroup } from "./route-groups.ts";
import type { RouteSemanticType } from "./route-classifier.ts";

export const PHASE_7_AUDIT_RULES = Object.freeze({
  automaticImportMinimumQuality: 70,
  lowQualityThreshold: 50,
  highFragmentationComponentCount: 10,
  suspiciousShortDistanceMeters: 100,
  suspiciousLongDistanceMeters: 500_000,
  reviewOpportunityLimit: 100,
  manualSamplePerCategory: 25,
  rankingLimit: 100,
});

export type AuditFlag =
  | "LOW_QUALITY"
  | "HIGH_FRAGMENTATION"
  | "MISSING_NAME"
  | "UNKNOWN_SEMANTIC"
  | "SUSPICIOUS_SHORT"
  | "SUSPICIOUS_LONG"
  | "MULTIPLE_SUMMITS";

export type ImportEligibility =
  | "AUTO_IMPORT_READY"
  | "MANUAL_REVIEW_REQUIRED"
  | "EXCLUDE";

export interface Phase6SummaryInput {
  generatedAt: string;
  mode: string;
  provenance: {
    id: string;
    source: string;
    extractProvider: string;
    license: string;
    attribution: string;
    sourcePage: string;
  };
  counts: {
    hikingRelationsFound: number;
    selectedRelations: number;
    reconstructedRoutes: number;
    rejectedRoutes: number;
    peaks: number;
    summitAssociations: Record<FinalSummitAssociation, number>;
    similarityClassifications: {
      EXACT_DUPLICATE: number;
      NEAR_DUPLICATE: number;
      SAME_VARIANT: number;
      DIFFERENT_VARIANT: number;
      UNRELATED: number;
    };
    duplicateGroups: number;
  };
}

export interface IntegrityFailure {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  entityType: "DATASET" | "ROUTE" | "PEAK" | "ASSOCIATION" | "DUPLICATE_GROUP";
  sourceId: string | null;
  message: string;
}

export interface AuditRouteInput {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  geometryType: RouteGeometry["type"];
  distanceMeters: number;
  componentCount: number;
  heavilyFragmented: boolean;
  geometryValid: boolean;
  coordinatesFinite: boolean;
  provenanceId: string;
  license: string;
  attribution: string;
  explicitCountryCode: string | null;
}

export interface AuditPeakInput {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  elevationMeters: number | null;
  coordinates: Coordinate;
  coordinatesValid: boolean;
  provenanceId: string;
  license: string;
  attribution: string;
  explicitCountryCode: string | null;
}

export type AuditAssociationInput = FinalAssociationResult;

export interface AuditAnalysisInput {
  routeSourceId: string;
  routeName: string;
  semanticType: RouteSemanticType;
  qualityScore: number;
  summitAssociations: AuditAssociationInput[];
}

export interface Phase7AuditInput {
  summary: Phase6SummaryInput;
  routes: AuditRouteInput[];
  peaks: AuditPeakInput[];
  analyses: AuditAnalysisInput[];
  duplicateGroups: DuplicateGroup[];
  loaderIntegrityFailures?: IntegrityFailure[];
}

export interface NumericDistribution {
  count: number;
  missing: number;
  minimum: number | null;
  maximum: number | null;
  average: number | null;
  median: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

export interface ConfirmedSummitAuditRecord {
  peakSourceId: string;
  peakName: string | null;
  peakElevationMeters: number | null;
  peakCoordinates: Coordinate | null;
  minimumGeometryDistanceMeters: number;
  endpointDistanceMeters: number;
  finalConfidence: number;
  reasons: string[];
  provenanceId: string | null;
}

export interface ConfirmedRouteAuditRecord {
  routeSourceId: string;
  routeName: string | null;
  semanticType: RouteSemanticType;
  qualityScore: number;
  geometryType: RouteGeometry["type"];
  distanceMeters: number;
  componentCount: number;
  confirmedSummits: ConfirmedSummitAuditRecord[];
  auditFlags: AuditFlag[];
  provenance: {
    provenanceId: string;
    sourceUrl: string;
    license: string;
    attribution: string;
  };
  duplicateStatus: "UNGROUPED" | "CANONICAL" | "DUPLICATE_REPRESENTATION";
  duplicateGroupId: string | null;
  canonicalRouteSourceId: string;
}

interface SourceAssociationProvenance {
  routeSourceId: string;
  routeSourceUrl: string;
  routeProvenanceId: string;
  finalConfidence: number;
  minimumGeometryDistanceMeters: number;
  endpointDistanceMeters: number;
  reasons: string[];
}

export interface CanonicalConfirmedRouteAuditRecord {
  canonicalRouteSourceId: string;
  routeName: string | null;
  semanticType: RouteSemanticType;
  qualityScore: number;
  geometryType: RouteGeometry["type"];
  distanceMeters: number;
  componentCount: number;
  sourceRouteIds: string[];
  removedDuplicateRepresentationIds: string[];
  confirmedSummits: Array<
    ConfirmedSummitAuditRecord & {
      sourceRouteIds: string[];
      sourceAssociations: SourceAssociationProvenance[];
    }
  >;
  auditFlags: AuditFlag[];
  sourceProvenance: Array<{
    routeSourceId: string;
    sourceUrl: string;
    provenanceId: string;
    license: string;
    attribution: string;
  }>;
  duplicateGroupId: string | null;
}

export interface CoveredPeakAuditRecord {
  peakSourceId: string;
  name: string | null;
  elevationMeters: number | null;
  coordinates: Coordinate;
  confirmedRouteCount: number;
  confirmedRouteIds: string[];
  bestRouteId: string;
  bestRouteQuality: number;
  provenance: {
    provenanceId: string;
    sourceUrl: string;
    license: string;
    attribution: string;
  };
}

export interface ImportEligibilityRecord {
  canonicalRouteSourceId: string;
  routeName: string | null;
  eligibility: ImportEligibility;
  reasons: string[];
  auditFlags: AuditFlag[];
  qualityScore: number;
  confirmedPeakIds: string[];
  sourceRouteIds: string[];
}

export interface AssociationAuditSampleRecord {
  sampleKey: string;
  sampleCategories: string[];
  routeSourceId: string;
  routeName: string | null;
  semanticType: RouteSemanticType;
  routeQualityScore: number;
  routeDistanceMeters: number;
  routeConfirmedSummitCount: number;
  peakSourceId: string;
  peakName: string | null;
  peakElevationMeters: number | null;
  peakCoordinates: Coordinate | null;
  minimumGeometryDistanceMeters: number;
  endpointDistanceMeters: number;
  finalConfidence: number;
  finalAssociation: "CONFIRMED";
  reasons: string[];
}

export interface Phase7AuditArtifacts {
  confirmedRoutes: ConfirmedRouteAuditRecord[];
  coveredPeaks: CoveredPeakAuditRecord[];
  canonicalConfirmedRoutes: CanonicalConfirmedRouteAuditRecord[];
  peakCoverageRanking: Record<string, unknown>;
  manualAuditSample: Record<string, unknown>;
  reviewOpportunities: Record<string, unknown>;
  importEligibility: ImportEligibilityRecord[];
  finalSummary: Record<string, unknown>;
}

export interface Phase7BuildResult {
  artifacts: Phase7AuditArtifacts;
  stageTimingsMilliseconds: {
    aggregation: number;
    dedupCanonicalProcessing: number;
    auditGeneration: number;
  };
}

const COUNTRY_CODES = new Map([
  ["DE", "Germany"],
  ["AT", "Austria"],
  ["CH", "Switzerland"],
  ["IT", "Italy"],
  ["FR", "France"],
  ["SI", "Slovenia"],
  ["LI", "Liechtenstein"],
]);

function round(value: number, decimalPlaces: number): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

export function stableSourceIdCompare(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function stableTextCompare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = Math.min(1, Math.max(0, percentileValue)) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return round(
    sortedValues[lowerIndex] +
      (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction,
    2,
  );
}

export function summarizeNumeric(values: Array<number | null>): NumericDistribution {
  const present = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (present.length === 0) {
    return {
      count: 0,
      missing: values.length,
      minimum: null,
      maximum: null,
      average: null,
      median: null,
      p10: null,
      p25: null,
      p75: null,
      p90: null,
    };
  }
  return {
    count: present.length,
    missing: values.length - present.length,
    minimum: present[0],
    maximum: present[present.length - 1],
    average: round(
      present.reduce((total, value) => total + value, 0) / present.length,
      2,
    ),
    median: percentile(present, 0.5),
    p10: percentile(present, 0.1),
    p25: percentile(present, 0.25),
    p75: percentile(present, 0.75),
    p90: percentile(present, 0.9),
  };
}

export function qualityBucket(qualityScore: number):
  | "90-100"
  | "80-89"
  | "70-79"
  | "60-69"
  | "50-59"
  | "<50" {
  if (qualityScore >= 90) return "90-100";
  if (qualityScore >= 80) return "80-89";
  if (qualityScore >= 70) return "70-79";
  if (qualityScore >= 60) return "60-69";
  if (qualityScore >= 50) return "50-59";
  return "<50";
}

function coordinateIsFinite(coordinate: unknown): coordinate is Coordinate {
  return (
    Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
  );
}

export function validatePeakCoordinate(coordinate: unknown): boolean {
  return (
    coordinateIsFinite(coordinate) &&
    coordinate[0] >= -180 &&
    coordinate[0] <= 180 &&
    coordinate[1] >= -90 &&
    coordinate[1] <= 90
  );
}

export function validateRouteGeometry(geometry: RouteGeometry): {
  geometryValid: boolean;
  coordinatesFinite: boolean;
} {
  const components =
    geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  const geometryValid =
    components.length > 0 &&
    components.every((component) => Array.isArray(component) && component.length >= 2);
  const coordinatesFinite =
    geometryValid && components.every((component) => component.every(coordinateIsFinite));
  return { geometryValid, coordinatesFinite };
}

export function inferExplicitCountryCode(
  tags: Record<string, string> | undefined,
): string | null {
  if (!tags) return null;
  const candidate = [
    tags["addr:country"],
    tags["is_in:country_code"],
    tags["country_code"],
  ].find(Boolean);
  if (!candidate) return null;
  const normalized = candidate.trim().toUpperCase();
  return COUNTRY_CODES.has(normalized) ? normalized : null;
}

export function createRouteAuditFlags(
  route: AuditRouteInput,
  analysis: AuditAnalysisInput,
  confirmedSummitCount: number,
): AuditFlag[] {
  const flags: AuditFlag[] = [];
  if (analysis.qualityScore < PHASE_7_AUDIT_RULES.lowQualityThreshold) {
    flags.push("LOW_QUALITY");
  }
  if (
    route.heavilyFragmented ||
    route.componentCount >= PHASE_7_AUDIT_RULES.highFragmentationComponentCount
  ) {
    flags.push("HIGH_FRAGMENTATION");
  }
  if (!route.name?.trim()) flags.push("MISSING_NAME");
  if (analysis.semanticType === "unknown") flags.push("UNKNOWN_SEMANTIC");
  if (route.distanceMeters < PHASE_7_AUDIT_RULES.suspiciousShortDistanceMeters) {
    flags.push("SUSPICIOUS_SHORT");
  }
  if (route.distanceMeters > PHASE_7_AUDIT_RULES.suspiciousLongDistanceMeters) {
    flags.push("SUSPICIOUS_LONG");
  }
  if (confirmedSummitCount > 1) flags.push("MULTIPLE_SUMMITS");
  return flags;
}

interface DuplicateLookupEntry {
  group: DuplicateGroup;
  canonicalSourceId: string;
  isCanonical: boolean;
}

export function buildDuplicateLookup(
  groups: DuplicateGroup[],
): Map<string, DuplicateLookupEntry> {
  const lookup = new Map<string, DuplicateLookupEntry>();
  for (const group of [...groups].sort((left, right) =>
    stableSourceIdCompare(left.canonicalSourceId, right.canonicalSourceId),
  )) {
    for (const sourceId of group.memberSourceIds) {
      lookup.set(sourceId, {
        group,
        canonicalSourceId: group.canonicalSourceId,
        isCanonical: sourceId === group.canonicalSourceId,
      });
    }
  }
  return lookup;
}

function provenanceIsComplete(
  value: Pick<AuditRouteInput | AuditPeakInput, "provenanceId" | "license" | "attribution">,
): boolean {
  return (
    Boolean(value.provenanceId) &&
    value.license === "ODbL-1.0" &&
    value.attribution === "© OpenStreetMap contributors"
  );
}

export function classifyImportEligibility(input: {
  route: AuditRouteInput;
  qualityScore: number;
  flags: AuditFlag[];
  confirmedPeaks: Array<AuditPeakInput | null>;
}): { eligibility: ImportEligibility; reasons: string[] } {
  const criticalReasons: string[] = [];
  if (!input.route.geometryValid || !input.route.coordinatesFinite) {
    criticalReasons.push("Route geometry is invalid or contains non-finite coordinates.");
  }
  if (!(input.route.distanceMeters > 0)) {
    criticalReasons.push("Route distance is not positive.");
  }
  if (!provenanceIsComplete(input.route)) {
    criticalReasons.push("Route provenance or ODbL attribution is incomplete.");
  }
  if (input.confirmedPeaks.some((peak) => peak === null)) {
    criticalReasons.push("At least one confirmed peak does not resolve.");
  }
  if (
    input.confirmedPeaks.some(
      (peak) => peak !== null && !peak.coordinatesValid,
    )
  ) {
    criticalReasons.push("At least one confirmed peak has invalid coordinates.");
  }
  if (criticalReasons.length > 0) {
    return { eligibility: "EXCLUDE", reasons: criticalReasons };
  }

  const reviewReasons: string[] = [];
  if (input.qualityScore < PHASE_7_AUDIT_RULES.automaticImportMinimumQuality) {
    reviewReasons.push(
      `Route quality ${input.qualityScore} is below the automatic-import minimum of ${PHASE_7_AUDIT_RULES.automaticImportMinimumQuality}.`,
    );
  }
  const reviewFlags = input.flags.filter((flag) =>
    [
      "LOW_QUALITY",
      "HIGH_FRAGMENTATION",
      "MISSING_NAME",
      "UNKNOWN_SEMANTIC",
      "SUSPICIOUS_SHORT",
      "SUSPICIOUS_LONG",
      "MULTIPLE_SUMMITS",
    ].includes(flag),
  );
  if (reviewFlags.length > 0) {
    reviewReasons.push(`Audit flags require inspection: ${reviewFlags.join(", ")}.`);
  }
  if (input.confirmedPeaks.some((peak) => peak !== null && !peak.name?.trim())) {
    reviewReasons.push("At least one confirmed peak is unnamed.");
  }
  if (reviewReasons.length > 0) {
    return { eligibility: "MANUAL_REVIEW_REQUIRED", reasons: reviewReasons };
  }
  return {
    eligibility: "AUTO_IMPORT_READY",
    reasons: [
      "Canonical confirmed route passes geometry, provenance, peak, quality, and audit-flag requirements.",
    ],
  };
}

function geometryDistanceBuckets(associations: AuditAssociationInput[]): Record<string, number> {
  const counts = { "0-5": 0, ">5-15": 0, ">15-30": 0, ">30": 0 };
  for (const association of associations) {
    const distance = association.minDistanceMeters;
    if (distance <= 5) counts["0-5"] += 1;
    else if (distance <= 15) counts[">5-15"] += 1;
    else if (distance <= 30) counts[">15-30"] += 1;
    else counts[">30"] += 1;
  }
  return counts;
}

function endpointDistanceBuckets(associations: AuditAssociationInput[]): Record<string, number> {
  const counts = { "0-10": 0, ">10-30": 0, ">30-60": 0, ">60": 0 };
  for (const association of associations) {
    const distance = association.endpointDistanceMeters;
    if (distance <= 10) counts["0-10"] += 1;
    else if (distance <= 30) counts[">10-30"] += 1;
    else if (distance <= 60) counts[">30-60"] += 1;
    else counts[">60"] += 1;
  }
  return counts;
}

function confidenceBuckets(associations: AuditAssociationInput[]): Record<string, number> {
  const counts = { "1.00": 0, "0.95-0.999": 0, "0.90-0.949": 0, "<0.90": 0 };
  for (const association of associations) {
    const confidence = association.finalConfidence;
    if (confidence === 1) counts["1.00"] += 1;
    else if (confidence >= 0.95) counts["0.95-0.999"] += 1;
    else if (confidence >= 0.9) counts["0.90-0.949"] += 1;
    else counts["<0.90"] += 1;
  }
  return counts;
}

function qualityDistribution(qualityScores: number[]): Record<string, unknown> {
  const buckets = {
    "90-100": 0,
    "80-89": 0,
    "70-79": 0,
    "60-69": 0,
    "50-59": 0,
    "<50": 0,
  };
  qualityScores.forEach((score) => {
    buckets[qualityBucket(score)] += 1;
  });
  return {
    buckets,
    statistics: summarizeNumeric(qualityScores),
  };
}

function associationSort(
  left: AssociationAuditSampleRecord,
  right: AssociationAuditSampleRecord,
): number {
  return (
    stableSourceIdCompare(left.routeSourceId, right.routeSourceId) ||
    stableSourceIdCompare(left.peakSourceId, right.peakSourceId)
  );
}

function associationKey(routeSourceId: string, peakSourceId: string): string {
  return `${routeSourceId}:${peakSourceId}`;
}

function selectOneAssociationPerRoute(
  associations: AssociationAuditSampleRecord[],
): AssociationAuditSampleRecord[] {
  const selected = new Map<string, AssociationAuditSampleRecord>();
  for (const association of [...associations].sort(
    (left, right) =>
      right.finalConfidence - left.finalConfidence || associationSort(left, right),
  )) {
    if (!selected.has(association.routeSourceId)) {
      selected.set(association.routeSourceId, association);
    }
  }
  return [...selected.values()];
}

function geographicallyDistributedSample(
  associations: AssociationAuditSampleRecord[],
  limit: number,
): AssociationAuditSampleRecord[] {
  const candidates = associations
    .filter((association) => association.peakCoordinates !== null)
    .sort(associationSort);
  if (candidates.length <= limit) return candidates;
  const selected: AssociationAuditSampleRecord[] = [candidates[0]];
  const remaining = new Set(candidates.slice(1));
  while (selected.length < limit && remaining.size > 0) {
    let best: AssociationAuditSampleRecord | null = null;
    let bestDistance = -1;
    for (const candidate of remaining) {
      const coordinate = candidate.peakCoordinates as Coordinate;
      const minimumSquaredDistance = Math.min(
        ...selected.map((existing) => {
          const existingCoordinate = existing.peakCoordinates as Coordinate;
          return (
            (coordinate[0] - existingCoordinate[0]) ** 2 +
            (coordinate[1] - existingCoordinate[1]) ** 2
          );
        }),
      );
      if (
        minimumSquaredDistance > bestDistance ||
        (minimumSquaredDistance === bestDistance &&
          best !== null &&
          associationSort(candidate, best) < 0)
      ) {
        best = candidate;
        bestDistance = minimumSquaredDistance;
      }
    }
    if (!best) break;
    selected.push(best);
    remaining.delete(best);
  }
  return selected;
}

export function buildManualAuditSample(
  associations: AssociationAuditSampleRecord[],
): Record<string, unknown> {
  const limit = PHASE_7_AUDIT_RULES.manualSamplePerCategory;
  const perRoute = selectOneAssociationPerRoute(associations);
  const categories: Record<string, AssociationAuditSampleRecord[]> = {
    highestQuality: [...perRoute]
      .sort(
        (left, right) =>
          right.routeQualityScore - left.routeQualityScore || associationSort(left, right),
      )
      .slice(0, limit),
    lowestQuality: [...perRoute]
      .sort(
        (left, right) =>
          left.routeQualityScore - right.routeQualityScore || associationSort(left, right),
      )
      .slice(0, limit),
    multipleSummitCases: perRoute
      .filter((association) => association.routeConfirmedSummitCount > 1)
      .sort(
        (left, right) =>
          right.routeConfirmedSummitCount - left.routeConfirmedSummitCount ||
          associationSort(left, right),
      )
      .slice(0, limit),
    longestRoutes: [...perRoute]
      .sort(
        (left, right) =>
          right.routeDistanceMeters - left.routeDistanceMeters || associationSort(left, right),
      )
      .slice(0, limit),
    shortestRoutes: [...perRoute]
      .sort(
        (left, right) =>
          left.routeDistanceMeters - right.routeDistanceMeters || associationSort(left, right),
      )
      .slice(0, limit),
    geographicallyDistributedDeterministic: geographicallyDistributedSample(
      associations,
      limit,
    ),
  };

  const entryByKey = new Map<string, AssociationAuditSampleRecord>();
  const categoryKeys: Record<string, string[]> = {};
  for (const [category, selected] of Object.entries(categories)) {
    categoryKeys[category] = selected.map((association) => association.sampleKey);
    for (const association of selected) {
      const existing = entryByKey.get(association.sampleKey);
      if (existing) {
        if (!existing.sampleCategories.includes(category)) {
          existing.sampleCategories.push(category);
        }
      } else {
        entryByKey.set(association.sampleKey, {
          ...association,
          sampleCategories: [category],
        });
      }
    }
  }
  const entries = [...entryByKey.values()].sort(associationSort);
  entries.forEach((entry) => entry.sampleCategories.sort(stableTextCompare));
  return {
    limitPerCategory: limit,
    categoryKeys,
    uniqueEntryCount: entries.length,
    entries,
  };
}

function failure(
  code: string,
  entityType: IntegrityFailure["entityType"],
  sourceId: string | null,
  message: string,
  severity: IntegrityFailure["severity"] = "CRITICAL",
): IntegrityFailure {
  return { code, severity, entityType, sourceId, message };
}

function addUniqueBySourceId<T extends { sourceId: string }>(
  values: T[],
  entityType: "ROUTE" | "PEAK",
  duplicateCode: string,
  failures: IntegrityFailure[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.sourceId)) {
      failures.push(
        failure(
          duplicateCode,
          entityType,
          value.sourceId,
          `Duplicate ${entityType.toLowerCase()} source ID ${value.sourceId}.`,
        ),
      );
    } else {
      result.set(value.sourceId, value);
    }
  }
  return result;
}

function routeProvenance(route: AuditRouteInput): ConfirmedRouteAuditRecord["provenance"] {
  return {
    provenanceId: route.provenanceId,
    sourceUrl: route.sourceUrl,
    license: route.license,
    attribution: route.attribution,
  };
}

function confirmedSummitRecord(
  association: AuditAssociationInput,
  peak: AuditPeakInput | undefined,
): ConfirmedSummitAuditRecord {
  return {
    peakSourceId: association.peakSourceId,
    peakName: peak?.name ?? association.peakName,
    peakElevationMeters: peak?.elevationMeters ?? association.peakElevation,
    peakCoordinates: peak?.coordinates ?? null,
    minimumGeometryDistanceMeters: association.minDistanceMeters,
    endpointDistanceMeters: association.endpointDistanceMeters,
    finalConfidence: association.finalConfidence,
    reasons: [...association.reasons],
    provenanceId: peak?.provenanceId ?? null,
  };
}

function createAssociationSample(
  route: AuditRouteInput,
  analysis: AuditAnalysisInput,
  association: AuditAssociationInput,
  peak: AuditPeakInput | undefined,
  confirmedSummitCount: number,
): AssociationAuditSampleRecord {
  return {
    sampleKey: associationKey(route.sourceId, association.peakSourceId),
    sampleCategories: [],
    routeSourceId: route.sourceId,
    routeName: route.name,
    semanticType: analysis.semanticType,
    routeQualityScore: analysis.qualityScore,
    routeDistanceMeters: route.distanceMeters,
    routeConfirmedSummitCount: confirmedSummitCount,
    peakSourceId: association.peakSourceId,
    peakName: peak?.name ?? association.peakName,
    peakElevationMeters: peak?.elevationMeters ?? association.peakElevation,
    peakCoordinates: peak?.coordinates ?? null,
    minimumGeometryDistanceMeters: association.minDistanceMeters,
    endpointDistanceMeters: association.endpointDistanceMeters,
    finalConfidence: association.finalConfidence,
    finalAssociation: "CONFIRMED",
    reasons: [...association.reasons],
  };
}

function hashDeterministicContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildPhase7Audit(input: Phase7AuditInput): Phase7BuildResult {
  const aggregationStart = performance.now();
  const failures = [...(input.loaderIntegrityFailures ?? [])];
  const routeById = addUniqueBySourceId(
    input.routes,
    "ROUTE",
    "DUPLICATE_ROUTE_SOURCE_ID",
    failures,
  );
  const peakById = addUniqueBySourceId(
    input.peaks,
    "PEAK",
    "DUPLICATE_PEAK_SOURCE_ID",
    failures,
  );

  for (const route of routeById.values()) {
    if (!route.geometryValid || !route.coordinatesFinite) {
      failures.push(
        failure(
          "INVALID_ROUTE_GEOMETRY",
          "ROUTE",
          route.sourceId,
          "Route geometry is empty, malformed, or contains non-finite coordinates.",
        ),
      );
    }
    if (!(route.distanceMeters > 0)) {
      failures.push(
        failure(
          "NON_POSITIVE_ROUTE_DISTANCE",
          "ROUTE",
          route.sourceId,
          `Route distance must be positive; received ${route.distanceMeters}.`,
        ),
      );
    }
    if (!provenanceIsComplete(route)) {
      failures.push(
        failure(
          "INVALID_ROUTE_PROVENANCE",
          "ROUTE",
          route.sourceId,
          "Route lacks complete ODbL provenance or attribution.",
        ),
      );
    }
  }
  for (const peak of peakById.values()) {
    if (!peak.coordinatesValid) {
      failures.push(
        failure(
          "INVALID_PEAK_COORDINATE",
          "PEAK",
          peak.sourceId,
          `Peak coordinate is invalid: ${JSON.stringify(peak.coordinates)}.`,
        ),
      );
    }
    if (!provenanceIsComplete(peak)) {
      failures.push(
        failure(
          "INVALID_PEAK_PROVENANCE",
          "PEAK",
          peak.sourceId,
          "Peak lacks complete ODbL provenance or attribution.",
        ),
      );
    }
  }

  const analysisByRouteId = new Map<string, AuditAnalysisInput>();
  const confirmedAssociations: AuditAssociationInput[] = [];
  const reviewAssociations: AuditAssociationInput[] = [];
  const confirmedRoutes: ConfirmedRouteAuditRecord[] = [];
  const confirmedSamples: AssociationAuditSampleRecord[] = [];
  const reviewRecords: Array<Record<string, unknown> & {
    routeSourceId: string;
    peakSourceId: string;
    finalConfidence: number;
    minimumGeometryDistanceMeters: number;
    endpointDistanceMeters: number;
    semanticType: RouteSemanticType;
    finalAssociation: "REVIEW";
  }> = [];
  const confirmedRouteIds = new Set<string>();
  const confirmedPeakRouteIds = new Map<string, Set<string>>();
  const associationKeys = new Set<string>();

  for (const analysis of input.analyses) {
    if (analysisByRouteId.has(analysis.routeSourceId)) {
      failures.push(
        failure(
          "DUPLICATE_ROUTE_ANALYSIS_ID",
          "ROUTE",
          analysis.routeSourceId,
          `Duplicate route analysis for ${analysis.routeSourceId}.`,
        ),
      );
      continue;
    }
    analysisByRouteId.set(analysis.routeSourceId, analysis);
    const route = routeById.get(analysis.routeSourceId);
    if (!route) {
      failures.push(
        failure(
          "ORPHAN_ROUTE_ANALYSIS",
          "ROUTE",
          analysis.routeSourceId,
          "Route analysis does not resolve to a reconstructed route.",
        ),
      );
    }

    for (const association of analysis.summitAssociations) {
      const key = associationKey(analysis.routeSourceId, association.peakSourceId);
      if (associationKeys.has(key)) {
        failures.push(
          failure(
            "DUPLICATE_ROUTE_PEAK_ASSOCIATION",
            "ASSOCIATION",
            key,
            `Duplicate route/peak association ${key}.`,
          ),
        );
      } else {
        associationKeys.add(key);
      }
      const peak = peakById.get(association.peakSourceId);
      if (!peak) {
        failures.push(
          failure(
            "ORPHAN_PEAK_ASSOCIATION",
            "ASSOCIATION",
            key,
            `Association peak ${association.peakSourceId} does not resolve.`,
          ),
        );
      }
    }

    const confirmed = analysis.summitAssociations.filter(
      (association) => association.finalAssociation === "CONFIRMED",
    );
    const reviews = analysis.summitAssociations.filter(
      (association) => association.finalAssociation === "REVIEW",
    );
    confirmedAssociations.push(...confirmed);
    reviewAssociations.push(...reviews);

    if (route && confirmed.length > 0) {
      confirmedRouteIds.add(route.sourceId);
      for (const association of confirmed) {
        const routeIds = confirmedPeakRouteIds.get(association.peakSourceId) ?? new Set<string>();
        routeIds.add(route.sourceId);
        confirmedPeakRouteIds.set(association.peakSourceId, routeIds);
        confirmedSamples.push(
          createAssociationSample(
            route,
            analysis,
            association,
            peakById.get(association.peakSourceId),
            confirmed.length,
          ),
        );
      }
      confirmedRoutes.push({
        routeSourceId: route.sourceId,
        routeName: route.name,
        semanticType: analysis.semanticType,
        qualityScore: analysis.qualityScore,
        geometryType: route.geometryType,
        distanceMeters: route.distanceMeters,
        componentCount: route.componentCount,
        confirmedSummits: confirmed
          .map((association) =>
            confirmedSummitRecord(association, peakById.get(association.peakSourceId)),
          )
          .sort((left, right) => stableSourceIdCompare(left.peakSourceId, right.peakSourceId)),
        auditFlags: createRouteAuditFlags(route, analysis, confirmed.length),
        provenance: routeProvenance(route),
        duplicateStatus: "UNGROUPED",
        duplicateGroupId: null,
        canonicalRouteSourceId: route.sourceId,
      });
    }

    if (route) {
      for (const association of reviews) {
        const peak = peakById.get(association.peakSourceId);
        reviewRecords.push({
          routeSourceId: route.sourceId,
          routeName: route.name,
          semanticType: analysis.semanticType,
          routeQualityScore: analysis.qualityScore,
          peakSourceId: association.peakSourceId,
          peakName: peak?.name ?? association.peakName,
          peakElevationMeters: peak?.elevationMeters ?? association.peakElevation,
          peakCoordinates: peak?.coordinates ?? null,
          minimumGeometryDistanceMeters: association.minDistanceMeters,
          endpointDistanceMeters: association.endpointDistanceMeters,
          finalConfidence: association.finalConfidence,
          finalAssociation: "REVIEW",
          reasons: [...association.reasons],
        });
      }
    }
  }

  if (routeById.size !== input.summary.counts.reconstructedRoutes) {
    failures.push(
      failure(
        "ROUTE_COUNT_MISMATCH",
        "DATASET",
        null,
        `Summary reports ${input.summary.counts.reconstructedRoutes} routes but ${routeById.size} unique routes were loaded.`,
      ),
    );
  }
  if (peakById.size !== input.summary.counts.peaks) {
    failures.push(
      failure(
        "PEAK_COUNT_MISMATCH",
        "DATASET",
        null,
        `Summary reports ${input.summary.counts.peaks} peaks but ${peakById.size} unique peaks were loaded.`,
      ),
    );
  }
  if (confirmedAssociations.length !== input.summary.counts.summitAssociations.CONFIRMED) {
    failures.push(
      failure(
        "CONFIRMED_ASSOCIATION_COUNT_MISMATCH",
        "DATASET",
        null,
        `Summary reports ${input.summary.counts.summitAssociations.CONFIRMED} confirmed associations but ${confirmedAssociations.length} were loaded.`,
      ),
    );
  }
  if (reviewAssociations.length !== input.summary.counts.summitAssociations.REVIEW) {
    failures.push(
      failure(
        "REVIEW_ASSOCIATION_COUNT_MISMATCH",
        "DATASET",
        null,
        `Summary reports ${input.summary.counts.summitAssociations.REVIEW} review associations but ${reviewAssociations.length} were loaded.`,
      ),
    );
  }
  const aggregationMilliseconds = performance.now() - aggregationStart;

  const canonicalStart = performance.now();
  const groupIds = new Set<string>();
  const groupedMemberIds = new Set<string>();
  for (const group of input.duplicateGroups) {
    if (groupIds.has(group.groupId)) {
      failures.push(
        failure(
          "DUPLICATE_GROUP_ID",
          "DUPLICATE_GROUP",
          group.groupId,
          `Duplicate group ID ${group.groupId}.`,
        ),
      );
    }
    groupIds.add(group.groupId);
    if (!group.memberSourceIds.includes(group.canonicalSourceId)) {
      failures.push(
        failure(
          "CANONICAL_NOT_IN_GROUP",
          "DUPLICATE_GROUP",
          group.groupId,
          `Canonical route ${group.canonicalSourceId} is not a group member.`,
        ),
      );
    }
    for (const sourceId of group.memberSourceIds) {
      if (!routeById.has(sourceId)) {
        failures.push(
          failure(
            "UNRESOLVED_DUPLICATE_ROUTE",
            "DUPLICATE_GROUP",
            sourceId,
            `Duplicate group ${group.groupId} references missing route ${sourceId}.`,
          ),
        );
      }
      if (groupedMemberIds.has(sourceId)) {
        failures.push(
          failure(
            "ROUTE_IN_MULTIPLE_DUPLICATE_GROUPS",
            "DUPLICATE_GROUP",
            sourceId,
            `Route ${sourceId} occurs in more than one duplicate group.`,
          ),
        );
      }
      groupedMemberIds.add(sourceId);
    }
    for (const relationship of group.duplicateRelationships) {
      if (
        !group.memberSourceIds.includes(relationship.sourceIdA) ||
        !group.memberSourceIds.includes(relationship.sourceIdB)
      ) {
        failures.push(
          failure(
            "UNRESOLVED_DUPLICATE_RELATIONSHIP",
            "DUPLICATE_GROUP",
            group.groupId,
            `Duplicate relationship ${relationship.sourceIdA}:${relationship.sourceIdB} is outside its group.`,
          ),
        );
      }
    }
  }
  if (input.duplicateGroups.length !== input.summary.counts.duplicateGroups) {
    failures.push(
      failure(
        "DUPLICATE_GROUP_COUNT_MISMATCH",
        "DATASET",
        null,
        `Summary reports ${input.summary.counts.duplicateGroups} groups but ${input.duplicateGroups.length} were loaded.`,
      ),
    );
  }

  const duplicateLookup = buildDuplicateLookup(input.duplicateGroups);
  for (const route of confirmedRoutes) {
    const duplicate = duplicateLookup.get(route.routeSourceId);
    if (duplicate) {
      route.duplicateGroupId = duplicate.group.groupId;
      route.canonicalRouteSourceId = duplicate.canonicalSourceId;
      route.duplicateStatus = duplicate.isCanonical
        ? "CANONICAL"
        : "DUPLICATE_REPRESENTATION";
    }
  }

  interface CanonicalAccumulator {
    canonicalRouteSourceId: string;
    sourceRecords: ConfirmedRouteAuditRecord[];
    summitByPeakId: Map<
      string,
      {
        representative: ConfirmedSummitAuditRecord;
        sourceAssociations: SourceAssociationProvenance[];
      }
    >;
  }
  const canonicalById = new Map<string, CanonicalAccumulator>();
  for (const sourceRecord of confirmedRoutes) {
    const canonicalId = sourceRecord.canonicalRouteSourceId;
    const accumulator: CanonicalAccumulator = canonicalById.get(canonicalId) ?? {
      canonicalRouteSourceId: canonicalId,
      sourceRecords: [],
      summitByPeakId: new Map(),
    };
    accumulator.sourceRecords.push(sourceRecord);
    for (const summit of sourceRecord.confirmedSummits) {
      const sourceAssociation: SourceAssociationProvenance = {
        routeSourceId: sourceRecord.routeSourceId,
        routeSourceUrl: sourceRecord.provenance.sourceUrl,
        routeProvenanceId: sourceRecord.provenance.provenanceId,
        finalConfidence: summit.finalConfidence,
        minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
        endpointDistanceMeters: summit.endpointDistanceMeters,
        reasons: [...summit.reasons],
      };
      const existing = accumulator.summitByPeakId.get(summit.peakSourceId);
      if (existing) {
        existing.sourceAssociations.push(sourceAssociation);
        if (
          summit.finalConfidence > existing.representative.finalConfidence ||
          (summit.finalConfidence === existing.representative.finalConfidence &&
            summit.minimumGeometryDistanceMeters <
              existing.representative.minimumGeometryDistanceMeters)
        ) {
          existing.representative = summit;
        }
      } else {
        accumulator.summitByPeakId.set(summit.peakSourceId, {
          representative: summit,
          sourceAssociations: [sourceAssociation],
        });
      }
    }
    canonicalById.set(canonicalId, accumulator);
  }

  const canonicalConfirmedRoutes: CanonicalConfirmedRouteAuditRecord[] = [];
  for (const accumulator of canonicalById.values()) {
    const canonicalRoute = routeById.get(accumulator.canonicalRouteSourceId);
    const canonicalAnalysis = analysisByRouteId.get(accumulator.canonicalRouteSourceId);
    if (!canonicalRoute || !canonicalAnalysis) {
      failures.push(
        failure(
          "UNRESOLVED_CANONICAL_ROUTE",
          "DUPLICATE_GROUP",
          accumulator.canonicalRouteSourceId,
          "Canonical confirmed representation does not resolve to both route and analysis data.",
        ),
      );
      continue;
    }
    const sourceRecords = accumulator.sourceRecords.sort((left, right) =>
      stableSourceIdCompare(left.routeSourceId, right.routeSourceId),
    );
    const mergedSummits = [...accumulator.summitByPeakId.entries()]
      .sort(([left], [right]) => stableSourceIdCompare(left, right))
      .map(([, value]) => ({
        ...value.representative,
        sourceRouteIds: [
          ...new Set(value.sourceAssociations.map((item) => item.routeSourceId)),
        ].sort(stableSourceIdCompare),
        sourceAssociations: value.sourceAssociations.sort(
          (left, right) =>
            stableSourceIdCompare(left.routeSourceId, right.routeSourceId) ||
            right.finalConfidence - left.finalConfidence,
        ),
      }));
    const duplicate = duplicateLookup.get(accumulator.canonicalRouteSourceId);
    canonicalConfirmedRoutes.push({
      canonicalRouteSourceId: accumulator.canonicalRouteSourceId,
      routeName: canonicalRoute.name,
      semanticType: canonicalAnalysis.semanticType,
      qualityScore: canonicalAnalysis.qualityScore,
      geometryType: canonicalRoute.geometryType,
      distanceMeters: canonicalRoute.distanceMeters,
      componentCount: canonicalRoute.componentCount,
      sourceRouteIds: sourceRecords.map((record) => record.routeSourceId),
      removedDuplicateRepresentationIds: sourceRecords
        .filter((record) => record.routeSourceId !== accumulator.canonicalRouteSourceId)
        .map((record) => record.routeSourceId),
      confirmedSummits: mergedSummits,
      auditFlags: createRouteAuditFlags(
        canonicalRoute,
        canonicalAnalysis,
        mergedSummits.length,
      ),
      sourceProvenance: sourceRecords.map((record) => ({
        routeSourceId: record.routeSourceId,
        sourceUrl: record.provenance.sourceUrl,
        provenanceId: record.provenance.provenanceId,
        license: record.provenance.license,
        attribution: record.provenance.attribution,
      })),
      duplicateGroupId: duplicate?.group.groupId ?? null,
    });
  }
  confirmedRoutes.sort((left, right) =>
    stableSourceIdCompare(left.routeSourceId, right.routeSourceId),
  );
  canonicalConfirmedRoutes.sort((left, right) =>
    stableSourceIdCompare(left.canonicalRouteSourceId, right.canonicalRouteSourceId),
  );
  const dedupCanonicalProcessingMilliseconds = performance.now() - canonicalStart;

  const auditGenerationStart = performance.now();
  const coveredPeaks: CoveredPeakAuditRecord[] = [];
  for (const [peakSourceId, routeIdsSet] of confirmedPeakRouteIds) {
    const peak = peakById.get(peakSourceId);
    if (!peak) continue;
    const routeIds = [...routeIdsSet].sort(stableSourceIdCompare);
    const rankedRoutes = routeIds
      .map((routeSourceId) => ({
        routeSourceId,
        qualityScore: analysisByRouteId.get(routeSourceId)?.qualityScore ?? 0,
      }))
      .sort(
        (left, right) =>
          right.qualityScore - left.qualityScore ||
          stableSourceIdCompare(left.routeSourceId, right.routeSourceId),
      );
    coveredPeaks.push({
      peakSourceId,
      name: peak.name,
      elevationMeters: peak.elevationMeters,
      coordinates: peak.coordinates,
      confirmedRouteCount: routeIds.length,
      confirmedRouteIds: routeIds,
      bestRouteId: rankedRoutes[0].routeSourceId,
      bestRouteQuality: rankedRoutes[0].qualityScore,
      provenance: {
        provenanceId: peak.provenanceId,
        sourceUrl: peak.sourceUrl,
        license: peak.license,
        attribution: peak.attribution,
      },
    });
  }
  coveredPeaks.sort((left, right) =>
    stableSourceIdCompare(left.peakSourceId, right.peakSourceId),
  );

  const peakCoverageBuckets = {
    exactly1ConfirmedRoute: coveredPeaks.filter((peak) => peak.confirmedRouteCount === 1)
      .length,
    from2To5ConfirmedRoutes: coveredPeaks.filter(
      (peak) => peak.confirmedRouteCount >= 2 && peak.confirmedRouteCount <= 5,
    ).length,
    from6To10ConfirmedRoutes: coveredPeaks.filter(
      (peak) => peak.confirmedRouteCount >= 6 && peak.confirmedRouteCount <= 10,
    ).length,
    moreThan10ConfirmedRoutes: coveredPeaks.filter(
      (peak) => peak.confirmedRouteCount > 10,
    ).length,
  };
  const maximumRoutesPerCoveredPeak = Math.max(
    0,
    ...coveredPeaks.map((peak) => peak.confirmedRouteCount),
  );
  const averageRoutesPerCoveredPeak =
    coveredPeaks.length === 0
      ? 0
      : round(
          coveredPeaks.reduce((total, peak) => total + peak.confirmedRouteCount, 0) /
            coveredPeaks.length,
          2,
        );

  const canonicalIdForRoute = (routeSourceId: string): string =>
    duplicateLookup.get(routeSourceId)?.canonicalSourceId ?? routeSourceId;
  const rankingRows = coveredPeaks.map((peak) => {
    const routeQualities = peak.confirmedRouteIds.map(
      (routeSourceId) => analysisByRouteId.get(routeSourceId)?.qualityScore ?? 0,
    );
    return {
      peakSourceId: peak.peakSourceId,
      peakName: peak.name,
      elevationMeters: peak.elevationMeters,
      confirmedSourceRouteCount: peak.confirmedRouteCount,
      canonicalRouteVariantCount: new Set(
        peak.confirmedRouteIds.map(canonicalIdForRoute),
      ).size,
      averageRouteQuality: round(
        routeQualities.reduce((total, quality) => total + quality, 0) /
          routeQualities.length,
        2,
      ),
      highestRouteQuality: Math.max(...routeQualities),
    };
  });
  rankingRows.sort(
    (left, right) =>
      right.confirmedSourceRouteCount - left.confirmedSourceRouteCount ||
      (right.elevationMeters ?? -Infinity) - (left.elevationMeters ?? -Infinity) ||
      stableSourceIdCompare(left.peakSourceId, right.peakSourceId),
  );
  const coveredWithElevation = [...coveredPeaks]
    .filter((peak) => peak.elevationMeters !== null)
    .sort(
      (left, right) =>
        (right.elevationMeters as number) - (left.elevationMeters as number) ||
        stableSourceIdCompare(left.peakSourceId, right.peakSourceId),
    );
  const elevationRecord = (peak: CoveredPeakAuditRecord) => ({
    peakSourceId: peak.peakSourceId,
    name: peak.name,
    elevationMeters: peak.elevationMeters,
    confirmedRouteCount: peak.confirmedRouteCount,
  });

  const explicitCountryCounts = Object.fromEntries(
    [...COUNTRY_CODES.entries()].map(([code, name]) => [
      code,
      { country: name, coveredPeaks: 0 },
    ]),
  ) as Record<string, { country: string; coveredPeaks: number }>;
  let explicitCountryAssignedCoveredPeaks = 0;
  for (const coveredPeak of coveredPeaks) {
    const code = peakById.get(coveredPeak.peakSourceId)?.explicitCountryCode;
    if (code && explicitCountryCounts[code]) {
      explicitCountryCounts[code].coveredPeaks += 1;
      explicitCountryAssignedCoveredPeaks += 1;
    }
  }
  const countryRegionCoverage = {
    status:
      explicitCountryAssignedCoveredPeaks > 0
        ? "PARTIAL_EXPLICIT_TAGS_ONLY"
        : "UNAVAILABLE_FROM_CURRENT_ARTIFACTS",
    method:
      "Only explicit OSM addr:country, is_in:country_code, or country_code tags are accepted; names and coordinates are not guessed or reverse-geocoded.",
    explicitCountryAssignedCoveredPeaks,
    unassignedCoveredPeaks: coveredPeaks.length - explicitCountryAssignedCoveredPeaks,
    countries: explicitCountryCounts,
    limitation:
      "The Phase 6 artifacts contain no administrative-boundary join, so comprehensive country/region coverage requires a future offline boundary dataset.",
  };

  const confirmedQualityScores = confirmedRoutes.map((route) => route.qualityScore);
  const qualityFlagCounts = Object.fromEntries(
    [
      "LOW_QUALITY",
      "HIGH_FRAGMENTATION",
      "MISSING_NAME",
      "UNKNOWN_SEMANTIC",
      "SUSPICIOUS_SHORT",
      "SUSPICIOUS_LONG",
      "MULTIPLE_SUMMITS",
    ].map((flag) => [
      flag,
      confirmedRoutes.filter((route) => route.auditFlags.includes(flag as AuditFlag)).length,
    ]),
  );

  const confirmedAssociationAudit = {
    total: confirmedAssociations.length,
    geometryDistanceBuckets: geometryDistanceBuckets(confirmedAssociations),
    endpointDistanceBuckets: endpointDistanceBuckets(confirmedAssociations),
    confidenceBuckets: confidenceBuckets(confirmedAssociations),
    geometryDistanceStatistics: summarizeNumeric(
      confirmedAssociations.map((association) => association.minDistanceMeters),
    ),
    endpointDistanceStatistics: summarizeNumeric(
      confirmedAssociations.map((association) => association.endpointDistanceMeters),
    ),
    confidenceStatistics: summarizeNumeric(
      confirmedAssociations.map((association) => association.finalConfidence),
    ),
    peakElevationStatistics: summarizeNumeric(
      confirmedAssociations.map(
        (association) => peakById.get(association.peakSourceId)?.elevationMeters ?? null,
      ),
    ),
    routeQualityStatistics: summarizeNumeric(
      confirmedSamples.map((association) => association.routeQualityScore),
    ),
  };

  const reviewRouteIds = new Set(reviewRecords.map((record) => record.routeSourceId));
  const reviewPeakIds = new Set(reviewRecords.map((record) => record.peakSourceId));
  const reviewSemanticTypes: Partial<Record<RouteSemanticType, number>> = {};
  for (const record of reviewRecords) {
    reviewSemanticTypes[record.semanticType] =
      (reviewSemanticTypes[record.semanticType] ?? 0) + 1;
  }
  const reviewOpportunityCriteria = {
    geometryDistanceAtMost5Meters: reviewRecords.filter(
      (record) => record.minimumGeometryDistanceMeters <= 5,
    ).length,
    confidenceAtLeast095: reviewRecords.filter(
      (record) => record.finalConfidence >= 0.95,
    ).length,
    endpointDistanceAtMost100Meters: reviewRecords.filter(
      (record) => record.endpointDistanceMeters <= 100,
    ).length,
    summitRouteSemantics: reviewRecords.filter(
      (record) => record.semanticType === "summit_route",
    ).length,
  };
  const allReviewOpportunityCriteria = reviewRecords
    .filter(
      (record) =>
        record.minimumGeometryDistanceMeters <= 5 &&
        record.finalConfidence >= 0.95 &&
        record.endpointDistanceMeters <= 100 &&
        record.semanticType === "summit_route",
    )
    .sort(
      (left, right) =>
        right.finalConfidence - left.finalConfidence ||
        left.minimumGeometryDistanceMeters - right.minimumGeometryDistanceMeters ||
        left.endpointDistanceMeters - right.endpointDistanceMeters ||
        stableSourceIdCompare(left.routeSourceId, right.routeSourceId) ||
        stableSourceIdCompare(left.peakSourceId, right.peakSourceId),
    );
  const reviewOpportunities = {
    classificationPolicy:
      "Diagnostic only. Every record remains REVIEW; this artifact never promotes associations.",
    totalReviewAssociations: reviewRecords.length,
    uniqueRoutesWithReview: reviewRouteIds.size,
    uniquePeaksInReview: reviewPeakIds.size,
    confidenceBuckets: confidenceBuckets(reviewAssociations),
    confidenceStatistics: summarizeNumeric(
      reviewAssociations.map((association) => association.finalConfidence),
    ),
    semanticTypeDistribution: Object.fromEntries(
      Object.entries(reviewSemanticTypes).sort(([left], [right]) =>
        stableTextCompare(left, right),
      ),
    ),
    geometryDistanceBuckets: geometryDistanceBuckets(reviewAssociations),
    endpointDistanceBuckets: endpointDistanceBuckets(reviewAssociations),
    opportunityCriteriaCounts: reviewOpportunityCriteria,
    allFourCriteriaCount: allReviewOpportunityCriteria.length,
    sampleLimit: PHASE_7_AUDIT_RULES.reviewOpportunityLimit,
    highestConfidenceAllCriteriaSample: allReviewOpportunityCriteria.slice(
      0,
      PHASE_7_AUDIT_RULES.reviewOpportunityLimit,
    ),
  };

  const manualAuditSample = buildManualAuditSample(confirmedSamples);

  const importEligibility: ImportEligibilityRecord[] = [];
  for (const canonical of canonicalConfirmedRoutes) {
    const route = routeById.get(canonical.canonicalRouteSourceId);
    if (!route) continue;
    const confirmedPeaks = canonical.confirmedSummits.map(
      (summit) => peakById.get(summit.peakSourceId) ?? null,
    );
    const classification = classifyImportEligibility({
      route,
      qualityScore: canonical.qualityScore,
      flags: canonical.auditFlags,
      confirmedPeaks,
    });
    importEligibility.push({
      canonicalRouteSourceId: canonical.canonicalRouteSourceId,
      routeName: canonical.routeName,
      eligibility: classification.eligibility,
      reasons: classification.reasons,
      auditFlags: [...canonical.auditFlags],
      qualityScore: canonical.qualityScore,
      confirmedPeakIds: canonical.confirmedSummits.map((summit) => summit.peakSourceId),
      sourceRouteIds: [...canonical.sourceRouteIds],
    });
  }
  importEligibility.sort((left, right) =>
    stableSourceIdCompare(left.canonicalRouteSourceId, right.canonicalRouteSourceId),
  );
  const eligibilityCounts = {
    AUTO_IMPORT_READY: importEligibility.filter(
      (record) => record.eligibility === "AUTO_IMPORT_READY",
    ).length,
    MANUAL_REVIEW_REQUIRED: importEligibility.filter(
      (record) => record.eligibility === "MANUAL_REVIEW_REQUIRED",
    ).length,
    EXCLUDE: importEligibility.filter((record) => record.eligibility === "EXCLUDE")
      .length,
  };
  const autoImportPeakIds = new Set(
    importEligibility
      .filter((record) => record.eligibility === "AUTO_IMPORT_READY")
      .flatMap((record) => record.confirmedPeakIds),
  );

  const confirmedCountsByRoute = confirmedRoutes.map(
    (route) => route.confirmedSummits.length,
  );
  const routesWithExactlyOneConfirmedSummit = confirmedCountsByRoute.filter(
    (count) => count === 1,
  ).length;
  const routesWithMultipleConfirmedSummits = confirmedCountsByRoute.filter(
    (count) => count > 1,
  ).length;
  const maximumConfirmedSummitsOnOneRoute = Math.max(0, ...confirmedCountsByRoute);
  const averageConfirmedSummitsPerConfirmedRoute =
    confirmedRoutes.length === 0
      ? 0
      : round(confirmedAssociations.length / confirmedRoutes.length, 2);
  const duplicateMembersCount = input.duplicateGroups.reduce(
    (total, group) => total + group.memberSourceIds.length,
    0,
  );
  const confirmedDuplicateRepresentations = confirmedRoutes.filter(
    (route) => route.duplicateStatus === "DUPLICATE_REPRESENTATION",
  ).length;

  failures.sort(
    (left, right) =>
      stableTextCompare(left.code, right.code) ||
      stableTextCompare(left.entityType, right.entityType) ||
      stableSourceIdCompare(left.sourceId ?? "", right.sourceId ?? "") ||
      stableTextCompare(left.message, right.message),
  );
  const criticalIntegrityFailureCount = failures.filter(
    (item) => item.severity === "CRITICAL",
  ).length;

  const peakCoverageRanking = {
    top100ByConfirmedRouteCount: rankingRows.slice(
      0,
      PHASE_7_AUDIT_RULES.rankingLimit,
    ),
    highestCoveredPeaks: coveredWithElevation.slice(0, 25).map(elevationRecord),
    lowestCoveredPeaks: [...coveredWithElevation]
      .reverse()
      .slice(0, 25)
      .map(elevationRecord),
    highestElevationCoveredPeak:
      coveredWithElevation.length > 0 ? elevationRecord(coveredWithElevation[0]) : null,
    elevationCoverage: {
      atLeast4000Meters: coveredPeaks.filter(
        (peak) => (peak.elevationMeters ?? -Infinity) >= 4_000,
      ).length,
      atLeast3000Meters: coveredPeaks.filter(
        (peak) => (peak.elevationMeters ?? -Infinity) >= 3_000,
      ).length,
      atLeast2000Meters: coveredPeaks.filter(
        (peak) => (peak.elevationMeters ?? -Infinity) >= 2_000,
      ).length,
      missingElevation: coveredPeaks.filter((peak) => peak.elevationMeters === null).length,
      unnamed: coveredPeaks.filter((peak) => !peak.name?.trim()).length,
    },
    countryRegionCoverage,
  };

  const coreSummary = {
    schemaVersion: 1,
    sourcePhase: 6,
    sourceGeneratedAt: input.summary.generatedAt,
    sourceMode: input.summary.mode,
    provenance: input.summary.provenance,
    sourceDataset: {
      hikingRelationsAnalyzed: input.summary.counts.hikingRelationsFound,
      reconstructedRoutes: input.summary.counts.reconstructedRoutes,
      rejectedRoutes: input.summary.counts.rejectedRoutes,
      peaks: input.summary.counts.peaks,
    },
    confirmedRoutes: {
      totalConfirmedAssociations: confirmedAssociations.length,
      uniqueRoutesWithConfirmedSummit: confirmedRoutes.length,
      routesWithExactlyOneConfirmedSummit,
      routesWithMultipleConfirmedSummits,
      maximumConfirmedSummitsOnOneRoute,
      averageConfirmedSummitsPerConfirmedRoute,
    },
    peakCoverage: {
      uniqueConfirmedPeaks: coveredPeaks.length,
      percentageOfAllPeaksCovered:
        input.summary.counts.peaks === 0
          ? 0
          : round((coveredPeaks.length / input.summary.counts.peaks) * 100, 4),
      ...peakCoverageBuckets,
      maximumConfirmedRoutesForOnePeak: maximumRoutesPerCoveredPeak,
      averageRoutesPerCoveredPeak,
    },
    deduplication: {
      exactDuplicatePairs:
        input.summary.counts.similarityClassifications.EXACT_DUPLICATE,
      nearDuplicatePairs:
        input.summary.counts.similarityClassifications.NEAR_DUPLICATE,
      duplicateGroups: input.duplicateGroups.length,
      routesContainedInDuplicateGroups: duplicateMembersCount,
      canonicalRoutesSelected: input.duplicateGroups.length,
      confirmedRoutesRemovedOnlyAsDuplicateRepresentations:
        confirmedDuplicateRepresentations,
      uniqueCanonicalConfirmedRoutesRemaining: canonicalConfirmedRoutes.length,
    },
    qualityAudit: {
      ...qualityDistribution(confirmedQualityScores),
      flagCounts: qualityFlagCounts,
    },
    confirmedAssociationAudit,
    reviewAnalysis: {
      totalReviewAssociations: reviewRecords.length,
      uniqueRoutesWithReview: reviewRouteIds.size,
      uniquePeaksInReview: reviewPeakIds.size,
      highConfidenceAllCriteriaOpportunities: allReviewOpportunityCriteria.length,
    },
    countryRegionCoverage,
    importEligibility: {
      ...eligibilityCounts,
      uniquePeaksCoveredByAutoImportReadyRoutes: autoImportPeakIds.size,
      rules: PHASE_7_AUDIT_RULES,
    },
    integrity: {
      criticalFailureCount: criticalIntegrityFailureCount,
      totalFailureCount: failures.length,
      status: criticalIntegrityFailureCount === 0 ? "PASS" : "FAIL",
      failures,
    },
    remainingDataQualityRisks: [
      "REVIEW associations remain unpublished and require matcher research or manual validation.",
      "Country/region coverage is incomplete without an offline administrative-boundary join.",
      "Canonical merging preserves source association provenance, but Phase 8 must define the durable import schema and review workflow.",
      "Low-quality, fragmented, unnamed, unusually short/long, multiple-summit, and unknown-semantic routes require manual inspection.",
    ],
    recommendedPhase8: [
      "Manually validate the deterministic confirmed and high-confidence REVIEW samples.",
      "Define a reviewed staging schema and idempotent dry-run importer for AUTO_IMPORT_READY canonical routes only.",
      "Add an offline Alps administrative-boundary join before country-level reporting or rollout decisions.",
      "Preserve OSM source IDs, ODbL attribution, canonical/source provenance, and merged summit associations during staging.",
      "Do not publish REVIEW records automatically; establish an explicit adjudication workflow.",
    ],
  };
  const deterministicContentHash = hashDeterministicContent({
    confirmedRoutes,
    coveredPeaks,
    canonicalConfirmedRoutes,
    peakCoverageRanking,
    manualAuditSample,
    reviewOpportunities,
    importEligibility,
    coreSummary,
  });
  const finalSummary = { ...coreSummary, deterministicContentHash };
  const auditGenerationMilliseconds = performance.now() - auditGenerationStart;

  return {
    artifacts: {
      confirmedRoutes,
      coveredPeaks,
      canonicalConfirmedRoutes,
      peakCoverageRanking,
      manualAuditSample,
      reviewOpportunities,
      importEligibility,
      finalSummary,
    },
    stageTimingsMilliseconds: {
      aggregation: round(aggregationMilliseconds, 1),
      dedupCanonicalProcessing: round(dedupCanonicalProcessingMilliseconds, 1),
      auditGeneration: round(auditGenerationMilliseconds, 1),
    },
  };
}

function formatInteger(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "n/a";
}

function formatDecimal(value: unknown, decimalPlaces = 2): string {
  return typeof value === "number" ? value.toFixed(decimalPlaces) : "n/a";
}

export function renderFinalAuditMarkdown(
  finalSummary: Record<string, unknown>,
  peakCoverageRanking: Record<string, unknown>,
  performance: Record<string, unknown>,
): string {
  const source = finalSummary.sourceDataset as Record<string, unknown>;
  const confirmed = finalSummary.confirmedRoutes as Record<string, unknown>;
  const peaks = finalSummary.peakCoverage as Record<string, unknown>;
  const deduplication = finalSummary.deduplication as Record<string, unknown>;
  const eligibility = finalSummary.importEligibility as Record<string, unknown>;
  const quality = finalSummary.qualityAudit as Record<string, unknown>;
  const review = finalSummary.reviewAnalysis as Record<string, unknown>;
  const integrity = finalSummary.integrity as Record<string, unknown>;
  const country = finalSummary.countryRegionCoverage as Record<string, unknown>;
  const elevation = peakCoverageRanking.elevationCoverage as Record<string, unknown>;
  const top = peakCoverageRanking.top100ByConfirmedRouteCount as Array<
    Record<string, unknown>
  >;
  const risks = finalSummary.remainingDataQualityRisks as string[];
  const phase8 = finalSummary.recommendedPhase8 as string[];

  const topRows = top
    .slice(0, 20)
    .map(
      (peak, index) =>
        `| ${index + 1} | ${String(peak.peakName ?? "Unnamed").replaceAll("|", "\\|")} | ${peak.peakSourceId} | ${formatInteger(peak.elevationMeters)} | ${formatInteger(peak.confirmedSourceRouteCount)} | ${formatInteger(peak.canonicalRouteVariantCount)} | ${formatDecimal(peak.averageRouteQuality, 2)} |`,
    )
    .join("\n");

  return `# Phase 7 — Final Alps Dataset Audit & Mountain Coverage

## Executive answers

1. **OSM hiking relations analyzed:** ${formatInteger(source.hikingRelationsAnalyzed)}
2. **Routes reconstructed successfully:** ${formatInteger(source.reconstructedRoutes)} (${formatInteger(source.rejectedRoutes)} rejected)
3. **CONFIRMED summit associations:** ${formatInteger(confirmed.totalConfirmedAssociations)}
4. **Unique source routes with confirmed summits:** ${formatInteger(confirmed.uniqueRoutesWithConfirmedSummit)}
5. **Unique peaks covered:** ${formatInteger(peaks.uniqueConfirmedPeaks)} (${formatDecimal(peaks.percentageOfAllPeaksCovered, 4)}% of Phase 6 peaks)
6. **Canonical confirmed routes after deduplication:** ${formatInteger(deduplication.uniqueCanonicalConfirmedRoutesRemaining)}
7. **AUTO_IMPORT_READY canonical routes:** ${formatInteger(eligibility.AUTO_IMPORT_READY)}
8. **Unique peaks covered by AUTO_IMPORT_READY routes:** ${formatInteger(eligibility.uniquePeaksCoveredByAutoImportReadyRoutes)}
9. **MANUAL_REVIEW_REQUIRED canonical routes:** ${formatInteger(eligibility.MANUAL_REVIEW_REQUIRED)}
10. **EXCLUDE canonical routes:** ${formatInteger(eligibility.EXCLUDE)}
11. **Main remaining risks:** REVIEW records are not publishable, country coverage lacks an administrative-boundary join, and flagged route-quality edge cases require human inspection.
12. **Recommended Phase 8:** validate the deterministic samples, design an idempotent staging-only importer for AUTO_IMPORT_READY records, and retain full OSM/canonical association provenance.

## Confirmed route and peak coverage

- Exactly one confirmed summit: ${formatInteger(confirmed.routesWithExactlyOneConfirmedSummit)} routes
- Multiple confirmed summits: ${formatInteger(confirmed.routesWithMultipleConfirmedSummits)} routes
- Maximum confirmed summits on one route: ${formatInteger(confirmed.maximumConfirmedSummitsOnOneRoute)}
- Average confirmed summits per confirmed route: ${formatDecimal(confirmed.averageConfirmedSummitsPerConfirmedRoute)}
- Peaks with exactly one confirmed route: ${formatInteger(peaks.exactly1ConfirmedRoute)}
- Peaks with 2–5 routes: ${formatInteger(peaks.from2To5ConfirmedRoutes)}
- Peaks with 6–10 routes: ${formatInteger(peaks.from6To10ConfirmedRoutes)}
- Peaks with more than 10 routes: ${formatInteger(peaks.moreThan10ConfirmedRoutes)}

## Deduplication

- EXACT_DUPLICATE pairs: ${formatInteger(deduplication.exactDuplicatePairs)}
- NEAR_DUPLICATE pairs: ${formatInteger(deduplication.nearDuplicatePairs)}
- Duplicate groups: ${formatInteger(deduplication.duplicateGroups)}
- Routes represented in groups: ${formatInteger(deduplication.routesContainedInDuplicateGroups)}
- Confirmed duplicate representations removed: ${formatInteger(deduplication.confirmedRoutesRemovedOnlyAsDuplicateRepresentations)}
- Canonical confirmed routes remaining: ${formatInteger(deduplication.uniqueCanonicalConfirmedRoutesRemaining)}

Summit associations from duplicate source representations are merged into their canonical audit record. Source route IDs, association evidence, and ODbL provenance remain attached.

## Quality and review

Quality distribution:

\`\`\`json
${JSON.stringify(quality, null, 2)}
\`\`\`

- REVIEW associations: ${formatInteger(review.totalReviewAssociations)}
- Unique REVIEW routes: ${formatInteger(review.uniqueRoutesWithReview)}
- Unique REVIEW peaks: ${formatInteger(review.uniquePeaksInReview)}
- Cases meeting all four high-confidence opportunity criteria: ${formatInteger(review.highConfidenceAllCriteriaOpportunities)}

No REVIEW association was promoted.

## Top 20 covered peaks

| Rank | Peak | OSM source ID | Elevation (m) | Source routes | Canonical variants | Avg. route quality |
|---:|---|---:|---:|---:|---:|---:|
${topRows}

## Elevation coverage

- Covered peaks ≥4,000 m: ${formatInteger(elevation.atLeast4000Meters)}
- Covered peaks ≥3,000 m: ${formatInteger(elevation.atLeast3000Meters)}
- Covered peaks ≥2,000 m: ${formatInteger(elevation.atLeast2000Meters)}
- Covered peaks missing elevation: ${formatInteger(elevation.missingElevation)}
- Unnamed covered peaks: ${formatInteger(elevation.unnamed)}

## Country and region limitation

Status: **${country.status}**. ${country.limitation}

Only explicit country-code tags were accepted. Route names were not used and no external API or reverse geocoder was called.

## Integrity

- Status: **${integrity.status}**
- Critical failures: ${formatInteger(integrity.criticalFailureCount)}
- Total recorded failures: ${formatInteger(integrity.totalFailureCount)}

## Performance

\`\`\`json
${JSON.stringify(performance, null, 2)}
\`\`\`

The audit read existing JSONL/summary artifacts only. It did not extract the PBF or recompute route similarities.

## Remaining data-quality risks

${risks.map((risk) => `- ${risk}`).join("\n")}

## Recommended Phase 8

${phase8.map((step, index) => `${index + 1}. ${step}`).join("\n")}
`;
}
