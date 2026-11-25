import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  buildOsmTrailGraph, HIKING_COST_VERSION, OSM_TRAIL_GRAPH_CONTRACT_VERSION,
  type OsmTrailDatasetIdentity, type OsmTrailGraph, type OsmTrailWayInput,
} from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { connectorEligible } from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { Coordinate } from '../../Lib/gpxIngestion/types.ts';

export const PILOT_GRAPH_PREPARATION_VERSION = 'mountain-tracker/adaptive-start-pilot-graphs/v1' as const;
export const PILOT_GRAPH_LIMITS = {
  chunkWays: 250, chunkNodes: 150_000, componentNodes: 150_000, componentWays: 50_000,
  cachedGraphs: 3, summitSnapMeters: 30, summitSnapCandidates: 10_000,
} as const;

const APPROACH_HIGHWAYS = new Set(['track', 'service', 'unclassified', 'residential', 'living_street', 'pedestrian']);
const CONNECTOR_HIGHWAYS = [...APPROACH_HIGHWAYS].filter(highway => highway !== 'track');
const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};

interface GraphInputs {
  extractionPath: string;
  cachePath: string;
  dataset: OsmTrailDatasetIdentity;
  /** Caller hash binds the frozen corpus and extraction artifact, not route outcomes. */
  identityHash: string;
}

export interface PilotGraphBlockStats {
  blockId: string;
  inputWays: number;
  admittedWays: number;
  admittedNodes: number;
  weakComponents: number;
  graphChunkBuilds: number;
  approachChunkBuilds: number;
  approachWays: number;
  motorwayWays: number;
  exclusionCounts: Record<string, number>;
  elapsedMs: number;
}

export interface PilotGraphPreparationStats {
  version: typeof PILOT_GRAPH_PREPARATION_VERSION;
  identityHash: string;
  cacheHit: boolean;
  blocksPrepared: number;
  blocksReused: number;
  blocks: PilotGraphBlockStats[];
  elapsedMs: number;
}

export interface PilotGraphPrepareInput extends GraphInputs {
  blocks: readonly { blockId: string }[];
  onProgress?: (progress: { blockId: string; inputWays: number; chunkBuilds: number; elapsedMs: number }) => void;
}

function sourceHashes(): Record<string, string> {
  const files = [
    '../../Lib/gpxIngestion/osmTrailGraph.ts', '../../Lib/gpxIngestion/hashing.ts',
    '../../Lib/gpxIngestion/gpxNormalization.ts', '../../Lib/gpxIngestion/routableAnchorResolution.ts',
    '../osm-import/phase11c9-road-safety.ts', './adaptive-start-pilot-graphs.ts',
  ];
  return Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]));
}

function readMetadata<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  return row ? JSON.parse(String(row.value)) as T : null;
}

function extractionMetadata(db: DatabaseSync, dataset: OsmTrailDatasetIdentity): unknown {
  const complete = readMetadata<{ identity?: { datasetSha256?: string } }>(db, 'complete');
  assert(complete, 'ADAPTIVE_GRAPH_REQUIRES_COMPLETE_EXTRACTION');
  assert.equal(complete.identity?.datasetSha256, dataset.pbfSha256, 'ADAPTIVE_GRAPH_DATASET_MISMATCH');
  return complete;
}

function identityFor(input: GraphInputs, blocks: readonly { blockId: string }[], extraction: unknown) {
  assert.match(input.identityHash, /^[a-f0-9]{64}$/, 'ADAPTIVE_GRAPH_CALLER_IDENTITY_HASH');
  return {
    version: PILOT_GRAPH_PREPARATION_VERSION,
    requestedIdentityHash: input.identityHash,
    dataset: input.dataset,
    extractionMetadataHash: sha256Stable(extraction),
    blocks: blocks.map(block => block.blockId).sort(),
    graphVersion: OSM_TRAIL_GRAPH_CONTRACT_VERSION,
    costVersion: HIKING_COST_VERSION,
    parameters: PILOT_GRAPH_LIMITS,
    sourceHashes: sourceHashes(),
  };
}
type CacheIdentity = ReturnType<typeof identityFor>;

