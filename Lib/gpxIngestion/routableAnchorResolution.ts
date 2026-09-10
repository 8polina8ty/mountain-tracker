// Phase 12E routable anchor resolution with the ACCESS_CONNECTOR policy. A
// resolved semantic entity is projected onto the walkable graph either by an
// in-distance hop onto an included trail highway or, bounded and access-safe,
// onto a nearby pedestrian-accessible connector highway. Hard blocks survive:
// motorways, links, foot=no/private and ambiguous access never admit a
// connector.

import { calculateCoordinateDistanceMeters } from "./gpxNormalization.ts";
import type { Coordinate } from "./types.ts";
import {
  ADMITTED_CONNECTOR_HIGHWAYS,
  HARD_BLOCKED_CONNECTOR_HIGHWAYS,
  INCLUDED_TRAIL_HIGHWAYS,
  type OsmTrailWayInput,
  buildOsmTrailGraph,
  type OsmTrailGraph,
} from "./osmTrailGraph.ts";
import { evaluatePedestrianAccess } from "../../scripts/osm-import/phase11c9-road-safety.ts";

export const ROUTABLE_ANCHOR_RESOLUTION_VERSION =
  "mountain-tracker/routable-anchor-resolution/v2" as const;
export const ACCESS_CONNECTOR_POLICY_VERSION =
  "mountain-tracker/access-connector-policy/v2" as const;

export interface RoutableAnchorOptions {
  startSnapMeters?: number;
  connectorSearchRadiusMeters?: number;
}

export type RoutableAnchor =
  | {
      kind: "SNAP";
      nodeId: number;
      wayId: number;
      coordinate: Coordinate;
      distanceM: number;
      highway: string;
    }
  | {
      kind: "CONNECTOR";
      nodeId: number;
      wayId: number;
      coordinate: Coordinate;
      distanceM: number;
      highway: string;
      connectorWayCount: number;
    }
  | { kind: "UNROUTABLE"; reason: string };

export function connectorEligible(tags: Readonly<Record<string, string>>): boolean {
  const highwayKey = (tags.highway ?? "").trim().toLowerCase();
  if (!highwayKey) return false;
  if (!ADMITTED_CONNECTOR_HIGHWAYS.has(highwayKey)) return false;
  if (HARD_BLOCKED_CONNECTOR_HIGHWAYS.has(highwayKey)) return false;
  const access = evaluatePedestrianAccess({ ...tags });
  return access === "ALLOWED" && tags.smoothness?.trim().toLowerCase() !== 'impassable';
}

export function resolveRoutableAnchor(
  entityCoordinate: Coordinate,
  ways: readonly OsmTrailWayInput[],
  options: RoutableAnchorOptions = {},
): RoutableAnchor {
  const startSnapMeters = options.startSnapMeters ?? 75;
  const connectorSearchRadiusMeters = options.connectorSearchRadiusMeters ?? 400;
  if (
    !Number.isFinite(startSnapMeters) ||
    startSnapMeters <= 0 ||
    startSnapMeters > 5_000 ||
    !Number.isFinite(connectorSearchRadiusMeters) ||
    connectorSearchRadiusMeters <= 0 ||
    connectorSearchRadiusMeters > 5_000
  ) {
    throw new Error("Routable anchor bounds are invalid.");
  }
  let bestSnap: RoutableAnchor & { kind: "SNAP" } | null = null;
  let bestConnector: RoutableAnchor & { kind: "CONNECTOR" } | null = null;
  let connectorWayCount = 0;
  for (const way of [...ways].sort((left, right) => left.id - right.id)) {
    const highway = (way.tags.highway ?? "").trim().toLowerCase();
    if (!highway) continue;
    const isTrail = INCLUDED_TRAIL_HIGHWAYS.has(highway);
    if (isTrail && (['FORBIDDEN', 'AMBIGUOUS'].includes(evaluatePedestrianAccess({ ...way.tags })) ||
      way.tags.smoothness === 'impassable' || way.nodes.some(n => !n.coordinate))) continue;
    if (!isTrail) {
      if (!ADMITTED_CONNECTOR_HIGHWAYS.has(highway)) continue;
      if (!connectorEligible(way.tags)) continue;
    }
    const radius = isTrail ? startSnapMeters : connectorSearchRadiusMeters;
    for (const node of way.nodes) {
      if (!node.coordinate) continue;
      const distanceM = calculateCoordinateDistanceMeters(entityCoordinate, node.coordinate);
      if (distanceM > radius) continue;
      if (isTrail) {
        if (
          !bestSnap ||
          distanceM < bestSnap.distanceM ||
          (distanceM === bestSnap.distanceM && way.id < bestSnap.wayId) ||
          (distanceM === bestSnap.distanceM && way.id === bestSnap.wayId && node.nodeId < bestSnap.nodeId)
        ) {
          bestSnap = {
            kind: "SNAP",
            nodeId: node.nodeId,
            wayId: way.id,
            coordinate: node.coordinate,
            distanceM: Math.round(distanceM * 1_000) / 1_000,
            highway,
          };
        }
      } else {
        connectorWayCount += 1;
        if (
          !bestConnector ||
          distanceM < bestConnector.distanceM ||
          (distanceM === bestConnector.distanceM && way.id < bestConnector.wayId) ||
          (distanceM === bestConnector.distanceM && way.id === bestConnector.wayId && node.nodeId < bestConnector.nodeId)
        ) {
          bestConnector = {
            kind: "CONNECTOR",
            nodeId: node.nodeId,
            wayId: way.id,
            coordinate: node.coordinate,
            distanceM: Math.round(distanceM * 1_000) / 1_000,
            highway,
            connectorWayCount: 0,
          };
        }
      }
    }
  }
  if (bestSnap) return bestSnap;
  if (bestConnector) {
    return { kind: 'UNROUTABLE', reason: 'CONNECTOR_REQUIRES_TOPOLOGY_PROJECTION' };
  }
  return {
    kind: "UNROUTABLE",
    reason: bestSnap
      ? "SNAP_THRESHOLD"
      : connectorWayCount > 0
        ? "CONNECTOR_THRESHOLD"
        : "NO_WALKABLE_REGION",
  };
}

