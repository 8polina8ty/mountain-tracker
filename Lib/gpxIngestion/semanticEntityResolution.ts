// Phase 12E semantic entity resolution over the offline multilingual feature
// index. Strict exact normalized-name matching across all name variants and
// bounded qualifier-stripped forms; ties fail closed as AMBIGUOUS.

import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import type { SemanticAnchorHint } from "./routeDiscovery.ts";
import {
  inferOsmAnchorType,
  OSM_ANCHOR_RESOLUTION_VERSION,
  type OsmAnchorResolution,
  type ResolvedOsmAnchor,
} from "./osmAnchorResolution.ts";
import {
  candidateSemanticNames,
  normalizeSemanticName,
  type SemanticNameVariant,
  elevationQualifierMeters,
} from "./nameNormalization.ts";
import type { SemanticFeatureIndex, SemanticFeatureIndexEntry } from "./semanticFeatureIndex.ts";
import { hasHistoricStatusEvidence } from './semanticFeatureIndex.ts';
import { sha256Stable } from "./hashing.ts";

export const SEMANTIC_ENTITY_RESOLUTION_VERSION =
  "mountain-tracker/semantic-entity-resolution/v3" as const;

export interface SemanticEntityResolutionContext {
  regionName?: string | null;
  mountainCoordinate?: [number, number] | null;
  previousRouteCoordinate?: [number, number] | null;
  maximumMountainDistanceM?: number;
  maximumCandidateCount?: number;
}

interface ScoredEntity {
  entry: SemanticFeatureIndexEntry;
  anchor: ResolvedOsmAnchor;
  score: number;
  matchedName: string;
  matchedKind: SemanticNameVariant["kind"];
}

const TAG_SUBSET_KEYS = [
  "name",
  "official_name",
  "short_name",
  "alt_name",
  "natural",
  "tourism",
  "amenity",
  "place",
  "highway",
  "information",
  "mountain_pass",
  "junction",
  "historic",
  "archaeological_site",
  "ruins",
  "abandoned",
  "building:condition",
  "addr:state",
  "addr:country",
  "is_in",
] as const;

const DEFAULT_REGION_HINT_KEYS = ["addr:state", "addr:country", "is_in"] as const;

function tagsSubset(tags: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    TAG_SUBSET_KEYS.flatMap((key) => {
      const value = tags[key]?.normalize("NFKC").trim();
      return value && value.length <= 200 ? [[key, value] as const] : [];
    }),
  );
}

function featureOrder(objectType: "node" | "way" | "relation"): number {
  return objectType === "node" ? 0 : objectType === "way" ? 1 : 2;
}

function regionMatches(tags: Readonly<Record<string, string>>, regionName: string): boolean {
  const wanted = normalizeSemanticName(regionName);
  return DEFAULT_REGION_HINT_KEYS.flatMap((key) => {
    const value = tags[key];
    return value ? value.split(/[;,&/]/) : [];
  })
    .map(normalizeSemanticName)
    .includes(wanted);
}

export interface SemanticEntityMatch {
  entry: SemanticFeatureIndexEntry;
  variant: SemanticNameVariant;
}

export function semanticEntityCandidates(
  hint: SemanticAnchorHint,
  index: SemanticFeatureIndex,
): SemanticEntityMatch[] {
  const candidates = candidateSemanticNames(hint.name);
  const wanted = new Map(candidates.map((variant) => [variant.name, variant]));
  const matches: SemanticEntityMatch[] = [];
  const pool = index.byName ? [...new Set([...wanted.keys()].flatMap(name => [...(index.byName?.get(name) ?? [])]))] : index.entries;
  for (const entry of pool) {
    if (hint.expectedTypes.length > 0) {
      const inferred = inferOsmAnchorType(entry.tags);
      if (!hint.expectedTypes.includes(inferred) && !entry.expectedTypes.some((t) => hint.expectedTypes.includes(t))) {
        continue;
      }
    }
    const names = new Set([...(entry.nameVariants ?? [])].map(normalizeSemanticName));
    if (entry.primaryName) names.add(normalizeSemanticName(entry.primaryName));
    for (const [name, variant] of wanted) {
      if (names.has(name)) {
        matches.push({ entry, variant });
        break;
      }
    }
  }
  return matches;
}

