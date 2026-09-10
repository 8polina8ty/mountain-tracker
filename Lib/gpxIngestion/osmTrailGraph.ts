import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import { sha256Stable } from "./hashing.ts";
import type { Coordinate } from "./types.ts";
import { evaluatePedestrianAccess } from "../../scripts/osm-import/phase11c9-road-safety.ts";

export const OSM_TRAIL_GRAPH_CONTRACT_VERSION =
  "mountain-tracker/osm-trail-graph/v1" as const;
export const HIKING_COST_VERSION = "mountain-tracker/hiking-cost/v1" as const;
export const LOCAL_CONNECTOR_GRAPH_VERSION = 'mountain-tracker/local-access-graph/v2' as const;

export interface OsmTrailDatasetIdentity {
  datasetKey: string;
  region: string;
  snapshotTimestamp: string;
  pbfSha256: string;
}

export interface OsmTrailWayNodeInput {
  nodeId: number;
  coordinate: Coordinate | null;
}

export interface OsmTrailWayInput {
  id: number;
  tags: Readonly<Record<string, string>>;
  nodes: readonly OsmTrailWayNodeInput[];
}

export type TrailWayExclusionReason =
  | "MOTORWAY"
  | "MOTORWAY_LINK"
  | "UNSUPPORTED_HIGHWAY"
  | "FOOT_FORBIDDEN"
  | "ACCESS_FORBIDDEN"
  | "ACCESS_AMBIGUOUS"
  | "IMPASSABLE"
  | "BROKEN_GEOMETRY"
  | "TOO_FEW_NODES";

export interface TrailWayExclusion {
  wayId: number;
  reason: TrailWayExclusionReason;
}

export interface OsmTrailGraphNode {
  nodeId: number;
  coordinate: Coordinate;
}

export interface OsmTrailGraphEdge {
  edgeId: string;
  wayId: number;
  fromNodeId: number;
  toNodeId: number;
  distanceM: number;
  traversalCost: number;
  costMultiplier: number;
  tagsSubset: Readonly<Record<string, string>>;
  warnings: string[];
  connector?: true;
}

export interface HikingCostEvaluation {
  multiplier: number;
  warnings: string[];
}

export const INCLUDED_TRAIL_HIGHWAYS = new Set(["path", "footway", "steps", "track"]);

export const ADMITTED_CONNECTOR_HIGHWAYS = new Set([
  "path",
  "footway",
  "steps",
  "track",
  "pedestrian",
  "residential",
  "living_street",
  "service",
  "unclassified",
]);

export const HARD_BLOCKED_CONNECTOR_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
]);

export const CONNECTOR_COST_MULTIPLIER = 1.15 as const;
export const CONNECTOR_HIGHWAY_WARNING = "ACCESS_CONNECTOR" as const;
const INCLUDED_HIGHWAYS = INCLUDED_TRAIL_HIGHWAYS;
const GRAPH_TAG_KEYS = [
  "highway",
  "foot",
  "access",
  "access:conditional",
  "foot:conditional",
  "motor_vehicle",
  "vehicle",
  "sac_scale",
  "trail_visibility",
  "surface",
  "smoothness",
  "tracktype",
  "bridge",
  "tunnel",
  "layer",
  "oneway:foot",
  "conveying",
] as const;

const HIGHWAY_COST: Readonly<Record<string, number>> = {
  path: 1,
  footway: 1.03,
  steps: 1.18,
  track: 1.12,
};

const SAC_COST: Readonly<Record<string, number>> = {
  hiking: 1,
  mountain_hiking: 1.02,
  demanding_mountain_hiking: 1.05,
  alpine_hiking: 1.1,
  demanding_alpine_hiking: 1.14,
  difficult_alpine_hiking: 1.18,
};

const VISIBILITY_COST: Readonly<Record<string, number>> = {
  excellent: 1,
  good: 1.01,
  intermediate: 1.04,
  bad: 1.08,
  horrible: 1.12,
  no: 1.16,
};

