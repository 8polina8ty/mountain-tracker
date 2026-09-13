import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePbfArgs, blockFor, checkpointValid, runPbf } from './pbf.ts';
import { buildOsmTrailGraph } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { primaryStartPriority } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { sha256Bytes } from '../../Lib/gpxIngestion/hashing.ts';

test('PBF CLI rejects unknown, duplicate, missing and malformed arguments', () => {
  for (const args of [[], ['--input'], ['--input', 'x', '--execute'], ['--input', 'x', '--limit', '0'], ['--input', 'x', '--offset', '-1'],
    ['--input', 'x', '--limit', '1', '--limit', '2'], ['--input', 'x', '--min-elevation', '2000', '--max-elevation', '1000']]) assert.throws(() => parsePbfArgs(args));
  const p = parsePbfArgs(['--input', 'x.osm.pbf', '--limit', '1000', '--offset', '573', '--resume']);
  assert.equal(p.limit, 1000); assert.equal(p.offset, 573); assert.equal(p.resume, true);
});
test('block assignment is stable and groups nearby mountains, including negative coordinates', () => {
  assert.equal(blockFor(11.01, 47.01), blockFor(11.02, 47.02));
  assert.notEqual(blockFor(11.01, 47.01), blockFor(11.26, 47.01)); assert.equal(blockFor(-0.01, -0.01), '-1_-1');
});
test('stale checkpoint fails rather than mixing datasets or policies', () => {
  checkpointValid({ identity: 'a', results: [] }, 'a'); assert.throws(() => checkpointValid({ identity: 'a', results: [] }, 'b'), /STALE_CHECKPOINT/);
});
test('base priorities reject huts and retain the specified semantic ordering', () => {
  assert.deepEqual(['TRAILHEAD', 'PARKING', 'VILLAGE', 'BUS_STOP', 'PUBLIC_ROAD_END', 'NETWORK_ACCESS'].map(primaryStartPriority), [0, 1, 2, 3, 4, 5]);
  assert.equal(primaryStartPriority('ALPINE_HUT'), 99); assert.equal(primaryStartPriority('WILDERNESS_HUT'), 99);
});
test('existing graph engine excludes forbidden access and never joins disconnected ways', () => {
  const dataset = { datasetKey: 'fixture', region: 'fixture', snapshotTimestamp: '2026-01-01T00:00:00.000Z', pbfSha256: 'a'.repeat(64) };
  const restrictions: Record<string, string>[] = [{ foot: 'no' }, { access: 'no' }, { access: 'private' }];
  for (const restriction of restrictions) {
    const graph = buildOsmTrailGraph(dataset, [{ id: 1, tags: { highway: 'path', ...restriction }, nodes: [{ nodeId: 1, coordinate: [11, 47] }, { nodeId: 2, coordinate: [11.01, 47] }] }]);
    assert.equal(graph.neighbors(1).length, 0);
  }
});
test('raw fixture PBF produces parking-to-hut-to-summit GPX, persists failures and resumes with identical hashes', async () => {
  const dir = await mkdtemp('data/routes/pbf-fixture-'), input = join(dir, 'source.osm.pbf');
  execFileSync('python', ['-c', `
import osmium,sys
w=osmium.SimpleWriter(sys.argv[1])
for i,lon,lat,tags in [
 (1,11,47,{}),(2,11.005,47,{}),(3,11.01,47,{'amenity':'parking','name':'Valley parking','ele':'500'}),
 (4,11.025,47.015,{'tourism':'alpine_hut','name':'Intermediate hut','ele':'1000'}),
 (5,11.04,47.03,{'natural':'peak','name':'Fixture summit','ele':'1500'}),
 (6,11.08,47.08,{'natural':'peak','name':'Disconnected summit','ele':'1700'})]:
 w.add_node(osmium.osm.mutable.Node(id=i,location=(lon,lat),tags=tags))
w.add_way(osmium.osm.mutable.Way(id=10,nodes=[1,2,3],tags={'highway':'residential','name':'Valley road'}))
w.add_way(osmium.osm.mutable.Way(id=11,nodes=[3,4,5],tags={'highway':'path','sac_scale':'hiking','surface':'ground'}))
w.close()
`, input], { timeout: 10000, windowsHide: true });
  const options = parsePbfArgs(['--input', input, '--limit', '10']);
  const first = await runPbf(options);
  assert.equal(first.mountainsAttempted, 2); assert.equal(first.counts.ROUTE_GENERATED, 1); assert.equal(first.counts.NO_SUMMIT_CONNECTION, 1);
  assert.equal(first.graphBuilds, 1); assert.equal(first.externalRequests, 0); assert.equal(first.productionWrites, 0);
  const path = join('data/routes/pbf', first.runId, 'artifacts/5/route.gpx'); const hash = sha256Bytes(await readFile(path));
  const second = await runPbf({ ...options, resume: true });
  assert.equal(second.graphBuilds, 0); assert.deepEqual(second.counts, first.counts); assert.equal(sha256Bytes(await readFile(path)), hash);
  assert.match((await readFile(path, 'utf8')), /11\.025/);
  const result = JSON.parse(await readFile(join('data/routes/pbf', first.runId, 'results/6.json'), 'utf8'));
  assert.equal(result.state, 'NO_SUMMIT_CONNECTION'); assert(result.reasons.length > 0);
});
