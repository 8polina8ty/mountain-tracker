import { calculateGeometryLengthMeters } from "../../scripts/osm-import/route-geometry.ts";
import type { ComparableRoute } from "../../scripts/osm-import/route-similarity.ts";
import type { StartContextType } from "../../scripts/osm-import/start-context-classifier3.ts";
import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import {
  sha256DirectionNeutralGeometryHash,
  sha256GeometryHash,
  sha256Stable,
} from "./hashing.ts";
import type { ResolvedOsmAnchor, OsmAnchorResolution } from "./osmAnchorResolution.ts";
import {
  HIKING_COST_VERSION,
  type OsmTrailGraph,
  type OsmTrailGraphEdge,
} from "./osmTrailGraph.ts";
import type { RouteDiscoverySignal } from "./routeDiscovery.ts";
import type { Coordinate, NormalizedTrackGeometry } from "./types.ts";

export const OSM_ROUTE_SOLVER_VERSION =
  "mountain-tracker/osm-a-star-route-solver/v1" as const;
export const OSM_RECONSTRUCTED_ROUTE_SCHEMA_VERSION =
  "mountain-tracker/reconstructed-osm-route/v1" as const;

export type ReconstructionStatus =
  | "RECONSTRUCTED"
  | "NEEDS_REVIEW"
  | "ANCHOR_UNRESOLVED"
  | "NO_ROUTE";

export interface RouteSolverOptions {
  maximumAnchorSnapDistanceM: number;
  maximumSummitSnapDistanceM: number;
  maximumVisitedNodesPerLeg: number;
  maximumLegCost: number;
}

export const DEFAULT_ROUTE_SOLVER_OPTIONS: Readonly<RouteSolverOptions> = {
  maximumAnchorSnapDistanceM: 75,
  maximumSummitSnapDistanceM: 30,
  maximumVisitedNodesPerLeg: 100_000,
  maximumLegCost: 1_000_000,
};

export interface ResolvedRouteAnchors {
  start: OsmAnchorResolution;
  vias: OsmAnchorResolution[];
  summit: OsmAnchorResolution;
  terminal?: OsmAnchorResolution | null;
}

export interface ReconstructedAnchorRecord {
  role: "START" | "VIA" | "SUMMIT" | "TERMINAL";
  anchor: ResolvedOsmAnchor;
  snappedNodeId: number;
  snapDistanceM: number;
}

export interface ReconstructedOsmRoute {
  schemaVersion: typeof OSM_RECONSTRUCTED_ROUTE_SCHEMA_VERSION;
  solverVersion: typeof OSM_ROUTE_SOLVER_VERSION;
  graphVersion: OsmTrailGraph['contractVersion'];
  hikingCostVersion: typeof HIKING_COST_VERSION;
  discoverySignalId: string;
  reconstructionManifestHash: string;
  geometrySource: "OPENSTREETMAP";
  geometryLicense: "ODbL-1.0";
  attribution: "© OpenStreetMap contributors";
  discoveryProvenance: {
    sourceKey: string;
    sourceReference: string;
    role: "ROUTE_EXISTENCE_SIGNAL";
  };
  geometryProvenance: {
    sourceKey: "openstreetmap";
    role: "ROUTE_GEOMETRY";
    license: "ODbL-1.0";
    attribution: "© OpenStreetMap contributors";
    datasetIdentity: OsmTrailGraph["dataset"];
    graphHash: string;
  };
  resolvedAnchors: ReconstructedAnchorRecord[];
  osmWayIds: number[];
  osmNodeIds: number[];
  geometry: NormalizedTrackGeometry;
  distanceM: number;
  startContext: StartContextType;
  solverCost: number;
  snapDistancesM: number[];
  warnings: string[];
  routeShape: RouteDiscoverySignal["routeShapeHint"];
  returnSemantics: "NONE" | "SAME_PATH_REVERSE" | "CLOSED_LOOP" | "TRAVERSE_TERMINAL";
  reconstructionStatus: "RECONSTRUCTED" | "NEEDS_REVIEW";
  geometryHash: string;
  directionNeutralGeometryHash: string;
}

