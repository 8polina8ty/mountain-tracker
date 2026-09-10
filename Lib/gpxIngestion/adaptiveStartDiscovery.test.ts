import assert from 'node:assert/strict';
import test from 'node:test';

import type { RoadSafetySourceDatasetIdentity } from '../../scripts/osm-import/phase11c9-road-safety.ts';
import type { FeatureIndex } from '../../scripts/osm-import/start-context-classifier3.ts';
import { compareRoutes } from '../../scripts/osm-import/route-similarity.ts';
import {
  AdaptiveStartDiscoverySession,
  DEFAULT_ADAPTIVE_START_POLICY,
  type AdaptiveStartDiscoveryRequest,
  type AdaptiveStartDiscoveryResult,
} from './adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from './adaptiveStartFeatures.ts';
import { buildOsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';
import { toPhase11ComparableRoute } from './osmRouteReconstruction.ts';
import { DEFAULT_SUMMIT_ATTACHMENT_POLICY, SUMMIT_ATTACHMENT_REASON_REVIEW } from './summitAttachment.ts';
import type { Coordinate } from './types.ts';

const EARTH_RADIUS_METERS = 6_371_008.8;
const LATITUDE = 47;
const SUMMIT_NODE = 999_000;
const dataset = {
  datasetKey: 'adaptive-start-synthetic-alps', region: 'synthetic',
  snapshotTimestamp: '2026-09-06T00:00:00.000Z', pbfSha256: 'a'.repeat(64),
};
const safetyIdentity: RoadSafetySourceDatasetIdentity = {
  pbfPath: 'synthetic-fixture-only.osm.pbf', pbfSizeBytes: 0, pbfModifiedMilliseconds: 0,
  pbfSha256: dataset.pbfSha256, pipelineDatasetFingerprint: 'b'.repeat(64),
  pipelineGeneratedAt: dataset.snapshotTimestamp, checkpointPath: 'synthetic-fixture-only',
  checkpointManifestSha256: 'c'.repeat(64), motorwayIndexContentHash: 'd'.repeat(64),
};
const request: AdaptiveStartDiscoveryRequest = {
  summit: { id: 'synthetic-summit', name: 'Fixture summit', coordinate: coordinate(0),
    elevationMeters: 3000, osmId: SUMMIT_NODE },
};

function coordinate(eastMeters: number, northMeters = 0): Coordinate {
  return [11 + eastMeters / (EARTH_RADIUS_METERS * Math.cos(LATITUDE * Math.PI / 180)) * 180 / Math.PI,
    LATITUDE + northMeters / EARTH_RADIUS_METERS * 180 / Math.PI];
}

function node(nodeId: number, eastMeters: number, northMeters = 0) {
  return { nodeId, coordinate: coordinate(eastMeters, northMeters) };
}

function way(id: number, nodes: ReturnType<typeof node>[], tags: Record<string, string> = {}): OsmTrailWayInput {
  return { id, nodes, tags: { highway: 'path', ...tags } };
}

function emptyIndex(): FeatureIndex {
  return { alpineHuts: [], wildernessHuts: [], mountainPasses: [], saddles: [], ridges: [], peaks: [],
    trailheads: [], trailheadInfo: [], parking: [], villages: [], hamlets: [], isolatedDwellings: [],
    farms: [], busStops: [], trainStations: [], halts: [], eleNodes: [] };
}

function feature(index: FeatureIndex, layer: keyof FeatureIndex, osmId: number, point: Coordinate,
  tags: Record<string, string>, name = `Fixture ${osmId}`): void {
  index[layer].push({ objectType: 'node', osmid: String(osmId), name, tags: { name, ...tags },
    coordinate: [point[0], point[1]], wayNodeCount: null });
}

function elevation(index: FeatureIndex, osmId: number, point: Coordinate, elevationMeters = 1000): void {
  feature(index, 'eleNodes', osmId, point, { ele: String(elevationMeters) });
}

function parking(index: FeatureIndex, osmId: number, point: Coordinate, withElevation = true): void {
  feature(index, 'parking', osmId, point, { amenity: 'parking' });
  if (withElevation) elevation(index, osmId + 100_000, point);
}

function session(ways: OsmTrailWayInput[], index = emptyIndex()): AdaptiveStartDiscoverySession {
  // Baseline positive fixtures now explicitly include an outward public road.
  const origins = [...index.parking, ...index.trailheads].sort((a, b) => Number(a.osmid) - Number(b.osmid));
  ways = [...ways, ...origins.map((p, i) => way(8_000_000 + i, [
    { nodeId: Number(p.osmid), coordinate: p.coordinate! },
    { nodeId: 9_000_000 + i, coordinate: [p.coordinate![0] + 0.005, p.coordinate![1]] },
  ], { highway: 'residential', foot: 'yes' }))];
  return new AdaptiveStartDiscoverySession({ graph: buildOsmTrailGraph(dataset, ways), ways,
    features: new AdaptiveStartFeatureIndex(index), safetyIdentity });
}

function parkingRoute(distanceMeters = 5000, withElevation = true) {
  const index = emptyIndex();
  parking(index, 1, coordinate(distanceMeters), withElevation);
  const ways = [way(10, [node(1, distanceMeters), node(2, distanceMeters / 2), node(SUMMIT_NODE, 0)])];
  return { index, ways, session: session(ways, index) };
}

function assertOfflineSafe(result: AdaptiveStartDiscoveryResult): void {
  assert.equal(result.publishable, false);
  assert.equal(result.fabricatedGapCount, 0);
  assert.ok(result.seriousCandidates <= DEFAULT_ADAPTIVE_START_POLICY.maximumSeriousCandidates);
  assert.ok(result.solverCalls <= DEFAULT_ADAPTIVE_START_POLICY.maximumSeriousCandidates);
  for (const candidate of result.candidates) {
    assert.equal(candidate.autoEligible, true);
    assert.equal(candidate.safety, 'SAFE');
    assert.equal(candidate.startRole, 'PRIMARY_BASE_ACCESS');
    assert.ok(candidate.route);
  }
}

test('A/L: summit-only request discovers safe parking within 10 km and retains BASE evidence', () => {
  const result = parkingRoute().session.discover(request);
  assert.equal(result.status, 'STARTS_FOUND');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.kind, 'PARKING');
  assert.equal(candidate.radiusTier, 10_000);
  assert.equal(candidate.startContext?.type, 'BASE_START');
  assert.equal(candidate.verticalGainMeters, 2000);
  assert.equal(candidate.category, 'STANDARD_ASCENT');
  assert.equal(candidate.anchor?.method, 'ENTITY_GRAPH_NODE');
  assertOfflineSafe(result);
});

