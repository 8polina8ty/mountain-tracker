import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseAccessNetwork, primaryBaseAccess, publicApproachRoad, primaryStartPriority } from './baseAccessStartPolicy.ts';
import { buildOsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';
import { AdaptiveStartDiscoverySession } from './adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from './adaptiveStartFeatures.ts';
import type { FeatureIndex } from '../../scripts/osm-import/start-context-classifier3.ts';

const dataset = { datasetKey: 'v2-fixture', region: 'synthetic', snapshotTimestamp: '2026-09-09T00:00:00.000Z', pbfSha256: 'a'.repeat(64) };
const node = (nodeId: number, lon: number) => ({ nodeId, coordinate: [lon, 47] as [number, number] });
const base = node(1, 11), hut = node(2, 11.01), summit = node(3, 11.02), roadEnd = node(4, 10.99);
const trail: OsmTrailWayInput = { id: 10, tags: { highway: 'path' }, nodes: [base, hut, summit] };
const road: OsmTrailWayInput = { id: 20, tags: { highway: 'residential', foot: 'yes' }, nodes: [roadEnd, base] };
const graph = buildOsmTrailGraph(dataset, [trail, road]);
const network = new BaseAccessNetwork([trail, road]);
for (const kind of ['PARKING', 'VILLAGE', 'HAMLET', 'BUS_STOP', 'TRAIN_STATION', 'TRAILHEAD', 'NETWORK_ACCESS']) {
  test(`${kind} on real public road topology is an accepted primary origin`, () => {
    const e = network.evaluate({ kind, tags: {}, nodeId: 1, graph });
    assert(primaryBaseAccess(e)); assert.equal(e.accessNetworkDistance, 0);
    assert.deepEqual(e.outwardRoadWayIds, [20]);
    assert.equal(e.startElevation, null);
  });
}
for (const kind of ['ALPINE_HUT', 'WILDERNESS_HUT', 'REFUGE', 'ARBITRARY_NODE', 'INTERMEDIATE_TRAIL_JUNCTION', 'HIGH_ALPINE_NETWORK_ACCESS']) {
  test(`${kind} is rejected even beside a public road`, () => {
    assert(!primaryBaseAccess(network.evaluate({ kind, tags: {}, nodeId: 1, graph })));
  });
}
test('guidepost and network access inside the hiking network cannot borrow distant road evidence', () => {
  for (const kind of ['TRAILHEAD_INFO', 'NETWORK_ACCESS', 'PARKING'])
    assert(!primaryBaseAccess(network.evaluate({ kind, tags: {}, nodeId: 2, graph })));
});
test('nearby disconnected road never fabricates a connector', () => {
  const separate = { ...road, nodes: [roadEnd, node(5, 11)] };
  assert(!primaryBaseAccess(new BaseAccessNetwork([trail, separate]).evaluate({ kind: 'PARKING', tags: {}, nodeId: 1, graph })));
});
for (const tags of [{ access: 'private', foot: 'yes' }, { foot: 'no' }, { motor_vehicle: 'no' },
  { access: 'customers' }, { 'access:conditional': 'yes @ (summer)' }, { highway: 'motorway', foot: 'yes' },
  { highway: 'service', foot: 'yes' }] as Record<string, string>[]) {
  test(`restricted or unproven public approach rejected: ${JSON.stringify(tags)}`, () => {
    const restricted: OsmTrailWayInput = { ...road, tags: { ...road.tags, ...tags } };
    assert(!publicApproachRoad(restricted));
    assert(!primaryBaseAccess(new BaseAccessNetwork([trail, restricted]).evaluate({ kind: 'PARKING', tags: {}, nodeId: 1, graph })));
  });
}
test('short isolated public road is insufficient outward access evidence', () => {
  const short = { ...road, nodes: [node(4, 10.9999), base] };
  assert(!primaryBaseAccess(new BaseAccessNetwork([short]).evaluate({ kind: 'PARKING', tags: {}, nodeId: 1, graph })));
});
test('priority preserves trailhead, parking, settlement, transit, road end, boundary order', () => {
  assert.deepEqual(['TRAILHEAD', 'PARKING', 'VILLAGE', 'BUS_STOP', 'PUBLIC_ROAD_END', 'NETWORK_ACCESS'].map(primaryStartPriority), [0, 1, 2, 3, 4, 5]);
});
test('reversing ways preserves deterministic evidence and exact OSM witnesses', () => {
  const input = { kind: 'PARKING', tags: {}, nodeId: 1, graph };
  assert.deepEqual(network.evaluate(input), new BaseAccessNetwork([road, trail]).evaluate(input));
});
for (const [kind, layer, tags] of [
  ['PARKING', 'parking', { amenity: 'parking' }], ['VILLAGE', 'villages', { place: 'village' }],
] as const) {
  test(`${kind} → hut → summit preserves the complete connected outing`, () => {
    const index: FeatureIndex = { alpineHuts: [], wildernessHuts: [], mountainPasses: [], saddles: [], ridges: [], peaks: [],
      trailheads: [], trailheadInfo: [], parking: [], villages: [], hamlets: [], isolatedDwellings: [], farms: [],
      busStops: [], trainStations: [], halts: [], eleNodes: [] };
    index[layer].push({ objectType: 'node', osmid: '1', name: 'Public base', tags: { ...tags, name: 'Public base' }, coordinate: base.coordinate, wayNodeCount: null });
    index.alpineHuts.push({ objectType: 'node', osmid: '2', name: 'Intermediate hut', tags: { tourism: 'alpine_hut' }, coordinate: hut.coordinate, wayNodeCount: null });
    const session = new AdaptiveStartDiscoverySession({ graph, ways: [trail, road], features: new AdaptiveStartFeatureIndex(index),
      safetyIdentity: { pbfPath: 'fixture', pbfSizeBytes: 0, pbfModifiedMilliseconds: 0, pbfSha256: dataset.pbfSha256,
        pipelineDatasetFingerprint: 'b'.repeat(64), pipelineGeneratedAt: dataset.snapshotTimestamp, checkpointPath: 'fixture',
        checkpointManifestSha256: 'c'.repeat(64), motorwayIndexContentHash: 'd'.repeat(64) } });
    const request = { summit: { id: 'fixture', name: 'Summit', coordinate: summit.coordinate, elevationMeters: 2500 } };
    const result = session.discover(request);
    assert.equal(result.candidates[0]?.kind, kind);
    assert.deepEqual(result.candidates[0]?.route?.osmNodeIds, [1, 2, 3]);
    assert.equal(result.fabricatedGapCount, 0);
    assert.equal(result.resultHash, session.discover(request).resultHash);
    assert(result.evaluated.filter(c => c.kind.includes('HUT')).every(c => !c.autoEligible));
  });
}