export const FEATURE_ACCESS_BOUNDS = {
  HUT: { snapM: 100, radiusM: 300, pathM: 300, roadM: 200 },
  TRAILHEAD: { snapM: 75, radiusM: 200, pathM: 200, roadM: 150 },
  PARKING: { snapM: 100, radiusM: 400, pathM: 400, roadM: 300 },
  TRANSIT: { snapM: 100, radiusM: 400, pathM: 400, roadM: 300 },
  SETTLEMENT: { snapM: 200, radiusM: 600, pathM: 600, roadM: 400 },
  ISOLATED_DWELLING: { snapM: 150, radiusM: 400, pathM: 400, roadM: 300 },
  OTHER: { snapM: 75, radiusM: 200, pathM: 200, roadM: 150 },
} as const;
export interface ResolvedRoutableAnchor {
  geometrySource: 'OPENSTREETMAP'; datasetSha256: string;
  status: 'RESOLVED' | 'UNROUTABLE';
  entityIdentity: { objectType: string; osmId: number };
  nodeId: number | null; coordinate: Coordinate | null;
  method: 'ENTITY_GRAPH_NODE' | 'BOUNDED_PROJECTION' | 'LOCAL_ACCESS_CONNECTOR' | null;
  snapDistanceM: number | null; pathLengthM: number; roadLengthM: number;
  connectorNodeIds: number[]; connectorCoordinates: Coordinate[]; connectorWayIds: number[];
  candidateCount: number; visitedNodes: number; reasons: string[];
  version: typeof ROUTABLE_ANCHOR_RESOLUTION_VERSION;
}
export function featureAccessFamily(tags: Readonly<Record<string, string>>): keyof typeof FEATURE_ACCESS_BOUNDS {
  if (['alpine_hut', 'wilderness_hut'].includes(tags.tourism)) return 'HUT';
  if (['isolated_dwelling', 'farm'].includes(tags.place)) return 'ISOLATED_DWELLING';
  if (tags.place) return 'SETTLEMENT';
  if (tags.amenity === 'parking') return 'PARKING';
  if (tags.railway || tags.highway === 'bus_stop' || tags.public_transport) return 'TRANSIT';
  if (tags.highway === 'trailhead' || tags.information === 'trailhead') return 'TRAILHEAD';
  return 'OTHER';
}

// Connectivity is to the independently confirmed summit, never to a reference route.
export function nodesReachingSummit(graph: OsmTrailGraph, summitNodeId: number): Set<number> {
  const reverse = new Map<number, number[]>();
  for (const edge of graph.edges) {
    const nodes = reverse.get(edge.toNodeId) ?? []; nodes.push(edge.fromNodeId); reverse.set(edge.toNodeId, nodes);
  }
  const seen = new Set([summitNodeId]), queue = [summitNodeId];
  for (let i = 0; i < queue.length; i++) for (const previous of reverse.get(queue[i]) ?? []) {
    if (!seen.has(previous)) { seen.add(previous); queue.push(previous); }
  }
  return seen;
}

