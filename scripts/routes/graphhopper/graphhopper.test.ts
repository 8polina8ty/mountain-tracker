import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { primaryStartPriority } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { graphIdFor, profileConfigHash } from './meta.ts';
import { rankCandidates, boundedCandidatesForSummit, type CandidateIndex, type RawCandidate } from './candidate-index.ts';
import { routeWithGraphHopper, serializeGpx, serializeGeojson, type RouteResult } from './adapter.ts';
import type { GraphMeta } from './meta.ts';

test('GraphHopper config identity is deterministic and uses foot profile', async () => {
  const raw = await readFile('data/routes/graphhopper/alps-hike/config.yml', 'utf8');
  assert.match(raw, /datareader\.file:\s*data\/osm\/source\/alps-latest\.osm\.pbf/);
  assert.match(raw, /graph\.location:\s*data\/routes\/graphhopper\/alps-hike\/graph-cache/);
  assert.match(raw, /name:\s*foot/);
  assert.match(raw, /graph\.encoded_values:.*foot_access/);
  assert.doesNotMatch(raw, /^\s*graph\.flag_encoders/m);
  const hash1 = createHash('sha256').update(raw).digest('hex');
  const hash2 = createHash('sha256').update(await readFile('data/routes/graphhopper/alps-hike/config.yml')).digest('hex');
  assert.equal(hash1, hash2);
});

test('graphId binds PBF fingerprint + profile + config hash', () => {
  const pbfSha = 'a'.repeat(64);
  const pHash = profileConfigHash();
  const cfgHash = 'b'.repeat(64);
  const id1 = graphIdFor({ pbfSha256: pbfSha, profileConfigHash: pHash, configHash: cfgHash });
  const id2 = graphIdFor({ pbfSha256: pbfSha, profileConfigHash: pHash, configHash: cfgHash });
  assert.equal(id1, id2);
  const id3 = graphIdFor({ pbfSha256: 'c'.repeat(64), profileConfigHash: pHash, configHash: cfgHash });
  assert.notEqual(id1, id3);
});

test('candidate index ranking respects Base Access V2 priorities and rejects hut', () => {
  const cands: RawCandidate[] = [
    { osmType: 'node', osmId: 1, kind: 'PARKING', name: 'P', lat: 47, lon: 11, tags: {} },
    { osmType: 'node', osmId: 2, kind: 'TRAILHEAD', name: 'T', lat: 47, lon: 11, tags: {} },
    { osmType: 'node', osmId: 3, kind: 'VILLAGE', name: 'V', lat: 47, lon: 11, tags: {} },
    { osmType: 'node', osmId: 4, kind: 'ALPINE_HUT', name: 'H', lat: 47, lon: 11, tags: {} },
  ];
  const ranked = rankCandidates(cands);
  assert.equal(ranked[0].kind, 'TRAILHEAD');
  assert.equal(ranked[1].kind, 'PARKING');
  assert.equal(ranked[2].kind, 'VILLAGE');
  assert.equal(primaryStartPriority('ALPINE_HUT'), 99);
});

test('boundedCandidates prefers 5-20 and not simply nearest', async () => {
  const index: CandidateIndex = {
    version: 'mountain-tracker/graphhopper-candidate-index/v1',
    pbfSha256: 'x'.repeat(64),
    createdAt: new Date().toISOString(),
    count: 30,
    candidates: Array.from({ length: 30 }, (_, i) => ({
      osmType: 'node' as const,
      osmId: i + 1,
      kind: i < 5 ? 'TRAILHEAD' : i < 15 ? 'PARKING' : 'VILLAGE',
      name: `C${i}`,
      lat: 47 + i * 0.001,
      lon: 11,
      tags: {},
    })),
  };
  const bounded = boundedCandidatesForSummit(index, { lat: 47, lon: 11 }, 20);
  assert.ok(bounded.length >= 5 && bounded.length <= 20);
  assert.equal(bounded[0].kind, 'TRAILHEAD');
});