test('B: an empty 10 km tier expands to a real trailhead in the 20 km tier', () => {
  const index = emptyIndex();
  feature(index, 'trailheads', 1, coordinate(15_000), { highway: 'trailhead' });
  elevation(index, 101, coordinate(15_000));
  const result = session([way(10, [node(1, 15_000), node(2, 7500), node(SUMMIT_NODE, 0)])], index).discover(request);
  assert.equal(result.candidates[0]?.kind, 'TRAILHEAD');
  assert.equal(result.candidates[0]?.radiusTier, 20_000);
  assert.deepEqual(result.tiersVisited.slice(0, 2), [10_000, 20_000]);
  assertOfflineSafe(result);
});

for (const [label, distanceMeters, tier] of [['C', 25_000, 35_000], ['D', 40_000, 50_000]] as const) {
  test(`${label}: a candidate first appears in the ${tier / 1000} km tier`, () => {
    const result = parkingRoute(distanceMeters).session.discover(request);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].radiusTier, tier);
    assert.ok(result.tiersVisited.includes(tier));
    assertOfflineSafe(result);
  });
}

test('E: public road/trail topology supplies NETWORK_ACCESS, with ambiguous context kept in review', () => {
  const index = emptyIndex();
  elevation(index, 101, coordinate(5000));
  const result = session([
    way(10, [node(1, 5000), node(2, 2500), node(SUMMIT_NODE, 0)]),
    way(20, [node(3, 5500, 500), node(1, 5000)], { highway: 'service', foot: 'yes' }),
  ], index).discover(request);
  assert.deepEqual(result.tiersVisited, [10_000, 20_000, 35_000, 50_000]);
  assert.equal(result.fallbackInspected, true);
  const candidate = result.evaluated.find(item => item.kind === 'NETWORK_ACCESS');
  assert.ok(candidate?.route, 'A real public approach junction must reach the existing solver.');
  assert.equal(candidate.networkAccess?.junctionNodeId, 1);
  assert.deepEqual(candidate.networkAccess?.mountainTrailWayIds, [10]);
  assert.deepEqual(candidate.networkAccess?.approachWays.map(item => item.wayId), [20]);
  assert.equal(candidate.networkAccess?.approachWays[0].highway, 'service');
  assert.equal(candidate.networkAccess?.approachWays[0].accessTags.foot, 'yes');
  assert.deepEqual(candidate.networkAccess?.coordinate, coordinate(5000));
  assert.equal(candidate.networkAccess?.networkDistanceMeters, candidate.networkDistanceMeters);
  assert.equal(candidate.startContext?.type, 'AMBIGUOUS_START');
  assert.equal(candidate.autoEligible, false);
  assert.equal(result.candidates.length, 0);
  assert.ok(['NEEDS_REVIEW', 'ONLY_AMBIGUOUS_STARTS'].includes(result.status));
  assertOfflineSafe(result);
});

