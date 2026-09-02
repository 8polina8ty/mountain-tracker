import { sha256Stable } from "./phase11-publication.ts";
import type {
  NearbyFeature,
  StartContextOptions,
} from "./start-context-classifier3.ts";

export const PHASE11H_CONTRACT = "mountain-tracker-phase11h-human-calibration/v1";
export const PHASE11H_NAME_RESOLUTION_CONTRACT =
  "mountain-tracker-phase11h-name-resolution/v1";
export const PHASE11H_QA_QUESTION_CONTRACT = "mountain-tracker-phase11h-human-qa/v1";
export const PHASE11H_STAGING_CONTRACT = "mountain-tracker-osm-route/v1";

export const PHASE11H_SAMPLE_TARGET = 45;
export const PHASE11H_DERIVED_AMBIGUITY_WINDOW_METERS = 50;

export type Phase11hNameStatus =
  | "SOURCE_NAME"
  | "SOURCE_OFFICIAL_NAME"
  | "SOURCE_LOCAL_NAME"
  | "DERIVED_SOURCE_BACKED"
  | "REF_ONLY"
  | "UNRESOLVED";

export type Phase11hNameOrigin =
  | "RELATION_NAME"
  | "RELATION_OFFICIAL_NAME"
  | "RELATION_LOCAL_NAME"
  | "DERIVED_FROM_FROZEN_OSM"
  | "ROUTE_REF_ONLY"
  | null;

export type Phase11hRefKind = "NO_REF" | "TECHNICAL_ONLY_REF" | "HUMAN_MEANINGFUL_REF";

export type Phase11hQualityBand = "Q65_74" | "Q75_89" | "Q90";

export interface Phase11hRelationTags {
  name: string | null;
  official_name: string | null;
  local_name: string | null;
  short_name: string | null;
  alt_name: string | null;
  ref: string | null;
  from: string | null;
  to: string | null;
  via: string | null;
  description: string | null;
  operator: string | null;
  network: string | null;
  symbol: string | null;
}

export interface Phase11hNamedStartEntity {
  featureType: NearbyFeature["featureType"];
  objectType: NearbyFeature["objectType"];
  osmid: string;
  name: string;
  distanceMeters: number;
}

export interface Phase11hNameResolution {
  canonicalRelationId: string;
  sourceName: string | null;
  officialName: string | null;
  localName: string | null;
  ref: string | null;
  refKind: Phase11hRefKind;
  startContext: "BASE_START" | "HUT_START" | string | null;
  startEntity: Phase11hNamedStartEntity | null;
  summitEntity: { peakSourceId: string; peakName: string | null; peakElevationMeters: number | null } | null;
  derivedDisplayName: string | null;
  sourceNamePreservedAsNull: boolean;
  nameOrigin: Phase11hNameOrigin;
  nameEvidence: string[];
  nameStatus: Phase11hNameStatus;
  deterministicResolutionHash: string;
}

export interface Phase11hQaQuestion {
  id: string;
  prompt: string;
}

export type Phase11hQaStatus =
  | "PENDING"
  | "VISUALLY_APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED";

export const PHASE11H_QA_QUESTIONS: Phase11hQaQuestion[] = [
  { id: "A", prompt: "Does the geometry represent a real ascent route to the associated summit?" },
  { id: "B", prompt: "Is the summit association visually correct?" },
  { id: "C", prompt: "Does the route start from a meaningful BASE or legitimate HUT?" },
  { id: "D", prompt: "Does the route avoid obvious motorway/road-safety problems?" },
  { id: "E", prompt: "Is the geometry complete enough to be useful to a climber/hiker?" },
  { id: "F", prompt: "Is there an obvious detour/branch/traverse problem that machine rules missed?" },
  { id: "G", prompt: "Is the proposed route label/name accurate and non-misleading?" },
];

export const PHASE11H_QA_STATUS_VOCABULARY: readonly Phase11hQaStatus[] = [
  "PENDING",
  "VISUALLY_APPROVED",
  "NEEDS_REVIEW",
  "REJECTED",
];

export function qualityBand(qualityScore: number): Phase11hQualityBand {
  if (qualityScore >= 90) return "Q90";
  if (qualityScore >= 75) return "Q75_89";
  return "Q65_74";
}

