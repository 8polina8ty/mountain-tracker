import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { buildOsmTrailGraph, HIKING_COST_VERSION, OSM_TRAIL_GRAPH_CONTRACT_VERSION, type OsmTrailWayInput, type OsmTrailGraph } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { reconstructOsmRoute, toPhase11ComparableRoute, OSM_ROUTE_SOLVER_VERSION, type GraphSearchDiagnostics } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import { OSM_ANCHOR_RESOLUTION_VERSION } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { compareRoutes, type ComparableRoute, type RouteSimilarityResult } from '../osm-import/route-similarity.ts';
import { classifyStartContextV2, type FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { analyzeRouteRoadSafety, type RoadSafetyWay } from '../osm-import/phase11c9-road-safety.ts';
import { OUTPUT, TAXONOMY, readJson, writeImmutable, type Corpus, type Plan, type Member } from './phase12d-calibration.ts';

export interface EvaluationRecord {
  relationId: string; signalCreated: boolean; startResolved: boolean; summitResolved: boolean; allAnchorsResolved: boolean;
  graphReady: boolean; solved: boolean; failure: string; similarity: RouteSimilarityResult | null;
  graph: { hash: string; nodes: number; edges: number; includedWays: number; exclusions: Record<string, number> } | null;
  routeHash: string | null; manifestHash: string | null; visitedNodes: number[];
  reconstructionReasons: string[]; snapDistancesM: number[]; excludedDirectTruthMembers: Record<string, number> | null;
  startContext: string | null; safetyReasons: string[]; roadSafety: string | null;
  intrinsicAutoCompatible: boolean; autoCompatible: boolean; frozenVetoes: string[];
  determinismVerified: boolean; diagnosticOnly: false;
}
interface Shard { identityHash: string; resultHash: string; result: EvaluationRecord; performance: { totalMs: number; graphBuildMs: number; reconstructionMs: number; rssBytes: number } }
const ACCEPTABLE = new Set(['EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'SAME_VARIANT']);
const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};
const dataset = { datasetKey: 'openstreetmap-odbl-geofabrik-alps', region: 'alps', snapshotTimestamp: '2026-08-24T21:21:08.000Z',
  pbfSha256: '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5' };
const countBy = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(k => [k, values.filter(v => v === k).length]));
function connected(graph: OsmTrailGraph, from: number, to: number): boolean {
  const seen = new Set([from]), queue = [from];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === to) return true;
    for (const edge of graph.neighbors(queue[i])) {
      if (!seen.has(edge.toNodeId)) { seen.add(edge.toNodeId); queue.push(edge.toNodeId); }
    }
  }
  return false;
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, max: sorted.at(-1) ?? null };
};
export function summarize(records: EvaluationRecord[]) {
  const total = records.length;
  const rate = (n: number, denominator = total) => ({ count: n, denominator, rate: denominator ? n / denominator : null });
  const signals = records.filter(r => r.signalCreated).length;
  const resolved = records.filter(r => r.allAnchorsResolved).length;
  const solved = records.filter(r => r.solved).length;
  const acceptable = records.filter(r => r.similarity && ACCEPTABLE.has(r.similarity.classification)).length;
  return { total, usableSignal: rate(signals), startAnchor: rate(records.filter(r => r.startResolved).length, signals),
    summitAnchor: rate(records.filter(r => r.summitResolved).length, signals), allAnchors: rate(resolved, signals),
    solverSuccess: rate(solved, resolved), acceptableMatch: rate(acceptable), acceptableAmongSolved: rate(acceptable, solved),
    differentVariant: rate(records.filter(r => r.similarity?.classification === 'DIFFERENT_VARIANT').length),
    unrelated: rate(records.filter(r => r.similarity?.classification === 'UNRELATED').length),
    autoCompatible: rate(records.filter(r => r.autoCompatible).length), failures: countBy(records.map(r => r.failure)),
    safetyReasons: countBy(records.flatMap(r => r.safetyReasons)) };
}
export function matrices(members: Member[], results: EvaluationRecord[]) {
  const rows = members.map(m => ({ m, r: results.find(r => r.relationId === m.relationId)! })).filter(x => x.r);
  const band = (v: number | null, limits: number[]) => v === null ? 'UNKNOWN' : `${limits.find(x => v < x) ?? 'PLUS'}_UPPER`;
  const keys: Record<string, (m: Member, r: EvaluationRecord) => string> = {
    startContext: m => m.labels.startContext, qualityBand: m => m.labels.qualityBand,
    nameSignal: (m, r) => `${m.facts.relationTags.name ? 'NAMED' : 'MISSING_NAME'}/${r.signalCreated ? 'USABLE' : 'INSUFFICIENT'}`,
    distanceBandM: m => band(m.labels.distanceM, [2000, 5000, 10000, 20000]),
    verticalGainBandM: m => band(m.labels.verticalGainM, [500, 1000, 1500]),
    semanticAnchorCount: (_, r) => r.signalCreated ? '2' : '0',
    graphSize: (_, r) => r.graph ? band(r.graph.nodes, [10000, 50000, 100000]) : 'NOT_BUILT',
  };
  return Object.fromEntries(Object.entries(keys).map(([name, getKey]) => [name,
    Object.fromEntries([...new Set(rows.map(({ m, r }) => getKey(m, r)))].sort().map(k => [k,
      { ...summarize(rows.filter(({ m, r }) => getKey(m, r) === k).map(x => x.r)), smallStratum: rows.filter(({ m, r }) => getKey(m, r) === k).length < 5 }]))]));
}
async function localFeatures(plan: Plan): Promise<{ index: FeatureIndex; hash: string }> {
  const files = { alpineHuts: 'alpine-huts', wildernessHuts: 'wilderness-huts', parking: 'parking', trainStations: 'stations',
    halts: 'halts', busStops: 'bus-stops', trailheads: 'trailheads', villages: 'villages', hamlets: 'hamlets',
    isolatedDwellings: 'isolated-dwellings', farms: 'farms', saddles: 'saddles', mountainPasses: 'mountain-passes',
    ridges: 'ridges', peaks: 'peaks', trailheadInfo: 'trailhead-info', eleNodes: 'ele-nodes' };
  const starts = plan.records.flatMap(r => r.start?.anchor ? [r.start.anchor.coordinate] : []);
  const index = {} as FeatureIndex;
  const hashes: Record<string, string> = {};
  for (const [key, file] of Object.entries(files)) {
    const bytes = await readFile(`data/osm/alps/staging/phase11f2-features/${file}.json`);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
    const records = JSON.parse(bytes.toString('utf8')) as Array<FeatureIndex['peaks'][number] & { ele?: number }>;
    index[key as keyof FeatureIndex] = records.filter(r => r.coordinate && starts.some(c =>
      Math.abs(c[0] - r.coordinate![0]) <= .03 && Math.abs(c[1] - r.coordinate![1]) <= .02)).map(r => key === 'eleNodes'
        ? { ...r, objectType: 'node', tags: { ele: String(r.ele) }, wayNodeCount: null } : r);
  }
  return { index, hash: sha256Stable(hashes) };
}