test('F: no POI or public transition does not turn an arbitrary low graph node into a start', () => {
  const index = emptyIndex();
  elevation(index, 101, coordinate(5000), 20);
  const result = session([way(10, [node(1, 5000), node(2, 2500), node(SUMMIT_NODE, 0)])], index).discover(request);
  assert.equal(result.status, 'NO_ROUTABLE_START');
  assert.equal(result.fallbackInspected, true);
  assert.equal(result.evaluated.length, 0);
  assert.equal(result.solverCalls, 0);
  assertOfflineSafe(result);
});

test('G/H: farther air distance wins when its actual network route is materially shorter', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(12_000));
  parking(index, 3, coordinate(0, -18_000));
  const result = session([
    way(10, [node(1, 12_000), node(2, 12_000, 14_000), node(SUMMIT_NODE, 0)]),
    way(20, [node(3, 0, -18_000), node(4, 6000, -9000), node(SUMMIT_NODE, 0)]),
  ], index).discover(request);
  assert.equal(result.candidates.length, 2);
  const [better, worse] = result.candidates;
  assert.equal(better.osmIdentity.osmId, 3);
  assert.equal(worse.osmIdentity.osmId, 1);
  assert.ok(better.airDistanceMeters > worse.airDistanceMeters);
  assert.ok(better.networkDistanceMeters! < worse.networkDistanceMeters! - 8000);
  assert.ok(better.networkDistanceMeters! > better.airDistanceMeters);
  assertOfflineSafe(result);
});

test('I: distinct ascent sides survive similarity filtering and permit deterministic early exit', () => {
  const index = emptyIndex();
  const starts = [node(1, 5000), node(2, -5000), node(3, 0, 5000)];
  for (const start of starts) parking(index, start.nodeId, start.coordinate);
  const result = session(starts.map(start => way(start.nodeId * 10, [start, node(SUMMIT_NODE, 0)])), index).discover(request);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.tiersVisited, [10_000]);
  assert.equal(result.fallbackInspected, true);
  assert.equal(new Set(result.candidates.map(item => item.osmIdentity.osmId)).size, 3);
  const comparison = compareRoutes(toPhase11ComparableRoute(result.candidates[0].route!, request.summit.id),
    toPhase11ComparableRoute(result.candidates[1].route!, request.summit.id));
  assert.equal(comparison.classification, 'DIFFERENT_VARIANT');
  assertOfflineSafe(result);
});

test('J: co-located starts producing the same OSM path are explicitly deprioritized as duplicates', () => {
  const fixture = parkingRoute();
  parking(fixture.index, 101, coordinate(5000));
  const result = session(fixture.ways, fixture.index).discover(request);
  assert.equal(result.candidates.length, 1);
  const duplicate = result.evaluated.find(item => item.duplicateOf !== null);
  assert.ok(duplicate);
  assert.ok(['EXACT_DUPLICATE', 'NEAR_DUPLICATE'].includes(duplicate.similarityToBetter ?? ''));
  assert.equal(duplicate.duplicateOf, result.candidates[0].id);
  assert.deepEqual(duplicate.route?.osmNodeIds, result.candidates[0].route?.osmNodeIds);
  assertOfflineSafe(result);
});

