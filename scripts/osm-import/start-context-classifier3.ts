import { readFile } from "node:fs/promises";
import { calculateCoordinateDistanceMeters, type Coordinate } from "./peak-matcher.ts";
import {
  DEFAULT_PHASE11F3_ELEVATION_OPTIONS,
  resolveStartElevationV3,
  type Phase11f3ElevationOptions,
  type Phase11f3FeatureIndex,
} from "./phase11f3-start-elevation.ts";

export type StartContextType =
  | "BASE_START"
  | "HUT_START"
  | "HIGH_MOUNTAIN_START"
  | "AMBIGUOUS_START";

export interface NearbyFeature {
  featureType:
    | "alpine_hut"
    | "wilderness_hut"
    | "mountain_pass"
    | "saddle"
    | "ridge"
    | "peak"
    | "trailhead"
    | "trailhead_info"
    | "parking"
    | "village"
    | "hamlet"
    | "isolated_dwelling"
    | "farm"
    | "bus_stop"
    | "train_station"
    | "halt"
    | "ele_node";
  osmid: string;
  objectType: "node" | "way" | "relation" | "ele_node";
  name: string | null;
  coordinate: Coordinate;
  distanceMeters: number;
  tags: Record<string, string>;
}

export interface StartContextEvidence {
  type: StartContextType;
  startElevationMeters: number | null;
  verticalGainMeters: number | null;
  startElevationSource?: string | null;
  reasons: string[];
  confidence: number;
  nearbyFeatures: NearbyFeature[];
}

export interface StartContextOptions {
  hutProximityThresholdMeters: number;
  highMountainProximityThresholdMeters: number;
  parkingThresholdMeters: number;
  trailheadThresholdMeters: number;
  trailheadInfoThresholdMeters: number;
  settlementThresholdMeters: number;
  settlementTightThresholdMeters: number;
  transitThresholdMeters: number;
  dwellingThresholdMeters: number;
  dwellingTightThresholdMeters: number;
  eleNodeRadiusMeters: number;
  minVerticalGainForBaseStartMeters: number;
}

export const DEFAULT_START_CONTEXT_OPTIONS: StartContextOptions = {
  hutProximityThresholdMeters: 200,
  highMountainProximityThresholdMeters: 500,
  parkingThresholdMeters: 300,
  trailheadThresholdMeters: 300,
  trailheadInfoThresholdMeters: 100,
  settlementThresholdMeters: 1000,
  settlementTightThresholdMeters: 300,
  transitThresholdMeters: 150,
  dwellingThresholdMeters: 600,
  dwellingTightThresholdMeters: 100,
  eleNodeRadiusMeters: 300,
  minVerticalGainForBaseStartMeters: 500,
};

interface FeatureRecord {
  objectType: "node" | "way" | "relation";
  osmid: string;
  name: string | null;
  tags: Record<string, string>;
  coordinate: Coordinate | null;
  wayNodeCount: number | null;
}

interface EleNodeRecord {
  osmid: string;
  name: string | null;
  coordinate: Coordinate | null;
  ele: number;
}

export interface FeatureIndex {
  alpineHuts: FeatureRecord[];
  wildernessHuts: FeatureRecord[];
  mountainPasses: FeatureRecord[];
  saddles: FeatureRecord[];
  ridges: FeatureRecord[];
  peaks: FeatureRecord[];
  trailheads: FeatureRecord[];
  trailheadInfo: FeatureRecord[];
  parking: FeatureRecord[];
  villages: FeatureRecord[];
  hamlets: FeatureRecord[];
  isolatedDwellings: FeatureRecord[];
  farms: FeatureRecord[];
  busStops: FeatureRecord[];
  trainStations: FeatureRecord[];
  halts: FeatureRecord[];
  eleNodes: FeatureRecord[];
}

async function loadJson<T>(path: string): Promise<T[]> {
  return readFile(path, "utf8")
    .then((s) => JSON.parse(s) as T[])
    .catch(() => []);
}