export function normalizeNameForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function classifyRouteRef(ref: string | null | undefined): Phase11hRefKind {
  const value = ref?.trim() ?? "";
  if (value.length === 0) return "NO_REF";
  if (/^[0-9]+$/.test(value)) return "TECHNICAL_ONLY_REF";
  if (/^[0-9]+[a-zA-Z]?$/.test(value) && value.length <= 3) return "TECHNICAL_ONLY_REF";
  if (/[a-zA-Z]/.test(value)) return "HUMAN_MEANINGFUL_REF";
  return "TECHNICAL_ONLY_REF";
}

function relationTagsOf(tags: Record<string, string>): Phase11hRelationTags {
  return {
    name: tags.name ?? null,
    official_name: tags.official_name ?? null,
    local_name: tags.local_name ?? null,
    short_name: tags.short_name ?? null,
    alt_name: tags.alt_name ?? null,
    ref: tags.ref ?? null,
    from: tags.from ?? null,
    to: tags.to ?? null,
    via: tags.via ?? null,
    description: tags.description ?? null,
    operator: tags.operator ?? null,
    network: tags.network ?? null,
    symbol: tags.symbol ?? null,
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function deriveNamedStartEntity(input: {
  startContext: "BASE_START" | "HUT_START";
  nearbyFeatures: NearbyFeature[];
  options: StartContextOptions;
}): Phase11hNamedStartEntity | null {
  const candidates: NearbyFeature[] = [];
  if (input.startContext === "HUT_START") {
    for (const feature of input.nearbyFeatures) {
      if (
        (feature.featureType === "alpine_hut" || feature.featureType === "wilderness_hut") &&
        feature.distanceMeters <= input.options.hutProximityThresholdMeters
      ) {
        candidates.push(feature);
      }
    }
  } else {
    const priority = (feature: NearbyFeature): number => {
      switch (feature.featureType) {
        case "trailhead_info":
          return 1;
        case "trailhead":
          return 2;
        case "train_station":
        case "halt":
        case "bus_stop":
          return 3;
        case "village":
        case "hamlet":
          return 4;
        case "parking":
          return 5;
        default:
          return 9;
      }
    };
    const within = (feature: NearbyFeature): boolean => {
      switch (feature.featureType) {
        case "trailhead_info":
          return feature.distanceMeters <= input.options.trailheadInfoThresholdMeters;
        case "trailhead":
          return feature.distanceMeters <= input.options.trailheadThresholdMeters;
        case "train_station":
        case "halt":
        case "bus_stop":
          return feature.distanceMeters <= input.options.transitThresholdMeters;
        case "village":
        case "hamlet":
          return feature.distanceMeters <= input.options.settlementTightThresholdMeters;
        case "parking":
          return feature.distanceMeters <= input.options.parkingThresholdMeters;
        default:
          return false;
      }
    };
    for (const feature of input.nearbyFeatures) {
      const rank = priority(feature);
      if (rank <= 5 && within(feature)) candidates.push(feature);
    }
  }

  const named = candidates
    .filter((feature) => nonEmpty(feature.name) !== null)
    .map((feature) => ({ feature, name: nonEmpty(feature.name)! }));

  if (input.startContext === "HUT_START") {
    named.sort((left, right) =>
      left.feature.distanceMeters - right.feature.distanceMeters ||
      Number(left.feature.osmid) - Number(right.feature.osmid),
    );
  } else {
    const priorityName = (feature: NearbyFeature): number => {
      switch (feature.featureType) {
        case "trailhead_info":
          return 1;
        case "trailhead":
          return 2;
        case "train_station":
        case "halt":
        case "bus_stop":
          return 3;
        case "village":
        case "hamlet":
          return 4;
        case "parking":
          return 5;
        default:
          return 9;
      }
    };
    named.sort((left, right) =>
      priorityName(left.feature) - priorityName(right.feature) ||
      left.feature.distanceMeters - right.feature.distanceMeters ||
      Number(left.feature.osmid) - Number(right.feature.osmid),
    );
  }

  if (named.length === 0) return null;

  const closest = named[0];
  const closestName = normalizeNameForCompare(closest.name);
  const competing = named.some(
    (candidate) =>
      candidate !== closest &&
      Math.abs(candidate.feature.distanceMeters - closest.feature.distanceMeters) <=
        PHASE11H_DERIVED_AMBIGUITY_WINDOW_METERS &&
      normalizeNameForCompare(candidate.name) !== closestName,
  );
  if (competing) return null;

  return {
    featureType: closest.feature.featureType,
    objectType: closest.feature.objectType,
    osmid: closest.feature.osmid,
    name: closest.name,
    distanceMeters: closest.feature.distanceMeters,
  };
}

export function composeDerivedDisplayName(
  startEntityName: string,
  summitName: string,
): string {
  return `${startEntityName} – ${summitName}`;
}

export function resolvePhase11hNameResolution(input: {
  canonicalRelationId: string;
  rawTags: Record<string, string>;
  startContext: string | null;
  startEntity: Phase11hNamedStartEntity | null;
  summitEntity: { peakSourceId: string; peakName: string | null; peakElevationMeters: number | null } | null;
}): Phase11hNameResolution {
  const tags = relationTagsOf(input.rawTags);
  const sourceName = nonEmpty(tags.name);
  const officialName = nonEmpty(tags.official_name);
  const localName = nonEmpty(tags.local_name);
  const ref = nonEmpty(tags.ref);
  const refKind = classifyRouteRef(ref);
  const evidence: string[] = [];

  let derivedDisplayName: string | null = null;
  let nameOrigin: Phase11hNameOrigin = null;
  let nameStatus: Phase11hNameStatus;

  if (sourceName) {
    nameStatus = "SOURCE_NAME";
    nameOrigin = "RELATION_NAME";
    evidence.push(`OSM relation name tag: "${sourceName}".`);
  } else if (officialName) {
    nameStatus = "SOURCE_OFFICIAL_NAME";
    nameOrigin = "RELATION_OFFICIAL_NAME";
    evidence.push(`OSM relation official_name tag: "${officialName}".`);
  } else if (localName) {
    nameStatus = "SOURCE_LOCAL_NAME";
    nameOrigin = "RELATION_LOCAL_NAME";
    evidence.push(`OSM relation local_name tag: "${localName}".`);
  } else if (input.summitEntity && input.startEntity && input.summitEntity.peakName) {
    derivedDisplayName = composeDerivedDisplayName(input.startEntity.name, input.summitEntity.peakName);
    nameStatus = "DERIVED_SOURCE_BACKED";
    nameOrigin = "DERIVED_FROM_FROZEN_OSM";
    evidence.push(
      `Exact named start feature ${input.startEntity.featureType} "${input.startEntity.name}" (${input.startEntity.osmid}, ${Math.round(input.startEntity.distanceMeters)} m from start).`,
      `Exact summit entity "${input.summitEntity.peakName}" (peak ${input.summitEntity.peakSourceId}).`,
      `Derived label composed from frozen OSM evidence only; never written to the OSM relation name.`,
    );
    if (tags.from) {
      evidence.push(`Relation from tag corroborates start: "${tags.from}".`);
    }
    if (tags.to) {
      evidence.push(`Relation to tag corroborates summit: "${tags.to}".`);
    }
  } else if (ref) {
    nameStatus = "REF_ONLY";
    nameOrigin = "ROUTE_REF_ONLY";
    evidence.push(
      `No human-readable name available; only route ref "${ref}" (${refKind}) retained as metadata, not a primary public name.`,
    );
  } else {
    nameStatus = "UNRESOLVED";
    evidence.push("No source name, official/local name, exact named start entity, or exact summit name available. Fail closed.");
  }

  const content = {
    canonicalRelationId: input.canonicalRelationId,
    sourceName,
    officialName,
    localName,
    ref,
    refKind,
    startContext: input.startContext,
    startEntity: input.startEntity,
    summitEntity: input.summitEntity,
    derivedDisplayName,
    sourceNamePreservedAsNull: nameOrigin === "DERIVED_FROM_FROZEN_OSM" || nameStatus === "REF_ONLY" || nameStatus === "UNRESOLVED",
    nameOrigin,
    nameEvidence: evidence,
    nameStatus,
  };
  return { ...content, deterministicResolutionHash: sha256Stable(content) };
}

export function isNameReady(status: Phase11hNameStatus): boolean {
  return (
    status === "SOURCE_NAME" ||
    status === "SOURCE_OFFICIAL_NAME" ||
    status === "SOURCE_LOCAL_NAME" ||
    status === "DERIVED_SOURCE_BACKED"
  );
}