/** Read-only summit proximity diagnostic; never builds graphs or generates routes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { connectorEligible } from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { INCLUDED_TRAIL_HIGHWAYS, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { evaluatePedestrianAccess } from '../osm-import/phase11c9-road-safety.ts';
import type { AdaptivePilotCorpus, AdaptivePilotMountain } from './adaptive-start-pilot-prepare.ts';

const OUT = 'data/gpx/adaptive-start-pilot';
const VERSION = 'mountain-tracker/adaptive-summit-distance-diagnostic/v1';
const SEARCH_RADII = [30, 50, 75, 100, 150, 300, 1000, 5000, 10_000, 50_000];
const APPROACH_HIGHWAYS = new Set(['track', 'service', 'unclassified', 'residential', 'living_street', 'pedestrian']);
const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};
/** node:sqlite exposes StatementSync#iterate, which lags behind in the installed type stubs. */
type IterableStatement = { iterate(...params: (string | number | null)[]): IterableIterator<NodeRow> };
const iterable = (statement: object): IterableStatement => statement as IterableStatement;

interface BaselineResult {
  mountainId: string;
  status: string;
  graphStatus: string;
  reasons: string[];
  candidates: unknown[];
}
interface CacheIdentity {
  version: string;
  requestedIdentityHash: string;
  dataset: AdaptivePilotCorpus['dataset'];
  extractionMetadataHash: string;
  blocks: string[];
  parameters: Record<string, number>;
  sourceHashes: Record<string, string>;
}
interface NodeRow { node: number; component?: number; lon: number; lat: number; way?: number }
interface WayEvidence {
  wayId: number;
  highway: string;
  accessTags: Record<string, string>;
  pedestrianAccess: string;
  admittedEdgeNeighborNodeId: number;
  admittedEdgeNeighborCoordinate: [number, number];
  wayEndpoint: boolean;
}
interface NearestNode {
  nodeId: number;
  coordinate: [number, number];
  componentId: number | null;
  distanceMeters: number;
  bucket: string;
  searchRadiusMeters: number;
  wayProvenance: WayEvidence[];
  queryMs: number;
}
interface DiagnosticMountain {
  mountainId: string;
  summit: AdaptivePilotMountain['summit'];
  stratum: AdaptivePilotMountain['stratum'];
  blockId: string;
  existingOutcome: string;
  existingGraphStatus: string;
  existingReasons: string[];
  wasSummitSnapFailure: boolean;
  A_admittedMountainTrailNode: NearestNode | null;
  B_pedestrianCompatibleGraphNode: NearestNode | null;
  C_safeApproachConnectorNode: NearestNode | null;
}

function load<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
function fileHash(path: string | URL): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function readMetadata<T>(db: DatabaseSync, key: string): T {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  assert(row, `REQUIRED_METADATA_MISSING:${key}`);
  return JSON.parse(String(row.value)) as T;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function bucket(distance: number): string {
  if (distance <= 30) return '0-30m';
  if (distance <= 50) return '>30-50m';
  if (distance <= 75) return '>50-75m';
  if (distance <= 100) return '>75-100m';
  if (distance <= 150) return '>100-150m';
  return '>150m';
}
function quantile(sorted: number[], proportion: number): number | null {
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * proportion)] : null;
}

function nearest(db: DatabaseSync, table: 'component_nodes' | 'approach_points', block: string,
  coordinate: [number, number]): NearestNode | null {
  const started = performance.now();
  const statement = db.prepare(`SELECT node,${table === 'component_nodes' ? 'component' : 'way'},lon,lat FROM ${table}
    WHERE block=? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?`);
  for (const radius of SEARCH_RADII) {
    const angular = radius / 6_371_000;
    const latitudeRadius = angular * 180 / Math.PI;
    const longitudeRadius = Math.asin(Math.sin(angular) / Math.cos(coordinate[1] * Math.PI / 180)) * 180 / Math.PI;
    let best: { row: NodeRow; distance: number } | null = null;
    for (const raw of iterable(statement).iterate(block, coordinate[0] - longitudeRadius, coordinate[0] + longitudeRadius,
      coordinate[1] - latitudeRadius, coordinate[1] + latitudeRadius)) {
      const row = raw as unknown as NodeRow;
      const distance = calculateCoordinateDistanceMeters(coordinate, [row.lon, row.lat]);
      if (distance <= radius && (!best || distance < best.distance ||
        (distance === best.distance && row.node < best.row.node))) best = { row, distance };
    }
    if (best) return {
      nodeId: best.row.node, coordinate: [best.row.lon, best.row.lat], componentId: best.row.component ?? null,
      distanceMeters: best.distance, bucket: bucket(best.distance), searchRadiusMeters: radius,
      wayProvenance: [], queryMs: performance.now() - started,
    };
  }
  return null;
}