export type OsmRouteReconstructionResult =
  | {
      status: "RECONSTRUCTED" | "NEEDS_REVIEW";
      route: ReconstructedOsmRoute;
      reasons: string[];
    }
  | {
      status: "ANCHOR_UNRESOLVED" | "NO_ROUTE";
      route: null;
      reasons: string[];
    };

interface QueueEntry {
  nodeId: number;
  g: number;
  f: number;
}

class MinQueue {
  private readonly values: QueueEntry[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: QueueEntry): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareQueue(this.values[parent], this.values[index]) <= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  pop(): QueueEntry | null {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last) return first ?? null;
    if (this.values.length === 0) return first;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < this.values.length && compareQueue(this.values[left], this.values[best]) < 0) {
        best = left;
      }
      if (right < this.values.length && compareQueue(this.values[right], this.values[best]) < 0) {
        best = right;
      }
      if (best === index) break;
      [this.values[index], this.values[best]] = [this.values[best], this.values[index]];
      index = best;
    }
    return first;
  }
}

function compareQueue(left: QueueEntry, right: QueueEntry): number {
  return left.f - right.f || left.g - right.g || left.nodeId - right.nodeId;
}

export interface SolvedGraphPath {
  nodeIds: number[];
  edges: OsmTrailGraphEdge[];
  cost: number;
  visitedNodes: number;
}

// Observability only: excluded from route manifests and never consulted by A*.
export interface GraphSearchDiagnostics {
  visitedNodes: number;
  outcome: 'SOLVED' | 'EXHAUSTED' | 'SEARCH_LIMIT_EXCEEDED';
}

export function solveGraphPathAStar(
  graph: OsmTrailGraph,
  startNodeId: number,
  goalNodeId: number,
  options: Pick<RouteSolverOptions, "maximumVisitedNodesPerLeg" | "maximumLegCost"> =
    DEFAULT_ROUTE_SOLVER_OPTIONS,
  diagnostics?: GraphSearchDiagnostics,
): SolvedGraphPath | null {
  const start = graph.node(startNodeId);
  const goal = graph.node(goalNodeId);
  if (!start || !goal) throw new Error("A* endpoints must exist in the graph.");
  if (
    !Number.isSafeInteger(options.maximumVisitedNodesPerLeg) ||
    options.maximumVisitedNodesPerLeg < 1 ||
    options.maximumVisitedNodesPerLeg > 5_000_000
  ) {
    throw new Error("maximumVisitedNodesPerLeg is invalid.");
  }
  if (!Number.isFinite(options.maximumLegCost) || options.maximumLegCost <= 0) {
    throw new Error("maximumLegCost must be a positive finite value.");
  }
  if (startNodeId === goalNodeId) {
    if (diagnostics) Object.assign(diagnostics, { visitedNodes: 0, outcome: 'SOLVED' });
    return { nodeIds: [startNodeId], edges: [], cost: 0, visitedNodes: 0 };
  }

  const queue = new MinQueue();
  const scores = new Map<number, number>([[startNodeId, 0]]);
  const cameFrom = new Map<number, { previousNodeId: number; edge: OsmTrailGraphEdge }>();
  queue.push({
    nodeId: startNodeId,
    g: 0,
    f: calculateCoordinateDistanceMeters(start.coordinate, goal.coordinate),
  });
  let visitedNodes = 0;

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) break;
    if (current.g !== scores.get(current.nodeId)) continue;
    visitedNodes += 1;
    if (diagnostics) diagnostics.visitedNodes = visitedNodes;
    if (visitedNodes > options.maximumVisitedNodesPerLeg) {
      if (diagnostics) diagnostics.outcome = 'SEARCH_LIMIT_EXCEEDED';
      return null;
    }
    if (current.nodeId === goalNodeId) {
      if (diagnostics) diagnostics.outcome = 'SOLVED';
      const edges: OsmTrailGraphEdge[] = [];
      const nodeIds = [goalNodeId];
      let cursor = goalNodeId;
      while (cursor !== startNodeId) {
        const link = cameFrom.get(cursor);
        if (!link) throw new Error("A* predecessor chain is incomplete.");
        edges.push(link.edge);
        nodeIds.push(link.previousNodeId);
        cursor = link.previousNodeId;
      }
      return {
        nodeIds: nodeIds.reverse(),
        edges: edges.reverse(),
        cost: Math.round(current.g * 1_000) / 1_000,
        visitedNodes,
      };
    }

    for (const edge of graph.neighbors(current.nodeId)) {
      const tentative = current.g + edge.traversalCost;
      if (tentative > options.maximumLegCost) continue;
      const known = scores.get(edge.toNodeId);
      const previous = cameFrom.get(edge.toNodeId);
      const sameCostPreferredEdge =
        known !== undefined &&
        tentative === known &&
        previous !== undefined &&
        edge.edgeId.localeCompare(previous.edge.edgeId) < 0;
      if (known !== undefined && tentative > known) continue;
      if (known !== undefined && tentative === known && !sameCostPreferredEdge) continue;
      const target = graph.node(edge.toNodeId);
      if (!target) throw new Error("Graph edge references a missing target node.");
      scores.set(edge.toNodeId, tentative);
      cameFrom.set(edge.toNodeId, { previousNodeId: current.nodeId, edge });
      queue.push({
        nodeId: edge.toNodeId,
        g: tentative,
        f: tentative + calculateCoordinateDistanceMeters(target.coordinate, goal.coordinate),
      });
    }
  }
  if (diagnostics) diagnostics.outcome = 'EXHAUSTED';
  return null;
}