export async function loadPhase11f2FeatureIndex(dir: string): Promise<FeatureIndex> {
  const [
    alpineHuts,
    wildernessHuts,
    mountainPasses,
    saddles,
    ridges,
    peaks,
    trailheads,
    trailheadInfo,
    parking,
    villages,
    hamlets,
    isolatedDwellings,
    farms,
    busStops,
    trainStations,
    halts,
    eleNodes,
  ] = await Promise.all([
    loadJson<FeatureRecord>(`${dir}/alpine-huts.json`),
    loadJson<FeatureRecord>(`${dir}/wilderness-huts.json`),
    loadJson<FeatureRecord>(`${dir}/mountain-passes.json`),
    loadJson<FeatureRecord>(`${dir}/saddles.json`),
    loadJson<FeatureRecord>(`${dir}/ridges.json`),
    loadJson<FeatureRecord>(`${dir}/peaks.json`),
    loadJson<FeatureRecord>(`${dir}/trailheads.json`),
    loadJson<FeatureRecord>(`${dir}/trailhead-info.json`),
    loadJson<FeatureRecord>(`${dir}/parking.json`),
    loadJson<FeatureRecord>(`${dir}/villages.json`),
    loadJson<FeatureRecord>(`${dir}/hamlets.json`),
    loadJson<FeatureRecord>(`${dir}/isolated-dwellings.json`),
    loadJson<FeatureRecord>(`${dir}/farms.json`),
    loadJson<FeatureRecord>(`${dir}/bus-stops.json`),
    loadJson<FeatureRecord>(`${dir}/stations.json`),
    loadJson<FeatureRecord>(`${dir}/halts.json`),
    loadJson<EleNodeRecord>(`${dir}/ele-nodes.json`).then((recs) =>
      recs.map((r) => ({
        objectType: "node" as const,
        osmid: String(r.osmid),
        name: r.name ?? null,
        tags: { ele: String(r.ele) },
        coordinate: r.coordinate,
        wayNodeCount: null,
      })),
    ),
  ]);
  return {
    alpineHuts,
    wildernessHuts,
    mountainPasses,
    saddles,
    ridges,
    peaks,
    trailheads,
    trailheadInfo,
    parking,
    villages,
    hamlets,
    isolatedDwellings,
    farms,
    busStops,
    trainStations,
    halts,
    eleNodes,
  };
}

interface HuntResult {
  featureType: NearbyFeature["featureType"];
  records: NearbyFeature[];
}

function collectNearby(start: Coordinate, index: FeatureIndex, radius: number): NearbyFeature[] {
  const out: NearbyFeature[] = [];
  const push = (featureType: NearbyFeature["featureType"], list: FeatureRecord[]) => {
    for (const rec of list) {
      if (!rec.coordinate) continue;
      const d = calculateCoordinateDistanceMeters(start, rec.coordinate);
      if (d <= radius) {
        out.push({
          featureType,
          osmid: rec.osmid,
          objectType: rec.objectType,
          name: rec.name,
          coordinate: rec.coordinate,
          distanceMeters: d,
          tags: rec.tags,
        });
      }
    }
  };
  push("alpine_hut", index.alpineHuts);
  push("wilderness_hut", index.wildernessHuts);
  push("mountain_pass", index.mountainPasses);
  push("saddle", index.saddles);
  push("ridge", index.ridges);
  push("peak", index.peaks);
  push("trailhead", index.trailheads);
  push("trailhead_info", index.trailheadInfo);
  push("parking", index.parking);
  push("village", index.villages);
  push("hamlet", index.hamlets);
  push("isolated_dwelling", index.isolatedDwellings);
  push("farm", index.farms);
  push("bus_stop", index.busStops);
  push("train_station", index.trainStations);
  push("halt", index.halts);
  out.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return out;
}

function nearestWithin(
  start: Coordinate,
  list: FeatureRecord[],
  radius: number,
): NearbyFeature | null {
  let best: NearbyFeature | null = null;
  for (const rec of list) {
    if (!rec.coordinate) continue;
    const d = calculateCoordinateDistanceMeters(start, rec.coordinate);
    if (d <= radius && (!best || d < best.distanceMeters)) {
      best = {
        featureType: "ele_node",
        osmid: rec.osmid,
        objectType: "ele_node",
        name: rec.name,
        coordinate: rec.coordinate,
        distanceMeters: d,
        tags: rec.tags,
      };
    }
  }
  return best;
}