async function main() {
  const mode = process.argv[2] ?? 'baseline';
  if (!['baseline', 'final', 'experiment'].includes(mode)) throw new Error('Expected baseline, experiment, or final');
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  const pbfHash = createHash('sha256');
  for await (const chunk of createReadStream('data/osm/source/alps-latest.osm.pbf')) pbfHash.update(chunk);
  assert.equal(pbfHash.digest('hex'), dataset.pbfSha256, 'PHASE12D_DATASET_IDENTITY_MISMATCH');
  let selection: { configuration: string; options: Record<string, number>; qualifierFallback?: boolean } = { configuration: 'baseline-v1', options: {} };
  if (mode === 'final') selection = await readJson(`${OUTPUT}/phase12d-selected-configuration.json`);
  if (mode === 'experiment') {
    await readJson(`${OUTPUT}/phase12d-baseline.json`);
    const specifications = await readJson<Array<typeof selection>>(`${OUTPUT}/phase12d-experiment-grid.json`);
    assert(specifications.length <= 50, 'PARAMETER_SEARCH_BOUND');
    const selected = specifications.find(s => s.configuration === process.argv[3]);
    assert(selected, 'UNKNOWN_CONFIGURATION'); selection = selected;
  }
  const plan = await readJson<Plan>(`${OUTPUT}/phase12d-semantic-plan${selection.qualifierFallback ? '-v2' : ''}.json`);
  assert.equal(plan.identity.corpusHash, sha256Stable(corpus));
  const cache = new ReadOnlyDatabase(`${OUTPUT}/cache/${plan.planHash}.sqlite`, { readOnly: true });
  const metadata = cache.prepare("SELECT value FROM metadata WHERE key='complete'").get() as { value: string } | undefined;
  assert(metadata, 'INCOMPLETE_EXTRACTION');
  assert.equal(JSON.parse(metadata.value).planHash, plan.planHash);
  const truthDb = new ReadOnlyDatabase('data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite', { readOnly: true });
  const { index, hash: featureHash } = await localFeatures(plan);
  const sourceFiles = ['Lib/gpxIngestion/osmTrailGraph.ts', 'Lib/gpxIngestion/osmRouteReconstruction.ts', 'Lib/gpxIngestion/osmAnchorResolution.ts',
    'Lib/gpxIngestion/routeDiscovery.ts', 'Lib/gpxIngestion/gpxNormalization.ts', 'Lib/gpxIngestion/hashing.ts',
    'scripts/osm-import/route-similarity.ts', 'scripts/osm-import/route-geometry.ts', 'scripts/osm-import/phase11c9-road-safety.ts',
    'scripts/osm-import/start-context-classifier3.ts', 'scripts/gpx/phase12d-calibration.ts', 'scripts/gpx/phase12d-run.ts',
    'scripts/gpx/phase12d-prepare.py', 'scripts/gpx/phase12d-extract.py'];
  const sourceHashes: Record<string, string> = {};
  for (const file of sourceFiles) sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  for (const file of [`${OUTPUT}/cache/${plan.planHash}.sqlite`, 'data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite']) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    sourceHashes[file] = hash.digest('hex');
  }
  const identity = { ...plan.identity, planHash: plan.planHash, featureHash, graphVersion: OSM_TRAIL_GRAPH_CONTRACT_VERSION,
    resolverVersion: OSM_ANCHOR_RESOLUTION_VERSION, solverVersion: OSM_ROUTE_SOLVER_VERSION, costVersion: HIKING_COST_VERSION,
    selection, sourceHashes, measurementVersion: 'phase12d/measurement/v1' };
  const identityHash = sha256Stable(identity);
  const dir = `${OUTPUT}/checkpoints/${mode}-${identityHash.slice(0, 16)}`;
  await mkdir(dir, { recursive: true });
  await writeImmutable(`${dir}/identity.json`, identity);
  let resumed = 0, graphBuilds = 0;
  const shards: Shard[] = [];
  const sourceDatasetIdentity = (await readJson<{ sourceDatasetIdentity: Parameters<typeof analyzeRouteRoadSafety>[0]['sourceDatasetIdentity'] }>(
    'data/osm/alps/publication/phase11c9-road-safety-eligible-pool-103.json')).sourceDatasetIdentity;
  const members = corpus.records.filter(m => mode !== 'experiment' || m.split === 'TRAIN');
  for (const member of members) {
    const checkpoint = `${dir}/${member.relationId}.json`;
    try {
      const shard = await readJson<Shard>(checkpoint);
      assert.equal(shard.identityHash, identityHash); assert.equal(shard.resultHash, sha256Stable(shard.result));
      shards.push(shard); resumed++; continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const startTime = performance.now(); let graphMs = 0, routeMs = 0;
    const item = plan.records.find(r => r.relationId === member.relationId)!;
    const result: EvaluationRecord = { relationId: member.relationId, signalCreated: !!item.signal,
      startResolved: item.start?.status === 'RESOLVED', summitResolved: item.summit?.status === 'RESOLVED',
      allAnchorsResolved: !!item.bbox, graphReady: false, solved: false, failure: 'SIGNAL_INSUFFICIENT', similarity: null,
      graph: null, routeHash: null, manifestHash: null, visitedNodes: [], startContext: null, safetyReasons: [], roadSafety: null,
      reconstructionReasons: [], snapDistancesM: [], excludedDirectTruthMembers: null,
      intrinsicAutoCompatible: false, autoCompatible: false, frozenVetoes: member.negativeReasons,
      determinismVerified: true, diagnosticOnly: false };
    try {
      if (item.signal) {
        result.failure = item.start?.status !== 'RESOLVED' ? `ANCHOR_START_${item.start?.status ?? 'NOT_FOUND'}` :
          item.summit?.status !== 'RESOLVED' ? `ANCHOR_SUMMIT_${item.summit?.status ?? 'NOT_FOUND'}` : 'NO_ROUTE';
      }
      if (item.bbox && item.signal && item.start?.anchor && item.summit?.anchor) {
        const ways = (cache.prepare('SELECT w.payload FROM ways w JOIN region_ways r ON w.id=r.way WHERE r.region=? ORDER BY w.id')
          .all(member.relationId) as { payload: string }[]).map(r => JSON.parse(r.payload) as OsmTrailWayInput);
        const graphStarted = performance.now();
        const graph = buildOsmTrailGraph(dataset, ways); graphBuilds++;
        graphMs = performance.now() - graphStarted;
        result.graph = { hash: graph.graphHash, nodes: graph.nodes.size, edges: graph.edges.length,
          includedWays: new Set(graph.edges.map(e => e.wayId)).size, exclusions: countBy(graph.exclusions.map(e => e.reason)) };
        result.graphReady = graph.nodes.size > 0;
        const peak = truthDb.prepare("SELECT json_extract(payload,'$.elevationMeters') AS elevation FROM peaks WHERE id=?")
          .get(Number(member.facts.summits[0].id)) as { elevation: number | null } | undefined;
        const context = classifyStartContextV2([item.start.anchor.coordinate[0], item.start.anchor.coordinate[1]],
          [item.summit.anchor.coordinate[0], item.summit.anchor.coordinate[1]], peak?.elevation ?? null, index);
        result.startContext = context.type;
        if (context.type === 'HIGH_MOUNTAIN_START') result.safetyReasons.push('START_HIGH_MOUNTAIN');
        if (context.type === 'AMBIGUOUS_START') result.safetyReasons.push('START_AMBIGUOUS');
        const diagnostics: GraphSearchDiagnostics[] = [];
        const input = { signal: item.signal, anchors: { start: item.start, summit: item.summit, vias: [] },
          graph, startContext: context.type, options: selection.options };
        const routeStarted = performance.now();
        const reconstruction = reconstructOsmRoute({ ...input, diagnostics });
        routeMs = performance.now() - routeStarted;
        result.visitedNodes = diagnostics.map(d => d.visitedNodes);
        result.reconstructionReasons = reconstruction.reasons;
        // Rerun solver and graph with reversed input ordering; neither sees comparison truth.
        assert.deepEqual(reconstructOsmRoute(input), reconstruction, 'NONDETERMINISTIC_SOLVER');
        assert.equal(buildOsmTrailGraph(dataset, [...ways].reverse()).graphHash, graph.graphHash, 'NONDETERMINISTIC_GRAPH');
        if (!reconstruction.route) {
          result.failure = !result.graphReady ? 'GRAPH_REGION_EMPTY' : reconstruction.reasons.some(r => r.includes('SNAP_THRESHOLD'))
            ? 'SNAP_FAILED' : diagnostics.some(d => d.outcome === 'SEARCH_LIMIT_EXCEEDED') ? 'SEARCH_LIMIT_EXCEEDED' : 'NO_ROUTE';
          if (result.failure === 'NO_ROUTE') {
            const from = graph.findNearestNode(item.start.anchor.coordinate, selection.options.maximumAnchorSnapDistanceM ?? 75);
            const to = graph.findNearestNode(item.summit.anchor.coordinate, selection.options.maximumSummitSnapDistanceM ?? 30);
            if (from && to && !connected(graph, from.node.nodeId, to.node.nodeId)) result.failure = 'GRAPH_DISCONNECTED';
          }
        } else {
          const route = reconstruction.route;
          result.solved = true; result.routeHash = route.geometryHash; result.manifestHash = route.reconstructionManifestHash;
          result.snapDistancesM = route.snapDistancesM;
          // First and only geometry truth access: strictly after independent reconstruction.
          const truthRow = truthDb.prepare('SELECT payload FROM routes WHERE id=?').get(member.relationId) as { payload: string } | undefined;
          assert(truthRow, 'MISSING_FROZEN_TRUTH');
          const truth = JSON.parse(truthRow.payload) as { name: string | null; geometry: ComparableRoute['geometry'] };
          result.similarity = compareRoutes(toPhase11ComparableRoute(route, member.facts.summits[0].id), {
            sourceId: member.relationId, name: truth.name || member.relationId, geometry: truth.geometry,
            summitEvidence: { confirmedPeakIds: member.facts.summits.map(s => s.id), associatedPeakIds: member.facts.summits.map(s => s.id) } });
          // Label-side limitation diagnostic, after solving; never fed back into the graph or solver.
          const relation = truthDb.prepare("SELECT json_extract(payload,'$.members') AS members FROM relations WHERE id=?")
            .get(Number(member.relationId)) as { members: string } | undefined;
          const directWayIds = new Set(relation ? (JSON.parse(relation.members) as { type: string; ref: number }[])
            .filter(m => m.type === 'way').map(m => m.ref) : []);
          result.excludedDirectTruthMembers = countBy(graph.exclusions.filter(e => directWayIds.has(e.wayId)).map(e => e.reason));
          const mapping = { EXACT_DUPLICATE: 'MATCH_EXACT', NEAR_DUPLICATE: 'MATCH_NEAR', SAME_VARIANT: 'MATCH_SAME_VARIANT',
            DIFFERENT_VARIANT: 'MATCH_DIFFERENT_VARIANT', UNRELATED: 'MATCH_UNRELATED' };
          result.failure = mapping[result.similarity.classification];
          // Reuse Phase 11 access AND grade-separated motorway-crossing checks.
          const routeWays: RoadSafetyWay[] = route.osmNodeIds.slice(1).map((to, i) => {
            const from = route.osmNodeIds[i];
            const edge = graph.neighbors(from).find(e => e.toNodeId === to && route.osmWayIds.includes(e.wayId));
            assert(edge, 'MISSING_TRAVERSED_EDGE');
            const source = ways.find(w => w.id === edge.wayId)!;
            return { id: edge.wayId, tags: { ...source.tags }, nodes: [from, to].map(nodeId => {
              const coordinate = graph.node(nodeId)!.coordinate;
              return { nodeId, coordinate: [coordinate[0], coordinate[1]] };
            }) };
          });
          const nearbyMotorwayWays: RoadSafetyWay[] = ways.filter(w => ['motorway', 'motorway_link'].includes(w.tags.highway))
            .filter(w => w.nodes.every(n => n.coordinate)).map(w => ({ id: w.id, tags: { ...w.tags },
              nodes: w.nodes.map(n => ({ nodeId: n.nodeId, coordinate: [n.coordinate![0], n.coordinate![1]] })) }));
          const safety = analyzeRouteRoadSafety({ canonicalRelationId: member.relationId, stagingRouteId: 'offline-only',
            routeType: 'hiking', routeWays, nearbyMotorwayWays, sourceDatasetIdentity });
          result.roadSafety = safety.status;
          result.safetyReasons.push(...safety.reasonCodes);
          result.intrinsicAutoCompatible = ['BASE_START', 'HUT_START'].includes(context.type) && safety.status === 'SAFE'
            && safety.reasonCodes.length === 0 && ACCEPTABLE.has(result.similarity.classification);
          result.autoCompatible = result.intrinsicAutoCompatible && member.negativeReasons.length === 0;
        }
      }
    } catch (error) {
      result.failure = 'INTERNAL_ERROR'; result.safetyReasons.push((error as Error).message);
      result.determinismVerified = false; result.autoCompatible = false;
    }
    assert(TAXONOMY.includes(result.failure as typeof TAXONOMY[number]), result.failure);
    const shard: Shard = { identityHash, resultHash: sha256Stable(result), result,
      performance: { totalMs: performance.now() - startTime, graphBuildMs: graphMs, reconstructionMs: routeMs, rssBytes: process.memoryUsage().rss } };
    await writeFile(`${checkpoint}.partial`, JSON.stringify(shard, null, 2) + '\n');
    await rename(`${checkpoint}.partial`, checkpoint);
    shards.push(shard);
    if (shards.length % 20 === 0) console.log(`${mode}: checkpointed ${shards.length}/${corpus.records.length}`);
  }
  cache.close(); truthDb.close();
  const results = shards.map(s => s.result);
  const select = (predicate: (m: Member) => boolean) => results.filter(r => corpus.records.some(m => m.relationId === r.relationId && predicate(m)));
  const report = { schemaVersion: 'phase12d/evaluation/v1', mode, identity, identityHash, checkpointDirectory: dir,
    denominatorPolicy: 'Signal rate per corpus; anchors per usable signal; solver per all-resolved; matches per corpus and per solved.',
    humanGold: summarize(select(m => m.humanApproved)), training: summarize(select(m => m.split === 'TRAIN')),
    holdout: summarize(select(m => m.split === 'HOLDOUT')), extendedMachineGreen: summarize(select(m => m.machineGreen)),
    negatives: { ...summarize(select(m => m.negativeReasons.length > 0)),
      intrinsicFalseAcceptsBeforeFrozenVeto: select(m => m.negativeReasons.length > 0).filter(r => r.intrinsicAutoCompatible).length },
    matrices: { humanGold: matrices(corpus.records.filter(m => m.humanApproved), results), extended: matrices(corpus.records.filter(m => m.machineGreen), results) },
    determinism: { checked: results.length, passed: results.filter(r => r.determinismVerified).length,
      scope: 'Every signal outcome checkpoint; every executed solver repeated and every built graph rebuilt from reversed way ordering. Failed pre-solver records use deterministic frozen plan.' },
    performance: { graphBuilds: results.filter(r => r.graph).length, determinismGraphRebuilds: results.filter(r => r.graph).length,
      graphCacheHits: 0, reconstructionMs: stats(shards.filter(s => s.result.allAnchorsResolved).map(s => s.performance.reconstructionMs)),
      routePipelineMs: stats(shards.map(s => s.performance.totalMs)), visitedNodes: stats(results.flatMap(r => r.visitedNodes)),
      largestRegionalGraph: Math.max(...results.map(r => r.graph?.nodes ?? 0)), sampledPeakRssBytes: Math.max(...shards.map(s => s.performance.rssBytes)) },
    resultsHash: sha256Stable(results), results };
  const reportName = mode === 'baseline' ? 'baseline' : mode === 'final' ? 'final-evaluation' : `experiment-${selection.configuration}`;
  const reportPath = `${OUTPUT}/phase12d-${reportName}.json`;
  if (mode === 'baseline') {
    try {
      const existing = await readJson<{ resultsHash: string }>(reportPath);
      assert.equal(existing.resultsHash, report.resultsHash, 'BASELINE_V1_REPLAY_DRIFT');
      await writeImmutable(`${OUTPUT}/phase12d-baseline-replay.json`, { originalResultsHash: existing.resultsHash,
        replayResultsHash: report.resultsHash, replayIdentityHash: identityHash, checked: results.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeImmutable(reportPath, report);
    }
  } else await writeImmutable(reportPath, report);
  console.log(JSON.stringify({ mode, resumed, actualGraphBuilds: graphBuilds, training: report.training }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
