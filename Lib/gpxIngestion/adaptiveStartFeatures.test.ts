import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptiveStartFeatureIndex } from './adaptiveStartFeatures.ts';
import { calculateCoordinateDistanceMeters } from './gpxNormalization.ts';
import { classifyStartContextV2, type FeatureIndex } from '../../scripts/osm-import/start-context-classifier3.ts';

const empty = (): FeatureIndex => ({
  alpineHuts: [], wildernessHuts: [], mountainPasses: [], saddles: [], ridges: [], peaks: [],
  trailheads: [], trailheadInfo: [], parking: [], villages: [], hamlets: [], isolatedDwellings: [],
  farms: [], busStops: [], trainStations: [], halts: [], eleNodes: [],
});
const record = (id: number, coordinate: [number, number], tags: Record<string, string> = {}): FeatureIndex['parking'][number] => ({
  objectType: 'node', osmid: String(id), name: tags.name ?? null, coordinate, tags, wayNodeCount: null,
});

test('adaptive feature index ignores geometry-only rows and deduplicates actual POIs across layers', () => {
  const source = empty();
  const parking = record(12, [10, 46], { amenity: 'parking', ele: '1000' });
  source.parking = [record(1, [10, 46]), parking, parking];
  source.eleNodes = [parking];
  source.alpineHuts = [record(2, [10, 46])];
  source.peaks = [record(3, [10, 46], { natural: 'peak' })];
  const index = new AdaptiveStartFeatureIndex(source);
  assert.deepEqual(index.queryStarts([10, 46], 10).map(feature => feature.identity), ['node:12']);
  assert.equal(index.contextAt([10, 46]).parking.length, 1);
  assert.equal(index.contextAt([10, 46]).alpineHuts.length, 0);
  assert.equal(index.contextAt([10, 46]).peaks.length, 1);
  assert.equal(index.stats.startFeatureCount, 1);
});

test('adaptive index recognizes every required start type from actual tags', () => {
  const source = empty();
  const definitions: Array<[keyof FeatureIndex, Record<string, string>, string]> = [
    ['trailheads', { highway: 'trailhead' }, 'TRAILHEAD'],
    ['trailheadInfo', { information: 'guidepost' }, 'TRAILHEAD_INFO'],
    ['parking', { amenity: 'parking' }, 'PARKING'],
    ['villages', { place: 'village' }, 'VILLAGE'],
    ['hamlets', { place: 'hamlet' }, 'HAMLET'],
    ['trainStations', { railway: 'station' }, 'TRAIN_STATION'],
    ['halts', { railway: 'halt' }, 'HALT'],
    ['busStops', { highway: 'bus_stop' }, 'BUS_STOP'],
    ['isolatedDwellings', { place: 'isolated_dwelling' }, 'ISOLATED_DWELLING'],
    ['farms', { place: 'farm' }, 'FARM'],
    ['alpineHuts', { tourism: 'alpine_hut' }, 'ALPINE_HUT'],
    ['wildernessHuts', { tourism: 'wilderness_hut' }, 'WILDERNESS_HUT'],
  ];
  definitions.forEach(([layer, tags], index) => source[layer].push(record(index + 1, [10, 46], tags)));
  const index = new AdaptiveStartFeatureIndex(source);
  assert.deepEqual(index.queryStarts([10, 46], 10).map(feature => feature.kind).sort(), definitions.map(([, , kind]) => kind).sort());
});

test('adaptive spatial queries use actual distance at all tiers and handle the dateline and polar cells', () => {
  const source = empty();
  source.parking = [
    record(1, [179.999, 0], { amenity: 'parking' }),
    record(2, [-179.999, 0], { amenity: 'parking' }),
    record(3, [120, 89.999], { amenity: 'parking' }),
    record(4, [-60, 89.999], { amenity: 'parking' }),
    ...[0.05, 0.15, 0.25, 0.4, 0.6].map((longitude, i) => record(i + 10, [longitude, 0], { amenity: 'parking' })),
  ];
  const index = new AdaptiveStartFeatureIndex(source);
  assert.deepEqual(index.queryStarts([180, 0], 200).map(feature => feature.osmId), [1, 2]);
  assert.deepEqual(index.queryStarts([0, 90], 200).map(feature => feature.osmId), [3, 4]);
  for (const radius of [10_000, 20_000, 35_000, 50_000]) {
    const expected = source.parking.filter(feature => calculateCoordinateDistanceMeters([0, 0], feature.coordinate!) <= radius)
      .map(feature => Number(feature.osmid)).sort((left, right) => left - right);
    assert.deepEqual(index.queryStarts([0, 0], radius).map(feature => feature.osmId), expected);
  }
});