interface UnionNode { parent: number; rank: number; minimum: number; coordinate: Coordinate }

/** Weak components only choose reusable graph partitions; routing still uses the directed graph. */
class AdmittedNodeUnion {
  readonly nodes = new Map<number, UnionNode>();

  add(nodeId: number, coordinate: Coordinate): void {
    const existing = this.nodes.get(nodeId);
    if (existing) {
      assert(calculateCoordinateDistanceMeters(existing.coordinate, coordinate) <= 0.1,
        `ADAPTIVE_GRAPH_NODE_COORDINATE_CONFLICT:${nodeId}`);
      return;
    }
    this.nodes.set(nodeId, { parent: nodeId, rank: 0, minimum: nodeId, coordinate });
  }

  root(nodeId: number): number {
    let root = nodeId;
    while (this.nodes.get(root)!.parent !== root) root = this.nodes.get(root)!.parent;
    let cursor = nodeId;
    while (cursor !== root) {
      const entry = this.nodes.get(cursor)!;
      const next = entry.parent;
      entry.parent = root;
      cursor = next;
    }
    return root;
  }

  connect(leftId: number, rightId: number): void {
    let leftRoot = this.root(leftId), rightRoot = this.root(rightId);
    if (leftRoot === rightRoot) return;
    if (this.nodes.get(leftRoot)!.rank < this.nodes.get(rightRoot)!.rank) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    const left = this.nodes.get(leftRoot)!, right = this.nodes.get(rightRoot)!;
    right.parent = leftRoot;
    left.minimum = Math.min(left.minimum, right.minimum);
    if (left.rank === right.rank) left.rank++;
  }

  component(nodeId: number): number { return this.nodes.get(this.root(nodeId))!.minimum; }
}

