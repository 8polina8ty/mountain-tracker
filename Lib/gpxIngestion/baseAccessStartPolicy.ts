import { evaluatePedestrianAccess } from '../../scripts/osm-import/phase11c9-road-safety.ts';
import { calculateCoordinateDistanceMeters } from './gpxNormalization.ts';
import type { OsmTrailGraph, OsmTrailWayInput } from './osmTrailGraph.ts';

export const BASE_ACCESS_START_POLICY = Object.freeze({
  version: 'mountain-tracker/base-access-start-policy/v2',
  maximumApproachMeters: 150,
  minimumOutwardRoadMeters: 250,
  maximumVisitedNodes: 5000,
} as const);
export interface BaseAccessEvidence {
  policyVersion: typeof BASE_ACCESS_START_POLICY.version;
  candidateKind: string;
  publicRoadConnected: boolean; settlementConnected: boolean; parkingConnected: boolean;
  transitConnected: boolean; trailheadConnected: boolean; approachBoundary: boolean;
  accessNetworkDistance: number | null; startElevation: number | null; summitElevation: number | null;
  startNodeId: number; approachNodeIds: number[]; approachWayIds: number[];
  outwardRoadNodeIds: number[]; outwardRoadWayIds: number[];
  reasonCodes: string[];
}
const MAIN_ROADS = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary']);
const YES = new Set(['yes', 'designated', 'permissive']);
const normalized = (tags: Readonly<Record<string, string>>) => Object.fromEntries(
  Object.entries(tags).map(([k, v]) => [k, v.trim().toLowerCase()]));

/** Pedestrian permission alone does not establish legal vehicle/public access. */
export function publicApproachRoad(way: OsmTrailWayInput): boolean {
  const t = normalized(way.tags);
  if (['FORBIDDEN', 'AMBIGUOUS'].includes(evaluatePedestrianAccess(t)) || t.smoothness === 'impassable' ||
    Object.keys(t).some(k => k.endsWith(':conditional')) ||
    ['access', 'vehicle', 'motor_vehicle', 'motorcar'].some(k => t[k] && !YES.has(t[k]))) return false;
  return MAIN_ROADS.has(t.highway) ||
    (['service', 'track'].includes(t.highway) && YES.has(t.motorcar ?? t.motor_vehicle ?? t.vehicle ?? t.access));
}
export function primaryStartPriority(kind: string): number {
  if (kind === 'TRAILHEAD') return 0;
  if (kind === 'PARKING') return 1;
  if (['VILLAGE', 'HAMLET'].includes(kind)) return 2;
  if (['TRAIN_STATION', 'HALT', 'BUS_STOP'].includes(kind)) return 3;
  if (kind === 'PUBLIC_ROAD_END') return 4;
  if (['NETWORK_ACCESS', 'TRAILHEAD_INFO'].includes(kind)) return 5;
  return 99;
}
type Edge = { to: number; way: number; distance: number; main: boolean };
type Path = { id: number; distance: number; nodes: number[]; ways: number[]; main: boolean };

