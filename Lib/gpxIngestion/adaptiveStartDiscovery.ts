import assert from 'node:assert/strict';
import { classifyStartContextV2, type StartContextEvidence } from '../../scripts/osm-import/start-context-classifier3.ts';
import { analyzeRouteRoadSafety, evaluatePedestrianAccess, type RoadSafetySourceDatasetIdentity, type RoadSafetyStatus, type RoadSafetyWay } from '../../scripts/osm-import/phase11c9-road-safety.ts';
import { compareRoutes } from '../../scripts/osm-import/route-similarity.ts';
import { AdaptiveStartFeatureIndex, type AdaptiveStartFeature } from './adaptiveStartFeatures.ts';
import { calculateCoordinateDistanceMeters } from './gpxNormalization.ts';
import { sha256Stable } from './hashing.ts';
import { OSM_ANCHOR_RESOLUTION_VERSION, type OsmAnchorResolution } from './osmAnchorResolution.ts';
import { reconstructOsmRoute, toPhase11ComparableRoute, type ReconstructedOsmRoute, type GraphSearchDiagnostics } from './osmRouteReconstruction.ts';
import { type OsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';
import { buildSummitAttachment, DEFAULT_SUMMIT_ATTACHMENT_POLICY, summitAutoEligible, validateSummitAttachmentPolicy, SUMMIT_ATTACHMENT_REASON_REVIEW, type SummitAttachment, type SummitAttachmentPolicy } from './summitAttachment.ts';
import { FEATURE_ACCESS_BOUNDS, featureAccessFamily, nodesReachingSummit, projectRoutableAnchor, type ResolvedRoutableAnchor } from './routableAnchorResolution.ts';
import { createRouteDiscoverySignal, type SemanticAnchorType } from './routeDiscovery.ts';
import type { Coordinate } from './types.ts';
import { BASE_ACCESS_START_POLICY, BaseAccessNetwork, primaryBaseAccess, primaryStartPriority, publicApproachRoad, type BaseAccessEvidence } from './baseAccessStartPolicy.ts';

export const ADAPTIVE_START_DISCOVERY_VERSION = 'mountain-tracker/adaptive-start-discovery/v1' as const;
export interface AdaptiveStartDiscoveryPolicy {
  version: 'mountain-tracker/base-access-start-policy/v2';
  radiusTiersMeters: readonly number[];
  seriousCandidatesPerTier: readonly number[];
  maximumSeriousCandidates: number;
  maximumNetworkCandidates: number;
  maximumReturnedCandidates: number;
  maximumScreenedPerTier: number;
  earlyExitSafeCandidates: number;
  earlyExitDiverseCandidates: number;
  remoteApproachMeters: number;
  maximumReasonableNetworkMeters: number;
  maximumVisitedNodesPerLeg: number;
}
export const DEFAULT_ADAPTIVE_START_POLICY: Readonly<AdaptiveStartDiscoveryPolicy> = Object.freeze({
  version: BASE_ACCESS_START_POLICY.version,
  radiusTiersMeters: Object.freeze([10_000, 20_000, 35_000, 50_000]),
  seriousCandidatesPerTier: Object.freeze([8, 4, 2, 2]),
  maximumSeriousCandidates: 20, maximumNetworkCandidates: 4, maximumReturnedCandidates: 10,
  maximumScreenedPerTier: 200, earlyExitSafeCandidates: 3, earlyExitDiverseCandidates: 2,
  remoteApproachMeters: 20_000,
  // One-way multi-day alpine approach: allow 25–40+ km, review beyond 100 km.
  maximumReasonableNetworkMeters: 100_000, maximumVisitedNodesPerLeg: 100_000,
});
export interface AdaptiveStartDiscoveryRequest {
  summit: { id: string; name: string; coordinate: Coordinate; elevationMeters?: number | null; osmId?: number };
  mountainIdentity?: string;
  regionName?: string;
  countryCode?: string;
  summitAttachmentPolicy?: SummitAttachmentPolicy;
}
export type AdaptiveStartKind = AdaptiveStartFeature['kind'] | 'NETWORK_ACCESS';
export type AdaptiveRouteCategory = 'STANDARD_ASCENT' | 'HUT_ASCENT' | 'REMOTE_APPROACH';
export type AdaptiveStartOutcome = 'STARTS_FOUND' | 'REMOTE_ACCESS_FOUND' | 'NO_SUMMIT_CONNECTION' | 'NO_ROUTABLE_START' |
  'ONLY_HIGH_MOUNTAIN_STARTS' | 'ONLY_AMBIGUOUS_STARTS' | 'NO_REASONABLE_START' | 'NEEDS_REVIEW';
export interface NetworkAccessEvidence {
  junctionNodeId: number;
  mountainTrailWayIds: number[];
  approachWays: { wayId: number; highway: string; accessTags: Record<string, string> }[];
  coordinate: Coordinate;
  elevationMeters: number | null;
  networkDistanceMeters: number | null;
}
export interface AdaptiveStartCandidate {
  startRole: 'PRIMARY_BASE_ACCESS' | null;
  accessEvidence: BaseAccessEvidence | null;
  id: string; name: string; kind: AdaptiveStartKind;
  osmIdentity: { objectType: 'node' | 'way' | 'relation'; osmId: number };
  coordinate: Coordinate; tags: Record<string, string>;
  radiusTier: number | 'NETWORK_ACCESS'; airDistanceMeters: number;
  anchor: ResolvedRoutableAnchor | null;
  networkDistanceMeters: number | null; routeDistanceMeters: number | null;
  elevationGainMeters: number | null; elevationGainSource: 'COMPLETE_ROUTE_OSM_ELEVATIONS' | null;
  verticalGainMeters: number | null;
  solverStatus: string; startContext: StartContextEvidence | null;
  safety: RoadSafetyStatus | 'NOT_EVALUATED'; safetyReasons: string[];
  autoEligible: boolean; category: AdaptiveRouteCategory | null;
  reasons: string[]; duplicateOf: string | null; similarityToBetter: string | null;
  networkAccess: NetworkAccessEvidence | null;
  route: ReconstructedOsmRoute | null;
}
export interface AdaptiveStartDiscoveryResult {
  version: typeof ADAPTIVE_START_DISCOVERY_VERSION;
  request: AdaptiveStartDiscoveryRequest; policy: AdaptiveStartDiscoveryPolicy; policyHash: string;
  datasetSha256: string; graphHash: string; resultHash: string;
  status: AdaptiveStartOutcome; reasons: string[]; candidates: AdaptiveStartCandidate[]; evaluated: AdaptiveStartCandidate[];
  summitAttachment: SummitAttachment | null;
  tiersVisited: number[]; fallbackInspected: boolean; seriousCandidates: number; solverCalls: number;
  discoveredFeatures: number; screenedFeatures: number; screeningTruncated: boolean;
  rejections: { motorway: number; footNo: number; privateForbidden: number; accessAmbiguous: number; highMountain: number; ambiguous: number; disconnected: number };
  fabricatedGapCount: number; componentCacheHit: boolean;
  timings: { totalMs: number; componentMs: number; routeMs: number };
  publishable: false;
}

/** Caller owns graph lifetime/cache; one session serves many summits on this graph. */
export class AdaptiveStartDiscoverySession {
  readonly graph: OsmTrailGraph;
  readonly ways: readonly OsmTrailWayInput[];
  readonly features: AdaptiveStartFeatureIndex;
  readonly safetyIdentity: RoadSafetySourceDatasetIdentity;
  private readonly componentCache = new Map<number, Set<number>>();
  private readonly undirected: boolean;
  private readonly wayById: Map<number, OsmTrailWayInput>;
  private readonly motorwayWays: RoadSafetyWay[];
  private readonly networkAccess: NetworkAccessEvidence[];
  readonly baseAccess: BaseAccessNetwork;

  constructor(input: { graph: OsmTrailGraph; ways: readonly OsmTrailWayInput[]; features: AdaptiveStartFeatureIndex; safetyIdentity: RoadSafetySourceDatasetIdentity }) {
    this.graph = input.graph; this.ways = input.ways; this.features = input.features; this.safetyIdentity = input.safetyIdentity;
    this.wayById = new Map(input.ways.map(way => [way.id, way]));
    this.undirected = !input.ways.some(way => ['yes', '-1'].includes(way.tags['oneway:foot']) || ['forward', 'backward'].includes(way.tags.conveying));
    this.motorwayWays = input.ways.filter(way => ['motorway', 'motorway_link'].includes(way.tags.highway) && way.nodes.every(n => n.coordinate))
      .map(way => ({ id: way.id, tags: { ...way.tags }, nodes: way.nodes.map(n => ({ nodeId: n.nodeId, coordinate: pair(n.coordinate!) })) }));
    this.networkAccess = this.indexNetworkAccess();
    this.baseAccess = new BaseAccessNetwork(input.ways);
  }

  private indexNetworkAccess(): NetworkAccessEvidence[] {
    const mountainWays = new Map<number, Set<number>>();
    for (const edge of this.graph.edges) if (['path', 'footway', 'steps'].includes(edge.tagsSubset.highway)) {
      for (const id of [edge.fromNodeId, edge.toNodeId]) {
        const ids = mountainWays.get(id) ?? new Set<number>(); ids.add(edge.wayId); mountainWays.set(id, ids);
      }
    }
    const junctions = new Map<number, NetworkAccessEvidence>();
    for (const way of [...this.ways].sort((a, b) => a.id - b.id)) {
      if (!['track', 'service', 'unclassified', 'residential', 'living_street', 'pedestrian'].includes(way.tags.highway) ||
        !(publicApproachRoad(way) || evaluatePedestrianAccess({ ...way.tags }) === 'ALLOWED') || way.tags.smoothness === 'impassable' ||
        way.nodes.length < 2 || way.nodes.some(n => !n.coordinate)) continue;
      for (let i = 0; i < way.nodes.length; i++) {
        const n = way.nodes[i], trails = mountainWays.get(n.nodeId);
        if (!trails?.size || !this.graph.node(n.nodeId) ||
          ![way.nodes[i - 1], way.nodes[i + 1]].some(other => other && calculateCoordinateDistanceMeters(n.coordinate!, other.coordinate!) > 0)) continue;
        const found = junctions.get(n.nodeId) ?? { junctionNodeId: n.nodeId, mountainTrailWayIds: [...trails].sort((a, b) => a - b),
          approachWays: [], coordinate: n.coordinate!, elevationMeters: null, networkDistanceMeters: null };
        if (!found.approachWays.some(w => w.wayId === way.id)) found.approachWays.push({ wayId: way.id, highway: way.tags.highway, accessTags: { ...way.tags } });
        junctions.set(n.nodeId, found);
      }
    }
    return [...junctions.values()].sort((a, b) => a.junctionNodeId - b.junctionNodeId);
  }

  discover(request: AdaptiveStartDiscoveryRequest, policy: AdaptiveStartDiscoveryPolicy = DEFAULT_ADAPTIVE_START_POLICY): AdaptiveStartDiscoveryResult {
    return discover(this, request, policy);
  }

  reachable(summitNodeId: number): { nodes: ReadonlySet<number>; cacheHit: boolean } {
    const cached = this.componentCache.get(summitNodeId);
    if (cached) return { nodes: cached, cacheHit: true };
    const nodes = nodesReachingSummit(this.graph, summitNodeId);
    if (this.undirected) for (const id of nodes) this.componentCache.set(id, nodes);
    else this.componentCache.set(summitNodeId, nodes);
    return { nodes, cacheHit: false };
  }

  networkStarts(coordinate: Coordinate, reachable: ReadonlySet<number>, radius: number): NetworkAccessEvidence[] {
    return this.networkAccess.filter(n => reachable.has(n.junctionNodeId) && calculateCoordinateDistanceMeters(coordinate, n.coordinate) <= radius);
  }

  routeSafety(route: ReconstructedOsmRoute) {
    const routeWays: RoadSafetyWay[] = route.osmNodeIds.slice(1).map((to, i) => {
      const from = route.osmNodeIds[i];
      const edge = this.graph.neighbors(from).find(e => e.toNodeId === to && route.osmWayIds.includes(e.wayId));
      assert(edge, 'NO_FABRICATED_GAP: every traversed pair must be an admitted OSM edge');
      const source = this.wayById.get(edge.wayId); assert(source, 'MISSING_OSM_WAY_PROVENANCE');
      return { id: source.id, tags: { ...source.tags }, nodes: [from, to].map(nodeId => ({ nodeId, coordinate: pair(this.graph.node(nodeId)!.coordinate) })) };
    });
    const points = routeWays.flatMap(w => w.nodes.map(n => n.coordinate));
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
    // Whole-way bounding boxes retain segments crossing the route box even when
    // both motorway endpoints lie outside it. The existing crossing gate follows.
    const nearbyMotorwayWays = this.motorwayWays.filter(w => {
      let lowX = Infinity, highX = -Infinity, lowY = Infinity, highY = -Infinity;
      for (const n of w.nodes) { lowX = Math.min(lowX, n.coordinate[0]); highX = Math.max(highX, n.coordinate[0]);
        lowY = Math.min(lowY, n.coordinate[1]); highY = Math.max(highY, n.coordinate[1]); }
      return lowX <= maxX && highX >= minX && lowY <= maxY && highY >= minY;
    });
    return analyzeRouteRoadSafety({ canonicalRelationId: route.discoverySignalId, stagingRouteId: 'offline-only', routeType: 'hiking',
      routeWays, nearbyMotorwayWays, sourceDatasetIdentity: this.safetyIdentity });
  }
}

function pair(coordinate: Coordinate): [number, number] { return [coordinate[0], coordinate[1]]; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }

// Implementation below deliberately calls the unchanged Phase12 solver and Phase11 final gates.
const FEATURE_QUALITY: Record<AdaptiveStartKind, number> = {
  TRAILHEAD: 0, PARKING: 1, ALPINE_HUT: 1, WILDERNESS_HUT: 2, TRAILHEAD_INFO: 2,
  VILLAGE: 3, HAMLET: 3, TRAIN_STATION: 3, HALT: 3, BUS_STOP: 4,
  ISOLATED_DWELLING: 5, FARM: 5, NETWORK_ACCESS: 6,
};
function semanticType(kind: AdaptiveStartKind): SemanticAnchorType {
  if (kind.includes('HUT')) return 'HUT';
  if (kind === 'PARKING') return 'PARKING';
  if (kind.startsWith('TRAILHEAD')) return 'TRAILHEAD';
  if (['VILLAGE', 'HAMLET', 'ISOLATED_DWELLING', 'FARM'].includes(kind)) return 'SETTLEMENT';
  return kind === 'NETWORK_ACCESS' ? 'JUNCTION' : 'OTHER_NAMED_FEATURE';
}
function anchor(id: number, name: string, coordinate: Coordinate, type: SemanticAnchorType, tags: Record<string, string>): OsmAnchorResolution {
  const resolved = { resolutionVersion: OSM_ANCHOR_RESOLUTION_VERSION, anchorType: type,
    osmObjectType: 'node' as const, osmId: id, name, coordinate, tagsSubset: tags,
    resolutionConfidence: 1, resolutionEvidence: ['INDEPENDENT_OSM_IDENTITY', 'SUMMIT_CONNECTED_GRAPH_PROJECTION'], geometrySource: 'OPENSTREETMAP' as const };
  return { status: 'RESOLVED', anchor: resolved, candidates: [resolved] };
}
function makeCandidate(feature: AdaptiveStartFeature, summit: Coordinate, tier: number | 'NETWORK_ACCESS', network: NetworkAccessEvidence | null = null): AdaptiveStartCandidate {
  return { id: feature.identity, name: feature.name || `${network ? 'Network access' : feature.kind} ${feature.identity}`,
    kind: network ? 'NETWORK_ACCESS' : feature.kind, osmIdentity: { objectType: feature.objectType, osmId: feature.osmId },
    coordinate: feature.coordinate, tags: feature.tags, radiusTier: tier,
    airDistanceMeters: round(calculateCoordinateDistanceMeters(summit, feature.coordinate)),
    anchor: null, networkDistanceMeters: null, routeDistanceMeters: null, elevationGainMeters: null,
    elevationGainSource: null, verticalGainMeters: null, solverStatus: 'NOT_EVALUATED', startContext: null,
    safety: 'NOT_EVALUATED', safetyReasons: [], autoEligible: false, category: null, reasons: [], startRole: null, accessEvidence: null,
    duplicateOf: null, similarityToBetter: null, networkAccess: network ? { ...network, approachWays: [...network.approachWays] } : null, route: null };
}

/** Safety precedes quality; length is the actual network route, never discovery radius. */
export function compareAdaptiveStartCandidates(a: AdaptiveStartCandidate, b: AdaptiveStartCandidate): number {
  const score = (c: AdaptiveStartCandidate) => (c.networkDistanceMeters ?? 1_000_000) + primaryStartPriority(c.kind) * 750 +
    (c.anchor?.snapDistanceM ?? 1000) * 10 + (c.elevationGainMeters ?? 0) * 0.1 +
    (evaluatePedestrianAccess(c.tags) === 'ALLOWED' ? 0 : 250);
  return Number(b.autoEligible) - Number(a.autoEligible) || Number(Boolean(a.duplicateOf)) - Number(Boolean(b.duplicateOf)) ||
    Number(b.route !== null) - Number(a.route !== null) || score(a) - score(b) || a.id.localeCompare(b.id);
}

function validate(request: AdaptiveStartDiscoveryRequest, policy: AdaptiveStartDiscoveryPolicy) {
  const s = request.summit;
  if (!s || !s.id?.trim() || !s.name?.trim() || !Array.isArray(s.coordinate) ||
    !Number.isFinite(s.coordinate[0]) || Math.abs(s.coordinate[0]) > 180 ||
    !Number.isFinite(s.coordinate[1]) || Math.abs(s.coordinate[1]) > 90 ||
    (s.elevationMeters != null && !Number.isFinite(s.elevationMeters))) throw new TypeError('INVALID_SUMMIT_REQUEST');
  if (Object.keys(request).some(key => !['summit', 'mountainIdentity', 'regionName', 'countryCode', 'summitAttachmentPolicy'].includes(key)) ||
    Object.keys(s).some(key => !['id', 'name', 'coordinate', 'elevationMeters', 'osmId'].includes(key))) throw new TypeError('SUMMIT_ONLY_INPUT_CONTRACT');
  if (request.summitAttachmentPolicy !== undefined) validateSummitAttachmentPolicy(request.summitAttachmentPolicy);
  if (!policy.radiusTiersMeters.length || policy.radiusTiersMeters.length !== policy.seriousCandidatesPerTier.length ||
    policy.radiusTiersMeters.some((r, i) => !Number.isFinite(r) || r <= (policy.radiusTiersMeters[i - 1] ?? 0) || r > 50_000) ||
    policy.seriousCandidatesPerTier.some(n => !Number.isSafeInteger(n) || n < 1) ||
    !Number.isSafeInteger(policy.maximumSeriousCandidates) || policy.maximumSeriousCandidates < 1 || policy.maximumSeriousCandidates > 20 ||
    !Number.isSafeInteger(policy.maximumNetworkCandidates) || policy.maximumNetworkCandidates < 1 ||
    !Number.isSafeInteger(policy.maximumReturnedCandidates) || policy.maximumReturnedCandidates < 1 || policy.maximumReturnedCandidates > 10 ||
    !Number.isSafeInteger(policy.maximumScreenedPerTier) || policy.maximumScreenedPerTier < 1 || policy.maximumScreenedPerTier > 1000 ||
    !Number.isFinite(policy.maximumReasonableNetworkMeters) || policy.maximumReasonableNetworkMeters <= 20_000 || policy.maximumReasonableNetworkMeters > 100_000 ||
    !Number.isSafeInteger(policy.maximumVisitedNodesPerLeg) || policy.maximumVisitedNodesPerLeg < 1 || policy.maximumVisitedNodesPerLeg > 100_000 ||
    !Number.isFinite(policy.remoteApproachMeters) || policy.remoteApproachMeters <= 0 ||
    !Number.isSafeInteger(policy.earlyExitSafeCandidates) || policy.earlyExitSafeCandidates < 1 ||
    !Number.isSafeInteger(policy.earlyExitDiverseCandidates) || policy.earlyExitDiverseCandidates < 1) throw new TypeError('INVALID_ADAPTIVE_POLICY');
}

function discover(session: AdaptiveStartDiscoverySession, request: AdaptiveStartDiscoveryRequest, policy: AdaptiveStartDiscoveryPolicy): AdaptiveStartDiscoveryResult {
  validate(request, policy);
  const started = performance.now(), { graph, features } = session, summit = request.summit;
  const result: AdaptiveStartDiscoveryResult = { version: ADAPTIVE_START_DISCOVERY_VERSION, request, policy, policyHash: sha256Stable(policy),
    datasetSha256: graph.dataset.pbfSha256, graphHash: graph.graphHash, resultHash: '', status: 'NO_ROUTABLE_START', reasons: [],
    candidates: [], evaluated: [], summitAttachment: null, tiersVisited: [], fallbackInspected: false, seriousCandidates: 0, solverCalls: 0,
    discoveredFeatures: 0, screenedFeatures: 0, screeningTruncated: false,
    rejections: { motorway: 0, footNo: 0, privateForbidden: 0, accessAmbiguous: 0, highMountain: 0, ambiguous: 0, disconnected: 0 },
    fabricatedGapCount: 0, componentCacheHit: false, timings: { totalMs: 0, componentMs: 0, routeMs: 0 }, publishable: false };
  // Graph exclusions are graph-level evidence; pilot aggregates them once per graph, not per summit.
  const finish = () => {
    result.evaluated.sort(compareAdaptiveStartCandidates);
    result.timings.totalMs = round(performance.now() - started);
    result.resultHash = sha256Stable({ ...result, timings: undefined, componentCacheHit: undefined, resultHash: undefined });
    return result;
  };
  const attachmentPolicy = request.summitAttachmentPolicy ?? null;
  const maximumSummitSnapDistanceM = attachmentPolicy ? attachmentPolicy.reviewMeters : 30;
  const snappedSummit = graph.findNearestNode(summit.coordinate, maximumSummitSnapDistanceM);
  if (!snappedSummit) {
    result.status = 'NO_SUMMIT_CONNECTION';
    result.reasons.push(attachmentPolicy ? 'NO_ELIGIBLE_GRAPH_NODE_WITHIN_ATTACHMENT_REVIEW_BOUND' : 'NO_ELIGIBLE_GRAPH_NODE_WITHIN_30M');
    return finish();
  }
  const summitAttachment = buildSummitAttachment({ targetCoordinate: summit.coordinate,
    routeTerminalCoordinate: snappedSummit.node.coordinate, distanceMeters: snappedSummit.distanceM,
    policy: attachmentPolicy ?? DEFAULT_SUMMIT_ATTACHMENT_POLICY });
  result.summitAttachment = summitAttachment;
  const summitEligible = summitAutoEligible(summitAttachment.tier);
  if (summitAttachment.tier === 'NONE') {
    result.status = 'NO_SUMMIT_CONNECTION'; result.reasons.push(...summitAttachment.reasonCodes); return finish();
  }
  const componentStarted = performance.now(), component = session.reachable(snappedSummit.node.nodeId);
  result.componentCacheHit = component.cacheHit; result.timings.componentMs = round(performance.now() - componentStarted);
  const seen = new Set<string>(), comparisons = new Map<string, string>();
  const context = (coordinate: Coordinate) => classifyStartContextV2(pair(coordinate), pair(summit.coordinate), summit.elevationMeters ?? null, features.contextAt(coordinate));
  const accessAt = (candidate: AdaptiveStartCandidate) => {
    if (!candidate.anchor) {
      const exact = candidate.osmIdentity.objectType === 'node' ? graph.node(candidate.osmIdentity.osmId) : null;
      const nearest = exact ?? graph.findNearestNode(candidate.coordinate, 1)?.node;
      if (!nearest || !component.nodes.has(nearest.nodeId)) return null;
      candidate.anchor = projectRoutableAnchor({ entity: { osmObjectType: 'node', osmId: nearest.nodeId,
        coordinate: candidate.coordinate, tagsSubset: candidate.tags }, graph, ways: session.ways, reachableNodes: component.nodes, connectors: false });
      candidate.anchor.entityIdentity = candidate.osmIdentity;
      candidate.anchor.snapDistanceM = round(calculateCoordinateDistanceMeters(candidate.coordinate, nearest.coordinate));
      if (!exact) candidate.anchor.method = 'BOUNDED_PROJECTION';
    }
    candidate.anchor ??= projectRoutableAnchor({ entity: { osmObjectType: candidate.osmIdentity.objectType, osmId: candidate.osmIdentity.osmId,
      coordinate: candidate.coordinate, tagsSubset: candidate.tags }, graph, ways: session.ways, reachableNodes: component.nodes, connectors: false });
    if (candidate.anchor.status !== 'RESOLVED') return null;
    const n = graph.node(candidate.anchor.nodeId!)!;
    const evidence = session.baseAccess.evaluate({ kind: candidate.kind, tags: candidate.tags, nodeId: n.nodeId, graph,
      startElevation: context(n.coordinate).startElevationMeters, summitElevation: summit.elevationMeters });
    // A detached POI projection is not proof of a connector or shared OSM identity.
    const identityConnected = candidate.osmIdentity.objectType === 'node' && candidate.osmIdentity.osmId === n.nodeId ||
      candidate.osmIdentity.objectType === 'way' && session.ways.some(w => w.id === candidate.osmIdentity.osmId && w.nodes.some(p => p.nodeId === n.nodeId));
    if (!identityConnected && candidate.anchor.snapDistanceM! > 1) {
      evidence.publicRoadConnected = false; evidence.reasonCodes = ['START_TOPOLOGY_UNPROVEN'];
    }
    return evidence;
  };

  const evaluate = (candidate: AdaptiveStartCandidate) => {
    result.seriousCandidates++; result.evaluated.push(candidate);
    const access = evaluatePedestrianAccess(candidate.tags), foot = candidate.tags.foot?.trim().toLowerCase();
    if (['motorway', 'motorway_link'].includes(candidate.tags.highway)) {
      result.rejections.motorway++; candidate.safety = 'BLOCKED'; candidate.reasons.push('START_MOTORWAY'); return;
    }
    if (access === 'FORBIDDEN' || access === 'AMBIGUOUS') {
      if (foot === 'no') result.rejections.footNo++;
      else if (access === 'FORBIDDEN') result.rejections.privateForbidden++;
      else result.rejections.accessAmbiguous++;
      candidate.safety = access === 'FORBIDDEN' ? 'BLOCKED' : 'MANUAL_REVIEW_REQUIRED'; candidate.reasons.push(`START_ACCESS_${access}`); return;
    }
    candidate.anchor ??= projectRoutableAnchor({ entity: { osmObjectType: candidate.osmIdentity.objectType, osmId: candidate.osmIdentity.osmId,
      coordinate: candidate.coordinate, tagsSubset: candidate.tags }, graph, ways: session.ways, reachableNodes: component.nodes, connectors: false });
    if (candidate.anchor.status !== 'RESOLVED') {
      candidate.solverStatus = 'ANCHOR_UNRESOLVED'; candidate.reasons.push(...candidate.anchor.reasons);
      result.rejections.disconnected++; return;
    }
    const startNode = graph.node(candidate.anchor.nodeId!)!;
    const initialContext = context(startNode.coordinate);
    candidate.accessEvidence ??= accessAt(candidate);
    const signal = createRouteDiscoverySignal({ signalId: `adaptive:${sha256Stable({ summit: summit.id, start: candidate.id }).slice(0, 32)}`,
      sourceKey: 'openstreetmap', sourceReference: `osm:${candidate.id}`, observedAt: graph.dataset.snapshotTimestamp,
      mountainIdentity: { name: summit.name.slice(0, 160), regionName: request.regionName ?? null, countryCode: request.countryCode ?? null },
      routeVariantName: null, activityType: 'HIKING', startHint: { name: candidate.name.slice(0, 160), expectedTypes: [semanticType(candidate.kind)], regionName: request.regionName ?? null },
      viaHints: [], summitHint: { name: summit.name.slice(0, 160), expectedTypes: ['SUMMIT'], regionName: request.regionName ?? null }, terminalHint: null,
      routeShapeHint: 'ONE_WAY', directionHint: 'ascent', sourcePolicyStatus: 'ALLOWED', signalConfidence: 1 });
    const diagnostics: GraphSearchDiagnostics[] = [], routeStarted = performance.now();
    const solved = reconstructOsmRoute({ signal, graph, anchors: { start: anchor(startNode.nodeId, candidate.name, startNode.coordinate, semanticType(candidate.kind), candidate.tags),
      summit: anchor(summit.osmId ?? snappedSummit.node.nodeId, summit.name, summit.coordinate, 'SUMMIT', { natural: 'peak' }), vias: [] },
      startContext: initialContext.type === 'AMBIGUOUS_START' && primaryBaseAccess(candidate.accessEvidence) ? 'BASE_START' : initialContext.type,
      options: { maximumVisitedNodesPerLeg: policy.maximumVisitedNodesPerLeg, maximumSummitSnapDistanceM }, diagnostics });
    result.solverCalls++; result.timings.routeMs += performance.now() - routeStarted;
    candidate.solverStatus = solved.status; candidate.reasons.push(...solved.reasons);
    if (!solved.route) { candidate.reasons.push(...diagnostics.map(d => d.outcome)); return; }
    candidate.route = solved.route; candidate.networkDistanceMeters = solved.route.distanceM; candidate.routeDistanceMeters = solved.route.distanceM;
    // Final authority runs after reconstruction on the actual first geometry point, not a semantic centroid.
    candidate.startContext = context(graph.node(solved.route.osmNodeIds[0])!.coordinate);
    candidate.verticalGainMeters = candidate.startContext.verticalGainMeters;
    const coordinates = solved.route.osmNodeIds.map(id => graph.node(id)!.coordinate);
    if (coordinates.every(c => c.length === 3 && Number.isFinite(c[2]))) {
      candidate.elevationGainMeters = round(coordinates.slice(1).reduce((total, c, i) => total + Math.max(0, c[2]! - coordinates[i][2]!), 0));
      candidate.elevationGainSource = 'COMPLETE_ROUTE_OSM_ELEVATIONS';
    }
    if (candidate.networkAccess) {
      candidate.networkAccess.elevationMeters = candidate.startContext.startElevationMeters;
      candidate.networkAccess.networkDistanceMeters = solved.route.distanceM;
    }
    const safety = session.routeSafety(solved.route);
    candidate.safety = safety.status; candidate.safetyReasons = safety.reasonCodes;
    candidate.reasons.push(...safety.reasonCodes);
    if (candidate.startContext.type === 'HIGH_MOUNTAIN_START') { result.rejections.highMountain++; candidate.reasons.push('START_HIGH_MOUNTAIN'); }
    if (candidate.startContext.type === 'AMBIGUOUS_START') { result.rejections.ambiguous++; candidate.reasons.push('START_AMBIGUOUS'); }
    if (solved.route.distanceM > policy.maximumReasonableNetworkMeters) candidate.reasons.push('NETWORK_DISTANCE_SANITY_CEILING');
    const baseAccess = primaryBaseAccess(candidate.accessEvidence) && !['HUT_START', 'HIGH_MOUNTAIN_START'].includes(candidate.startContext.type);
    candidate.startRole = baseAccess ? 'PRIMARY_BASE_ACCESS' : null;
    candidate.reasons.push(...(candidate.accessEvidence?.reasonCodes ?? ['NO_EXTERNAL_PUBLIC_ACCESS']));
    candidate.autoEligible = summitEligible && baseAccess && solved.status === 'RECONSTRUCTED' &&
      safety.status === 'SAFE' && !safety.reasonCodes.length && solved.route.distanceM <= policy.maximumReasonableNetworkMeters;
    candidate.category = candidate.kind === 'NETWORK_ACCESS' || solved.route.distanceM > policy.remoteApproachMeters ? 'REMOTE_APPROACH' :
      candidate.startContext.type === 'HUT_START' ? 'HUT_ASCENT' : 'STANDARD_ASCENT';
    if (candidate.autoEligible) candidate.reasons.push('SAFE_CONNECTED_OSM_ROUTE');
  };

  const classifyPair = (a: AdaptiveStartCandidate, b: AdaptiveStartCandidate): string => {
    const key = [a.id, b.id].sort().join('|'), cached = comparisons.get(key);
    if (cached) return cached;
    const classification = compareRoutes(toPhase11ComparableRoute(a.route!, summit.id), toPhase11ComparableRoute(b.route!, summit.id)).classification;
    comparisons.set(key, classification); return classification;
  };
  const rank = () => {
    const selected: AdaptiveStartCandidate[] = [];
    for (const c of result.evaluated) { c.duplicateOf = null; c.similarityToBetter = null; }
    const safe = result.evaluated.filter(c => c.autoEligible).sort(compareAdaptiveStartCandidates);
    for (const c of safe) {
      c.duplicateOf = null; c.similarityToBetter = null;
      const duplicate = selected.find(better => ['EXACT_DUPLICATE', 'NEAR_DUPLICATE'].includes(classifyPair(c, better)));
      if (duplicate) { c.duplicateOf = duplicate.id; c.similarityToBetter = classifyPair(c, duplicate); }
      else selected.push(c);
    }
    result.candidates = selected.slice(0, policy.maximumReturnedCandidates);
    return selected.length >= policy.earlyExitSafeCandidates &&
      (policy.earlyExitDiverseCandidates === 1 || selected.some((a, i) => selected.slice(i + 1).some(b => classifyPair(a, b) === 'DIFFERENT_VARIANT')));
  };
  const select = (pool: AdaptiveStartCandidate[], limit: number): AdaptiveStartCandidate[] => {
    // Preliminary context is a ranking hint only; the post-route classifier remains the gate.
    const scored = pool.map(candidate => {
      const c = context(candidate.coordinate), permission = evaluatePedestrianAccess(candidate.tags);
      const nearest = graph.findNearestNode(candidate.coordinate, FEATURE_ACCESS_BOUNDS[featureAccessFamily(candidate.tags)].snapM);
      candidate.accessEvidence = accessAt(candidate);
      const score = (permission === 'FORBIDDEN' || permission === 'AMBIGUOUS' ? 100_000_000 : 0) +
        (primaryBaseAccess(candidate.accessEvidence) ? 0 : 50_000_000) + primaryStartPriority(candidate.kind) * 100_000 +
        (nearest && component.nodes.has(nearest.node.nodeId) ? 0 : 10_000_000) +
        (['BASE_START', 'HUT_START'].includes(c.type) ? 0 : c.type === 'HIGH_MOUNTAIN_START' ? 2_000_000 : 1_000_000) +
        FEATURE_QUALITY[candidate.kind] * 750 + candidate.airDistanceMeters;
      return { candidate, score, sector: Math.floor((Math.atan2(candidate.coordinate[1] - summit.coordinate[1],
        (candidate.coordinate[0] - summit.coordinate[0]) * Math.cos(summit.coordinate[1] * Math.PI / 180)) + Math.PI) / (Math.PI / 4)) % 8 };
    }).sort((a, b) => a.score - b.score || a.candidate.id.localeCompare(b.candidate.id));
    // Small diversity preference within the same connectivity/context quality band, then stable score.
    const selected: AdaptiveStartCandidate[] = [], sectors = new Set<number>();
    while (scored.length && selected.length < limit) {
      const best = scored[0], different = scored.findIndex(c => !sectors.has(c.sector) && c.score <= best.score + 3000);
      const chosen = scored.splice(different < 0 ? 0 : different, 1)[0]; sectors.add(chosen.sector); selected.push(chosen.candidate);
    }
    return selected;
  };
  for (let tierIndex = 0; tierIndex < policy.radiusTiersMeters.length; tierIndex++) {
    const radius = policy.radiusTiersMeters[tierIndex]; result.tiersVisited.push(radius);
    const found = features.queryStarts(summit.coordinate, radius).filter(feature => !seen.has(feature.identity));
    for (const feature of found) seen.add(feature.identity);
    result.discoveredFeatures += found.length;
    const topologyRank = (c: AdaptiveStartCandidate) => c.osmIdentity.objectType === 'node' && component.nodes.has(c.osmIdentity.osmId) ? 0 : 1;
    const shortlist = found.map(f => makeCandidate(f, summit.coordinate, radius)).sort((a, b) =>
      topologyRank(a) - topologyRank(b) || primaryStartPriority(a.kind) - primaryStartPriority(b.kind) ||
      a.airDistanceMeters - b.airDistanceMeters || a.id.localeCompare(b.id));
    result.screeningTruncated ||= shortlist.length > policy.maximumScreenedPerTier;
    const screened = shortlist.slice(0, policy.maximumScreenedPerTier); result.screenedFeatures += screened.length;
    const limit = Math.min(policy.seriousCandidatesPerTier[tierIndex], policy.maximumSeriousCandidates - policy.maximumNetworkCandidates - result.seriousCandidates);
    for (const candidate of select(screened, Math.max(0, limit))) evaluate(candidate);
    if (rank()) { result.reasons.push('EARLY_EXIT_SAFE_AND_DIVERSE'); break; }
  }
  // Always compare genuine public boundaries: a distant named POI must not hide
  // the normal road/trail origin merely because its semantic priority is higher.
  {
    result.fallbackInspected = true;
    const access = session.networkStarts(summit.coordinate, component.nodes, policy.radiusTiersMeters.at(-1)!);
    const pool = access.map(network => makeCandidate({ identity: `network:${network.junctionNodeId}`, objectType: 'node', osmId: network.junctionNodeId,
      coordinate: network.coordinate, name: null, kind: 'TRAILHEAD', tags: {} }, summit.coordinate, 'NETWORK_ACCESS', network));
    for (const candidate of pool) candidate.accessEvidence = accessAt(candidate);
    pool.sort((a, b) => Number(primaryBaseAccess(b.accessEvidence)) - Number(primaryBaseAccess(a.accessEvidence)) ||
      a.airDistanceMeters - b.airDistanceMeters || a.id.localeCompare(b.id));
    result.screeningTruncated ||= pool.length > policy.maximumScreenedPerTier;
    const screened = pool.slice(0, policy.maximumScreenedPerTier); result.screenedFeatures += screened.length;
    for (const candidate of select(screened, Math.min(policy.maximumNetworkCandidates, policy.maximumSeriousCandidates - result.seriousCandidates))) evaluate(candidate);
    rank();
    if (!pool.length) result.reasons.push('NO_PUBLIC_TRAIL_APPROACH_JUNCTION');
  }
  const routed = result.evaluated.filter(c => c.route);
  if (result.candidates.length) result.status = result.candidates.some(c => c.kind === 'NETWORK_ACCESS') ? 'REMOTE_ACCESS_FOUND' : 'STARTS_FOUND';
  else if (routed.length && routed.every(c => c.reasons.includes('NETWORK_DISTANCE_SANITY_CEILING'))) result.status = 'NO_REASONABLE_START';
  else if (routed.length && routed.every(c => c.startContext?.type === 'HIGH_MOUNTAIN_START')) result.status = 'ONLY_HIGH_MOUNTAIN_STARTS';
  else if (routed.length && routed.every(c => c.startContext?.type === 'AMBIGUOUS_START')) result.status = 'ONLY_AMBIGUOUS_STARTS';
  else if (routed.length) result.status = 'NEEDS_REVIEW';
  if (result.screeningTruncated) result.reasons.push('BOUNDED_CANDIDATE_SCREENING_NOT_EXHAUSTIVE');
  if (summitAttachment.tier === 'REVIEW_PROXIMITY' && !result.candidates.length) {
    result.status = 'NEEDS_REVIEW';
    if (!result.reasons.includes(SUMMIT_ATTACHMENT_REASON_REVIEW)) result.reasons.unshift(SUMMIT_ATTACHMENT_REASON_REVIEW);
  }
  result.timings.routeMs = round(result.timings.routeMs);
  return finish();
}