test('spatial context preserves authoritative base and high-mountain decisions and elevation evidence', () => {
  const source = empty();
  source.parking = [record(1, [10, 46], { amenity: 'parking' })];
  source.villages = [record(2, [10.01, 46], { place: 'village' })];
  source.eleNodes = [record(3, [10, 46], { ele: '1000' }), record(4, [20, 46], { ele: '3000' })];
  const index = new AdaptiveStartFeatureIndex(source);
  const full = classifyStartContextV2([10, 46], [10.1, 46.1], 2500, source);
  const nearby = classifyStartContextV2([10, 46], [10.1, 46.1], 2500, index.contextAt([10, 46]));
  assert.deepEqual(nearby, full);
  assert.equal(nearby.type, 'BASE_START');
  assert.equal(index.contextAt([10, 46]).eleNodes.length, 1);
  for (const [layer, tags] of [
    ['peaks', { natural: 'peak' }], ['ridges', { natural: 'ridge' }],
    ['saddles', { natural: 'saddle' }], ['mountainPasses', { mountain_pass: 'yes' }],
  ] as const) {
    const highSource = { ...source, [layer]: [record(5, [10, 46], tags)] };
    const highIndex = new AdaptiveStartFeatureIndex(highSource);
    assert.equal(classifyStartContextV2([10, 46], [10.1, 46.1], 2500, highIndex.contextAt([10, 46])).type, 'HIGH_MOUNTAIN_START');
    assert.equal(highIndex.queryStarts([10, 46], 100).length, 1);
  }
});

test('spatial lookup and duplicate resolution are deterministic when all source rows are reversed', () => {
  const source = empty();
  source.parking = [record(10, [10.001, 46], { amenity: 'parking' }),
    record(2, [10, 46], { amenity: 'parking', name: 'Start' }),
    record(2, [10, 46], { name: 'Start', amenity: 'parking' })];
  const reversed = Object.fromEntries(Object.entries(source).map(([layer, records]) => [layer, [...records].reverse()])) as unknown as FeatureIndex;
  const first = new AdaptiveStartFeatureIndex(source);
  const second = new AdaptiveStartFeatureIndex(reversed);
  assert.deepEqual(first.queryStarts([10, 46], 5000), second.queryStarts([10, 46], 5000));
  assert.deepEqual(first.contextAt([10, 46]), second.contextAt([10, 46]));
});

test('invalid coordinates and identities are excluded; invalid queries fail explicitly', () => {
  const source = empty();
  source.parking = [record(-1, [10, 46], { amenity: 'parking' }), record(2, [NaN, 46], { amenity: 'parking' }),
    record(3, [10, 91], { amenity: 'parking' }), record(4, [181, 46], { amenity: 'parking' })];
  const index = new AdaptiveStartFeatureIndex(source);
  assert.equal(index.queryStarts([10, 46], 50_000).length, 0);
  assert.throws(() => index.queryStarts([10, 91], 100));
  assert.throws(() => index.queryStarts([10, 46], Infinity));
  assert.throws(() => index.queryStarts([10, 46], -1));
});

test('a local query examines nearby bucket records rather than the entire feature catalog', () => {
  const source = empty();
  source.parking = Array.from({ length: 1000 }, (_, index) => record(index + 1, [-170 + index / 3, -40], { amenity: 'parking' }));
  source.parking.push(record(1001, [10, 46], { amenity: 'parking' }));
  const index = new AdaptiveStartFeatureIndex(source);
  assert.equal(index.queryStarts([10, 46], 50_000).length, 1);
  assert.equal(index.contextAt([10, 46]).parking.length, 1);
  assert.equal(index.stats.recordsExamined, 2);
});
