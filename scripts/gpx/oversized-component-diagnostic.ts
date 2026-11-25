/** Read-only oversized-component diagnostic; never builds graphs or generates routes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { INCLUDED_TRAIL_HIGHWAYS, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { evaluatePedestrianAccess } from '../osm-import/phase11c9-road-safety.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import type { AdaptivePilotCorpus } from './adaptive-start-pilot-prepare.ts';

const OUT = 'data/gpx/adaptive-start-pilot';
const VERSION = 'mountain-tracker/oversized-component-diagnostic/v1';
const CURRENT_COMPONENT_NODE_LIMIT = 150_000;
const CURRENT_COMPONENT_WAY_LIMIT = 50_000;
const PILOT_GRAPH_LIMITS = { summitSnapCandidates: 10_000 };
const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};
function load<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
function fileHash(path: string | URL): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function readMetadata<T>(db: DatabaseSync, key: string): T { const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); assert(row, `REQUIRED_METADATA_MISSING:${key}`); return JSON.parse(String(row.value)) as T; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function quantile(sorted: number[], p: number): number | null { return sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null; }
function haversine(a: [number, number], b: [number, number]): number { return calculateCoordinateDistanceMeters(a, b); }

interface V2Row {
  mountainId: string; stratum: string; name: string; blockId: string;
  status: string; graphStatus: string; reasons: string[];
  summitAttachment: unknown; graphStats: { componentNodes: number; componentWays: number; snapDistanceM: number | null } | null;
}

interface ComponentRecord {
  blockId: string; componentId: number; nodeCount: number; wayCount: number;
  bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  lonSpanDegrees: number; latSpanDegrees: number; lonSpanMeters: number; latSpanMeters: number;
  rawEdgeEstimate: number; admittedEdgeEstimate: number;
  approachNodeCount: number; motorwayWayCount: number;
  hypothesis: string;
  constituentMountains: Array<{ mountainId: string; stratum: string; snapDistanceM: number | null }>;
}

async function main(): Promise<void> {
  const started = performance.now();
  const corpus = load<AdaptivePilotCorpus>(`${OUT}/adaptive-start-pilot-corpus.json`);
  const { corpusHash, ...corpusPayload } = corpus;
  assert.equal(sha256Stable(corpusPayload), corpusHash, 'FROZEN_CORPUS_HASH_MISMATCH');
  const v2Rows = load<V2Row[]>(`${OUT}/adaptive-start-pilot-summit-v2-results.json`);
  assert.equal(v2Rows.length, 100);

  const graphPath = `${OUT}/cache/${corpusHash}-graphs.sqlite`;
  const extractionPath = `${OUT}/cache/${corpusHash}.sqlite`;
  const initialStats = [graphPath, extractionPath].map(p => ({ path: p, sizeBytes: statSync(p).size, modifiedMs: statSync(p).mtimeMs }));
  const graphCache = new ReadOnlyDatabase(graphPath, { readOnly: true });
  const extraction = new ReadOnlyDatabase(extractionPath, { readOnly: true });

  try {
    const graphIdentity = readMetadata<Record<string, unknown>>(graphCache, 'identity');
    const completion = readMetadata<{ identityHash: string; blocks: unknown[]; elapsedMs: number }>(graphCache, 'complete');
    const extractionMeta = readMetadata<{ identity: { corpusHash: string }; uniqueWays: number }>(extraction, 'complete');
    assert.equal((graphIdentity as Record<string, unknown>).requestedIdentityHash, corpusHash);
    assert.equal(extractionMeta.identity.corpusHash, corpusHash);

    // Identify oversized component-limit rows from v2 results.
    const componentLimitRows = v2Rows.filter(r => r.graphStatus === 'GRAPH_COMPONENT_LIMIT' && r.reasons.includes('SHARED_COMPONENT_EXCEEDS_FROZEN_MEMORY_BOUND'));
    assert.equal(componentLimitRows.length, 36, 'V2_COMPONENT_LIMIT_COUNT_DRIFT');

    // Group by block+component using the nearest-attachment component from v2 graphStats.
    // For component-limit rows, selectedAttachmentNode is present in the row (via summitAttachment? No - v2 stores null summitAttachment).
    // Actually v2 row graphStats.componentNodes/Ways are set but componentId is NOT stored in v2 results directly.
    // Instead, query component_nodes spatially: for each blocked mountain's summit, find the nearest component node within 100m.
    const blockedByComponent = new Map<string, { blockId: string; componentId: number; mountains: V2Row[] }>();
    const mountainById = new Map(corpus.mountains.map(m => [m.mountainId, m]));

    for (const row of componentLimitRows) {
      const mountain = mountainById.get(row.mountainId)!;
      const [lon, lat] = mountain.summit.coordinate;
      // Find nearest admitted edge node within 100m → component ID.
      const r100 = 100 / 110_000;
      const lonR = r100 / Math.cos(lat * Math.PI / 180);
      const nodes = graphCache.prepare(
        `SELECT node,component,lon,lat FROM component_nodes WHERE block=? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT ${PILOT_GRAPH_LIMITS.summitSnapCandidates + 1}`
      ).all(row.blockId, lon - lonR, lon + lonR, lat - r100, lat + r100) as Array<{ node: number; component: number; lon: number; lat: number }>;
      assert(nodes.length <= PILOT_GRAPH_LIMITS.summitSnapCandidates, 'SPATIAL_CANDIDATE_OVERFLOW');
      const selected = nodes
        .map(n => ({ ...n, distance: haversine([lon, lat], [n.lon, n.lat]) }))
        .filter(n => n.distance <= 100)
        .sort((a, b) => a.distance - b.distance || a.node - b.node)[0];
      assert(selected, `NO_NODE_WITHIN_100M_FOR_BLOCKED_MOUNTAIN:${row.mountainId}`);

      const key = `${row.blockId}:${selected.component}`;
      const existing = blockedByComponent.get(key);
      if (existing) existing.mountains.push(row);
      else blockedByComponent.set(key, { blockId: row.blockId, componentId: selected.component, mountains: [row] });
    }

    console.log(JSON.stringify({ status: 'OVERSIZED_COMPONENTS_IDENTIFIED', count: blockedByComponent.size }));

    // Load feature index for candidate-start counts.
    const featureStarted = performance.now();
    const features = new AdaptiveStartFeatureIndex(await loadPhase11f2FeatureIndex('data/osm/alps/staging/phase11f2-features'));
    const featureLoadMs = performance.now() - featureStarted;

    const readWay = extraction.prepare('SELECT payload FROM ways WHERE id=?');
    const components: ComponentRecord[] = [];
    const allNodeCounts: number[] = [], allWayCounts: number[] = [], allEdgeEstimates: number[] = [];

    for (const [, group] of blockedByComponent) {
      const { blockId, componentId, mountains } = group;
      // Component size from components table.
      const size = graphCache.prepare('SELECT nodes,ways FROM components WHERE block=? AND component=?').get(blockId, componentId) as { nodes: number; ways: number };

      // Bbox from component_nodes.
      const bboxRow = graphCache.prepare(
        `SELECT MIN(lon) minLon, MAX(lon) maxLon, MIN(lat) minLat, MAX(lat) maxLat FROM component_nodes WHERE block=? AND component=?`
      ).get(blockId, componentId) as { minLon: number; maxLon: number; minLat: number; maxLat: number };
      const lonSpanDeg = bboxRow.maxLon - bboxRow.minLon;
      const latSpanDeg = bboxRow.maxLat - bboxRow.minLat;
      const midLat = (bboxRow.minLat + bboxRow.maxLat) / 2;
      const lonSpanM = lonSpanDeg * 111_320 * Math.cos(midLat * Math.PI / 180);
      const latSpanM = latSpanDeg * 110_540;

      // Approach node count within this component.
      const approachCount = (graphCache.prepare(
        `SELECT COUNT(DISTINCT a.node) cnt FROM approach_nodes a JOIN component_nodes n ON n.block=a.block AND n.node=a.node WHERE a.block=? AND n.component=?`
      ).get(blockId, componentId) as { cnt: number }).cnt;

      // Motorway ways in the block.
      const motorwayCount = (graphCache.prepare('SELECT COUNT(*) cnt FROM motorway_ways WHERE block=?').get(blockId) as { cnt: number }).cnt;

      // Load component ways, estimate edges.
      const wayIds = graphCache.prepare('SELECT way FROM component_ways WHERE block=? AND component=? ORDER BY way').all(blockId, componentId) as { way: number }[];
      let rawEdgeEstimate = 0, admittedEdgeEstimate = 0;
      const highwayCounts: Record<string, number> = {};
      for (const { way: wayId } of wayIds) {
        const row = readWay.get(wayId);
        assert(row, `WAY_MISSING_FROM_EXTRACTION:${wayId}`);
        const way = JSON.parse(String(row.payload)) as OsmTrailWayInput;
        const hw = (way.tags.highway ?? '').trim().toLowerCase();
        highwayCounts[hw] = (highwayCounts[hw] ?? 0) + 1;
        const validPairs = Math.max(0, way.nodes.filter(n => n.coordinate).length - 1);
        rawEdgeEstimate += validPairs;
        // Quick admitted-edge estimate: included trail highway + not forbidden/ambiguous + not impassable.
        if (INCLUDED_TRAIL_HIGHWAYS.has(hw)) {
          const access = evaluatePedestrianAccess({ ...way.tags });
          if (access === 'ALLOWED' && way.tags.smoothness !== 'impassable') admittedEdgeEstimate += validPairs;
        }
      }

      // Per-mountain candidate start feature counts within tiers (10/20/35/50km).
      const mountainFeatures = mountains.map(m => {
        const mt = mountainById.get(m.mountainId)!;
        const tiers = [10_000, 20_000, 35_000, 50_000];
        const counts = tiers.map(r => features.queryStarts(mt.summit.coordinate, r).length);
        return { mountainId: m.mountainId, stratum: m.stratum, snapDistanceM: m.graphStats?.snapDistanceM ?? null, featuresInTiers: Object.fromEntries(tiers.map((t, i) => [`${t / 1000}km`, counts[i]])) };
      });

      // Root cause hypothesis.
      let hypothesis: string;
      const ratio = size.nodes / CURRENT_COMPONENT_NODE_LIMIT;
      if (ratio > 4) hypothesis = 'GENUINELY_MASSIVE_NETWORK — component is a large connected pedestrian trail network spanning most of the extraction block; summit-centered 50km envelope covers most but not all of the component; full component load is the correct approach for global routing correctness';
      else if (ratio > 2) hypothesis = 'LARGE_NETWORK — component is significantly above the artificial limit but not enormous; full component load within bounded memory budgets';
      else hypothesis = 'MODERATELY_ABOVE_LIMIT — component is only slightly above the frozen memory bound; the artificial limit could be raised safely';

      const record: ComponentRecord = {
        blockId, componentId, nodeCount: size.nodes, wayCount: size.ways,
        bbox: bboxRow, lonSpanDegrees: round(lonSpanDeg), latSpanDegrees: round(latSpanDeg),
        lonSpanMeters: Math.round(lonSpanM), latSpanMeters: Math.round(latSpanM),
        rawEdgeEstimate, admittedEdgeEstimate, approachNodeCount: approachCount,
        motorwayWayCount: motorwayCount, hypothesis,
        constituentMountains: mountainFeatures.map(f => ({
          mountainId: f.mountainId, stratum: f.stratum, snapDistanceM: f.snapDistanceM,
        })),
      };
      components.push(record);
      allNodeCounts.push(size.nodes);
      allWayCounts.push(size.ways);
      allEdgeEstimates.push(admittedEdgeEstimate);
      console.log(JSON.stringify({ status: 'COMPONENT_DIAGNOSED', blockId, componentId, nodes: size.nodes, ways: size.ways,
        estimatedEdges: admittedEdgeEstimate, bboxDimM: `${Math.round(lonSpanM)}x${Math.round(latSpanM)}` }));
    }

    allNodeCounts.sort((a, b) => a - b);
    allWayCounts.sort((a, b) => a - b);
    allEdgeEstimates.sort((a, b) => a - b);

    const summary = {
      totalOversizedComponents: components.length,
      totalBlockedMountains: componentLimitRows.length,
      distributions: {
        nodes: { min: allNodeCounts[0], p50: quantile(allNodeCounts, 0.5), p75: quantile(allNodeCounts, 0.75), p90: quantile(allNodeCounts, 0.9), p95: quantile(allNodeCounts, 0.95), max: allNodeCounts.at(-1) },
        ways: { min: allWayCounts[0], p50: quantile(allWayCounts, 0.5), p75: quantile(allWayCounts, 0.75), p90: quantile(allWayCounts, 0.9), p95: quantile(allWayCounts, 0.95), max: allWayCounts.at(-1) },
        estimatedEdges: { min: allEdgeEstimates[0], p50: quantile(allEdgeEstimates, 0.5), p75: quantile(allEdgeEstimates, 0.75), p90: quantile(allEdgeEstimates, 0.9), p95: quantile(allEdgeEstimates, 0.95), max: allEdgeEstimates.at(-1) },
      },
      currentLimits: { componentNodes: CURRENT_COMPONENT_NODE_LIMIT, componentWays: CURRENT_COMPONENT_WAY_LIMIT },
      rootCauseSummary: {
        genuinelyMassive: components.filter(c => c.hypothesis.includes('GENUINELY_MASSIVE')).length,
        large: components.filter(c => c.hypothesis.includes('LARGE_NETWORK')).length,
        moderateAboveLimit: components.filter(c => c.hypothesis.includes('MODERATELY_ABOVE_LIMIT')).length,
      },
    };

    const diagnostic = {
      schemaVersion: VERSION, corpusHash,
      graphCacheReuse: { identityHash: completion.identityHash, blocksReused: (completion.blocks as unknown[]).length, cacheLoadMs: 0, persistentCachesReadOnly: true },
      featureLoadMs: Math.round(featureLoadMs),
      summary, components,
      noGraphBuildsPerformed: true, noPolicySelected: true,
      productionWrites: 0, externalRequests: 0,
      performance: { elapsedMs: Math.round(performance.now() - started) },
    };

    // Verify caches unchanged.
    for (const prior of initialStats) {
      assert.equal(statSync(prior.path).size, prior.sizeBytes, 'READONLY_CACHE_SIZE_CHANGED');
      assert.equal(statSync(prior.path).mtimeMs, prior.modifiedMs, 'READONLY_CACHE_TIMESTAMP_CHANGED');
    }

    const outPath = `${OUT}/oversized-component-diagnostic.json`;
    writeFileSync(outPath, `${JSON.stringify(diagnostic, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ status: 'DIAGNOSTIC_COMPLETE', path: outPath, sha256: fileHash(outPath), summary, performance: diagnostic.performance }));
  } finally { extraction.close(); graphCache.close(); }
}

main().catch(err => { console.error(err); process.exit(1); });