function buildBlock(input: PilotGraphPrepareInput, source: DatabaseSync, cache: DatabaseSync, blockId: string): PilotGraphBlockStats {
  const started = performance.now();
  const stats: PilotGraphBlockStats = {
    blockId, inputWays: 0, admittedWays: 0, admittedNodes: 0, weakComponents: 0,
    graphChunkBuilds: 0, approachChunkBuilds: 0, approachWays: 0, motorwayWays: 0,
    exclusionCounts: {}, elapsedMs: 0,
  };
  const union = new AdmittedNodeUnion();
  const wayRepresentatives = new Map<number, Set<number>>();
  const nextWays = source.prepare(`SELECT w.id,w.payload FROM region_ways r JOIN ways w ON w.id=r.way
    WHERE r.region=? AND r.way>? ORDER BY r.way LIMIT ${PILOT_GRAPH_LIMITS.chunkWays}`);
  const putApproachNode = cache.prepare('INSERT OR IGNORE INTO approach_nodes(block,node,way) VALUES(?,?,?)');
  const putMotorway = cache.prepare('INSERT INTO motorway_ways(block,way) VALUES(?,?)');
  let lastWay = 0;
  while (true) {
    const rows = nextWays.all(blockId, lastWay) as { id: number; payload: string }[];
    if (rows.length === 0) break;
    lastWay = rows[rows.length - 1].id;
    const ways = rows.map(row => JSON.parse(row.payload) as OsmTrailWayInput);
    stats.inputWays += ways.length;
    const graph = buildOsmTrailGraph(input.dataset, ways,
      { maximumWays: PILOT_GRAPH_LIMITS.chunkWays, maximumNodes: PILOT_GRAPH_LIMITS.chunkNodes });
    stats.graphChunkBuilds++;
    for (const exclusion of graph.exclusions) stats.exclusionCounts[exclusion.reason] = (stats.exclusionCounts[exclusion.reason] ?? 0) + 1;
    // Nodes without a traversable edge never enter the partition index or summit snap search.
    for (const edge of graph.edges) {
      union.add(edge.fromNodeId, graph.node(edge.fromNodeId)!.coordinate);
      union.add(edge.toNodeId, graph.node(edge.toNodeId)!.coordinate);
      union.connect(edge.fromNodeId, edge.toNodeId);
    }
    for (const edge of graph.edges) {
      const representatives = wayRepresentatives.get(edge.wayId) ?? new Set<number>();
      representatives.add(union.root(edge.fromNodeId));
      wayRepresentatives.set(edge.wayId, representatives);
    }
    const approachWays = ways.filter(way => APPROACH_HIGHWAYS.has((way.tags.highway ?? '').trim().toLowerCase()) && connectorEligible(way.tags));
    if (approachWays.length) {
      // A second bounded admission call validates real road edges without adding them to the trail union.
      const approachGraph = buildOsmTrailGraph(input.dataset, approachWays, {
        maximumWays: PILOT_GRAPH_LIMITS.chunkWays, maximumNodes: PILOT_GRAPH_LIMITS.chunkNodes,
        connectorHighways: CONNECTOR_HIGHWAYS,
      });
      stats.approachChunkBuilds++;
      const admittedApproaches = new Set<number>();
      for (const edge of approachGraph.edges) {
        putApproachNode.run(blockId, edge.fromNodeId, edge.wayId);
        putApproachNode.run(blockId, edge.toNodeId, edge.wayId);
        admittedApproaches.add(edge.wayId);
      }
      stats.approachWays += admittedApproaches.size;
    }
    for (const way of ways) if (['motorway', 'motorway_link'].includes((way.tags.highway ?? '').trim().toLowerCase())) {
      putMotorway.run(blockId, way.id);
      stats.motorwayWays++;
    }
    if (stats.graphChunkBuilds % 100 === 0) input.onProgress?.({ blockId, inputWays: stats.inputWays,
      chunkBuilds: stats.graphChunkBuilds, elapsedMs: performance.now() - started });
  }
  const putNode = cache.prepare('INSERT INTO component_nodes(block,node,component,lon,lat) VALUES(?,?,?,?,?)');
  for (const [nodeId, node] of union.nodes) putNode.run(blockId, nodeId, union.component(nodeId), node.coordinate[0], node.coordinate[1]);
  const putWay = cache.prepare('INSERT OR IGNORE INTO component_ways(block,way,component) VALUES(?,?,?)');
  for (const [wayId, representatives] of wayRepresentatives) for (const nodeId of representatives) putWay.run(blockId, wayId, union.component(nodeId));
  cache.prepare(`INSERT INTO components(block,component,nodes,ways)
    SELECT n.block,n.component,n.node_count,w.way_count FROM
      (SELECT block,component,COUNT(*) node_count FROM component_nodes WHERE block=? GROUP BY component) n JOIN
      (SELECT block,component,COUNT(*) way_count FROM component_ways WHERE block=? GROUP BY component) w
    ON n.block=w.block AND n.component=w.component`).run(blockId, blockId);
  stats.admittedWays = wayRepresentatives.size;
  stats.admittedNodes = union.nodes.size;
  stats.weakComponents = Number(cache.prepare('SELECT COUNT(*) count FROM components WHERE block=?').get(blockId)!.count);
  stats.elapsedMs = performance.now() - started;
  input.onProgress?.({ blockId, inputWays: stats.inputWays, chunkBuilds: stats.graphChunkBuilds, elapsedMs: stats.elapsedMs });
  return stats;
}

