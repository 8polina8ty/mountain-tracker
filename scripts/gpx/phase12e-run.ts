import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { buildOsmTrailGraph, OSM_TRAIL_GRAPH_CONTRACT_VERSION, LOCAL_CONNECTOR_GRAPH_VERSION, HIKING_COST_VERSION, type OsmTrailGraph, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { reconstructOsmRoute, toPhase11ComparableRoute, OSM_ROUTE_SOLVER_VERSION, type GraphSearchDiagnostics } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import { OSM_ANCHOR_RESOLUTION_VERSION, type OsmAnchorResolution } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { SEMANTIC_EVIDENCE_VERSION } from '../../Lib/gpxIngestion/semanticEvidence.ts';
import { SEMANTIC_NAME_NORMALIZATION_VERSION } from '../../Lib/gpxIngestion/nameNormalization.ts';
import { SEMANTIC_FEATURE_INDEX_VERSION } from '../../Lib/gpxIngestion/semanticFeatureIndex.ts';
import { SEMANTIC_ENTITY_RESOLUTION_VERSION } from '../../Lib/gpxIngestion/semanticEntityResolution.ts';
import { ROUTABLE_ANCHOR_RESOLUTION_VERSION, ACCESS_CONNECTOR_POLICY_VERSION, FEATURE_ACCESS_BOUNDS, nodesReachingSummit, type ResolvedRoutableAnchor } from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { resolveRouteAccess, SEMANTIC_ROUTE_ACCESS_VERSION } from '../../Lib/gpxIngestion/semanticRouteAccess.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { compareRoutes, type ComparableRoute, type RouteSimilarityResult } from '../osm-import/route-similarity.ts';
import { classifyStartContextV2, type FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { analyzeRouteRoadSafety, type RoadSafetyWay } from '../osm-import/phase11c9-road-safety.ts';
import { OUTPUT, readJson, writeImmutable } from './phase12e-calibration.ts';
import type { ECorpus, EMember, EPlan } from './phase12e-evaluation-plan.ts';
import type { EvaluationRecord } from './phase12d-run.ts';

export const CONFIGURATIONS = [
  { id: 'E0-baseline-v1', semantic: false, projection: false, connectors: false },
  { id: 'E1-semantic-v2', semantic: true, projection: false, connectors: false },
  { id: 'E2-routable-projection-v2', semantic: true, projection: true, connectors: false },
  { id: 'E3-local-access-v2', semantic: true, projection: true, connectors: true },
] as const;
type Configuration = typeof CONFIGURATIONS[number];
export interface EResult {
  relationId: string; configuration: string; signalCreated: boolean; entityResolved: boolean;
  routableAnchorResolved: boolean; graphConnected: boolean; solved: boolean; failure: string;
  entityStatus: string; evidenceHash: string | null; projections: ResolvedRoutableAnchor[];
  graph: { hash: string; nodes: number; edges: number } | null;
  routeHash: string | null; manifestHash: string | null; visitedNodes: number[];
  similarity: RouteSimilarityResult | null; startContext: string | null; roadSafety: string | null;
  safetyReasons: string[]; autoCompatible: boolean; intrinsicAutoCompatible: boolean; frozenVetoes: string[];
  determinismVerified: boolean;
}
interface Timing { graphMs: number; anchorMs: number; solverMs: number; totalMs: number; rssBytes: number }
interface Shard { identityHash: string; resultHash: string; result: EResult; timing: Timing }
export const acceptable = (r: { similarity: RouteSimilarityResult | null }) => !!r.similarity && ['EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'SAME_VARIANT'].includes(r.similarity.classification);
export const countBy = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(k => [k, values.filter(v => v === k).length]));
export function metrics(results: EResult[]) {
  return { total: results.length, semanticEvidenceAvailable: results.filter(r => r.signalCreated).length,
    entityResolved: results.filter(r => r.entityResolved).length, routableAnchorResolved: results.filter(r => r.routableAnchorResolved).length,
    graphConnected: results.filter(r => r.graphConnected).length, solverSolved: results.filter(r => r.solved).length,
    acceptableMatch: results.filter(acceptable).length, classifications: countBy(results.flatMap(r => r.similarity ? [r.similarity.classification] : [])),
    ambiguous: results.filter(r => r.entityStatus === 'AMBIGUOUS').length, failures: countBy(results.map(r => r.failure)),
    startContext: countBy(results.map(r => r.startContext ?? 'NOT_EVALUATED')), roadSafety: countBy(results.map(r => r.roadSafety ?? 'NOT_EVALUATED')),
    autoCompatible: results.filter(r => r.autoCompatible).length,
    falseAutoAccept: results.filter(r => r.autoCompatible && (r.frozenVetoes.length || !['BASE_START', 'HUT_START'].includes(r.startContext ?? '') || r.roadSafety !== 'SAFE')).length,
    intrinsicNegativeFalseAccept: results.filter(r => r.frozenVetoes.length && r.intrinsicAutoCompatible).length };
}
export const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? null,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, max: sorted.at(-1) ?? null };
};
export const versions = { semanticEvidence: SEMANTIC_EVIDENCE_VERSION, normalizer: SEMANTIC_NAME_NORMALIZATION_VERSION,
  index: SEMANTIC_FEATURE_INDEX_VERSION, entityResolver: SEMANTIC_ENTITY_RESOLUTION_VERSION,
  baselineAnchor: OSM_ANCHOR_RESOLUTION_VERSION, routableAnchor: ROUTABLE_ANCHOR_RESOLUTION_VERSION,
  connector: ACCESS_CONNECTOR_POLICY_VERSION, routeAccess: SEMANTIC_ROUTE_ACCESS_VERSION,
  mountainGraph: OSM_TRAIL_GRAPH_CONTRACT_VERSION, localAccessGraph: LOCAL_CONNECTOR_GRAPH_VERSION,
  solver: OSM_ROUTE_SOLVER_VERSION, cost: HIKING_COST_VERSION, evaluation: 'phase12e/evaluation/v1' };