const SURFACE_COST: Readonly<Record<string, number>> = {
  asphalt: 1.12,
  concrete: 1.1,
  paved: 1.1,
  paving_stones: 1.08,
  compacted: 1.04,
  fine_gravel: 1.04,
  gravel: 1.03,
  ground: 1,
  dirt: 1,
  earth: 1,
  grass: 1.02,
  rock: 1.04,
  stone: 1.04,
  scree: 1.08,
};

const SMOOTHNESS_COST: Readonly<Record<string, number>> = {
  excellent: 1,
  good: 1,
  intermediate: 1.01,
  bad: 1.03,
  very_bad: 1.05,
  horrible: 1.08,
  very_horrible: 1.1,
  impassable: 1.15,
};

function normalizedTag(tags: Readonly<Record<string, string>>, key: string): string | null {
  const value = tags[key]?.normalize("NFKC").trim().toLowerCase();
  return value || null;
}

function round(value: number, digits = 6): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function tagsSubset(tags: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    GRAPH_TAG_KEYS.flatMap((key) => {
      const value = normalizedTag(tags, key);
      return value ? [[key, value] as const] : [];
    }),
  );
}

export function evaluateHikingCost(
  tags: Readonly<Record<string, string>>,
): HikingCostEvaluation {
  const highway = normalizedTag(tags, "highway");
  if (!highway || !INCLUDED_HIGHWAYS.has(highway)) {
    throw new Error("Hiking cost may only be evaluated for an included trail highway.");
  }
  const warnings: string[] = [];
  let multiplier = HIGHWAY_COST[highway];
  const apply = (
    key: string,
    table: Readonly<Record<string, number>>,
    unknownWarning: string,
  ) => {
    const value = normalizedTag(tags, key);
    if (!value) return;
    const factor = table[value];
    if (factor === undefined) {
      warnings.push(unknownWarning);
      return;
    }
    multiplier *= factor;
  };
  apply("sac_scale", SAC_COST, "UNKNOWN_SAC_SCALE");
  apply("trail_visibility", VISIBILITY_COST, "UNKNOWN_TRAIL_VISIBILITY");
  apply("surface", SURFACE_COST, "UNKNOWN_SURFACE");
  apply("smoothness", SMOOTHNESS_COST, "UNKNOWN_SMOOTHNESS");
  if (["yes", "designated", "permissive"].includes(normalizedTag(tags, "motor_vehicle") ?? "")) {
    multiplier *= 1.08;
    warnings.push("MOTOR_VEHICLE_EXPOSURE");
  } else if (["yes", "designated", "permissive"].includes(normalizedTag(tags, "vehicle") ?? "")) {
    multiplier *= 1.05;
    warnings.push("VEHICLE_EXPOSURE");
  }
  return { multiplier: round(multiplier), warnings: [...new Set(warnings)].sort() };
}

export function evaluateConnectorCost(tags: Readonly<Record<string, string>>): HikingCostEvaluation {
  const highway = normalizedTag(tags, "highway");
  if (!highway || INCLUDED_HIGHWAYS.has(highway) || !ADMITTED_CONNECTOR_HIGHWAYS.has(highway)) {
    throw new Error("Connector cost may only be evaluated for an admitted connector highway.");
  }
  const warnings: string[] = [CONNECTOR_HIGHWAY_WARNING];
  let multiplier = CONNECTOR_COST_MULTIPLIER;
  const apply = (
    key: string,
    table: Readonly<Record<string, number>>,
    unknownWarning: string,
  ) => {
    const value = normalizedTag(tags, key);
    if (!value) return;
    const factor = table[value];
    if (factor === undefined) {
      warnings.push(unknownWarning);
      return;
    }
    multiplier *= factor;
  };
  apply("surface", SURFACE_COST, "UNKNOWN_SURFACE");
  apply("smoothness", SMOOTHNESS_COST, "UNKNOWN_SMOOTHNESS");
  if (["yes", "designated", "permissive"].includes(normalizedTag(tags, "motor_vehicle") ?? "")) {
    multiplier *= 1.08;
    warnings.push("MOTOR_VEHICLE_EXPOSURE");
  } else if (["yes", "designated", "permissive"].includes(normalizedTag(tags, "vehicle") ?? "")) {
    multiplier *= 1.05;
    warnings.push("VEHICLE_EXPOSURE");
  }
  return { multiplier: round(multiplier), warnings: [...new Set(warnings)].sort() };
}

