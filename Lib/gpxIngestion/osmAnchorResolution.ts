import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import type { Coordinate } from "./types.ts";
import type { SemanticAnchorHint, SemanticAnchorType } from "./routeDiscovery.ts";

export const OSM_ANCHOR_RESOLUTION_VERSION =
  "mountain-tracker/osm-anchor-resolution/v1" as const;

export type OsmObjectType = "node" | "way" | "relation";
export type AnchorResolutionStatus = "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";

export interface OsmAnchorFeature {
  sourceKey: "openstreetmap";
  osmObjectType: OsmObjectType;
  osmId: number;
  coordinate: Coordinate;
  tags: Readonly<Record<string, string>>;
}

export interface ResolvedOsmAnchor {
  resolutionVersion: typeof OSM_ANCHOR_RESOLUTION_VERSION;
  anchorType: SemanticAnchorType;
  osmObjectType: OsmObjectType;
  osmId: number;
  name: string;
  coordinate: Coordinate;
  tagsSubset: Readonly<Record<string, string>>;
  resolutionConfidence: number;
  resolutionEvidence: string[];
  geometrySource: "OPENSTREETMAP";
}

export type OsmAnchorResolution =
  | {
      status: "RESOLVED";
      anchor: ResolvedOsmAnchor;
      candidates: ResolvedOsmAnchor[];
    }
  | {
      status: "AMBIGUOUS";
      anchor: null;
      candidates: ResolvedOsmAnchor[];
    }
  | {
      status: "NOT_FOUND";
      anchor: null;
      candidates: [];
    };

export interface OsmAnchorResolutionContext {
  regionName?: string | null;
  mountainCoordinate?: Coordinate | null;
  previousRouteCoordinate?: Coordinate | null;
  maximumMountainDistanceM?: number;
  maximumCandidateCount?: number;
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
  "addr:state",
  "addr:country",
  "is_in",
] as const;

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/g, " ").trim();
}

function candidateNames(tags: Readonly<Record<string, string>>): string[] {
  return [tags.name, tags.official_name, tags.short_name, ...(tags.alt_name?.split(";") ?? [])]
    .filter((value): value is string => typeof value === "string")
    .map(normalizedName)
    .filter(Boolean);
}

export function inferOsmAnchorType(
  tags: Readonly<Record<string, string>>,
): SemanticAnchorType {
  if (tags.natural === "peak") return "SUMMIT";
  if (tags.natural === "saddle") return "SADDLE";
  if (tags.mountain_pass === "yes") return "PASS";
  if (tags.natural === "valley") return "VALLEY";
  if (["alpine_hut", "wilderness_hut"].includes(tags.tourism ?? "")) return "HUT";
  if (tags.amenity === "parking") return "PARKING";
  if (["village", "hamlet", "town", "city", "isolated_dwelling"].includes(tags.place ?? "")) {
    return "SETTLEMENT";
  }
  if (tags.information === "trailhead" || tags.highway === "trailhead") return "TRAILHEAD";
  if (tags.junction || tags.highway === "crossing") return "JUNCTION";
  return "OTHER_NAMED_FEATURE";
}

function tagsSubset(tags: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    TAG_SUBSET_KEYS.flatMap((key) => {
      const value = tags[key]?.normalize("NFKC").trim();
      return value && value.length <= 200 ? [[key, value] as const] : [];
    }),
  );
}

function assertCoordinate(coordinate: Coordinate): void {
  if (
    !Number.isFinite(coordinate[0]) ||
    !Number.isFinite(coordinate[1]) ||
    coordinate[0] < -180 ||
    coordinate[0] > 180 ||
    coordinate[1] < -90 ||
    coordinate[1] > 90
  ) {
    throw new Error("OSM anchor candidate has an invalid coordinate.");
  }
}

interface ScoredCandidate {
  anchor: ResolvedOsmAnchor;
  score: number;
}

function featureOrder(value: OsmObjectType): number {
  return value === "node" ? 0 : value === "way" ? 1 : 2;
}

function regionMatches(tags: Readonly<Record<string, string>>, regionName: string): boolean {
  const wanted = normalizedName(regionName);
  return [tags["addr:state"], tags["addr:country"], tags.is_in]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => value.split(/[;,]/))
    .some((value) => normalizedName(value) === wanted);
}

