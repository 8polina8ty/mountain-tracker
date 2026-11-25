import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import { buildOsmTrailGraph, type OsmTrailDatasetIdentity, type OsmTrailGraph, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import type { Coordinate } from '../../Lib/gpxIngestion/types.ts';
import {
  PILOT_GRAPH_LIMITS, PilotGraphProvider,
  type PilotGraphProviderStats, type PilotGraphRequestStats, type PilotGraphResult,
} from './adaptive-start-pilot-graphs.ts';

export const SUMMIT_ATTACHMENT_GRAPH_PROVIDER_VERSION =
  'mountain-tracker/summit-attachment-graph-provider/v1' as const;
export const OVERSIZED_GRAPH_PROVIDER_VERSION =
  'mountain-tracker/summit-attachment-oversized-loader/v1' as const;

/**
 * Oversized components exceed the frozen preparation memory bound but remain
 * valid graph partitions from the same frozen cache. This loader re-builds the
 * full component with a versioned, larger bound solely to make previously
 * blocked mountains routable. Graph topology, eligibility and cost contract
 * are unchanged; only the loading bound is raised.
 */
export const OVERSIZED_COMPONENT_LIMITS = {
  maximumNodes: 1_200_000,
  maximumWays: 45_000,
  maximumCachedOversizedGraphs: 2,
  maximumRssMb: 7_000,
} as const;

const MAXIMUM_QUERY_DISTANCE_METERS = 150;
const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};

export interface SummitAttachmentGraphProviderInput {
  extractionPath: string;
  cachePath: string;
  dataset: OsmTrailDatasetIdentity;
  identityHash: string;
}

export interface SelectedSummitAttachmentNode {
  nodeId: number;
  coordinate: Coordinate;
  distanceMeters: number;
  componentId: number;
}

export interface SummitAttachmentGraphResult extends PilotGraphResult {
  selectedAttachmentNode: SelectedSummitAttachmentNode | null;
  queryMs: number;
  /** Which loader produced the graph: frozen pilot for in-limit components, oversized loader above it. */
  loader: 'PILOT' | 'OVERSIZED';
  /** RSS samples around an oversized build; null when no oversized build occurred. */
  rssMb: { beforeBuild: number; afterBuild: number; peakOversized: number } | null;
}

export interface OversizedGraphProviderStats {
  loadRequests: number;
  graphBuilds: number;
  graphCacheHits: number;
  graphEvictions: number;
  loadMs: number;
  buildMs: number;
  peakBuildRssMb: number;
}

interface IndexedNode { node: number; component: number; lon: number; lat: number }
interface CachedOversizedGraph { graph: OsmTrailGraph; ways: OsmTrailWayInput[] }

/**
 * Selects existing admitted edge nodes from the frozen spatial index. This is an
 * attachment lookup, never a new graph edge or proof of a traversable summit gap.
 * The caller must explicitly supply its frozen distance policy on every request.
 */
export class SummitAttachmentGraphProvider {
  readonly version = SUMMIT_ATTACHMENT_GRAPH_PROVIDER_VERSION;
  readonly cacheIdentity: Readonly<{ identity: unknown; complete: unknown }>;
  readonly constructorLoadMs: number;
  private readonly provider: PilotGraphProvider;
  private readonly cache: DatabaseSync;
  private readonly extraction: DatabaseSync;
  private readonly dataset: OsmTrailDatasetIdentity;
  private readonly oversizedGraphs = new Map<string, CachedOversizedGraph>();
  private readonly oversized: OversizedGraphProviderStats = {
    loadRequests: 0, graphBuilds: 0, graphCacheHits: 0, graphEvictions: 0, loadMs: 0, buildMs: 0, peakBuildRssMb: 0,
  };
  private closed = false;

  constructor(input: SummitAttachmentGraphProviderInput) {
    const started = performance.now();
    this.dataset = input.dataset;
    // Keep the complete original source/dataset/cache identity assertion intact.
    this.provider = new PilotGraphProvider(input);
    let cache: DatabaseSync | null = null;
    let extraction: DatabaseSync | null = null;
    try {
      cache = new ReadOnlyDatabase(input.cachePath, { readOnly: true });
      extraction = new ReadOnlyDatabase(input.extractionPath, { readOnly: true });
      const identity = cache.prepare("SELECT value FROM metadata WHERE key='identity'").get();
      const complete = cache.prepare("SELECT value FROM metadata WHERE key='complete'").get();
      assert(identity && complete, 'SUMMIT_ATTACHMENT_REQUIRES_COMPLETE_FROZEN_CACHE');
      this.cacheIdentity = Object.freeze({
        identity: JSON.parse(String(identity.value)) as unknown,
        complete: JSON.parse(String(complete.value)) as unknown,
      });
      this.cache = cache;
      this.extraction = extraction;
    } catch (error) {
      try { extraction?.close(); } catch { /* ignore */ }
      try { cache?.close(); } catch { /* ignore */ }
      this.provider.close(); throw error;
    }
    this.constructorLoadMs = performance.now() - started;
  }