function exclusionReason(
  way: OsmTrailWayInput,
  connectorHighways: ReadonlySet<string>,
): TrailWayExclusionReason | null {
  const highway = normalizedTag(way.tags, "highway");
  if (highway === "motorway") return "MOTORWAY";
  if (highway === "motorway_link") return "MOTORWAY_LINK";
  const isIncluded = highway !== null && INCLUDED_HIGHWAYS.has(highway);
  const isConnector = highway !== null && connectorHighways.has(highway);
  if (!isIncluded && !isConnector) return "UNSUPPORTED_HIGHWAY";
  const access = evaluatePedestrianAccess({ ...way.tags });
  if (access === "FORBIDDEN") {
    return normalizedTag(way.tags, "foot") === "no" ? "FOOT_FORBIDDEN" : "ACCESS_FORBIDDEN";
  }
  if (access === "AMBIGUOUS") return "ACCESS_AMBIGUOUS";
  if (isConnector && !isIncluded && access !== 'ALLOWED') return 'ACCESS_AMBIGUOUS';
  if (normalizedTag(way.tags, "smoothness") === "impassable") return "IMPASSABLE";
  if (way.nodes.length < 2) return "TOO_FEW_NODES";
  if (way.nodes.some((node) => node.coordinate === null)) return "BROKEN_GEOMETRY";
  return null;
}

function assertNode(node: OsmTrailWayNodeInput): asserts node is {
  nodeId: number;
  coordinate: Coordinate;
} {
  if (!Number.isSafeInteger(node.nodeId) || node.nodeId <= 0 || node.coordinate === null) {
    throw new Error("OSM trail nodes require positive IDs and coordinates.");
  }
  const [longitude, latitude] = node.coordinate;
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error("OSM trail node coordinate is invalid.");
  }
}

function datasetIdentity(input: OsmTrailDatasetIdentity): OsmTrailDatasetIdentity {
  if (!/^[a-f0-9]{64}$/.test(input.pbfSha256)) {
    throw new Error("Dataset pbfSha256 must be a lowercase SHA-256 hash.");
  }
  const timestamp = new Date(input.snapshotTimestamp);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.snapshotTimestamp) {
    throw new Error("Dataset snapshotTimestamp must be canonical ISO-8601 UTC.");
  }
  for (const [key, value] of Object.entries({ datasetKey: input.datasetKey, region: input.region })) {
    if (!value.trim() || value.length > 160) throw new Error(`${key} is invalid.`);
  }
  return { ...input };
}

interface MetricPoint {
  x: number;
  y: number;
  z: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;

function metricPoint(coordinate: Coordinate): MetricPoint {
  const longitude = (coordinate[0] * Math.PI) / 180;
  const latitude = (coordinate[1] * Math.PI) / 180;
  const latitudeRadius = EARTH_RADIUS_METERS * Math.cos(latitude);
  return {
    x: latitudeRadius * Math.cos(longitude),
    y: latitudeRadius * Math.sin(longitude),
    z: EARTH_RADIUS_METERS * Math.sin(latitude),
  };
}

export interface SnappedGraphNode {
  node: OsmTrailGraphNode;
  distanceM: number;
}

export class OsmTrailGraph {
  readonly contractVersion: typeof OSM_TRAIL_GRAPH_CONTRACT_VERSION | typeof LOCAL_CONNECTOR_GRAPH_VERSION;
  readonly costVersion = HIKING_COST_VERSION;
  readonly dataset: OsmTrailDatasetIdentity;
  readonly graphHash: string;
  readonly exclusions: readonly TrailWayExclusion[];
  readonly nodes: ReadonlyMap<number, OsmTrailGraphNode>;
  readonly edges: readonly OsmTrailGraphEdge[];
  private readonly adjacency = new Map<number, OsmTrailGraphEdge[]>();
  private readonly spatialCells = new Map<string, Array<{ node: OsmTrailGraphNode; point: MetricPoint }>>();
  private readonly cellSizeMeters = 250;