function evidence(way: OsmTrailWayInput, nodeId: number): WayEvidence | null {
  // Membership in component_nodes / approach_nodes is the authoritative prior edge admission.
  // Confirm the reported supporting way actually contains a non-zero adjacent OSM segment.
  for (let index = 0; index < way.nodes.length; index++) {
    const node = way.nodes[index];
    if (node.nodeId !== nodeId || !node.coordinate) continue;
    for (const offset of [-1, 1]) {
      const neighbor = way.nodes[index + offset];
      if (!neighbor?.coordinate || calculateCoordinateDistanceMeters(node.coordinate, neighbor.coordinate) <= 0) continue;
      const accessTags = Object.fromEntries(Object.entries(way.tags).filter(([key]) =>
        ['highway', 'foot', 'access', 'access:conditional', 'foot:conditional', 'motor_vehicle', 'vehicle',
          'smoothness', 'oneway:foot', 'conveying', 'sac_scale', 'trail_visibility', 'surface'].includes(key)));
      return { wayId: way.id, highway: way.tags.highway, accessTags,
        pedestrianAccess: evaluatePedestrianAccess({ ...way.tags }),
        admittedEdgeNeighborNodeId: neighbor.nodeId,
        admittedEdgeNeighborCoordinate: [neighbor.coordinate[0], neighbor.coordinate[1]],
        wayEndpoint: index === 0 || index === way.nodes.length - 1 };
    }
  }
  return null;
}

function summary(records: DiagnosticMountain[], field: 'A_admittedMountainTrailNode' | 'B_pedestrianCompatibleGraphNode' | 'C_safeApproachConnectorNode') {
  const histogram: Record<string, number> = Object.fromEntries(
    ['0-30m', '>30-50m', '>50-75m', '>75-100m', '>100-150m', '>150m', 'NOT_FOUND_WITHIN_50KM'].map(key => [key, 0]),
  );
  const distances: number[] = [];
  for (const record of records) {
    const node = record[field];
    histogram[node?.bucket ?? 'NOT_FOUND_WITHIN_50KM']++;
    if (node) distances.push(node.distanceMeters);
  }
  distances.sort((left, right) => left - right);
  return { mountains: records.length, histogram, distanceQuantilesMeters: {
    p50: quantile(distances, 0.5), p75: quantile(distances, 0.75),
    p90: quantile(distances, 0.9), p95: quantile(distances, 0.95),
  }, quantilesExcludeCensoredMissing: true };
}

