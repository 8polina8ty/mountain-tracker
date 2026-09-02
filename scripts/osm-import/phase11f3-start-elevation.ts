import { calculateCoordinateDistanceMeters, type Coordinate } from "./peak-matcher.ts";
import { normalizeEle, type EleParseStatus } from "./ele-normalizer.ts";
import type { FeatureIndex } from "./start-context-classifier3.ts";

export type ElevationSourceType =
  | "EXACT_ENDPOINT_OSM_ELE"
  | "EXACT_START_FEATURE_ELE"
  | "CONTAINING_START_FEATURE_ELE"
  | "CONNECTED_NETWORK_ELEVATION"
  | "FROZEN_TERRAIN_DATA"
  | "NONE";

export interface ElevationSourceEvidence {
  sourceType: ElevationSourceType;
  sourceOsmType: string;
  sourceOsmId: string | null;
  rawEle: string;
  parseStatus: EleParseStatus;
  normalizedEleMeters: number | null;
  distanceMeters: number | null;
  topologicalRelationship: string | null;
  confidence: number;
}

export interface StartElevationResolution {
  deterministic: boolean;
  startElevationMeters: number | null;
  selectedSource: ElevationSourceEvidence | null;
  candidates: ElevationSourceEvidence[];
  conflict: boolean;
  reasonCodes: string[];
}

export interface Phase11f3ElevationOptions {
  eleNodeRadiusMeters: number;
  parkingThresholdMeters: number;
  trailheadThresholdMeters: number;
  trailheadInfoThresholdMeters: number;
  transitThresholdMeters: number;
  settlementTightThresholdMeters: number;
  dwellingTightThresholdMeters: number;
  toleranceMeters: number;
  endpointConflictWindowMeters: number;
}

export const DEFAULT_PHASE11F3_ELEVATION_OPTIONS: Phase11f3ElevationOptions = {
  eleNodeRadiusMeters: 300,
  parkingThresholdMeters: 300,
  trailheadThresholdMeters: 300,
  trailheadInfoThresholdMeters: 100,
  transitThresholdMeters: 150,
  settlementTightThresholdMeters: 300,
  dwellingTightThresholdMeters: 100,
  toleranceMeters: 5,
  endpointConflictWindowMeters: 25,
};

interface EleNodeRecord {
  osmid: string;
  coordinate: [number, number] | null;
  rawEle: string;
  parseStatus: EleParseStatus;
  normalizedMeters: number | null;
  name: string | null;
}

export type { EleNodeRecord };

interface FeatureRecord {
  objectType: "node" | "way" | "relation";
  osmid: string;
  name: string | null;
  tags: Record<string, string>;
  coordinate: [number, number] | null;
}

function nearestFeatureEle(
  start: Coordinate,
  list: FeatureRecord[],
  radius: number,
): { feature: FeatureRecord; distance: number } | null {
  let best: { feature: FeatureRecord; distance: number } | null = null;
  for (const feature of list) {
    if (!feature.coordinate) continue;
    const raw = feature.tags.ele ?? "";
    if (normalizeEle(raw).normalizedMeters == null) continue;
    const distance = calculateCoordinateDistanceMeters(start, feature.coordinate);
    if (distance <= radius && (!best || distance < best.distance)) {
      best = { feature, distance };
    }
  }
  return best;
}

export interface Phase11f3FeatureIndex {
  eleNodes: EleNodeRecord[];
  parking: FeatureRecord[];
  trailheads: FeatureRecord[];
  trailheadInfo: FeatureRecord[];
  busStops: FeatureRecord[];
  trainStations: FeatureRecord[];
  halts: FeatureRecord[];
  villages: FeatureRecord[];
  hamlets: FeatureRecord[];
  isolatedDwellings: FeatureRecord[];
  farms: FeatureRecord[];
}

function buildFeatureIndex(source: FeatureIndex, eleNodes: EleNodeRecord[]): Phase11f3FeatureIndex {
  return {
    eleNodes,
    parking: source.parking,
    trailheads: source.trailheads,
    trailheadInfo: source.trailheadInfo,
    busStops: source.busStops,
    trainStations: source.trainStations,
    halts: source.halts,
    villages: source.villages,
    hamlets: source.hamlets,
    isolatedDwellings: source.isolatedDwellings,
    farms: source.farms,
  };
}

function asEvidence(
  sourceType: ElevationSourceType,
  sourceOsmType: string,
  sourceOsmId: string | null,
  rawEle: string,
  distanceMeters: number | null,
  confidence: number,
): ElevationSourceEvidence {
  const parsed = normalizeEle(rawEle);
  return {
    sourceType,
    sourceOsmType,
    sourceOsmId,
    rawEle,
    parseStatus: parsed.status,
    normalizedEleMeters: parsed.normalizedMeters,
    distanceMeters,
    topologicalRelationship: null,
    confidence,
  };
}