test('K: a real alpine hut remains secondary only without invented elevation', () => {
  const index = emptyIndex();
  feature(index, 'alpineHuts', 1, coordinate(5000), { tourism: 'alpine_hut' }, 'Fixture hut');
  const result = session([way(10, [node(1, 5000), node(2, 2500), node(SUMMIT_NODE, 0)])], index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.evaluated[0]?.startContext?.type, 'HUT_START');
  assert.equal(result.evaluated[0]?.autoEligible, false);
  assert.equal(result.evaluated[0]?.elevationGainMeters, null);
  assert.equal(result.evaluated[0]?.verticalGainMeters, null);
  assertOfflineSafe(result);
});

test('M: high-mountain evidence vetoes a parking start even with a connected safe route', () => {
  const fixture = parkingRoute();
  feature(fixture.index, 'saddles', 301, coordinate(5000, 100), { natural: 'saddle' });
  const result = session(fixture.ways, fixture.index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.evaluated[0]?.startContext?.type, 'HIGH_MOUNTAIN_START');
  assert.equal(result.evaluated[0]?.autoEligible, false);
  assert.ok(result.rejections.highMountain >= 1);
  assert.equal(result.status, 'ONLY_HIGH_MOUNTAIN_STARTS');
  assertOfflineSafe(result);
});

test('N: proven public access does not invent or require an unknown elevation', () => {
  const result = parkingRoute(5000, false).session.discover(request);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.evaluated[0]?.startContext?.type, 'AMBIGUOUS_START');
  assert.equal(result.evaluated[0]?.autoEligible, true);
  assert.ok(result.rejections.ambiguous >= 1);
  assert.equal(result.status, 'STARTS_FOUND');
  assertOfflineSafe(result);
});

for (const [label, tags, rejectedWayId] of [
  ['O', { access: 'private' }, 10],
  ['P', { foot: 'no' }, 10],
  ['Q', { highway: 'motorway' }, 10],
] as const) {
  test(`${label}: forbidden ${JSON.stringify(tags)} geometry cannot connect the candidate`, () => {
    const index = emptyIndex();
    parking(index, 1, coordinate(5000));
    const fixture = session([
      way(rejectedWayId, [node(1, 5000), node(2, 2500)], tags),
      way(20, [node(2, 2500), node(SUMMIT_NODE, 0)]),
    ], index);
    assert.ok(fixture.graph.exclusions.some(item => item.wayId === rejectedWayId));
    const result = fixture.discover(request);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.evaluated.every(item => item.route === null));
    assertOfflineSafe(result);
  });
}

test('O/P follow-up: explicit pedestrian permission preserves the existing private-access override', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const result = session([way(10, [node(1, 5000), node(2, 2500), node(SUMMIT_NODE, 0)],
    { access: 'private', foot: 'permissive' })], index).discover(request);
  assert.equal(result.candidates.length, 1);
  assertOfflineSafe(result);
});

test('Q follow-up: an actual at-grade motorway crossing is blocked after reconstruction', () => {
  const fixture = parkingRoute();
  const result = session([
    ...fixture.ways.map(item => ({ ...item, tags: { ...item.tags, layer: '0' } })),
    way(20, [node(20, 2500, -1000), node(2, 2500), node(21, 2500, 1000)], { highway: 'motorway', layer: '0' }),
  ], fixture.index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluated.some(item => item.route && item.safety === 'BLOCKED'));
  assert.ok(result.evaluated.some(item => item.safetyReasons.includes('UNSAFE_AT_GRADE_MOTORWAY_CROSSING')));
  assertOfflineSafe(result);
});

test('R: a disconnected POI is rejected despite being on another admitted trail component', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const result = session([
    way(10, [node(1, 5000), node(2, 4000)]),
    way(20, [node(3, 2000), node(SUMMIT_NODE, 0)]),
  ], index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluated.every(item => item.route === null));
  assert.ok(result.rejections.disconnected >= 1);
  assertOfflineSafe(result);
});

test('S: a 200 m break between nearby trails is never replaced by a fabricated straight line', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const result = session([
    way(10, [node(1, 5000), node(2, 4900)]),
    way(20, [node(3, 4700), node(SUMMIT_NODE, 0)]),
  ], index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.evaluated.every(item => item.route === null));
  assert.equal(result.fabricatedGapCount, 0);
  assertOfflineSafe(result);
});