function main(): void {
  const started = performance.now();
  const corpusPath = `${OUT}/adaptive-start-pilot-corpus.json`;
  const baselinePath = `${OUT}/adaptive-start-pilot-results.json`;
  const corpus = load<AdaptivePilotCorpus>(corpusPath);
  const { corpusHash, ...corpusPayload } = corpus;
  assert.equal(sha256Stable(corpusPayload), corpusHash, 'FROZEN_CORPUS_HASH_MISMATCH');
  const baseline = load<BaselineResult[]>(baselinePath);
  assert.equal(baseline.length, 100);
  assert.equal(corpus.mountains.length, 100);
  assert.deepEqual([...baseline.map(record => record.mountainId)].sort(), [...corpus.mountains.map(record => record.mountainId)].sort());
  const baselineById = new Map(baseline.map(record => [record.mountainId, record]));
  const graphPath = `${OUT}/cache/${corpusHash}-graphs.sqlite`;
  const extractionPath = `${OUT}/cache/${corpusHash}.sqlite`;
  const initialStats = [graphPath, extractionPath].map(path => ({ path, sizeBytes: statSync(path).size, modifiedMs: statSync(path).mtimeMs }));
  const loadStarted = performance.now();
  const cache = new ReadOnlyDatabase(graphPath, { readOnly: true });
  const source = new ReadOnlyDatabase(extractionPath, { readOnly: true });
  const temporary = new DatabaseSync(':memory:');
  try {
    const identity = readMetadata<CacheIdentity>(cache, 'identity');
    const completion = readMetadata<{ identityHash: string; blocksPrepared: number; blocks: unknown[]; elapsedMs: number }>(cache, 'complete');
    const extraction = readMetadata<{ identity: { corpusHash: string; datasetSha256: string }; uniqueWays: number }>(source, 'complete');
    assert.equal(identity.requestedIdentityHash, corpusHash);
    assert.deepEqual(identity.dataset, corpus.dataset);
    assert.equal(identity.extractionMetadataHash, sha256Stable(extraction));
    assert.equal(completion.identityHash, sha256Stable(identity));
    assert.equal(extraction.identity.corpusHash, corpusHash);
    assert.equal(extraction.identity.datasetSha256, corpus.dataset.pbfSha256);
    assert.deepEqual(identity.blocks, corpus.blocks.map(block => block.blockId).sort());
    assert.equal(completion.blocks.length, 10);
    const sourceProof = Object.entries(identity.sourceHashes).map(([path, expected]) => {
      const actual = fileHash(new URL(path, new URL('./adaptive-start-pilot-graphs.ts', import.meta.url)));
      assert.equal(actual, expected, `GRAPH_SOURCE_IDENTITY_DRIFT:${path}`);
      return { path, expectedSha256: expected, actualSha256: actual, matches: true };
    });
    const cacheLoadMs = performance.now() - loadStarted;
    console.log(JSON.stringify({ status: 'READONLY_CACHE_IDENTITIES_VERIFIED', graphIdentityHash: completion.identityHash,
      providerSourceHash: identity.sourceHashes['./adaptive-start-pilot-graphs.ts'], cacheLoadMs: round(cacheLoadMs) }));
    const records: DiagnosticMountain[] = corpus.mountains.map(mountain => {
      const prior = baselineById.get(mountain.mountainId)!;
      const node = nearest(cache, 'component_nodes', mountain.blockId, mountain.summit.coordinate);
      return { mountainId: mountain.mountainId, summit: mountain.summit, stratum: mountain.stratum, blockId: mountain.blockId,
        existingOutcome: prior.status, existingGraphStatus: prior.graphStatus, existingReasons: prior.reasons,
        wasSummitSnapFailure: prior.reasons.includes('NO_ADMITTED_EDGE_NODE_WITHIN_30M'),
        A_admittedMountainTrailNode: node, B_pedestrianCompatibleGraphNode: node, C_safeApproachConnectorNode: null };
    });
    console.log(JSON.stringify({ status: 'ADMITTED_NODE_DISTANCES_MEASURED',
      failures: summary(records.filter(record => record.wasSummitSnapFailure), 'A_admittedMountainTrailNode'),
      sparse: summary(records.filter(record => record.stratum === 'SPARSE'), 'A_admittedMountainTrailNode') }));

    temporary.exec(`CREATE TABLE approach_points(block TEXT NOT NULL,node INTEGER NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL,way INTEGER NOT NULL,PRIMARY KEY(block,node));
      CREATE INDEX approach_points_spatial ON approach_points(block,lon,lat);`);
    const putPoint = temporary.prepare('INSERT OR IGNORE INTO approach_points(block,node,lon,lat,way) VALUES(?,?,?,?,?)');
    const getWay = source.prepare('SELECT payload FROM ways WHERE id=?');
    let sourceWaysInspected = 0;
    let approachNodeMemberships = 0;
    const perBlockTiming: Array<{ blockId: string; elapsedMs: number; sourceWaysInspected: number; approachMemberships: number }> = [];
    for (const block of corpus.blocks) {
      const blockStarted = performance.now();
      const previousWayCount = sourceWaysInspected;
      const blockRecords = records.filter(record => record.blockId === block.blockId);
      const wanted = new Map(blockRecords.flatMap(record => record.A_admittedMountainTrailNode ?
        [[record.A_admittedMountainTrailNode.nodeId, record.A_admittedMountainTrailNode] as const] : []));
      const components = [...new Set([...wanted.values()].map(node => node.componentId!))];
      if (components.length) {
        const placeholders = components.map(() => '?').join(',');
        const ways = cache.prepare(`SELECT DISTINCT way FROM component_ways WHERE block=? AND component IN (${placeholders}) ORDER BY way`);
        for (const raw of iterable(ways).iterate(block.blockId, ...components)) {
          const row = getWay.get(Number(raw.way));
          assert(row, 'ADMITTED_WAY_MISSING_FROM_FROZEN_EXTRACTION');
          const way = JSON.parse(String(row.payload)) as OsmTrailWayInput;
          sourceWaysInspected++;
          for (const node of way.nodes) {
            const selected = wanted.get(node.nodeId);
            if (!selected) continue;
            assert(INCLUDED_TRAIL_HIGHWAYS.has(way.tags.highway));
            assert(!['FORBIDDEN', 'AMBIGUOUS'].includes(evaluatePedestrianAccess({ ...way.tags })));
            const provenance = evidence(way, node.nodeId);
            if (!provenance) continue;
            selected.wayProvenance = [provenance];
            wanted.delete(node.nodeId);
          }
          if (wanted.size === 0) break;
        }
        assert.equal(wanted.size, 0, 'NEAREST_ADMITTED_NODE_LACKS_SUPPORTING_OSM_WAY');
      }

      const approachByWay = new Map<number, Set<number>>();
      let blockMemberships = 0;
      for (const row of iterable(cache.prepare('SELECT node,way FROM approach_nodes WHERE block=?')).iterate(block.blockId)) {
        const wayId = Number(row.way);
        const nodes = approachByWay.get(wayId) ?? new Set<number>();
        nodes.add(Number(row.node));
        approachByWay.set(wayId, nodes);
        blockMemberships++;
      }
      approachNodeMemberships += blockMemberships;
      const approachWays = new Map<number, OsmTrailWayInput>();
      temporary.exec('BEGIN');
      for (const [wayId, members] of [...approachByWay.entries()].sort(([left], [right]) => left - right)) {
        const row = getWay.get(wayId);
        assert(row, 'ADMITTED_APPROACH_WAY_MISSING_FROM_FROZEN_EXTRACTION');
        const way = JSON.parse(String(row.payload)) as OsmTrailWayInput;
        sourceWaysInspected++;
        assert(APPROACH_HIGHWAYS.has(way.tags.highway.trim().toLowerCase()) && connectorEligible(way.tags),
          'CACHED_APPROACH_ACCESS_POLICY_MISMATCH');
        approachWays.set(wayId, way);
        for (const node of way.nodes) if (node.coordinate && members.has(node.nodeId)) {
          putPoint.run(block.blockId, node.nodeId, node.coordinate[0], node.coordinate[1], wayId);
        }
      }
      temporary.exec('COMMIT');
      for (const record of blockRecords) {
        const selected = nearest(temporary, 'approach_points', block.blockId, record.summit.coordinate);
        if (selected) {
          const row = temporary.prepare('SELECT way FROM approach_points WHERE block=? AND node=?').get(block.blockId, selected.nodeId)!;
          const provenance = evidence(approachWays.get(Number(row.way))!, selected.nodeId);
          assert(provenance, 'APPROACH_NODE_LACKS_SUPPORTING_OSM_EDGE');
          selected.wayProvenance = [provenance];
        }
        record.C_safeApproachConnectorNode = selected;
      }
      // One block of temporary connector coordinates at a time; persistent caches stay read-only.
      temporary.prepare('DELETE FROM approach_points WHERE block=?').run(block.blockId);
      const timing = { blockId: block.blockId, elapsedMs: round(performance.now() - blockStarted),
        sourceWaysInspected: sourceWaysInspected - previousWayCount, approachMemberships: blockMemberships };
      perBlockTiming.push(timing);
      console.log(JSON.stringify({ status: 'BLOCK_PROVENANCE_DIAGNOSED', ...timing }));
    }
    const failures = records.filter(record => record.wasSummitSnapFailure);
    assert.equal(failures.length, 62, 'CURRENT_PILOT_SUMMIT_FAILURE_COUNT_DRIFT');
    const nodeQueryTimes = records.flatMap(record => record.A_admittedMountainTrailNode ? [record.A_admittedMountainTrailNode.queryMs] : [])
      .sort((left, right) => left - right);
    const diagnostic = {
      schemaVersion: VERSION, corpusHash, baselineRole: 'EXPOSED_REGRESSION_ENGINEERING_PILOT',
      corpusFileSha256: fileHash(corpusPath), baselineResultsFileSha256: fileHash(baselinePath),
      datasetSha256: corpus.dataset.pbfSha256,
      definitions: {
        A: 'Nearest node incident to an admitted mountain-trail edge (path, footway, steps, track) in the existing frozen block graph.',
        B: 'The existing pedestrian-compatible routing graph is the same admitted trail graph as A; no broader road graph is silently admitted, so A and B coincide.',
        C: 'Nearest node incident to a cached admitted public-approach edge (track, service, unclassified, residential, living_street, pedestrian) with current connectorEligible explicit pedestrian permission. This separate evidence set is not added to summit routing.',
        distance: 'Exact haversine distance to actual mapped OSM nodes, not projection onto an edge interior. A node-only attachment preserves the existing router contract.',
        search: 'Expanding bounded spatial-index queries through50000 m; first radius containing a node establishes exact nearest node inside that radius. Missing nodes are censored, not invented.',
        provenance: 'Minimum ascending supporting way ID encountered for each chosen node, with a real adjacent segment and trusted cached edge admission. wayEndpoint refers to that supporting way; it does not prove a physical network dead end.',
        bareRockHypothesis: 'Node proximity can test geometric offset, but these caches do not establish summit landcover or prove that a path genuinely terminates below a bare-rock summit.',
      },
      cacheReuse: { graphIdentityHash: completion.identityHash, graphIdentity: identity, sourceProof,
        extractionUniqueWays: extraction.uniqueWays, graphBlocksReused: 10, graphBlocksBuilt: 0, pbfScans: 0,
        graphCacheLoadMs: round(cacheLoadMs), originalColdGraphPreparationMs: completion.elapsedMs,
        persistentCachesOpenedReadOnly: true, temporaryConnectorIndex: 'In-memory SQLite only', persistentFileStatsBefore: initialStats },
      summaries: {
        all100: summary(records, 'A_admittedMountainTrailNode'),
        failure62A: summary(failures, 'A_admittedMountainTrailNode'),
        failure62B: summary(failures, 'B_pedestrianCompatibleGraphNode'),
        failure62C: summary(failures, 'C_safeApproachConnectorNode'),
        sparse30A: summary(records.filter(record => record.stratum === 'SPARSE'), 'A_admittedMountainTrailNode'),
      },
      performance: { elapsedMs: round(performance.now() - started), nearestAdmittedNodeP50Ms: quantile(nodeQueryTimes, 0.5),
        nearestAdmittedNodeP95Ms: quantile(nodeQueryTimes, 0.95), sourceWaysInspected, approachNodeMemberships, perBlockTiming },
      noRouteGenerationPerformed: true, noPolicySelected: true, productionWrites: 0, externalRequests: 0,
      records,
    };
    for (const prior of initialStats) {
      assert.equal(statSync(prior.path).size, prior.sizeBytes, 'READONLY_CACHE_SIZE_CHANGED');
      assert.equal(statSync(prior.path).mtimeMs, prior.modifiedMs, 'READONLY_CACHE_TIMESTAMP_CHANGED');
    }
    const path = `${OUT}/adaptive-start-summit-snap-diagnostic.json`;
    writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: 'DIAGNOSTIC_COMPLETE', path, sha256: fileHash(path),
      summaries: diagnostic.summaries, performance: diagnostic.performance }));
  } finally { temporary.close(); source.close(); cache.close(); }
}

main();