export function resolveSemanticEntity(
  hint: SemanticAnchorHint,
  index: SemanticFeatureIndex,
  context: SemanticEntityResolutionContext = {},
): OsmAnchorResolution {
  const maximumCandidateCount = context.maximumCandidateCount ?? 5_000;
  if (
    !Number.isSafeInteger(maximumCandidateCount) ||
    maximumCandidateCount < 1 ||
    maximumCandidateCount > 50_000
  ) {
    throw new Error("maximumCandidateCount must be between 1 and 50000.");
  }
  const maximumMountainDistanceM = context.maximumMountainDistanceM ?? 50_000;
  if (!Number.isFinite(maximumMountainDistanceM) || maximumMountainDistanceM <= 0) {
    throw new Error("maximumMountainDistanceM must be positive.");
  }
  const matches = semanticEntityCandidates(hint, index);
  if (matches.length > maximumCandidateCount) throw new Error('SEMANTIC_CANDIDATE_LIMIT_EXCEEDED');
  const elevation = elevationQualifierMeters(hint.name);
  const scored: ScoredEntity[] = [];
  for (const match of matches) {
    const { entry, variant } = match;
    if (variant.kind === 'STATUS_QUALIFIER_STRIPPED') {
      if (!hasHistoricStatusEvidence(entry.tags)) continue;
      const region = hint.regionName ?? context.regionName;
      if (region && DEFAULT_REGION_HINT_KEYS.some(k => entry.tags[k]) && !regionMatches(entry.tags, region)) continue;
    }
    let score = variant.kind === "EXACT_OSM_NAME" ? 100 : variant.kind === "NAME_VARIANT" ? 95 : 90;
    const evidence: string[] = [variant.kind];
    if (variant.kind === 'STATUS_QUALIFIER_STRIPPED') evidence.push('INDEPENDENT_OSM_STATUS_COMPATIBLE');
    if (elevation !== null) {
      const raw = (entry.tags.ele ?? '').trim();
      const actual = /^-?\d+(?:\.\d+)?(?:\s*m)?$/.test(raw) ? Number(raw.replace(/\s*m$/, '')) : null;
      if (actual !== null && Math.abs(actual - elevation) > 100) continue;
      evidence.push(actual === null ? 'ELEVATION_QUALIFIER_UNPROVEN' : 'ELEVATION_QUALIFIER_COMPATIBLE');
      if (actual !== null) score += 5;
    }
    const inferred = inferOsmAnchorType(entry.tags);
    if (hint.expectedTypes.includes(inferred)) {
      score += 30;
      evidence.push("EXPECTED_FEATURE_TYPE");
    }
    const requestedRegion = hint.regionName ?? context.regionName ?? null;
    if (requestedRegion && regionMatches(entry.tags, requestedRegion)) {
      score += 20;
      evidence.push("EXACT_OSM_REGION");
    }
    if (context.mountainCoordinate) {
      const distance = calculateCoordinateDistanceMeters(context.mountainCoordinate, entry.coordinate);
      if (distance > maximumMountainDistanceM) continue;
      score += 20 * (1 - distance / maximumMountainDistanceM);
      evidence.push(`MOUNTAIN_PROXIMITY_${Math.round(distance)}M`);
    }
    if (context.previousRouteCoordinate) {
      const distance = calculateCoordinateDistanceMeters(context.previousRouteCoordinate, entry.coordinate);
      score += 10 / (1 + distance / 1_000);
      evidence.push(`ROUTE_ORDERING_PROXIMITY_${Math.round(distance)}M`);
    }
    scored.push({
      entry,
      anchor: {
        resolutionVersion: OSM_ANCHOR_RESOLUTION_VERSION,
        anchorType: inferred,
        osmObjectType: entry.objectType,
        osmId: entry.osmId,
        name: entry.primaryName ?? hint.name,
        coordinate: [...entry.coordinate] as [number, number],
        tagsSubset: tagsSubset(entry.tags),
        resolutionConfidence: 0,
        resolutionEvidence: [...new Set(evidence)].sort(),
        geometrySource: "OPENSTREETMAP",
      },
      score,
      matchedName: variant.name,
      matchedKind: variant.kind,
    });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      featureOrder(left.entry.objectType) - featureOrder(right.entry.objectType) ||
      left.entry.osmId - right.entry.osmId,
  );
  if (scored.length === 0) return { status: "NOT_FOUND", anchor: null, candidates: [] };
  const candidates = scored.map((candidate, index) => ({
    ...candidate.anchor,
    resolutionConfidence: Math.round(
      Math.min(
        0.99,
        0.72 + (candidate.score - 100) / 100 + (index === 0 ? 0.02 : 0),
      ) * 1_000,
    ) / 1_000,
  }));
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.5) {
    return { status: "AMBIGUOUS", anchor: null, candidates };
  }
  return { status: "RESOLVED", anchor: candidates[0], candidates };
}

export function semanticIndexHash(index: SemanticFeatureIndex): string {
  return sha256Stable({
    schemaVersion: index.schemaVersion,
    wantedNameCount: index.wantedNameCount,
    sourceHashes: index.sourceHashes,
    entries: index.entries,
  });
}