function collectCandidates(
  start: Coordinate,
  index: Phase11f3FeatureIndex,
  options: Phase11f3ElevationOptions,
): ElevationSourceEvidence[] {
  const candidates: ElevationSourceEvidence[] = [];

  for (const node of index.eleNodes) {
    if (!node.coordinate || node.normalizedMeters == null) continue;
    const distance = calculateCoordinateDistanceMeters(start, node.coordinate);
    if (distance <= options.eleNodeRadiusMeters) {
      candidates.push(
        asEvidence(
          "EXACT_ENDPOINT_OSM_ELE",
          "node",
          node.osmid,
          node.rawEle,
          distance,
          0.95,
        ),
      );
    }
  }

  const startFeatureDefinitions: Array<{
    list: FeatureRecord[];
    radius: number;
    type: string;
    osmType: string;
  }> = [
    { list: index.parking, radius: options.parkingThresholdMeters, type: "parking", osmType: "node" },
    { list: index.trailheads, radius: options.trailheadThresholdMeters, type: "trailhead", osmType: "node" },
    { list: index.trailheadInfo, radius: options.trailheadInfoThresholdMeters, type: "trailhead_info", osmType: "node" },
    { list: index.busStops, radius: options.transitThresholdMeters, type: "bus_stop", osmType: "node" },
    { list: index.trainStations, radius: options.transitThresholdMeters, type: "train_station", osmType: "node" },
    { list: index.halts, radius: options.transitThresholdMeters, type: "halt", osmType: "node" },
    { list: index.villages, radius: options.settlementTightThresholdMeters, type: "village", osmType: "node" },
    { list: index.hamlets, radius: options.settlementTightThresholdMeters, type: "hamlet", osmType: "node" },
    { list: index.isolatedDwellings, radius: options.dwellingTightThresholdMeters, type: "isolated_dwelling", osmType: "node" },
    { list: index.farms, radius: options.dwellingTightThresholdMeters, type: "farm", osmType: "node" },
  ];

  for (const def of startFeatureDefinitions) {
    const found = nearestFeatureEle(start, def.list, def.radius);
    if (found) {
      candidates.push(
        asEvidence(
          "EXACT_START_FEATURE_ELE",
          def.osmType,
          found.feature.osmid,
          found.feature.tags.ele ?? "",
          found.distance,
          def.type === "parking" || def.type === "trailhead"
            ? 0.85
            : def.type === "trailhead_info"
              ? 0.8
              : 0.7,
        ),
      );
    }
  }

  return candidates.sort((a, b) => {
    const prio = (t: ElevationSourceType) =>
      t === "EXACT_ENDPOINT_OSM_ELE" ? 1 : t === "EXACT_START_FEATURE_ELE" ? 2 : 3;
    const pa = prio(a.sourceType);
    const pb = prio(b.sourceType);
    if (pa !== pb) return pa - pb;
    return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
  });
}

export function resolveStartElevationV3(
  start: Coordinate,
  index: Phase11f3FeatureIndex,
  options: Phase11f3ElevationOptions = DEFAULT_PHASE11F3_ELEVATION_OPTIONS,
): StartElevationResolution {
  const candidates = collectCandidates(start, index, options);
  const valid = candidates.filter((c) => c.normalizedEleMeters != null);
  const reasonCodes: string[] = [];
  if (valid.length === 0) {
    reasonCodes.push("START_ELEVATION_UNPROVEN");
    return {
      deterministic: false,
      startElevationMeters: null,
      selectedSource: null,
      candidates,
      conflict: false,
      reasonCodes,
    };
  }

  const selected = valid[0];
  const sameEndpointConflicts = valid.filter(
    (c) =>
      c.sourceType === selected.sourceType &&
      (c.distanceMeters ?? Infinity) <= options.endpointConflictWindowMeters &&
      (selected.distanceMeters ?? Infinity) <= options.endpointConflictWindowMeters &&
      Math.abs((c.normalizedEleMeters ?? 0) - (selected.normalizedEleMeters ?? 0)) > options.toleranceMeters,
  );
  if (sameEndpointConflicts.length > 0) {
    reasonCodes.push("START_ELEVATION_CONFLICT");
    return {
      deterministic: false,
      startElevationMeters: null,
      selectedSource: null,
      candidates,
      conflict: true,
      reasonCodes,
    };
  }

  reasonCodes.push("START_ELEVATION_PROVEN");
  return {
    deterministic: true,
    startElevationMeters: selected.normalizedEleMeters,
    selectedSource: selected,
    candidates,
    conflict: false,
    reasonCodes,
  };
}

export { buildFeatureIndex };