/** Build once from the frozen local highway extraction; complete blocks can be resumed safely. */
export async function prepareGraphCache(input: PilotGraphPrepareInput): Promise<PilotGraphPreparationStats> {
  const started = performance.now();
  assert(input.blocks.length > 0 && input.blocks.length <= 100, 'ADAPTIVE_GRAPH_BLOCK_BOUND');
  assert.equal(new Set(input.blocks.map(block => block.blockId)).size, input.blocks.length, 'ADAPTIVE_GRAPH_DUPLICATE_BLOCK');
  await mkdir(dirname(input.cachePath), { recursive: true });
  const source = new ReadOnlyDatabase(input.extractionPath, { readOnly: true });
  let cache: DatabaseSync | null = null;
  try {
    const extraction = extractionMetadata(source, input.dataset);
    const identity = identityFor(input, input.blocks, extraction);
    const identityHash = sha256Stable(identity);
    const existed = existsSync(input.cachePath);
    cache = new DatabaseSync(input.cachePath);
    cache.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-262144;');
    if (!existed) {
      cache.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE component_nodes(block TEXT NOT NULL,node INTEGER NOT NULL,component INTEGER NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL,PRIMARY KEY(block,node));
        CREATE INDEX component_nodes_spatial ON component_nodes(block,lon,lat);
        CREATE INDEX component_nodes_component ON component_nodes(block,component,node);
        CREATE TABLE component_ways(block TEXT NOT NULL,way INTEGER NOT NULL,component INTEGER NOT NULL,PRIMARY KEY(block,way,component));
        CREATE INDEX component_ways_component ON component_ways(block,component,way);
        CREATE TABLE components(block TEXT NOT NULL,component INTEGER NOT NULL,nodes INTEGER NOT NULL,ways INTEGER NOT NULL,PRIMARY KEY(block,component));
        CREATE TABLE approach_nodes(block TEXT NOT NULL,node INTEGER NOT NULL,way INTEGER NOT NULL,PRIMARY KEY(block,node,way));
        CREATE TABLE motorway_ways(block TEXT NOT NULL,way INTEGER NOT NULL,PRIMARY KEY(block,way));`);
      cache.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('identity', JSON.stringify(identity));
    }
    assert.deepEqual(readMetadata(cache, 'identity'), identity, 'ADAPTIVE_GRAPH_CACHE_IDENTITY_DRIFT');
    const existing = readMetadata<PilotGraphPreparationStats>(cache, 'complete');
    if (existing) return { ...existing, cacheHit: true, blocksPrepared: 0, blocksReused: input.blocks.length, elapsedMs: performance.now() - started };
    const stats: PilotGraphPreparationStats = {
      version: PILOT_GRAPH_PREPARATION_VERSION, identityHash, cacheHit: false,
      blocksPrepared: 0, blocksReused: 0, blocks: [], elapsedMs: 0,
    };
    for (const block of [...input.blocks].sort((left, right) => left.blockId.localeCompare(right.blockId))) {
      const prior = readMetadata<PilotGraphBlockStats>(cache, `block:${block.blockId}`);
      if (prior) { stats.blocks.push(prior); stats.blocksReused++; continue; }
      assert(source.prepare('SELECT 1 present FROM region_ways WHERE region=? LIMIT 1').get(block.blockId), 'ADAPTIVE_GRAPH_EXTRACTION_BLOCK_MISSING');
      cache.exec('BEGIN IMMEDIATE');
      try {
        const blockStats = buildBlock(input, source, cache, block.blockId);
        cache.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(`block:${block.blockId}`, JSON.stringify(blockStats));
        cache.exec('COMMIT');
        stats.blocks.push(blockStats);
        stats.blocksPrepared++;
      } catch (error) { cache.exec('ROLLBACK'); throw error; }
    }
    stats.elapsedMs = performance.now() - started;
    cache.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('complete', JSON.stringify(stats));
    return stats;
  } finally { cache?.close(); source.close(); }
}

export interface PilotGraphRequestStats {
  componentId: number | null;
  snapDistanceM: number | null;
  componentNodes: number;
  componentWays: number;
  graphCacheHit: boolean;
  loadMs: number;
  buildMs: number;
  reasonCodes: string[];
}

export interface PilotGraphResult {
  graph: OsmTrailGraph | null;
  ways: OsmTrailWayInput[];
  status: 'READY' | 'NO_SUMMIT_CONNECTION' | 'GRAPH_COMPONENT_LIMIT';
  stats: PilotGraphRequestStats;
}

export interface PilotGraphProviderStats {
  graphRequests: number;
  graphBuilds: number;
  graphCacheHits: number;
  graphEvictions: number;
  componentLimitCount: number;
  noSummitConnectionCount: number;
  loadMs: number;
  buildMs: number;
}

interface CachedGraph { graph: OsmTrailGraph; ways: OsmTrailWayInput[] }

export class PilotGraphProvider {
  private readonly extraction: DatabaseSync;
  private readonly cache: DatabaseSync;
  private readonly dataset: OsmTrailDatasetIdentity;
  private readonly maxCachedGraphs: number;
  private readonly graphs = new Map<string, CachedGraph>();
  private readonly counters: PilotGraphProviderStats = {
    graphRequests: 0, graphBuilds: 0, graphCacheHits: 0, graphEvictions: 0,
    componentLimitCount: 0, noSummitConnectionCount: 0, loadMs: 0, buildMs: 0,
  };
  private closed = false;

  constructor(input: GraphInputs & { maxCachedGraphs?: number }) {
    this.dataset = input.dataset;
    this.maxCachedGraphs = input.maxCachedGraphs ?? PILOT_GRAPH_LIMITS.cachedGraphs;
    assert(Number.isInteger(this.maxCachedGraphs) && this.maxCachedGraphs >= 1 && this.maxCachedGraphs <= 3, 'ADAPTIVE_GRAPH_LRU_BOUND');
    this.extraction = new ReadOnlyDatabase(input.extractionPath, { readOnly: true });
    this.cache = new ReadOnlyDatabase(input.cachePath, { readOnly: true });
    try {
      const saved = readMetadata<CacheIdentity>(this.cache, 'identity');
      assert(saved && readMetadata(this.cache, 'complete'), 'ADAPTIVE_GRAPH_CACHE_INCOMPLETE');
      const expected = identityFor(input, saved.blocks.map(blockId => ({ blockId })), extractionMetadata(this.extraction, input.dataset));
      assert.deepEqual(saved, expected, 'ADAPTIVE_GRAPH_CACHE_IDENTITY_DRIFT');
    } catch (error) { this.extraction.close(); this.cache.close(); throw error; }
  }

  get stats(): PilotGraphProviderStats { return { ...this.counters }; }

  get(blockId: string, coordinate: Coordinate): PilotGraphResult {
    assert(!this.closed, 'ADAPTIVE_GRAPH_PROVIDER_CLOSED');
    assert(Number.isFinite(coordinate[0]) && Math.abs(coordinate[0]) <= 180 &&
      Number.isFinite(coordinate[1]) && Math.abs(coordinate[1]) < 89, 'ADAPTIVE_GRAPH_ALPS_COORDINATE_REQUIRED');
    assert(readMetadata(this.cache, `block:${blockId}`), 'ADAPTIVE_GRAPH_BLOCK_NOT_PREPARED');
    this.counters.graphRequests++;
    const stats: PilotGraphRequestStats = {
      componentId: null, snapDistanceM: null, componentNodes: 0, componentWays: 0,
      graphCacheHit: false, loadMs: 0, buildMs: 0, reasonCodes: [],
    };
    const noSummit = (reason: string): PilotGraphResult => {
      this.counters.noSummitConnectionCount++;
      stats.reasonCodes.push(reason);
      return { graph: null, ways: [], status: 'NO_SUMMIT_CONNECTION', stats };
    };
    const limited = (reason: string): PilotGraphResult => {
      this.counters.componentLimitCount++;
      stats.reasonCodes.push(reason);
      return { graph: null, ways: [], status: 'GRAPH_COMPONENT_LIMIT', stats };
    };
    const latitudeRadius = PILOT_GRAPH_LIMITS.summitSnapMeters / 110_000;
    const longitudeRadius = latitudeRadius / Math.cos(coordinate[1] * Math.PI / 180);
    const nearest = this.cache.prepare(`SELECT node,component,lon,lat FROM component_nodes
      WHERE block=? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT ${PILOT_GRAPH_LIMITS.summitSnapCandidates + 1}`)
      .all(blockId, coordinate[0] - longitudeRadius, coordinate[0] + longitudeRadius,
        coordinate[1] - latitudeRadius, coordinate[1] + latitudeRadius) as Array<{ node: number; component: number; lon: number; lat: number }>;
    if (nearest.length > PILOT_GRAPH_LIMITS.summitSnapCandidates) return limited('SUMMIT_SNAP_CANDIDATE_LIMIT');
    const selected = nearest.map(node => ({ ...node, distance: calculateCoordinateDistanceMeters(coordinate, [node.lon, node.lat]) }))
      .filter(node => node.distance <= PILOT_GRAPH_LIMITS.summitSnapMeters)
      .sort((left, right) => left.distance - right.distance || left.node - right.node)[0];
    if (!selected) return noSummit('NO_ADMITTED_EDGE_NODE_WITHIN_30M');
    stats.componentId = selected.component;
    stats.snapDistanceM = selected.distance;
    const size = this.cache.prepare('SELECT nodes,ways FROM components WHERE block=? AND component=?')
      .get(blockId, selected.component) as { nodes: number; ways: number };
    stats.componentNodes = size.nodes;
    stats.componentWays = size.ways;
    if (size.nodes > PILOT_GRAPH_LIMITS.componentNodes || size.ways > PILOT_GRAPH_LIMITS.componentWays) return limited('SHARED_COMPONENT_EXCEEDS_FROZEN_MEMORY_BOUND');
    const key = `${blockId}:${selected.component}`;
    const hit = this.graphs.get(key);
    if (hit) {
      this.graphs.delete(key); this.graphs.set(key, hit);
      this.counters.graphCacheHits++; stats.graphCacheHit = true;
      return { ...hit, status: 'READY', stats };
    }
    const loadStarted = performance.now();
    const trailIds = this.cache.prepare('SELECT way FROM component_ways WHERE block=? AND component=? ORDER BY way')
      .all(blockId, selected.component) as { way: number }[];
    const approachIds = this.cache.prepare(`SELECT DISTINCT a.way FROM approach_nodes a JOIN component_nodes n
      ON n.block=a.block AND n.node=a.node WHERE n.block=? AND n.component=? ORDER BY a.way`)
      .all(blockId, selected.component) as { way: number }[];
    const motorwayIds = this.cache.prepare('SELECT way FROM motorway_ways WHERE block=? ORDER BY way').all(blockId) as { way: number }[];
    const readWay = this.extraction.prepare('SELECT payload FROM ways WHERE id=?');
    const trailSet = new Set(trailIds.map(row => row.way));
    const allIds = [...new Set([...trailIds, ...approachIds, ...motorwayIds].map(row => row.way))].sort((left, right) => left - right);
    const ways = allIds.map(wayId => {
      const row = readWay.get(wayId);
      assert(row, `ADAPTIVE_GRAPH_EXTRACTION_WAY_MISSING:${wayId}`);
      return JSON.parse(String(row.payload)) as OsmTrailWayInput;
    });
    stats.loadMs = performance.now() - loadStarted;
    this.counters.loadMs += stats.loadMs;
    if (this.graphs.size >= this.maxCachedGraphs) {
      this.graphs.delete(this.graphs.keys().next().value!); this.counters.graphEvictions++;
    }
    const buildStarted = performance.now();
    // Roads remain auxiliary provenance for bounded connectors and safety; no global road graph is built.
    const graph = buildOsmTrailGraph(this.dataset, ways.filter(way => trailSet.has(way.id)), {
      maximumNodes: PILOT_GRAPH_LIMITS.componentNodes, maximumWays: PILOT_GRAPH_LIMITS.componentWays,
    });
    stats.buildMs = performance.now() - buildStarted;
    this.counters.buildMs += stats.buildMs; this.counters.graphBuilds++;
    if (!graph.findNearestNode(coordinate, PILOT_GRAPH_LIMITS.summitSnapMeters)) return noSummit('ACTUAL_GRAPH_SUMMIT_SNAP_FAILED');
    const value = { graph, ways };
    this.graphs.set(key, value);
    return { ...value, status: 'READY', stats };
  }

  close(): void {
    if (this.closed) return;
    this.graphs.clear(); this.extraction.close(); this.cache.close(); this.closed = true;
  }
}