export function classifyStartContextV2(
  startCoordinate: Coordinate,
  summitCoordinate: Coordinate,
  summitElevationMeters: number | null,
  featureIndex: FeatureIndex,
  options: StartContextOptions = DEFAULT_START_CONTEXT_OPTIONS,
): StartContextEvidence {
  const reasons: string[] = [];

  // --- Elevation evidence (deterministic, frozen OSM) ---
  const eleNode = nearestWithin(startCoordinate, featureIndex.eleNodes, options.eleNodeRadiusMeters);
  let startElevationMeters: number | null = null;
  if (eleNode) {
    const e = parseFloat(eleNode.tags.ele ?? "");
    if (Number.isFinite(e)) {
      startElevationMeters = e;
      reasons.push(
        `Deterministic elevation node (OSM node ${eleNode.osmid}, ele=${e} m) ${Math.round(eleNode.distanceMeters)} m from start.`,
      );
    }
  }
  const verticalGainMeters =
    startElevationMeters !== null && summitElevationMeters !== null
      ? summitElevationMeters - startElevationMeters
      : null;

  // --- High-mountain evidence (fail-closed, highest priority) ---
  const maxSearch = Math.max(
    options.hutProximityThresholdMeters,
    options.highMountainProximityThresholdMeters,
    options.settlementThresholdMeters,
    options.transitThresholdMeters,
    options.dwellingThresholdMeters,
  );
  const nearby = collectNearby(startCoordinate, featureIndex, maxSearch);

  const highMountain = nearby
    .map((n) => n)
    .filter(
      (f) =>
        f.featureType === "mountain_pass" ||
        f.featureType === "saddle" ||
        f.featureType === "ridge" ||
        f.featureType === "peak",
    );
  const closestHigh = highMountain[0] ?? null;

  if (closestHigh && closestHigh.distanceMeters <= options.highMountainProximityThresholdMeters) {
    // Fail-closed: endpoint is at/within a pass/saddle/ridge/peak — not a meaningful base ascent.
    return {
      type: "HIGH_MOUNTAIN_START",
      startElevationMeters,
      verticalGainMeters,
      reasons: [
        `Route starts within ${Math.round(closestHigh.distanceMeters)} m of ${closestHigh.featureType} "${closestHigh.name ?? closestHigh.osmid}" (${closestHigh.objectType ?? "unknown"}).`,
        "Start at pass/saddle/ridge/peak indicates high-mountain start, not a meaningful base ascent.",
        ...reasons,
      ],
      confidence: 0.85,
      nearbyFeatures: nearby,
    };
  }

  // --- HUT evidence (strong positive, but only when NOT a high-mountain start) ---
  const huts = nearby.filter(
    (f) => f.featureType === "alpine_hut" || f.featureType === "wilderness_hut",
  );
  const closestHut = huts[0] ?? null;
  if (closestHut && closestHut.distanceMeters <= options.hutProximityThresholdMeters) {
    return {
      type: "HUT_START",
      startElevationMeters,
      verticalGainMeters,
      reasons: [
        `Route starts within ${Math.round(closestHut.distanceMeters)} m of ${closestHut.featureType} "${closestHut.name ?? closestHut.osmid}" (${closestHut.objectType ?? "unknown"}).`,
        "Legitimate hut start (not at a pass/saddle/ridge/peak), qualifies as a valid summit route start.",
        ...reasons,
      ],
      confidence: 0.9,
      nearbyFeatures: nearby,
    };
  }

  // --- BASE compound evidence ---
  const primaryAccess = nearby.filter(
    (f) =>
      (f.featureType === "parking" && f.distanceMeters <= options.parkingThresholdMeters) ||
      (f.featureType === "trailhead" && f.distanceMeters <= options.trailheadThresholdMeters) ||
      (f.featureType === "trailhead_info" && f.distanceMeters <= options.trailheadInfoThresholdMeters) ||
      (f.featureType === "bus_stop" && f.distanceMeters <= options.transitThresholdMeters) ||
      (f.featureType === "train_station" && f.distanceMeters <= options.transitThresholdMeters) ||
      (f.featureType === "halt" && f.distanceMeters <= options.transitThresholdMeters),
  );
  const settlements = nearby.filter(
    (f) =>
      (f.featureType === "village" || f.featureType === "hamlet") &&
      f.distanceMeters <= options.settlementThresholdMeters,
  );
  const dwellings = nearby.filter(
    (f) =>
      (f.featureType === "isolated_dwelling" || f.featureType === "farm") &&
      f.distanceMeters <= options.dwellingThresholdMeters,
  );

  const baseSignals = [
    ...primaryAccess,
    ...settlements.filter((s) => s.distanceMeters <= options.settlementTightThresholdMeters),
    ...dwellings.filter((d) => d.distanceMeters <= options.dwellingTightThresholdMeters),
  ];
  const closestBaseSignal = baseSignals[0] ?? null;

  if (
    closestBaseSignal &&
    startElevationMeters !== null &&
    verticalGainMeters !== null &&
    verticalGainMeters >= options.minVerticalGainForBaseStartMeters
  ) {
    const corroborating = [...settlements, ...dwellings].filter(
      (f) => f.distanceMeters <= options.settlementThresholdMeters,
    )[0];
    return {
      type: "BASE_START",
      startElevationMeters,
      verticalGainMeters,
      reasons: [
        `Route starts within ${Math.round(closestBaseSignal.distanceMeters)} m of ${closestBaseSignal.featureType} "${closestBaseSignal.name ?? closestBaseSignal.osmid}" (${closestBaseSignal.objectType ?? "unknown"}).`,
        corroborating
          ? `Corroborating settlement/dwelling evidence: ${corroborating.featureType} "${corroborating.name ?? corroborating.osmid}" ${Math.round(corroborating.distanceMeters)} m.`
          : `Corroborating deterministic elevation (${Math.round(startElevationMeters)} m) with substantial vertical gain (${Math.round(verticalGainMeters)} m) proves a base ascent.`,
        `Start elevation ${Math.round(startElevationMeters)} m, summit ${summitElevationMeters} m, vertical gain ${Math.round(verticalGainMeters)} m.`,
        "Base-access marker with deterministic elevation and meaningful vertical gain qualifies as a valid base ascent start.",
        ...reasons,
      ],
      confidence: 0.82,
      nearbyFeatures: nearby,
    };
  }

  // --- AMBIGUOUS summary ---
  const ambiguousReasons: string[] = ["No qualifying base, hut, or high-mountain evidence at the route start."];
  if (!closestBaseSignal) {
    ambiguousReasons.push("No parking, trailhead, guidepost, settlement, or transit base-access marker within search radius.");
  }
  if (startElevationMeters === null && closestBaseSignal) {
    ambiguousReasons.push("Start elevation unknown — no deterministic elevation node within radius.");
  }
  if (closestBaseSignal && startElevationMeters !== null && verticalGainMeters === null) {
    ambiguousReasons.push("Summit elevation unknown — cannot compute vertical gain.");
  }
  if (closestBaseSignal && verticalGainMeters !== null && verticalGainMeters < options.minVerticalGainForBaseStartMeters) {
    ambiguousReasons.push(
      `Vertical gain (${Math.round(verticalGainMeters)} m) below threshold (${options.minVerticalGainForBaseStartMeters} m) for a definitive base ascent.`,
    );
  }
  return {
    type: "AMBIGUOUS_START",
    startElevationMeters,
    verticalGainMeters,
    reasons: [...ambiguousReasons, ...reasons],
    confidence: 0.4,
    nearbyFeatures: nearby,
  };
}