  constructor(input: {
    dataset: OsmTrailDatasetIdentity;
    nodes: OsmTrailGraphNode[];
    edges: OsmTrailGraphEdge[];
    exclusions: TrailWayExclusion[];
  }) {
    this.contractVersion = input.edges.some(e => e.connector) ? LOCAL_CONNECTOR_GRAPH_VERSION : OSM_TRAIL_GRAPH_CONTRACT_VERSION;
    this.dataset = datasetIdentity(input.dataset);
    const sortedNodes = [...input.nodes].sort((left, right) => left.nodeId - right.nodeId);
    this.nodes = new Map(sortedNodes.map((node) => [node.nodeId, node]));
    this.edges = [...input.edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    this.exclusions = [...input.exclusions].sort(
      (left, right) => left.wayId - right.wayId || left.reason.localeCompare(right.reason),
    );
    for (const edge of this.edges) {
      const list = this.adjacency.get(edge.fromNodeId);
      if (list) list.push(edge);
      else this.adjacency.set(edge.fromNodeId, [edge]);
    }
    for (const list of this.adjacency.values()) {
      list.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    }
    for (const node of sortedNodes) {
      const point = metricPoint(node.coordinate);
      const key = this.spatialKey(point);
      const cell = this.spatialCells.get(key);
      if (cell) cell.push({ node, point });
      else this.spatialCells.set(key, [{ node, point }]);
    }
    this.graphHash = sha256Stable({
      contractVersion: this.contractVersion,
      costVersion: this.costVersion,
      dataset: this.dataset,
      nodes: sortedNodes,
      edges: this.edges,
      exclusions: this.exclusions,
    });
  }

  neighbors(nodeId: number): readonly OsmTrailGraphEdge[] {
    return this.adjacency.get(nodeId) ?? [];
  }

  node(nodeId: number): OsmTrailGraphNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSizeMeters);
  }

  private spatialKey(point: MetricPoint): string {
    return `${this.cell(point.x)}:${this.cell(point.y)}:${this.cell(point.z)}`;
  }

  findNearestNode(coordinate: Coordinate, maximumDistanceM: number): SnappedGraphNode | null {
    if (!Number.isFinite(maximumDistanceM) || maximumDistanceM <= 0 || maximumDistanceM > 5_000) {
      throw new Error("maximumDistanceM must be between zero and 5000.");
    }
    const point = metricPoint(coordinate);
    const center = [this.cell(point.x), this.cell(point.y), this.cell(point.z)];
    const cellRadius = Math.ceil(maximumDistanceM / this.cellSizeMeters);
    let best: SnappedGraphNode | null = null;
    for (let x = -cellRadius; x <= cellRadius; x += 1) {
      for (let y = -cellRadius; y <= cellRadius; y += 1) {
        for (let z = -cellRadius; z <= cellRadius; z += 1) {
          const cell = this.spatialCells.get(
            `${center[0] + x}:${center[1] + y}:${center[2] + z}`,
          );
          for (const candidate of cell ?? []) {
            const distanceM = calculateCoordinateDistanceMeters(coordinate, candidate.node.coordinate);
            if (
              distanceM <= maximumDistanceM &&
              (!best ||
                distanceM < best.distanceM ||
                (distanceM === best.distanceM && candidate.node.nodeId < best.node.nodeId))
            ) {
              best = { node: candidate.node, distanceM: round(distanceM, 3) };
            }
          }
        }
      }
    }
    return best;
  }
}