/** Exact OSM node topology only. No proximity links are added to either network. */
export class BaseAccessNetwork {
  private readonly roads = new Map<number, Edge[]>();
  private readonly witnesses = new Map<number, Path | null>();
  constructor(ways: readonly OsmTrailWayInput[]) {
    for (const w of [...ways].sort((a, b) => a.id - b.id)) {
      if (!publicApproachRoad(w) || w.nodes.some(n => !n.coordinate)) continue;
      for (let i = 1; i < w.nodes.length; i++) {
        const a = w.nodes[i - 1], b = w.nodes[i];
        const distance = calculateCoordinateDistanceMeters(a.coordinate!, b.coordinate!);
        if (!(distance > 0)) continue;
        for (const [from, to] of [[a.nodeId, b.nodeId], [b.nodeId, a.nodeId]]) {
          const edges = this.roads.get(from) ?? [];
          edges.push({ to, way: w.id, distance, main: MAIN_ROADS.has(w.tags.highway) });
          this.roads.set(from, edges);
        }
      }
    }
  }
  private outward(start: number): Path | null {
    if (this.witnesses.has(start)) return this.witnesses.get(start)!;
    const queue: Path[] = [{ id: start, distance: 0, nodes: [start], ways: [], main: false }];
    const seen = new Set<number>();
    let witness: Path | null = null;
    while (queue.length && seen.size < BASE_ACCESS_START_POLICY.maximumVisitedNodes) {
      queue.sort((a, b) => a.distance - b.distance || a.id - b.id);
      const p = queue.shift()!;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.main && p.distance >= BASE_ACCESS_START_POLICY.minimumOutwardRoadMeters) { witness = p; break; }
      for (const e of this.roads.get(p.id) ?? []) if (!seen.has(e.to)) queue.push({
        id: e.to, distance: p.distance + e.distance, nodes: [...p.nodes, e.to], ways: [...p.ways, e.way], main: p.main || e.main,
      });
    }
    this.witnesses.set(start, witness); return witness;
  }
  evaluate(input: { kind: string; tags: Record<string, string>; nodeId: number; graph: OsmTrailGraph;
    startElevation?: number | null; summitElevation?: number | null }): BaseAccessEvidence {
    const { kind, tags, nodeId, graph } = input;
    const evidence: BaseAccessEvidence = {
      policyVersion: BASE_ACCESS_START_POLICY.version, candidateKind: kind,
      publicRoadConnected: false, settlementConnected: false, parkingConnected: false,
      transitConnected: false, trailheadConnected: false, approachBoundary: false,
      accessNetworkDistance: null, startElevation: input.startElevation ?? null, summitElevation: input.summitElevation ?? null,
      startNodeId: nodeId, approachNodeIds: [], approachWayIds: [], outwardRoadNodeIds: [], outwardRoadWayIds: [], reasonCodes: [],
    };
    const reject = (reason: string) => { evidence.reasonCodes.push(reason); return evidence; };
    if (/HUT|REFUGE/.test(kind) || ['alpine_hut', 'wilderness_hut', 'refuge'].includes(tags.tourism)) return reject('HUT_SECONDARY_ONLY');
    if (primaryStartPriority(kind) === 99) return reject('NO_PRIMARY_START_SEMANTICS');
    if (['FORBIDDEN', 'AMBIGUOUS'].includes(evaluatePedestrianAccess(tags)) || (tags.access && !YES.has(tags.access))) return reject('RESTRICTED_START');
    const maximum = ['NETWORK_ACCESS', 'TRAILHEAD_INFO', 'PUBLIC_ROAD_END'].includes(kind) ? 0 :
      kind === 'TRAILHEAD' ? 30 : BASE_ACCESS_START_POLICY.maximumApproachMeters;
    const queue: Path[] = [{ id: nodeId, distance: 0, nodes: [nodeId], ways: [], main: false }];
    const seen = new Set<number>();
    while (queue.length && seen.size < BASE_ACCESS_START_POLICY.maximumVisitedNodes) {
      queue.sort((a, b) => a.distance - b.distance || a.id - b.id);
      const p = queue.shift()!;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const outward = this.roads.has(p.id) ? this.outward(p.id) : null;
      if (outward) {
        evidence.publicRoadConnected = true;
        evidence.settlementConnected = ['VILLAGE', 'HAMLET'].includes(kind);
        evidence.parkingConnected = kind === 'PARKING';
        evidence.transitConnected = ['TRAIN_STATION', 'HALT', 'BUS_STOP'].includes(kind);
        evidence.trailheadConnected = kind === 'TRAILHEAD';
        evidence.approachBoundary = maximum === 0;
        evidence.accessNetworkDistance = Math.round(p.distance * 1000) / 1000;
        evidence.approachNodeIds = p.nodes; evidence.approachWayIds = p.ways;
        evidence.outwardRoadNodeIds = outward.nodes; evidence.outwardRoadWayIds = outward.ways;
        evidence.reasonCodes.push('EXACT_OSM_ACCESS_TOPOLOGY', 'OUTWARD_PUBLIC_ROAD_NETWORK', 'PRIMARY_BASE_ACCESS');
        return evidence;
      }
      for (const e of graph.neighbors(p.id)) {
        if (p.distance + e.distanceM > maximum || seen.has(e.toNodeId) ||
          ['FORBIDDEN', 'AMBIGUOUS'].includes(evaluatePedestrianAccess({ ...e.tagsSubset })) ||
          (e.tagsSubset.access && !YES.has(e.tagsSubset.access)) ||
          (e.tagsSubset.sac_scale && e.tagsSubset.sac_scale !== 'hiking')) continue;
        queue.push({ id: e.toNodeId, distance: p.distance + e.distanceM, nodes: [...p.nodes, e.toNodeId],
          ways: [...p.ways, e.wayId], main: false });
      }
    }
    return reject(seen.size >= BASE_ACCESS_START_POLICY.maximumVisitedNodes ? 'ACCESS_SEARCH_LIMIT' : 'NO_EXTERNAL_PUBLIC_ACCESS');
  }
}

export function primaryBaseAccess(e: BaseAccessEvidence | null | undefined): boolean {
  return e?.policyVersion === BASE_ACCESS_START_POLICY.version && primaryStartPriority(e.candidateKind) < 99 &&
    e.publicRoadConnected === true && e.accessNetworkDistance !== null && Number.isFinite(e.accessNetworkDistance) &&
    e.accessNetworkDistance >= 0 && e.accessNetworkDistance <= BASE_ACCESS_START_POLICY.maximumApproachMeters &&
    e.approachNodeIds[0] === e.startNodeId && e.outwardRoadNodeIds.length > 1 && e.outwardRoadWayIds.length > 0 &&
    e.reasonCodes.includes('PRIMARY_BASE_ACCESS');
}