export async function classifyStartContextV3(
  startCoordinate: Coordinate,
  coordinateUnusedSummit: Coordinate,
  summitElevationMeters: number | null,
  featureIndex: FeatureIndex,
  phase11f3Index: Phase11f3FeatureIndex,
  elevationOptions: Phase11f3ElevationOptions = DEFAULT_PHASE11F3_ELEVATION_OPTIONS,
  options: StartContextOptions = DEFAULT_START_CONTEXT_OPTIONS,
): Promise<StartContextEvidence> {
  const elevation = resolveStartElevationV3(startCoordinate, phase11f3Index, elevationOptions);

  let startElevationMeters: number | null = elevation.deterministic
    ? elevation.startElevationMeters
    : null;
  const sourceType = elevation.selectedSource?.sourceType ?? null;
  const verticalGainMeters =
    startElevationMeters !== null && summitElevationMeters !== null
      ? summitElevationMeters - startElevationMeters
      : null;

  const reasons: string[] = [];
  if (sourceType && startElevationMeters !== null) {
    reasons.push(
      `Deterministic start elevation via ${sourceType} (${startElevationMeters} m).`,
    );
  }
  for (const code of elevation.reasonCodes) {
    reasons.push(code);
  }
  if (startElevationMeters !== null && summitElevationMeters !== null) {
    if (startElevationMeters >= summitElevationMeters) {
      startElevationMeters = null;
      reasons.push("START_ELEVATION_INVALID: start elevation >= summit elevation");
    } else if (verticalGainMeters !== null && verticalGainMeters < 0) {
      startElevationMeters = null;
      reasons.push("START_ELEVATION_INVALID: negative vertical gain");
    }
  }

  const maxSearch = Math.max(
    options.hutProximityThresholdMeters,
    options.highMountainProximityThresholdMeters,
    options.settlementThresholdMeters,
    options.transitThresholdMeters,
    options.dwellingThresholdMeters,
  );
  const nearby = collectNearby(startCoordinate, featureIndex, maxSearch);

  const highMountain = nearby.filter(
    (f) =>
      f.featureType === "mountain_pass" ||
      f.featureType === "saddle" ||
      f.featureType === "ridge" ||
      f.featureType === "peak",
  );
  const closestHigh = highMountain[0] ?? null;
  if (closestHigh && closestHigh.distanceMeters <= options.highMountainProximityThresholdMeters) {
    return {
      type: "HIGH_MOUNTAIN_START",
      startElevationMeters,
      verticalGainMeters,
      startElevationSource: sourceType,
      reasons: [
        `Route starts within ${Math.round(closestHigh.distanceMeters)} m of ${closestHigh.featureType} "${closestHigh.name ?? closestHigh.osmid}" (${closestHigh.objectType ?? "unknown"}).`,
        "Start at pass/saddle/ridge/peak indicates high-mountain start, not a meaningful base ascent.",
        ...reasons,
      ],
      confidence: 0.85,
      nearbyFeatures: nearby,
    };
  }

  const huts = nearby.filter(
    (f) => f.featureType === "alpine_hut" || f.featureType === "wilderness_hut",
  );
  const closestHut = huts[0] ?? null;
  if (closestHut && closestHut.distanceMeters <= options.hutProximityThresholdMeters) {
    return {
      type: "HUT_START",
      startElevationMeters,
      verticalGainMeters,
      startElevationSource: sourceType,
      reasons: [
        `Route starts within ${Math.round(closestHut.distanceMeters)} m of ${closestHut.featureType} "${closestHut.name ?? closestHut.osmid}" (${closestHut.objectType ?? "unknown"}).`,
        "Legitimate hut start (not at a pass/saddle/ridge/peak), qualifies as a valid summit route start.",
        ...reasons,
      ],
      confidence: 0.9,
      nearbyFeatures: nearby,
    };
  }

  const primaryAccess = nearby.filter(
    (f) =>
      (f.featureType === "parking" && f.distanceMeters <= options.parkingThresholdMeters) ||
      (f.featureType === "trailhead" && f.distanceMeters <= options.trailheadThresholdMeters) ||
      (f.featureType === "trailhead_info" && f.distanceMeters <= options.trailheadInfoThresholdMeters) ||
      (f.featureType === "bus_stop" && f.distanceMeters <= options.transitThresholdMeters) ||
      (f.featureType === "train_station" && f.distanceMeters <= options.transitThresholdMeters) ||
      (f.featureType === "halt" && f.distanceMeters <= options.transitThresholdMeters),
  );
  const settlements = nearby.filter(
    (f) =>
      (f.featureType === "village" || f.featureType === "hamlet") &&
      f.distanceMeters <= options.settlementThresholdMeters,
  );
  const dwellings = nearby.filter(
    (f) =>
      (f.featureType === "isolated_dwelling" || f.featureType === "farm") &&
      f.distanceMeters <= options.dwellingThresholdMeters,
  );

  const baseSignals = [
    ...primaryAccess,
    ...settlements.filter((s) => s.distanceMeters <= options.settlementTightThresholdMeters),
    ...dwellings.filter((d) => d.distanceMeters <= options.dwellingTightThresholdMeters),
  ];
  const closestBaseSignal = baseSignals[0] ?? null;

  if (
    closestBaseSignal &&
    startElevationMeters !== null &&
    verticalGainMeters !== null &&
    verticalGainMeters >= options.minVerticalGainForBaseStartMeters
  ) {
    const corroborating = [...settlements, ...dwellings].filter(
      (f) => f.distanceMeters <= options.settlementThresholdMeters,
    )[0];
    return {
      type: "BASE_START",
      startElevationMeters,
      verticalGainMeters,
      startElevationSource: sourceType,
      reasons: [
        `Route starts within ${Math.round(closestBaseSignal.distanceMeters)} m of ${closestBaseSignal.featureType} "${closestBaseSignal.name ?? closestBaseSignal.osmid}" (${closestBaseSignal.objectType ?? "unknown"}).`,
        corroborating
          ? `Corroborating settlement/dwelling evidence: ${corroborating.featureType} "${corroborating.name ?? corroborating.osmid}" ${Math.round(corroborating.distanceMeters)} m.`
          : `Corroborating deterministic elevation (${Math.round(startElevationMeters)} m) with substantial vertical gain (${Math.round(verticalGainMeters)} m) proves a base ascent.`,
        `Start elevation ${Math.round(startElevationMeters)} m, summit ${summitElevationMeters} m, vertical gain ${Math.round(verticalGainMeters)} m.`,
        "Base-access marker with deterministic elevation and meaningful vertical gain qualifies as a valid base ascent start.",
        ...reasons,
      ],
      confidence: 0.82,
      nearbyFeatures: nearby,
    };
  }

  const ambiguousReasons: string[] = ["No qualifying base, hut, or high-mountain evidence at the route start."];
  if (!closestBaseSignal) {
    ambiguousReasons.push("No parking, trailhead, guidepost, settlement, or transit base-access marker within search radius.");
  }
  if (startElevationMeters === null && closestBaseSignal) {
    ambiguousReasons.push("Start elevation unknown — no deterministic elevation within evidence rules.");
  }
  if (closestBaseSignal && startElevationMeters !== null && verticalGainMeters === null) {
    ambiguousReasons.push("Summit elevation unknown — cannot compute vertical gain.");
  }
  if (closestBaseSignal && verticalGainMeters !== null && verticalGainMeters < options.minVerticalGainForBaseStartMeters) {
    ambiguousReasons.push(
      `Vertical gain (${Math.round(verticalGainMeters)} m) below threshold (${options.minVerticalGainForBaseStartMeters} m) for a definitive base ascent.`,
    );
  }
  return {
    type: "AMBIGUOUS_START",
    startElevationMeters,
    verticalGainMeters,
    startElevationSource: sourceType,
    reasons: [...ambiguousReasons, ...reasons],
    confidence: 0.4,
    nearbyFeatures: nearby,
  };
}

export async function loadPhase11f2FeatureIndexFromDir(
  dir: string,
): Promise<FeatureIndex> {
  return loadPhase11f2FeatureIndex(dir);
}