export function projectRoutableAnchor(input: {
  entity: { osmObjectType: string; osmId: number; coordinate: Coordinate; tagsSubset: Readonly<Record<string, string>> };
  graph: OsmTrailGraph; ways: readonly OsmTrailWayInput[]; reachableNodes: ReadonlySet<number>;
  connectors: boolean;
}): ResolvedRoutableAnchor {
  const { entity, graph, ways, reachableNodes } = input;
  const bounds = FEATURE_ACCESS_BOUNDS[featureAccessFamily(entity.tagsSubset)];
  const result: ResolvedRoutableAnchor = { geometrySource: 'OPENSTREETMAP', datasetSha256: graph.dataset.pbfSha256,
    status: 'UNROUTABLE', entityIdentity: { objectType: entity.osmObjectType, osmId: entity.osmId },
    nodeId: null, coordinate: null, method: null, snapDistanceM: null, pathLengthM: 0, roadLengthM: 0,
    connectorNodeIds: [], connectorCoordinates: [], connectorWayIds: [], candidateCount: 0, visitedNodes: 0,
    reasons: [], version: ROUTABLE_ANCHOR_RESOLUTION_VERSION };
  const distance = (point: Coordinate) => calculateCoordinateDistanceMeters(entity.coordinate, point);
  const setResolved = (id: number, method: ResolvedRoutableAnchor['method'], snap: number) => {
    result.status = 'RESOLVED'; result.nodeId = id; result.coordinate = graph.node(id)!.coordinate;
    result.method = method; result.snapDistanceM = Math.round(snap * 1000) / 1000; return result;
  };
  if (entity.osmObjectType === 'node' && graph.node(entity.osmId) && reachableNodes.has(entity.osmId)) {
    return setResolved(entity.osmId, 'ENTITY_GRAPH_NODE', 0);
  }
  const candidates = [...graph.nodes.values()].filter(n => reachableNodes.has(n.nodeId))
    .map(n => ({ node: n, distance: distance(n.coordinate) })).filter(n => n.distance <= bounds.snapM)
    .sort((a, b) => a.distance - b.distance || a.node.nodeId - b.node.nodeId);
  result.candidateCount = candidates.length;
  if (candidates.length > 2000) { result.reasons.push('ANCHOR_CANDIDATE_LIMIT'); return result; }
  if (candidates[0]) return setResolved(candidates[0].node.nodeId, 'BOUNDED_PROJECTION', candidates[0].distance);
  if (!input.connectors) { result.reasons.push('NO_REACHABLE_TRAIL_WITHIN_FEATURE_BOUND'); return result; }
  const roads: OsmTrailWayInput[] = [];
  for (const way of ways) {
    if (INCLUDED_TRAIL_HIGHWAYS.has(way.tags.highway) || !connectorEligible(way.tags) || way.nodes.some(n => !n.coordinate)) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1], b = way.nodes[i];
      if (distance(a.coordinate!) <= bounds.radiusM && distance(b.coordinate!) <= bounds.radiusM) roads.push({ ...way, nodes: [a, b] });
    }
  }
  if (roads.length > 2000) { result.reasons.push('CONNECTOR_EDGE_LIMIT'); return result; }
  const local = buildOsmTrailGraph(graph.dataset, roads, { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS] });
  const starts = [...local.nodes.values()].map(n => ({ node: n, distance: distance(n.coordinate) }))
    .filter(n => n.distance <= 75).sort((a, b) => a.distance - b.distance || a.node.nodeId - b.node.nodeId);
  if (starts.length > 64) { result.reasons.push('CONNECTOR_START_CANDIDATE_LIMIT'); return result; }
  result.candidateCount += starts.length;
  type State = { id: number; length: number; snap: number; nodes: number[]; ways: number[] };
  const queue: State[] = starts.map(s => ({ id: s.node.nodeId, length: 0, snap: s.distance, nodes: [s.node.nodeId], ways: [] }));
  const best = new Map<number, number>();
  while (queue.length && result.visitedNodes < 10000) {
    queue.sort((a, b) => a.length + a.snap - b.length - b.snap || a.id - b.id);
    const state = queue.shift()!;
    if ((best.get(state.id) ?? Infinity) <= state.length + state.snap) continue;
    best.set(state.id, state.length + state.snap); result.visitedNodes++;
    if (reachableNodes.has(state.id) && graph.node(state.id) && state.nodes.length > 1) {
      result.connectorNodeIds = state.nodes; result.connectorCoordinates = state.nodes.map(id => local.node(id)!.coordinate);
      result.connectorWayIds = state.ways; result.pathLengthM = state.length; result.roadLengthM = state.length;
      return setResolved(state.id, 'LOCAL_ACCESS_CONNECTOR', state.snap);
    }
    for (const edge of local.neighbors(state.id)) {
      const length = state.length + edge.distanceM;
      if (length + state.snap <= bounds.pathM && length <= bounds.roadM && !state.nodes.includes(edge.toNodeId)) queue.push({ id: edge.toNodeId, length, snap: state.snap,
        nodes: [...state.nodes, edge.toNodeId], ways: [...state.ways, edge.wayId] });
    }
    if (queue.length > 20000) { result.reasons.push('CONNECTOR_QUEUE_LIMIT'); return result; }
  }
  result.reasons.push(result.visitedNodes >= 10000 ? 'CONNECTOR_SEARCH_LIMIT' : 'NO_BOUNDED_ACCESS_PATH_TO_TRAIL');
  return result;
}