test('T: a safe 30+ km remote approach is retained, without a 20 km route cutoff', () => {
  const result = parkingRoute(32_000).session.discover(request);
  const candidate = result.candidates[0];
  assert.ok(candidate);
  assert.ok(candidate.networkDistanceMeters! > 30_000);
  assert.equal(candidate.category, 'REMOTE_APPROACH');
  assert.equal(candidate.startContext?.type, 'BASE_START');
  assertOfflineSafe(result);
});

test('U: an actual network detour beyond 100 km is review-only despite a nearby valid base', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const result = session([way(10, [node(1, 5000), node(2, 60_000), node(SUMMIT_NODE, 0)])], index).discover(request);
  assert.equal(result.candidates.length, 0);
  const candidate = result.evaluated.find(item => item.networkDistanceMeters !== null);
  assert.ok(candidate);
  assert.ok(candidate.networkDistanceMeters! > DEFAULT_ADAPTIVE_START_POLICY.maximumReasonableNetworkMeters);
  assert.equal(candidate.autoEligible, false);
  assert.ok(['NO_REASONABLE_START', 'NEEDS_REVIEW'].includes(result.status));
  assertOfflineSafe(result);
});

test('V: reversed source arrays and repeated discovery preserve ordered candidates and result hashes', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  parking(index, 2, coordinate(-5000));
  const ways = [way(10, [node(1, 5000), node(SUMMIT_NODE, 0)]),
    way(20, [node(2, -5000), node(SUMMIT_NODE, 0)])];
  const firstSession = session(ways, index);
  const first = firstSession.discover(request);
  const repeated = firstSession.discover(request);
  const reversedIndex = Object.fromEntries(Object.entries(index).map(([key, records]) => [key, [...records].reverse()])) as unknown as FeatureIndex;
  const reversed = session([...ways].reverse(), reversedIndex).discover(request);
  assert.equal(first.resultHash, repeated.resultHash);
  assert.equal(first.resultHash, reversed.resultHash);
  assert.equal(first.graphHash, reversed.graphHash);
  assert.deepEqual(first.candidates.map(item => item.id), reversed.candidates.map(item => item.id));
  assert.deepEqual(first.evaluated.map(item => item.id), reversed.evaluated.map(item => item.id));
  assert.equal(repeated.componentCacheHit, true);
  assert.match(first.policyHash, /^[a-f0-9]{64}$/);
  assertOfflineSafe(first);
});

test('integration: summit discovery, ranking and existing reconstruction retain every traversed OSM edge', () => {
  const fixture = parkingRoute();
  const result = fixture.session.discover(request);
  const route = result.candidates[0]?.route;
  assert.ok(route);
  assert.deepEqual(route.osmNodeIds, [1, 2, SUMMIT_NODE]);
  assert.deepEqual(route.osmWayIds, [10]);
  assert.equal(route.geometryProvenance.sourceKey, 'openstreetmap');
  assert.equal(route.geometryProvenance.datasetIdentity.pbfSha256, dataset.pbfSha256);
  for (let i = 1; i < route.osmNodeIds.length; i++) {
    assert.ok(fixture.session.graph.neighbors(route.osmNodeIds[i - 1])
      .some(edge => edge.toNodeId === route.osmNodeIds[i] && route.osmWayIds.includes(edge.wayId)));
  }
  assert.deepEqual(route.geometry.coordinates, [coordinate(5000), coordinate(2500), coordinate(0)]);
  assert.equal(result.candidates[0].routeDistanceMeters, route.distanceM);
  assertOfflineSafe(result);
});

test('a summit more than 30 m from graph nodes fails explicitly before any candidate routing', () => {
  const fixture = parkingRoute();
  const result = fixture.session.discover({ summit: { ...request.summit, coordinate: coordinate(0, 40) } });
  assert.equal(result.status, 'NO_SUMMIT_CONNECTION');
  assert.equal(result.solverCalls, 0);
  assert.equal(result.candidates.length, 0);
  assertOfflineSafe(result);
});