async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeEvaluation(path: string, report: { identity: unknown; resultsHash: string }) {
  try {
    const existing = await readJson<typeof report>(path);
    assert.deepEqual(existing.identity, report.identity, 'EVALUATION_IDENTITY_DRIFT');
    assert.equal(existing.resultsHash, report.resultsHash, 'EVALUATION_RESULTS_DRIFT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeImmutable(path, report);
  }
}
export async function contextFeatures(plan: EPlan) {
  const files = { alpineHuts: 'alpine-huts', wildernessHuts: 'wilderness-huts', parking: 'parking', trainStations: 'stations',
    halts: 'halts', busStops: 'bus-stops', trailheads: 'trailheads', villages: 'villages', hamlets: 'hamlets',
    isolatedDwellings: 'isolated-dwellings', farms: 'farms', saddles: 'saddles', mountainPasses: 'mountain-passes',
    ridges: 'ridges', peaks: 'peaks', trailheadInfo: 'trailhead-info', eleNodes: 'ele-nodes' };
  const starts = plan.records.flatMap(r => [r.start, r.baselineStart].flatMap(a => a?.anchor ? [a.anchor.coordinate] : []));
  const index = {} as FeatureIndex, hashes: Record<string, string> = {};
  for (const [key, file] of Object.entries(files)) {
    const bytes = await readFile(`data/osm/alps/staging/phase11f2-features/${file}.json`);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
    const records = JSON.parse(bytes.toString('utf8')) as Array<FeatureIndex['peaks'][number] & { ele?: number }>;
    index[key as keyof FeatureIndex] = records.filter(r => r.coordinate && starts.some(c =>
      Math.abs(c[0] - r.coordinate![0]) <= .03 && Math.abs(c[1] - r.coordinate![1]) <= .02))
      .map(r => key === 'eleNodes' ? { ...r, objectType: 'node', tags: { ele: String(r.ele) }, wayNodeCount: null } : r);
  }
  return { index, hashes };
}

async function main() {
  const mode = process.argv[2]; assert(['train', 'final'].includes(mode), 'Expected train or final');
  const corpus = await readJson<ECorpus>(`${OUTPUT}/phase12e-corpus.json`);
  const plan = await readJson<EPlan>(`${OUTPUT}/phase12e-evaluation-plan.json`);
  assert.equal(corpus.corpusHash, plan.corpusHash);
  const { planHash, ...planContent } = plan; assert.equal(sha256Stable(planContent), planHash);
  const selection = mode === 'final' ? await readJson<{ configuration: Configuration; freezeHash: string; identity: unknown }>(`${OUTPUT}/phase12e-selected-configuration.json`) : null;
  const grid = { configurations: CONFIGURATIONS, versions, parameters: { featureBounds: FEATURE_ACCESS_BOUNDS, roadAccess: 'EXPLICIT_ALLOWED_ONLY',
    connectorEdgeLimit: 2000, startCandidateLimit: 64, candidateLimit: 2000, visitedLimit: 10000, queueLimit: 20000,
    initialRoadSnapM: 75, summitSnapM: 30, mountainRouterOptions: 'baseline-v1 defaults unchanged' },
    selectionRule: ['false auto accept = 0', 'maximize TRAIN acceptableMatch', 'maximize TRAIN solverSolved',
      'maximize TRAIN routableAnchorResolved', 'minimize TRAIN ambiguous', 'retain older/simpler on tie'],
    negativePolicy: 'Synthetic access controls gate implementation; real 19 controls are final safety validation, never a tuning set.',
    corpusHash: corpus.corpusHash, splitHash: corpus.phase12dSplitHash };
  await writeImmutable(`${OUTPUT}/phase12e-experiment-grid.json`, grid);
  const extraction = await readJson<{ identity: { planHash: string; datasetSha256: string; locations: Record<string, { cache: string; region: string }> } }>(`${OUTPUT}/phase12e-extraction.json`);
  assert.equal(extraction.identity.planHash, planHash);
  assert.equal(extraction.identity.datasetSha256, corpus.datasetSha256);
  assert.equal(await fileHash('data/osm/source/alps-latest.osm.pbf'), corpus.datasetSha256);
  const sourceHashes: Record<string, string> = {};
  const sourceFiles = (await readdir('Lib/gpxIngestion')).filter(f => f.endsWith('.ts')).map(f => `Lib/gpxIngestion/${f}`);
  sourceFiles.push('scripts/gpx/phase12e-run.ts', 'scripts/gpx/phase12e-evaluation-plan.ts', 'scripts/gpx/phase12e-calibration.ts',
    'scripts/gpx/phase12e-prepare.py', 'scripts/gpx/phase12e-extract.py', 'scripts/gpx/phase12d-calibration.ts',
    'scripts/osm-import/route-similarity.ts', 'scripts/osm-import/route-geometry.ts', 'scripts/osm-import/phase11c9-road-safety.ts',
    'scripts/osm-import/start-context-classifier3.ts');
  for (const file of sourceFiles) sourceHashes[file] = await fileHash(file);
  const cachePaths = [...new Set(Object.values(extraction.identity.locations).map(l => l.cache))].sort();
  const truthPath = 'data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite';
  const cacheHashes: Record<string, string> = {};
  for (const file of [...cachePaths, truthPath]) cacheHashes[file] = await fileHash(file);
  const features = await contextFeatures(plan);
  const identity = { datasetSha256: corpus.datasetSha256, corpusHash: corpus.corpusHash, splitHash: corpus.phase12dSplitHash,
    planHash, indexHash: plan.indexHash, versions, parameters: grid.parameters, sourceHashes, cacheHashes, featureHashes: features.hashes };
  if (selection) assert.deepEqual(selection.identity, identity, 'FROZEN_CONFIGURATION_INPUT_OR_CODE_DRIFT');
  const ReadOnlyDatabase = DatabaseSync as unknown as { new(path: string, options: { readOnly: true }): DatabaseSync };
  const caches = new Map(cachePaths.map(path => [path, new ReadOnlyDatabase(path, { readOnly: true })]));
  const truthDb = new ReadOnlyDatabase(truthPath, { readOnly: true });
  const dataset = { datasetKey: 'openstreetmap-odbl-geofabrik-alps', region: 'alps', snapshotTimestamp: '2026-08-24T21:21:08.000Z', pbfSha256: corpus.datasetSha256 };
  const sourceDatasetIdentity = (await readJson<{ sourceDatasetIdentity: Parameters<typeof analyzeRouteRoadSafety>[0]['sourceDatasetIdentity'] }>(
    'data/osm/alps/publication/phase11c9-road-safety-eligible-pool-103.json')).sourceDatasetIdentity;
  let graphBuilds = 0, graphCacheHits = 0, checkpointHits = 0;
  const graphCache = new Map<string, { ways: OsmTrailWayInput[]; graph: OsmTrailGraph }>();
  const getGraph = (key: string) => {
    const location = extraction.identity.locations[key]; assert(location, 'MISSING_SEMANTIC_REGION');
    const cacheKey = `${location.cache}:${location.region}`;
    const hit = graphCache.get(cacheKey); if (hit) { graphCacheHits++; return hit; }
    const ways = (caches.get(location.cache)!.prepare('SELECT w.payload FROM ways w JOIN region_ways r ON w.id=r.way WHERE r.region=? ORDER BY w.id')
      .all(location.region) as { payload: string }[]).map(r => JSON.parse(r.payload) as OsmTrailWayInput);
    const graph = buildOsmTrailGraph(dataset, ways); graphBuilds++;
    assert.equal(buildOsmTrailGraph(dataset, [...ways].reverse()).graphHash, graph.graphHash, 'GRAPH_DETERMINISM');
    if (graphCache.size >= 4) graphCache.delete(graphCache.keys().next().value!);
    const value = { ways, graph }; graphCache.set(cacheKey, value); return value;
  };
  const shards: Shard[] = [];
  const members = corpus.records.filter(m => mode === 'final' || m.group === 'TRAIN');
  const configs: readonly Configuration[] = selection ? [selection.configuration] : CONFIGURATIONS;
  for (const member of members) {
    const runConfigs = selection && member.group === 'FRESH_PUBLISHED_REFERENCE' && selection.configuration.id !== CONFIGURATIONS[0].id
      ? [CONFIGURATIONS[0], ...configs] : configs;
    for (const config of runConfigs) {
      const runIdentity = { ...identity, configuration: config };
      const identityHash = sha256Stable(runIdentity), directory = `${OUTPUT}/checkpoints/${identityHash.slice(0, 20)}`;
      await mkdir(directory, { recursive: true }); await writeImmutable(`${directory}/identity.json`, runIdentity);
      const checkpoint = `${directory}/${member.relationId}.json`;
      try {
        const existing = await readJson<Shard>(checkpoint);
        assert.equal(existing.identityHash, identityHash); assert.equal(existing.resultHash, sha256Stable(existing.result));
        shards.push(existing); checkpointHits++; continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const started = performance.now(), timing: Timing = { graphMs: 0, anchorMs: 0, solverMs: 0, totalMs: 0, rssBytes: 0 };
      const item = plan.records.find(r => r.relationId === member.relationId)!;
      const signal = config.semantic ? item.evidence.signal : item.baselineSignal;
      const start = config.semantic ? item.start : item.baselineStart;
      const summit = config.semantic ? item.summit : item.baselineSummit;
      const vias = config.semantic ? item.vias : [];
      const all = [start, ...vias, summit];
      const result: EResult = { relationId: member.relationId, configuration: config.id, signalCreated: !!signal,
        entityResolved: all.every(a => a?.status === 'RESOLVED'), routableAnchorResolved: false, graphConnected: false,
        solved: false, failure: 'SEMANTIC_EVIDENCE_ABSENT', entityStatus: all.some(a => a?.status === 'AMBIGUOUS') ? 'AMBIGUOUS' : start?.status ?? 'NOT_FOUND',
        evidenceHash: config.semantic ? item.evidence.hash : null, projections: [], graph: null, routeHash: null, manifestHash: null,
        visitedNodes: [], similarity: null, startContext: null, roadSafety: null, safetyReasons: [], autoCompatible: false,
        intrinsicAutoCompatible: false, frozenVetoes: member.negativeReasons, determinismVerified: true };
      if (signal) result.failure = !result.entityResolved ? `ENTITY_${result.entityStatus}` : 'NO_ROUTE';
      if (signal && result.entityResolved && start?.anchor && summit?.anchor) {
        const graphStarted = performance.now();
        const region = getGraph(`${config.semantic ? 'semantic' : 'baseline'}:${member.relationId}`);
        timing.graphMs = performance.now() - graphStarted;
        let graph = region.graph, routeStart: OsmAnchorResolution = start, routeVias = vias;
        const peak = truthDb.prepare("SELECT json_extract(payload,'$.elevationMeters') AS elevation FROM peaks WHERE id=?")
          .get(Number(member.facts.summits[0].id)) as { elevation: number | null } | undefined;
        const context = classifyStartContextV2([...start.anchor.coordinate] as [number, number], [...summit.anchor.coordinate] as [number, number], peak?.elevation ?? null, features.index);
        result.startContext = context.type;
        if (context.type === 'HIGH_MOUNTAIN_START') result.safetyReasons.push('START_HIGH_MOUNTAIN');
        if (context.type === 'AMBIGUOUS_START') result.safetyReasons.push('START_AMBIGUOUS');
        const anchorStarted = performance.now();
        if (config.projection) {
          const accessInput = { graph, ways: region.ways, start, summit, vias, connectors: config.connectors };
          const access = resolveRouteAccess(accessInput);
          const repeated = resolveRouteAccess({ ...accessInput, ways: [...region.ways].reverse() });
          assert.deepEqual(access.projections, repeated.projections, 'ANCHOR_DETERMINISM');
          assert.equal(access.graph.graphHash, repeated.graph.graphHash, 'LOCAL_GRAPH_DETERMINISM');
          result.projections = access.projections; graph = access.graph; routeStart = access.start; routeVias = access.vias;
          result.routableAnchorResolved = access.ready;
        }
        const snapped = [routeStart, ...routeVias, summit].map((a, i, arr) => a.anchor && graph.findNearestNode(a.anchor.coordinate, i === arr.length - 1 ? 30 : 75));
        if (!config.projection) result.routableAnchorResolved = snapped.every(Boolean);
        if (result.routableAnchorResolved) result.graphConnected = snapped.slice(1).every((to, i) => to && snapped[i] && nodesReachingSummit(graph, to.node.nodeId).has(snapped[i]!.node.nodeId));
        timing.anchorMs = performance.now() - anchorStarted;
        result.graph = { hash: graph.graphHash, nodes: graph.nodes.size, edges: graph.edges.length };
        const diagnostics: GraphSearchDiagnostics[] = [];
        const input = { signal, graph, anchors: { start: routeStart, summit, vias: routeVias }, startContext: context.type };
        const solverStarted = performance.now();
        const reconstruction = reconstructOsmRoute({ ...input, diagnostics });
        timing.solverMs = performance.now() - solverStarted;
        assert.deepEqual(reconstructOsmRoute(input), reconstruction, 'SOLVER_DETERMINISM');
        result.visitedNodes = diagnostics.map(d => d.visitedNodes);
        if (!reconstruction.route) {
          result.failure = !graph.nodes.size ? 'GRAPH_REGION_EMPTY' : !result.routableAnchorResolved ? 'ROUTABLE_ANCHOR_FAILED'
            : !result.graphConnected ? 'GRAPH_DISCONNECTED' : diagnostics.some(d => d.outcome === 'SEARCH_LIMIT_EXCEEDED') ? 'SEARCH_LIMIT_EXCEEDED' : 'NO_ROUTE';
        } else {
          const route = reconstruction.route;
          result.solved = true; result.routeHash = route.geometryHash;
          result.manifestHash = sha256Stable({ baselineManifest: route.reconstructionManifestHash, evidence: result.evidenceHash,
            projections: result.projections, versions, configuration: config });
          // No route/reference geometry has been accessed before this point.
          const row = truthDb.prepare('SELECT payload FROM routes WHERE id=?').get(member.relationId) as { payload: string } | undefined;
          assert(row, 'MISSING_FROZEN_REFERENCE');
          const truth = JSON.parse(row.payload) as { name: string | null; geometry: ComparableRoute['geometry'] };
          result.similarity = compareRoutes(toPhase11ComparableRoute(route, member.facts.summits[0].id), {
            sourceId: member.relationId, name: truth.name || member.relationId, geometry: truth.geometry,
            summitEvidence: { confirmedPeakIds: member.facts.summits.map(s => s.id), associatedPeakIds: member.facts.summits.map(s => s.id) } });
          result.failure = result.similarity.classification;
          const routeWays: RoadSafetyWay[] = route.osmNodeIds.slice(1).map((to, i) => {
            const from = route.osmNodeIds[i], edge = graph.neighbors(from).find(e => e.toNodeId === to && route.osmWayIds.includes(e.wayId));
            assert(edge, 'MISSING_REAL_TRAVERSED_EDGE');
            const source = region.ways.find(w => w.id === edge.wayId)!;
            return { id: source.id, tags: { ...source.tags }, nodes: [from, to].map(nodeId => ({ nodeId, coordinate: [...graph.node(nodeId)!.coordinate] as [number, number] })) };
          });
          const nearbyMotorwayWays: RoadSafetyWay[] = region.ways.filter(w => ['motorway', 'motorway_link'].includes(w.tags.highway))
            .filter(w => w.nodes.every(n => n.coordinate)).map(w => ({ id: w.id, tags: { ...w.tags }, nodes: w.nodes.map(n => ({ nodeId: n.nodeId, coordinate: [...n.coordinate!] as [number, number] })) }));
          const safety = analyzeRouteRoadSafety({ canonicalRelationId: member.relationId, stagingRouteId: 'offline-only', routeType: 'hiking', routeWays, nearbyMotorwayWays, sourceDatasetIdentity });
          result.roadSafety = safety.status; result.safetyReasons.push(...safety.reasonCodes);
          result.intrinsicAutoCompatible = ['BASE_START', 'HUT_START'].includes(context.type) && safety.status === 'SAFE' && !safety.reasonCodes.length && acceptable(result);
          result.autoCompatible = result.intrinsicAutoCompatible && !member.negativeReasons.length;
        }
      }
      timing.totalMs = performance.now() - started; timing.rssBytes = process.memoryUsage().rss;
      const shard: Shard = { identityHash, resultHash: sha256Stable(result), result, timing };
      await writeFile(`${checkpoint}.partial`, JSON.stringify(shard, null, 2) + '\n'); await rename(`${checkpoint}.partial`, checkpoint);
      shards.push(shard);
    }
    if (shards.length % 20 === 0) console.log(`${mode}: checkpointed ${shards.length} configuration outcomes`);
  }
  for (const db of caches.values()) db.close(); truthDb.close();
  const results = shards.map(s => s.result);
  const performanceReport = { graphBuilds, graphCacheHits, checkpointHits, determinismGraphRebuilds: graphBuilds,
    anchorResolverMs: stats(shards.filter(s => s.result.entityResolved).map(s => s.timing.anchorMs)),
    solverMs: stats(shards.filter(s => s.result.entityResolved).map(s => s.timing.solverMs)),
    pipelineMs: stats(shards.map(s => s.timing.totalMs)), visitedNodes: stats(results.flatMap(r => r.visitedNodes)),
    connectorVisitedNodes: stats(results.flatMap(r => r.projections.map(p => p.visitedNodes))),
    largestCandidateSet: Math.max(0, ...results.flatMap(r => r.projections.map(p => p.candidateCount))),
    largestGraph: Math.max(0, ...results.map(r => r.graph?.nodes ?? 0)), sampledPeakRssBytes: Math.max(...shards.map(s => s.timing.rssBytes)) };
  if (mode === 'train') {
    const baseline = results.filter(r => r.configuration === CONFIGURATIONS[0].id);
    const prior = await readJson<{ results: EvaluationRecord[] }>('data/gpx/phase12d/phase12d-final-evaluation.json');
    for (const r of baseline) {
      const old = prior.results.find(o => o.relationId === r.relationId)!;
      assert.equal(r.routeHash, old.routeHash, `BASELINE_GEOMETRY_DRIFT:${r.relationId}`);
      assert.equal(r.similarity?.classification, old.similarity?.classification, 'BASELINE_COMPARISON_DRIFT');
    }
    await writeImmutable(`${OUTPUT}/phase12e-semantic-evidence-baseline.json`, { metrics: metrics(baseline), results: baseline,
      priorPhase12dReplay: 'All 30 route hashes and comparison classifications identical', identity, resultsHash: sha256Stable(baseline) });
    const experiments = CONFIGURATIONS.map(configuration => ({ configuration, metrics: metrics(results.filter(r => r.configuration === configuration.id)) }));
    await writeEvaluation(`${OUTPUT}/phase12e-experiments.json`, { identity, experiments, performance: performanceReport, resultsHash: sha256Stable(results), results } as { identity: unknown; resultsHash: string });
    const ranked = [...experiments].filter(e => e.metrics.falseAutoAccept === 0).sort((a, b) =>
      b.metrics.acceptableMatch - a.metrics.acceptableMatch || b.metrics.solverSolved - a.metrics.solverSolved ||
      b.metrics.routableAnchorResolved - a.metrics.routableAnchorResolved || a.metrics.ambiguous - b.metrics.ambiguous ||
      CONFIGURATIONS.findIndex(c => c.id === a.configuration.id) - CONFIGURATIONS.findIndex(c => c.id === b.configuration.id));
    assert(ranked[0], 'NO_SAFE_TRAIN_CONFIGURATION');
    const selected = { configuration: ranked[0].configuration, identity, parameters: grid.parameters, versions,
      trainingMetrics: ranked[0].metrics, ranking: ranked.map(e => e.configuration.id), selectionRule: grid.selectionRule,
      reason: 'Lexicographic TRAIN-only selection; no exposed, GREEN245, negative19 or fresh outcomes used. Final negative19 gate remains mandatory.',
      corpusHash: corpus.corpusHash, splitHash: corpus.phase12dSplitHash, freshResultsOpened: false };
    await writeImmutable(`${OUTPUT}/phase12e-selected-configuration.json`, { ...selected, freezeHash: sha256Stable(selected) });
    console.log(JSON.stringify({ experiments, selected: selected.configuration.id, freezeHash: sha256Stable(selected) }));
  } else {
    const selectedResults = results.filter(r => r.configuration === selection!.configuration.id);
    const select = (predicate: (m: EMember) => boolean, rows = selectedResults) => rows.filter(r => corpus.records.some(m => m.relationId === r.relationId && predicate(m)));
    const report = { identity, freezeHash: selection!.freezeHash, configuration: selection!.configuration,
      train: metrics(select(m => m.group === 'TRAIN')), exposedRegressionSet: metrics(select(m => m.group === 'EXPOSED_REGRESSION_SET')),
      humanGold44: metrics(select(m => m.humanApproved)), base23: metrics(select(m => m.humanApproved && m.labels.startContext === 'BASE_START')),
      hut21: metrics(select(m => m.humanApproved && m.labels.startContext === 'HUT_START')),
      machineGreen245: metrics(select(m => m.machineGreen)), negative19: metrics(select(m => m.negativeReasons.length > 0)),
      fresh: { baseline: metrics(select(m => m.group === 'FRESH_PUBLISHED_REFERENCE', results.filter(r => r.configuration === CONFIGURATIONS[0].id))),
        selected: metrics(select(m => m.group === 'FRESH_PUBLISHED_REFERENCE')) },
      determinism: { checked: results.length, passed: results.filter(r => r.determinismVerified).length,
        scope: 'Every executed solver repeated; every base graph reversed/rebuilt; projections and local graphs repeated with reversed way order. Pre-solver outcomes are frozen deterministic evidence.' },
      performance: performanceReport, resultsHash: sha256Stable(results), results };
    await writeEvaluation(`${OUTPUT}/phase12e-final-evaluation.json`, report);
    console.log(JSON.stringify({ ...report, identity: undefined, results: undefined }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