function requireResolved(
  resolution: OsmAnchorResolution | null | undefined,
  label: string,
): { anchor: ResolvedOsmAnchor | null; reason: string | null } {
  if (!resolution) return { anchor: null, reason: `${label}_MISSING` };
  if (resolution.status === "RESOLVED") return { anchor: resolution.anchor, reason: null };
  return { anchor: null, reason: `${label}_${resolution.status}` };
}

function validateOptions(options: RouteSolverOptions): void {
  for (const [key, value] of Object.entries({
    maximumAnchorSnapDistanceM: options.maximumAnchorSnapDistanceM,
    maximumSummitSnapDistanceM: options.maximumSummitSnapDistanceM,
  })) {
    if (!Number.isFinite(value) || value <= 0 || value > 5_000) {
      throw new Error(`${key} must be between zero and 5000.`);
    }
  }
  if (
    !Number.isSafeInteger(options.maximumVisitedNodesPerLeg) ||
    options.maximumVisitedNodesPerLeg < 1
  ) {
    throw new Error("maximumVisitedNodesPerLeg must be a positive integer.");
  }
  if (!Number.isFinite(options.maximumLegCost) || options.maximumLegCost <= 0) {
    throw new Error("maximumLegCost must be positive.");
  }
}

export function reconstructOsmRoute(input: {
  signal: RouteDiscoverySignal;
  anchors: ResolvedRouteAnchors;
  graph: OsmTrailGraph;
  startContext: StartContextType;
  options?: Partial<RouteSolverOptions>;
  diagnostics?: GraphSearchDiagnostics[];
}): OsmRouteReconstructionResult {
  const options = { ...DEFAULT_ROUTE_SOLVER_OPTIONS, ...input.options };
  validateOptions(options);
  if (input.anchors.vias.length !== input.signal.viaHints.length) {
    return { status: "ANCHOR_UNRESOLVED", route: null, reasons: ["VIA_COUNT_MISMATCH"] };
  }

  const requested: Array<{
    role: ReconstructedAnchorRecord["role"];
    resolution: OsmAnchorResolution | null | undefined;
  }> = [
    { role: "START", resolution: input.anchors.start },
    ...input.anchors.vias.map((resolution) => ({ role: "VIA" as const, resolution })),
    { role: "SUMMIT", resolution: input.anchors.summit },
  ];
  if (input.signal.routeShapeHint === "TRAVERSE") {
    requested.push({ role: "TERMINAL", resolution: input.anchors.terminal });
  } else if (input.signal.routeShapeHint === "LOOP" && input.anchors.terminal) {
    requested.push({ role: "TERMINAL", resolution: input.anchors.terminal });
  }

  const unresolved: string[] = [];
  const resolved: Array<{ role: ReconstructedAnchorRecord["role"]; anchor: ResolvedOsmAnchor }> = [];
  for (const item of requested) {
    const result = requireResolved(item.resolution, item.role);
    if (result.reason) unresolved.push(result.reason);
    if (result.anchor) resolved.push({ role: item.role, anchor: result.anchor });
  }
  if (unresolved.length > 0) {
    return { status: "ANCHOR_UNRESOLVED", route: null, reasons: unresolved };
  }
  if (input.signal.routeShapeHint === "TRAVERSE" && !input.signal.terminalHint) {
    return { status: "ANCHOR_UNRESOLVED", route: null, reasons: ["TRAVERSE_TERMINAL_HINT_MISSING"] };
  }

  if (input.signal.routeShapeHint === "LOOP" && !resolved.some((item) => item.role === "TERMINAL")) {
    resolved.push({ role: "TERMINAL", anchor: resolved[0].anchor });
  }

  const snapped: ReconstructedAnchorRecord[] = [];
  for (const item of resolved) {
    const maximumDistanceM =
      item.role === "SUMMIT"
        ? options.maximumSummitSnapDistanceM
        : options.maximumAnchorSnapDistanceM;
    const match = input.graph.findNearestNode(item.anchor.coordinate, maximumDistanceM);
    if (!match) {
      return {
        status: "NO_ROUTE",
        route: null,
        reasons: [`${item.role}_OUTSIDE_SNAP_THRESHOLD`],
      };
    }
    snapped.push({
      role: item.role,
      anchor: item.anchor,
      snappedNodeId: match.node.nodeId,
      snapDistanceM: match.distanceM,
    });
  }

  const allEdges: OsmTrailGraphEdge[] = [];
  const allNodeIds: number[] = [snapped[0].snappedNodeId];
  let solverCost = 0;
  for (let index = 1; index < snapped.length; index += 1) {
    const diagnostics: GraphSearchDiagnostics = { visitedNodes: 0, outcome: 'EXHAUSTED' };
    const path = solveGraphPathAStar(
      input.graph,
      snapped[index - 1].snappedNodeId,
      snapped[index].snappedNodeId,
      options,
      diagnostics,
    );
    input.diagnostics?.push(diagnostics);
    if (!path) {
      return {
        status: "NO_ROUTE",
        route: null,
        reasons: [`NO_SAFE_GRAPH_PATH_${snapped[index - 1].role}_TO_${snapped[index].role}`],
      };
    }
    allEdges.push(...path.edges);
    allNodeIds.push(...path.nodeIds.slice(1));
    solverCost += path.cost;
  }
  if (allEdges.length === 0 || allNodeIds.length < 2) {
    return { status: "NO_ROUTE", route: null, reasons: ["ROUTE_HAS_NO_GRAPH_EDGES"] };
  }

  const coordinates = allNodeIds.map((nodeId) => {
    const node = input.graph.node(nodeId);
    if (!node) throw new Error("Solved route references a missing graph node.");
    return [...node.coordinate] as Coordinate;
  });
  const geometry: NormalizedTrackGeometry = { type: "LineString", coordinates };
  const phase11Geometry = {
    type: "LineString" as const,
    coordinates: coordinates.map((coordinate) => [coordinate[0], coordinate[1]] as [number, number]),
  };
  const distanceM = Math.round(calculateGeometryLengthMeters(phase11Geometry) * 1_000) / 1_000;
  const warnings = [...new Set(allEdges.flatMap((edge) => edge.warnings))].sort();
  if (snapped.some((anchor) => anchor.snapDistanceM > 25)) warnings.push("ANCHOR_SNAP_OVER_25M");
  if (input.startContext === "HIGH_MOUNTAIN_START") warnings.push("HIGH_MOUNTAIN_START");
  if (input.startContext === "AMBIGUOUS_START") warnings.push("AMBIGUOUS_START");
  const reconstructionStatus = warnings.some((warning) =>
    ["HIGH_MOUNTAIN_START", "AMBIGUOUS_START"].includes(warning),
  )
    ? "NEEDS_REVIEW"
    : "RECONSTRUCTED";
  const returnSemantics =
    input.signal.routeShapeHint === "OUT_AND_BACK"
      ? "SAME_PATH_REVERSE"
      : input.signal.routeShapeHint === "LOOP"
        ? "CLOSED_LOOP"
        : input.signal.routeShapeHint === "TRAVERSE"
          ? "TRAVERSE_TERMINAL"
          : "NONE";
  const osmWayIds = [...new Set(allEdges.map((edge) => edge.wayId))];
  const manifest = {
    solverVersion: OSM_ROUTE_SOLVER_VERSION,
    graphVersion: input.graph.contractVersion,
    graphHash: input.graph.graphHash,
    hikingCostVersion: input.graph.costVersion,
    discoverySignalId: input.signal.signalId,
    routeShape: input.signal.routeShapeHint,
    anchors: snapped.map((entry) => ({
      role: entry.role,
      osmObjectType: entry.anchor.osmObjectType,
      osmId: entry.anchor.osmId,
      snappedNodeId: entry.snappedNodeId,
      snapDistanceM: entry.snapDistanceM,
    })),
    options,
  };
  const route: ReconstructedOsmRoute = {
    schemaVersion: OSM_RECONSTRUCTED_ROUTE_SCHEMA_VERSION,
    solverVersion: OSM_ROUTE_SOLVER_VERSION,
    graphVersion: input.graph.contractVersion,
    hikingCostVersion: input.graph.costVersion,
    discoverySignalId: input.signal.signalId,
    reconstructionManifestHash: sha256Stable(manifest),
    geometrySource: "OPENSTREETMAP",
    geometryLicense: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    discoveryProvenance: { ...input.signal.discoveryProvenance },
    geometryProvenance: {
      sourceKey: "openstreetmap",
      role: "ROUTE_GEOMETRY",
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      datasetIdentity: { ...input.graph.dataset },
      graphHash: input.graph.graphHash,
    },
    resolvedAnchors: snapped,
    osmWayIds,
    osmNodeIds: allNodeIds,
    geometry,
    distanceM,
    startContext: input.startContext,
    solverCost: Math.round(solverCost * 1_000) / 1_000,
    snapDistancesM: snapped.map((anchor) => anchor.snapDistanceM),
    warnings: [...new Set(warnings)].sort(),
    routeShape: input.signal.routeShapeHint,
    returnSemantics,
    reconstructionStatus,
    geometryHash: sha256GeometryHash(geometry),
    directionNeutralGeometryHash: sha256DirectionNeutralGeometryHash(geometry),
  };
  return { status: reconstructionStatus, route, reasons: route.warnings };
}

export function toPhase11ComparableRoute(
  route: ReconstructedOsmRoute,
  confirmedSummitId: string,
): ComparableRoute {
  return {
    sourceId: route.discoverySignalId,
    name: route.discoverySignalId,
    geometry: {
      type: "LineString",
      coordinates: route.geometry.coordinates.map(
        (coordinate) => [coordinate[0], coordinate[1]] as [number, number],
      ),
    },
    summitEvidence: {
      confirmedPeakIds: [confirmedSummitId],
      associatedPeakIds: [confirmedSummitId],
    },
  };
}
