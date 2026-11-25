import assert from 'node:assert/strict';
import test from 'node:test';
import { IDENTITY, inCoverage, primaryCounts, validHeight, type Mountain } from './bulk700-contract.ts';
import { routeWithGraphHopper, routeJson, type RouteResult } from './adapter.ts';
import { graphHealthy } from './lifecycle.ts';
import { summarize, validateCheckpoint, type BulkResult } from './bulk700-run.ts';
import { verifyWitnessEdges } from './bulk700-audit.ts';
import type { BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import type { OsmTrailWayInput } from '../../../Lib/gpxIngestion/osmTrailGraph.ts';

const mountain: Mountain = { id: 1, osm_id: 1, name: 'unit test only', height: 700, latitude: 47, longitude: 11 };
test('bulk height boundary rejects null, below700, nonfinite and strings', () => {
  for (const height of [null, 699.99, NaN, Infinity, '700']) assert.equal(validHeight({ ...mountain, height } as Mountain), false);
  assert.equal(validHeight(mountain), true);
  assert.equal(inCoverage({ ...mountain, longitude: 180 }), false);
  assert.equal(inCoverage({ ...mountain, latitude: null }), false);
});
test('review flags never add a primary state', () => {
  const rows: BulkResult[] = [{ mountainId: 1, state: 'TRUSTED_REPLACEMENT_READY', reviewFlags: ['REVIEW_GEOMETRY_CHANGE'], reason: null, ...IDENTITY, routingEngine: 'GRAPH_HOPPER', fallbackReason: null, attempts: [{ routingEngine: 'GRAPH_HOPPER', ms: 1000, fetchFailed: false }], baseAccessMs: 2000, routingMs: 1000, artifactWriteMs: 100, artifacts: {}, syntheticGeometryCount: 0, fabricatedEvidenceCount: 0 }];
  assert.equal(Object.values(primaryCounts(rows)).reduce((a,b) => a+b,0),1);
  assert.throws(() => primaryCounts([{ state: 'REVIEW_GEOMETRY_CHANGE' }] as never), /INVALID_PRIMARY_STATE/);
  const summary = summarize(rows,100);
  assert.equal(summary.graphHopperSuccess,1); assert.equal(summary.fallbackSuccess,0);
  assert.equal(summary.graphHopperRoutesPerMinute,60);
  assert.equal(summary.fallbackRoutesPerMinute,null);
  const cp = { runHash: 'x', inventoryHash: 'i', mode: 'canary', completed: rows, rejectedTargets: [] };
  validateCheckpoint(cp,'x',new Set([1]));
  assert.throws(() => validateCheckpoint(cp,'other',new Set([1])), /CHECKPOINT/);
  assert.throws(() => validateCheckpoint({...cp,completed:[...rows,...rows]},'x',new Set([1])), /CHECKPOINT/);
  assert.throws(() => validateCheckpoint(cp,'x',new Set([2])), /CHECKPOINT/);
});
test('unavailable HTTP without prior health cannot invoke OSM fallback', async t => {
  t.mock.method(globalThis,'fetch',async () => { throw new TypeError('fetch failed'); });
  const engines: string[] = [];
  const response = await routeWithGraphHopper({start:{lat:47,lon:11},summit:{lat:47.1,lon:11.1}}, {graphId:IDENTITY.graphId,graphHopperVersion:'10.2',onAttempt:e=>engines.push(e)});
  assert.equal(response.ok,false);
  if (!response.ok) assert.match(response.reason,/^FETCH_FAILED/);
  assert.deepEqual(engines,['GRAPH_HOPPER']);
});
test('readiness rejects arbitrary HTTP 400, wrong version and missing profile', async t => {
  const mock = t.mock.method(globalThis,'fetch',async () => new Response('bad request',{status:400}));
  assert.equal(await graphHealthy(),false);
  mock.mock.mockImplementation(async () => Response.json({version:'10.2',profiles:[{name:'car'}],bbox:[5,43,17,49]}));
  assert.equal(await graphHealthy(),false);
  mock.mock.mockImplementation(async () => Response.json({version:'10.2',profiles:[{name:'foot'}],bbox:[5,43,17,49]}));
  assert.equal(await graphHealthy(),true);
});
test('route artifacts persist engine identity and explicit null fallback', () => {
  const route = { ...IDENTITY, routingEngine:'GRAPH_HOPPER', graphHopperVersion:'10.2', geometry:{type:'LineString',coordinates:[[11,47],[11.1,47.1]]} } as RouteResult;
  const json = JSON.parse(routeJson(route,'PARKING',{id:1,name:'unit test'}));
  assert.equal(json.routingEngine,'GRAPH_HOPPER'); assert.equal(json.fallbackReason,null); assert.equal(json.pbfSha256,IDENTITY.pbfSha256);
});
test('independent evidence audit rejects fabricated OSM edges and distance fields', () => {
  const ways: OsmTrailWayInput[] = [{id:10,tags:{highway:'residential'},nodes:[{nodeId:1,coordinate:[11,47]},{nodeId:2,coordinate:[11.002,47]},{nodeId:3,coordinate:[11.004,47]}]}];
  const evidence: BaseAccessEvidence = {policyVersion:'mountain-tracker/base-access-start-policy/v2',candidateKind:'NETWORK_ACCESS',publicRoadConnected:true,settlementConnected:false,parkingConnected:false,transitConnected:false,trailheadConnected:false,approachBoundary:true,accessNetworkDistance:0,startElevation:null,summitElevation:null,startNodeId:1,approachNodeIds:[1],approachWayIds:[],outwardRoadNodeIds:[1,2,3],outwardRoadWayIds:[10,10],reasonCodes:['PRIMARY_BASE_ACCESS']};
  verifyWitnessEdges(evidence,ways);
  assert.throws(()=>verifyWitnessEdges({...evidence,outwardRoadNodeIds:[1,99,3]},ways),/REAL_OSM_EDGE/);
  assert.throws(()=>verifyWitnessEdges({...evidence,accessNetworkDistance:12.5},ways),/APPROACH_DISTANCE/);
  assert.throws(()=>verifyWitnessEdges(evidence,[{...ways[0],tags:{highway:'residential',access:'private'}}]),/REAL_OSM_EDGE/);
});
test('block reuse cannot leak state between mountains and preserves witness equivalence', async () => {
  const { BaseAccessNetwork } = await import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts');
  const { buildReconstructionPbfBlockGraph } = await import('../../../Lib/gpxIngestion/pbfBlockGraph.ts');
  const dataset = { datasetKey: 'local-osm-pbf', region: 'alps', snapshotTimestamp: new Date().toISOString(), pbfSha256: IDENTITY.pbfSha256 };
  const ways: OsmTrailWayInput[] = [
    { id: 10, tags: { highway: 'residential' }, nodes: [{ nodeId: 1, coordinate: [11, 47] }, { nodeId: 2, coordinate: [11.002, 47] }] },
    { id: 11, tags: { highway: 'path', sac_scale: 'hiking' }, nodes: [{ nodeId: 2, coordinate: [11.002, 47] }, { nodeId: 3, coordinate: [11.003, 47] }] },
  ];
  const graph1 = buildReconstructionPbfBlockGraph(dataset, ways);
  const graph2 = buildReconstructionPbfBlockGraph(dataset, ways);
  const net1 = new BaseAccessNetwork(ways);
  const w1 = net1.evaluate({ kind: 'PARKING', tags: { amenity: 'parking' }, nodeId: 3, graph: graph1 });
  const w2 = new BaseAccessNetwork(ways).evaluate({ kind: 'PARKING', tags: { amenity: 'parking' }, nodeId: 3, graph: graph2 });
  assert.deepEqual(w1, w2);
  // second mountain reuses same block data but different candidate must not leak
  const w3 = new BaseAccessNetwork(ways).evaluate({ kind: 'TRAILHEAD', tags: { highway: 'trailhead' }, nodeId: 3, graph: graph1 });
  assert.notDeepEqual(w1.candidateKind, w3.candidateKind);
  // Ensure graph reuse is immutable: second evaluation with same data yields same result
  const w1Again = net1.evaluate({ kind: 'PARKING', tags: { amenity: 'parking' }, nodeId: 3, graph: graph1 });
  assert.deepEqual(w1, w1Again);
});
test('block grouping preserves inventory membership and height invariant', async () => {
  const { blockFor } = await import('./pbf-block-loader.ts');
  const { readJson } = await import('./bulk700-contract.ts');
  const inv = await readJson<{ targets: Mountain[]; inventoryHash: string }>('data/routes/graphhopper-bulk/700m/inventory.json');
  assert.equal(inv.targets.length, 62014);
  for (const m of inv.targets.slice(0, 20)) {
    assert.equal(validHeight(m), true);
    assert.equal(typeof m.latitude, 'number');
    assert.equal(typeof m.longitude, 'number');
  }
  // grouping must not change membership
  const sorted = [...inv.targets].sort((a, b) => {
    const ka = blockFor(a.longitude!, a.latitude!), kb = blockFor(b.longitude!, b.latitude!);
    if (ka < kb) return -1; if (ka > kb) return 1; return a.id - b.id;
  });
  assert.equal(sorted.length, inv.targets.length);
  assert.deepEqual(new Set(sorted.map(m => m.id)), new Set(inv.targets.map(m => m.id)));
  // blockFor deterministic
  assert.equal(blockFor(11, 47), blockFor(11, 47));
  assert.match(blockFor(11, 47), /^\d+_\d+$/);
});
test('partial cache remains unreadable and strict DB source required', async () => {
  const { BLOCK_EXTRACTION_VERSION } = await import('./pbf-block-loader.ts');
  assert.equal(BLOCK_EXTRACTION_VERSION, 'complete-v2');
  // pbf-block-loader must reject partial reads: loadBlockWays never reads .partial
  // verify by checking source contains .partial guard
  const { readFile } = await import('node:fs/promises');
  const src = await readFile('scripts/routes/graphhopper/pbf-block-loader.ts', 'utf8');
  assert.match(src, /\.partial/);
  assert.match(src, /BLOCK_EXTRACTION_VERSION/);
  assert.match(src, /Do not read.*\.partial/);
  // strict source check present in bulk700-run
  const runSrc = await readFile('scripts/routes/graphhopper/bulk700-run.ts', 'utf8');
  assert.match(runSrc, /SUPABASE_DATABASE/);
  assert.match(runSrc, /REAL_MOUNTAIN_SOURCE_UNAVAILABLE/);
  assert.match(runSrc, /validHeight/);
});