export function resolveOsmAnchor(
  hint: SemanticAnchorHint,
  features: readonly OsmAnchorFeature[],
  context: OsmAnchorResolutionContext = {},
): OsmAnchorResolution {
  const maximumCandidateCount = context.maximumCandidateCount ?? 5_000;
  if (
    !Number.isSafeInteger(maximumCandidateCount) ||
    maximumCandidateCount < 1 ||
    maximumCandidateCount > 50_000
  ) {
    throw new Error("maximumCandidateCount must be between 1 and 50000.");
  }
  if (features.length > maximumCandidateCount) {
    throw new Error("Anchor resolution candidate query exceeded its bound.");
  }
  const wantedName = normalizedName(hint.name);
  const maximumMountainDistanceM = context.maximumMountainDistanceM ?? 50_000;
  if (!Number.isFinite(maximumMountainDistanceM) || maximumMountainDistanceM <= 0) {
    throw new Error("maximumMountainDistanceM must be positive.");
  }

  const scored: ScoredCandidate[] = [];
  for (const feature of features) {
    if (feature.sourceKey !== "openstreetmap") {
      throw new Error("Resolved anchors may only use independently supplied OSM features.");
    }
    if (!Number.isSafeInteger(feature.osmId) || feature.osmId <= 0) {
      throw new Error("OSM anchor IDs must be positive safe integers.");
    }
    assertCoordinate(feature.coordinate);
    if (!candidateNames(feature.tags).includes(wantedName)) continue;

    const anchorType = inferOsmAnchorType(feature.tags);
    if (hint.expectedTypes.length > 0 && !hint.expectedTypes.includes(anchorType)) continue;
    const evidence = ["EXACT_OSM_NAME"];
    let score = 100;
    if (hint.expectedTypes.includes(anchorType)) {
      score += 30;
      evidence.push("EXPECTED_FEATURE_TYPE");
    }
    const requestedRegion = hint.regionName ?? context.regionName ?? null;
    if (requestedRegion && regionMatches(feature.tags, requestedRegion)) {
      score += 20;
      evidence.push("EXACT_OSM_REGION");
    }
    if (context.mountainCoordinate) {
      const distance = calculateCoordinateDistanceMeters(
        context.mountainCoordinate,
        feature.coordinate,
      );
      if (distance > maximumMountainDistanceM) continue;
      score += 20 * (1 - distance / maximumMountainDistanceM);
      evidence.push(`MOUNTAIN_PROXIMITY_${Math.round(distance)}M`);
    }
    if (context.previousRouteCoordinate) {
      const distance = calculateCoordinateDistanceMeters(
        context.previousRouteCoordinate,
        feature.coordinate,
      );
      score += 10 / (1 + distance / 1_000);
      evidence.push(`ROUTE_ORDERING_PROXIMITY_${Math.round(distance)}M`);
    }

    scored.push({
      score,
      anchor: {
        resolutionVersion: OSM_ANCHOR_RESOLUTION_VERSION,
        anchorType,
        osmObjectType: feature.osmObjectType,
        osmId: feature.osmId,
        name: feature.tags.name?.normalize("NFKC").trim() || hint.name,
        coordinate: [...feature.coordinate] as Coordinate,
        tagsSubset: tagsSubset(feature.tags),
        resolutionConfidence: 0,
        resolutionEvidence: evidence,
        geometrySource: "OPENSTREETMAP",
      },
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      featureOrder(left.anchor.osmObjectType) - featureOrder(right.anchor.osmObjectType) ||
      left.anchor.osmId - right.anchor.osmId,
  );
  if (scored.length === 0) return { status: "NOT_FOUND", anchor: null, candidates: [] };

  const candidates = scored.map((candidate, index) => ({
    ...candidate.anchor,
    resolutionConfidence: Math.round(
      Math.min(0.99, 0.72 + (candidate.score - 100) / 100 + (index === 0 ? 0.02 : 0)) * 1_000,
    ) / 1_000,
  }));
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.5) {
    return { status: "AMBIGUOUS", anchor: null, candidates };
  }
  return { status: "RESOLVED", anchor: candidates[0], candidates };
}