test('GraphHopper response parsing and snap safety fail-closed', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        paths: [
          {
            distance: 5000,
            time: 3600000,
            points: { coordinates: [[11.0, 47.0], [11.01, 47.01]], type: 'LineString' },
            snapped_waypoints: { coordinates: [[11.5, 47.5], [11.01, 47.01]], type: 'MultiPoint' },
          },
        ],
      }),
    }) as unknown as Response;
  const res = await routeWithGraphHopper({ start: { lat: 47, lon: 11 }, summit: { lat: 47.01, lon: 11.01 } }, { graphId: 'abc', graphHopperVersion: '10.2' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'REJECTED_ACCESS');

  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, status: 400, text: async () => 'Connection between locations not found' }) as unknown as Response;
  const res2 = await routeWithGraphHopper({ start: { lat: 47, lon: 11 }, summit: { lat: 47.01, lon: 11.01 } }, { graphId: 'abc', graphHopperVersion: '10.2' });
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.reason, 'NO_ROUTE');

  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        paths: [
          {
            distance: 1234,
            time: 1800000,
            points: { coordinates: [[11.0, 47.0], [11.005, 47.005], [11.01, 47.01]], type: 'LineString' },
            snapped_waypoints: { coordinates: [[11.0001, 47.0001], [11.01, 47.01]], type: 'MultiPoint' },
          },
        ],
      }),
    }) as unknown as Response;
  const res3 = await routeWithGraphHopper({ start: { lat: 47, lon: 11 }, summit: { lat: 47.01, lon: 11.01 } }, { graphId: 'abc', graphHopperVersion: '10.2' });
  assert.equal(res3.ok, true);
  if (res3.ok) {
    assert.equal(res3.result.distanceMeters, 1234);
    assert.ok(res3.result.geometry.coordinates.length === 3);
  }
  globalThis.fetch = originalFetch;
});

test('GPX/GeoJSON determinism', () => {
  const route: RouteResult = {
    geometry: { type: 'LineString', coordinates: [[11, 47], [11.01, 47.01]] },
    distanceMeters: 1000,
    timeMillis: 600000,
    requestedStart: { lat: 47, lon: 11 },
    requestedSummit: { lat: 47.01, lon: 11.01 },
    snappedStart: { lat: 47, lon: 11 },
    snappedSummit: { lat: 47.01, lon: 11.01 },
    snapDistanceStartM: 5,
    snapDistanceSummitM: 3,
    profile: 'foot',
    graphId: 'abc123',
    graphHopperVersion: '10.2',
  };
  const gpx1 = serializeGpx('A → B', route);
  const gpx2 = serializeGpx('A → B', route);
  assert.equal(gpx1, gpx2);
  const gj1 = serializeGeojson('A → B', route, { startKind: 'PARKING' });
  const gj2 = serializeGeojson('A → B', route, { startKind: 'PARKING' });
  assert.equal(gj1, gj2);
  assert.match(gpx1, /trkpt lat="47"/);
  assert.match(gj1, /LineString/);
});

test('checkpoint graphId binding and reuse-without-reimport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-meta-'));
  const fakePbf = join(dir, 'fake.pbf');
  await writeFile(fakePbf, 'fake-pbf-content');
  const fakeConfig = join(dir, 'config.yml');
  await writeFile(fakeConfig, 'graphhopper:\n  datareader.file: fake\n');
  const { currentMeta } = await import('./meta.ts');
  const meta1 = await currentMeta(fakePbf, fakeConfig);
  const meta2 = await currentMeta(fakePbf, fakeConfig);
  assert.equal(meta1.graphId, meta2.graphId);
  assert.equal(meta1.pbfSha256, meta2.pbfSha256);
  await writeFile(fakeConfig, 'graphhopper:\n  datareader.file: fake2\n');
  const meta3 = await currentMeta(fakePbf, fakeConfig);
  assert.notEqual(meta1.graphId, meta3.graphId);
  await rm(dir, { recursive: true, force: true });
});

test('graph cache drift detection fails closed', async () => {
  const metaA: GraphMeta = {
    version: 'mountain-tracker/graphhopper-graph-meta/v1',
    pbfSha256: 'a'.repeat(64),
    pbfSizeBytes: 100,
    pbfModifiedMs: 0,
    graphHopperVersion: '10.2',
    profile: 'foot',
    profileConfig: { name: 'foot', custom_model: { priority: [{ if: '!foot_access', multiply_by: '0' }], speed: [{ if: 'true', limit_to: 'foot_average_speed' }] } },
    profileConfigHash: 'x',
    graphHopperConfigHash: 'y',
    graphId: 'id1',
    graphLocation: 'x',
    configPath: 'y',
    createdAt: new Date().toISOString(),
  };
  const metaB: GraphMeta = { ...metaA, pbfSha256: 'b'.repeat(64), graphId: 'id2' };
  const { isCompatible } = await import('./meta.ts');
  assert.equal(isCompatible(metaA, metaA), true);
  assert.equal(isCompatible(metaA, metaB), false);
});