test('tier candidate budgets and deduplication bound routing even without an early-exit success', () => {
  const index = emptyIndex();
  const ways: OsmTrailWayInput[] = [];
  for (const [tierIndex, distanceMeters] of [6000, 15_000, 25_000, 40_000].entries()) {
    for (let side = 0; side < 9; side++) {
      const id = 100 + tierIndex * 10 + side;
      const angle = side * Math.PI * 2 / 9;
      const start = node(id, distanceMeters * Math.cos(angle), distanceMeters * Math.sin(angle));
      parking(index, id, start.coordinate, false);
      feature(index, 'saddles', id + 500_000, start.coordinate, { natural: 'saddle' });
      ways.push(way(id, [start, node(SUMMIT_NODE, 0)]));
    }
  }
  const result = session(ways, index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.tiersVisited, [10_000, 20_000, 35_000, 50_000]);
  assert.ok(result.solverCalls > 0);
  assert.ok(result.solverCalls <= DEFAULT_ADAPTIVE_START_POLICY.maximumSeriousCandidates);
  assert.equal(new Set(result.evaluated.map(item => item.id)).size, result.evaluated.length);
  assertOfflineSafe(result);
});

test('directed pedestrian topology does not mistake a descent-only component for summit access', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const result = session([way(10, [node(SUMMIT_NODE, 0), node(2, 2500), node(1, 5000)],
    { 'oneway:foot': 'yes' })], index).discover(request);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.evaluated[0]?.route, null);
  assertOfflineSafe(result);
});

for (const tags of [
  { highway: 'service', access: 'private' },
  { highway: 'service', foot: 'no' },
  { highway: 'motorway', foot: 'yes' },
  { highway: 'motorway_link', foot: 'yes' },
  { highway: 'service', access: 'customers' },
] as Record<string, string>[]) {
  test(`NETWORK_ACCESS requires permitted real approach topology: ${JSON.stringify(tags)}`, () => {
    const result = session([
      way(10, [node(1, 5000), node(2, 2500), node(SUMMIT_NODE, 0)]),
      way(20, [node(3, 5500, 500), node(1, 5000)], tags),
    ]).discover(request);
    assert.equal(result.evaluated.filter(item => item.kind === 'NETWORK_ACCESS').length, 0);
    assert.equal(result.candidates.length, 0);
    assertOfflineSafe(result);
  });
}

function attachmentRequest(northMeters: number) {
  return { ...request, summit: { ...request.summit, coordinate: coordinate(0, northMeters) },
    summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY };
}

for (const [distanceMeters, tier, expectedStatus] of [
  [29, 'DIRECT', 'STARTS_FOUND'],
  [30, 'DIRECT', 'STARTS_FOUND'],
] as const) {
  test(`summit attachment: ${distanceMeters} m snaps directly and keeps a safe parking start (${tier})`, () => {
    const result = parkingRoute().session.discover(attachmentRequest(distanceMeters));
    assert.equal(result.status, expectedStatus);
    assert.ok(result.summitAttachment);
    assert.equal(result.summitAttachment.tier, tier);
    assert.equal(result.summitAttachment.autoEligible, true);
    assert.equal(result.summitAttachment.distanceMeters, distanceMeters);
    assert.deepEqual(result.summitAttachment.targetCoordinate, coordinate(0, distanceMeters));
    assert.deepEqual(result.summitAttachment.routeTerminalCoordinate, coordinate(0));
    const candidate = result.candidates[0];
    assert.ok(candidate?.route);
    assert.deepEqual(candidate.route.osmNodeIds.at(-1), SUMMIT_NODE);
    assert.deepEqual(candidate.route.geometry.coordinates.at(-1), result.summitAttachment.routeTerminalCoordinate);
    assertOfflineSafe(result);
  });
}

for (const distanceMeters of [31, 50] as const) {
  test(`summit attachment: ${distanceMeters} m extends the automatic boundary and still derives a safe start (EXTENDED)`, () => {
    const result = parkingRoute().session.discover(attachmentRequest(distanceMeters));
    assert.equal(result.status, 'STARTS_FOUND');
    assert.ok(result.summitAttachment);
    assert.equal(result.summitAttachment.tier, 'EXTENDED');
    assert.equal(result.summitAttachment.autoEligible, true);
    assert.equal(result.summitAttachment.distanceMeters, distanceMeters);
    assert.deepEqual(result.summitAttachment.routeTerminalCoordinate, coordinate(0));
    const candidate = result.candidates[0];
    assert.ok(candidate?.route);
    assert.deepEqual(candidate.route.geometry.coordinates.at(-1), result.summitAttachment.routeTerminalCoordinate);
    assertOfflineSafe(result);
  });
}