  /** Inner graph loading/build/reuse metrics retain their existing definitions. */
  get stats(): PilotGraphProviderStats { return this.provider.stats; }

  get oversizedStats(): OversizedGraphProviderStats { return { ...this.oversized }; }

  get(blockId: string, targetCoordinate: Coordinate, maximumDistanceMeters: number): SummitAttachmentGraphResult {
    assert(!this.closed, 'SUMMIT_ATTACHMENT_PROVIDER_CLOSED');
    assert(Number.isFinite(maximumDistanceMeters) && maximumDistanceMeters > 0 &&
      maximumDistanceMeters <= MAXIMUM_QUERY_DISTANCE_METERS, 'SUMMIT_ATTACHMENT_DISTANCE_MUST_BE_EXPLICIT_AND_AT_MOST_150M');
    assert(Number.isFinite(targetCoordinate[0]) && Math.abs(targetCoordinate[0]) <= 180 &&
      Number.isFinite(targetCoordinate[1]) && Math.abs(targetCoordinate[1]) < 89, 'SUMMIT_ATTACHMENT_INVALID_COORDINATE');
    assert(this.cache.prepare('SELECT 1 present FROM metadata WHERE key=?').get(`block:${blockId}`),
      'SUMMIT_ATTACHMENT_BLOCK_NOT_PREPARED');
    const queryStarted = performance.now();
    const stats: PilotGraphRequestStats = {
      componentId: null, snapDistanceM: null, componentNodes: 0, componentWays: 0,
      graphCacheHit: false, loadMs: 0, buildMs: 0, reasonCodes: [],
    };
    const latitudeRadius = maximumDistanceMeters / 110_000;
    const longitudeRadius = latitudeRadius / Math.cos(targetCoordinate[1] * Math.PI / 180);
    const minimumLongitude = targetCoordinate[0] - longitudeRadius;
    const maximumLongitude = targetCoordinate[0] + longitudeRadius;
    const longitudeRanges = minimumLongitude < -180
      ? [[minimumLongitude + 360, 180], [-180, maximumLongitude]]
      : maximumLongitude > 180
        ? [[minimumLongitude, 180], [-180, maximumLongitude - 360]]
        : [[minimumLongitude, maximumLongitude]];
    const query = this.cache.prepare(`SELECT node,component,lon,lat FROM component_nodes
      WHERE block=? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT ?`);
    const indexedNodes: IndexedNode[] = [];
    for (const [minimum, maximum] of longitudeRanges) {
      const remaining = PILOT_GRAPH_LIMITS.summitSnapCandidates + 1 - indexedNodes.length;
      if (remaining <= 0) break;
      indexedNodes.push(...query.all(blockId, minimum, maximum,
        targetCoordinate[1] - latitudeRadius, targetCoordinate[1] + latitudeRadius, remaining) as unknown as IndexedNode[]);
    }
    if (indexedNodes.length > PILOT_GRAPH_LIMITS.summitSnapCandidates) {
      stats.reasonCodes.push('SUMMIT_ATTACHMENT_SPATIAL_CANDIDATE_LIMIT');
      return { graph: null, ways: [], status: 'GRAPH_COMPONENT_LIMIT', stats,
        selectedAttachmentNode: null, queryMs: performance.now() - queryStarted, loader: 'PILOT', rssMb: null };
    }
    const selected = indexedNodes.map(node => ({
      nodeId: node.node, coordinate: [node.lon, node.lat] as Coordinate,
      distanceMeters: calculateCoordinateDistanceMeters(targetCoordinate, [node.lon, node.lat]),
      componentId: node.component,
    })).filter(node => node.distanceMeters <= maximumDistanceMeters)
      .sort((left, right) => left.distanceMeters - right.distanceMeters || left.nodeId - right.nodeId)[0] ?? null;
    const queryMs = performance.now() - queryStarted;
    if (!selected) {
      stats.reasonCodes.push('NO_ADMITTED_EDGE_NODE_WITHIN_ATTACHMENT_BOUND');
      return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION', stats, selectedAttachmentNode: null, queryMs,
        loader: 'PILOT', rssMb: null };
    }