export interface BuildOsmTrailGraphOptions {
  maximumWays?: number;
  maximumNodes?: number;
  connectorHighways?: readonly string[];
}

export function buildOsmTrailGraph(
  dataset: OsmTrailDatasetIdentity,
  ways: readonly OsmTrailWayInput[],
  options: BuildOsmTrailGraphOptions = {},
): OsmTrailGraph {
  const maximumWays = options.maximumWays ?? 1_000_000;
  const maximumNodes = options.maximumNodes ?? 10_000_000;
  if (ways.length > maximumWays) throw new Error("OSM graph way input exceeded its bound.");
  const connectorHighways = new Set(
    (options.connectorHighways ?? []).map((highway) => highway.trim().toLowerCase()),
  );
  for (const highway of connectorHighways) {
    if (!ADMITTED_CONNECTOR_HIGHWAYS.has(highway)) {
      throw new Error(`Connector highway is not admitted by the contract: ${highway}`);
    }
  }
  const nodes = new Map<number, OsmTrailGraphNode>();
  const edges: OsmTrailGraphEdge[] = [];
  const exclusions: TrailWayExclusion[] = [];

  for (const way of [...ways].sort((left, right) => left.id - right.id)) {
    if (!Number.isSafeInteger(way.id) || way.id <= 0) throw new Error("OSM way IDs must be positive.");
    const excluded = exclusionReason(way, connectorHighways);
    if (excluded) {
      exclusions.push({ wayId: way.id, reason: excluded });
      continue;
    }
    const highway = normalizedTag(way.tags, "highway") ?? "";
    const isConnector = !INCLUDED_HIGHWAYS.has(highway);
    const cost = isConnector ? evaluateConnectorCost(way.tags) : evaluateHikingCost(way.tags);
    const subset = tagsSubset(way.tags);
    const direction = normalizedTag(way.tags, "oneway:foot");
    const conveying = normalizedTag(way.tags, "conveying");
    const forwardOnly = direction === "yes" || conveying === "forward";
    const backwardOnly = direction === "-1" || conveying === "backward";

    const completeNodes = way.nodes.map((node) => {
      assertNode(node);
      return node;
    });
    for (const node of completeNodes) {
      const existing = nodes.get(node.nodeId);
      if (
        existing &&
        calculateCoordinateDistanceMeters(existing.coordinate, node.coordinate) > 0.1
      ) {
        throw new Error(`OSM node ${node.nodeId} has conflicting coordinates.`);
      }
      nodes.set(node.nodeId, { nodeId: node.nodeId, coordinate: [...node.coordinate] as Coordinate });
      if (nodes.size > maximumNodes) throw new Error("OSM graph node input exceeded its bound.");
    }
    for (let index = 1; index < completeNodes.length; index += 1) {
      const from = completeNodes[index - 1];
      const to = completeNodes[index];
      const distanceM = calculateCoordinateDistanceMeters(from.coordinate, to.coordinate);
      if (distanceM <= 0) continue;
      const makeEdge = (
        edgeFrom: number,
        edgeTo: number,
        directionCode: "f" | "b",
      ): OsmTrailGraphEdge => ({
        edgeId: `${way.id}:${index - 1}:${edgeFrom}:${edgeTo}:${directionCode}`,
        wayId: way.id,
        fromNodeId: edgeFrom,
        toNodeId: edgeTo,
        distanceM: round(distanceM, 3),
        traversalCost: round(distanceM * cost.multiplier, 3),
        costMultiplier: cost.multiplier,
        tagsSubset: subset,
        warnings: cost.warnings,
        connector: isConnector ? true : undefined,
      });
      if (!backwardOnly) edges.push(makeEdge(from.nodeId, to.nodeId, "f"));
      if (!forwardOnly) edges.push(makeEdge(to.nodeId, from.nodeId, "b"));
    }
  }

  return new OsmTrailGraph({ dataset, nodes: [...nodes.values()], edges, exclusions });
}