for (const distanceMeters of [51, 100] as const) {
  test(`summit attachment: ${distanceMeters} m requires review and is never auto-approved (REVIEW_PROXIMITY)`, () => {
    const result = parkingRoute().session.discover(attachmentRequest(distanceMeters));
    assert.equal(result.status, 'NEEDS_REVIEW');
    assert.ok(result.summitAttachment);
    assert.equal(result.summitAttachment.tier, 'REVIEW_PROXIMITY');
    assert.equal(result.summitAttachment.autoEligible, false);
    assert.equal(result.summitAttachment.distanceMeters, distanceMeters);
    assert.ok(result.reasons.includes(SUMMIT_ATTACHMENT_REASON_REVIEW));
    assert.equal(result.candidates.length, 0);
    const routed = result.evaluated.find(item => item.route !== null);
    assert.ok(routed, 'REVIEW proximity still routes real candidates for human review');
    assert.ok(routed.route, 'proximity route still routes real candidates on real OSM edges');
    assert.equal(routed.autoEligible, false);
    assert.equal(result.fabricatedGapCount, 0);
    assert.deepEqual(routed.route!.osmNodeIds.at(-1), SUMMIT_NODE);
    assert.deepEqual(routed.route!.geometry.coordinates.at(-1), result.summitAttachment.routeTerminalCoordinate);
    assert.equal(result.publishable, false);
  });
}

test('summit attachment: beyond the review bound no automatic node is admitted', () => {
  const result = parkingRoute().session.discover(attachmentRequest(101));
  assert.equal(result.status, 'NO_SUMMIT_CONNECTION');
  assert.equal(result.summitAttachment, null);
  assert.ok(result.reasons.includes('NO_ELIGIBLE_GRAPH_NODE_WITHIN_ATTACHMENT_REVIEW_BOUND'));
  assert.equal(result.solverCalls, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.publishable, false);
});

test('summit attachment: a 70 m real trail node yields NEEDS_REVIEW without fabrication or invented geometry', () => {
  const fixture = parkingRoute();
  const result = fixture.session.discover(attachmentRequest(70));
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.ok(result.summitAttachment);
  assert.equal(result.summitAttachment.tier, 'REVIEW_PROXIMITY');
  const routed = result.evaluated.find(item => item.route !== null);
  assert.ok(routed, 'a 70 m trail node still routes a real candidate for human review');
  assert.ok(routed.route, 'routed candidate retains a real OSM route');
  assert.equal(result.fabricatedGapCount, 0);
  assert.equal(routed.route.geometrySource, 'OPENSTREETMAP');
  const route = routed.route;
  for (let i = 1; i < route.osmNodeIds.length; i++) {
    assert.ok(fixture.session.graph.neighbors(route.osmNodeIds[i - 1])
      .some(edge => edge.toNodeId === route.osmNodeIds[i] && route.osmWayIds.includes(edge.wayId)));
  }
});

test('summit attachment: equidistant nodes tie-break deterministically across repeated discovery', () => {
  const index = emptyIndex();
  parking(index, 1, coordinate(5000));
  const first = session([way(10, [node(1, 5000), node(2, 0, -50), node(3, 0, 50)])], index);
  const center = { ...request, summit: { ...request.summit, coordinate: coordinate(0) },
    summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY };
  const result = first.discover(center);
  const repeated = first.discover(center);
  assert.equal(result.resultHash, repeated.resultHash);
  assert.ok(result.summitAttachment);
  assert.equal(result.summitAttachment.tier, 'EXTENDED');
  assert.equal(result.summitAttachment.distanceMeters, 50);
  assert.deepEqual(result.summitAttachment.routeTerminalCoordinate, coordinate(0, -50));
  assert.deepEqual(result.candidates[0]?.route?.osmNodeIds.at(-1), 2);
  assert.equal(result.publishable, false);
});