    // Oversized components exceed the frozen preparation bound. Load the full
    // component through the oversized loader (raised limits only) so these
    // mountains become routable; in-limit components keep the exact pilot path.
    const size = this.cache.prepare('SELECT nodes,ways FROM components WHERE block=? AND component=?')
      .get(blockId, selected.componentId) as { nodes: number; ways: number };
    if (size.nodes > PILOT_GRAPH_LIMITS.componentNodes || size.ways > PILOT_GRAPH_LIMITS.componentWays) {
      const loaded = this.loadOversized(blockId, selected, size);
      if (loaded.status === 'READY') {
        const actualNode = loaded.graph?.node(selected.nodeId);
        if (!actualNode || actualNode.coordinate[0] !== selected.coordinate[0] ||
          actualNode.coordinate[1] !== selected.coordinate[1]) {
          return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION',
            stats: { ...loaded.stats, snapDistanceM: selected.distanceMeters,
              reasonCodes: [...loaded.stats.reasonCodes, 'SUMMIT_ATTACHMENT_GRAPH_NODE_IDENTITY_MISMATCH'] },
            selectedAttachmentNode: selected, queryMs, loader: 'OVERSIZED', rssMb: loaded.rssMb };
        }
      }
      return { ...loaded, stats: { ...loaded.stats, snapDistanceM: selected.distanceMeters },
        selectedAttachmentNode: selected, queryMs, loader: 'OVERSIZED', rssMb: loaded.rssMb };
    }

    // Load the chosen component at its real node; do not search a different
    // component if the nearest one exceeds the original memory limits.
    const loaded = this.provider.get(blockId, selected.coordinate);
    const selectedStats = { ...loaded.stats, snapDistanceM: selected.distanceMeters };
    if (loaded.stats.componentId !== selected.componentId) {
      return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION',
        stats: { ...selectedStats, reasonCodes: [...selectedStats.reasonCodes, 'SUMMIT_ATTACHMENT_COMPONENT_IDENTITY_MISMATCH'] },
        selectedAttachmentNode: selected, queryMs, loader: 'PILOT', rssMb: null };
    }
    if (loaded.status !== 'READY') return { ...loaded, stats: selectedStats, selectedAttachmentNode: selected, queryMs,
      loader: 'PILOT', rssMb: null };
    const actualNode = loaded.graph?.node(selected.nodeId);
    if (!actualNode || actualNode.coordinate[0] !== selected.coordinate[0] ||
      actualNode.coordinate[1] !== selected.coordinate[1]) {
      return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION',
        stats: { ...selectedStats, reasonCodes: [...selectedStats.reasonCodes, 'SUMMIT_ATTACHMENT_GRAPH_NODE_IDENTITY_MISMATCH'] },
        selectedAttachmentNode: selected, queryMs, loader: 'PILOT', rssMb: null };
    }
    return { ...loaded, stats: selectedStats, selectedAttachmentNode: selected, queryMs, loader: 'PILOT', rssMb: null };
  }

  /** Full oversized component load with raised bounds; LRU-bounded and RSS-guarded. */
  private loadOversized(blockId: string, selected: SelectedSummitAttachmentNode,
    size: { nodes: number; ways: number }): PilotGraphResult & {
      rssMb: { beforeBuild: number; afterBuild: number; peakOversized: number } | null;
    } {
    const key = `${blockId}:${selected.componentId}`;
    const hit = this.oversizedGraphs.get(key);
    if (hit) {
      this.oversizedGraphs.delete(key); this.oversizedGraphs.set(key, hit);
      this.oversized.graphCacheHits++;
      return { ...hit, status: 'READY', stats: {
        componentId: selected.componentId, snapDistanceM: selected.distanceMeters, componentNodes: size.nodes,
        componentWays: size.ways, graphCacheHit: true, loadMs: 0, buildMs: 0, reasonCodes: [],
      }, rssMb: null };
    }
    this.oversized.loadRequests++;
    const loadStarted = performance.now();
    const trailIds = this.cache.prepare('SELECT way FROM component_ways WHERE block=? AND component=? ORDER BY way')
      .all(blockId, selected.componentId) as { way: number }[];
    const approachIds = this.cache.prepare(`SELECT DISTINCT a.way FROM approach_nodes a JOIN component_nodes n
      ON n.block=a.block AND n.node=a.node WHERE n.block=? AND n.component=? ORDER BY a.way`)
      .all(blockId, selected.componentId) as { way: number }[];
    const motorwayIds = this.cache.prepare('SELECT way FROM motorway_ways WHERE block=? ORDER BY way')
      .all(blockId) as { way: number }[];
    const readWay = this.extraction.prepare('SELECT payload FROM ways WHERE id=?');
    const trailSet = new Set(trailIds.map(row => row.way));
    const allIds = [...new Set([...trailIds, ...approachIds, ...motorwayIds].map(row => row.way))]
      .sort((left, right) => left - right);
    const ways = allIds.map(wayId => {
      const row = readWay.get(wayId);
      assert(row, `ADAPTIVE_GRAPH_EXTRACTION_WAY_MISSING:${wayId}`);
      return JSON.parse(String(row.payload)) as OsmTrailWayInput;
    });
    const loadMs = performance.now() - loadStarted;
    this.oversized.loadMs += loadMs;
    if (this.oversizedGraphs.size >= OVERSIZED_COMPONENT_LIMITS.maximumCachedOversizedGraphs) {
      this.oversizedGraphs.delete(this.oversizedGraphs.keys().next().value!);
      this.oversized.graphEvictions++;
    }
    const buildStarted = performance.now();
    const beforeBuild = process.memoryUsage().rss / 1024 / 1024;
    let graph: OsmTrailGraph;
    try {
      graph = buildOsmTrailGraph(this.dataset, ways.filter(way => trailSet.has(way.id)), {
        maximumNodes: OVERSIZED_COMPONENT_LIMITS.maximumNodes,
        maximumWays: OVERSIZED_COMPONENT_LIMITS.maximumWays,
      });
    } catch {
      this.oversized.peakBuildRssMb = Math.max(this.oversized.peakBuildRssMb, process.memoryUsage().rss / 1024 / 1024);
      return { graph: null, ways: [], status: 'GRAPH_COMPONENT_LIMIT', stats: {
        componentId: selected.componentId, snapDistanceM: selected.distanceMeters, componentNodes: size.nodes,
        componentWays: size.ways, graphCacheHit: false, loadMs, buildMs: performance.now() - buildStarted,
        reasonCodes: ['OVERSIZED_COMPONENT_BUILD_EXCEEDS_LOADER_BOUND'],
      }, rssMb: { beforeBuild, afterBuild: process.memoryUsage().rss / 1024 / 1024, peakOversized: this.oversized.peakBuildRssMb } };
    }
    const afterBuild = process.memoryUsage().rss / 1024 / 1024;
    this.oversized.peakBuildRssMb = Math.max(this.oversized.peakBuildRssMb, afterBuild);
    this.oversized.buildMs += performance.now() - buildStarted;
    this.oversized.graphBuilds++;
    if (!graph.findNearestNode(selected.coordinate, PILOT_GRAPH_LIMITS.summitSnapMeters)) {
      return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION', stats: {
        componentId: selected.componentId, snapDistanceM: selected.distanceMeters, componentNodes: size.nodes,
        componentWays: size.ways, graphCacheHit: false, loadMs, buildMs: performance.now() - buildStarted,
        reasonCodes: ['ACTUAL_GRAPH_SUMMIT_SNAP_FAILED'],
      }, rssMb: { beforeBuild, afterBuild, peakOversized: this.oversized.peakBuildRssMb } };
    }
    if (process.memoryUsage().rss / 1024 / 1024 > OVERSIZED_COMPONENT_LIMITS.maximumRssMb) this.oversizedGraphs.clear();
    const value = { graph, ways };
    this.oversizedGraphs.set(key, value);
    const buildMs = performance.now() - buildStarted;
    return { ...value, status: 'READY', stats: {
      componentId: selected.componentId, snapDistanceM: selected.distanceMeters, componentNodes: size.nodes,
      componentWays: size.ways, graphCacheHit: false, loadMs, buildMs, reasonCodes: [],
    }, rssMb: { beforeBuild, afterBuild, peakOversized: this.oversized.peakBuildRssMb } };
  }

  close(): void {
    if (this.closed) return;
    this.oversizedGraphs.clear();
    this.provider.close(); this.extraction.close(); this.cache.close(); this.closed = true;
  }
}
