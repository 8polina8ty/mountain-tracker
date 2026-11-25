import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import type { OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { prepareGraphCache } from './adaptive-start-pilot-graphs.ts';
import { SummitAttachmentGraphProvider } from './adaptive-start-summit-graphs.ts';

const dataset = { datasetKey: 'synthetic', region: 'alps', snapshotTimestamp: '2026-08-24T21:21:08.000Z', pbfSha256: 'a'.repeat(64) };
const identityHash = 'b'.repeat(64);
const way = (id: number, nodes: Array<[number, number, number]>, tags: Record<string, string> = { highway: 'path' }): OsmTrailWayInput => ({
  id, tags, nodes: nodes.map(([nodeId, longitude, latitude]) => ({ nodeId, coordinate: [longitude, latitude] })),
});

async function fixture(ways: OsmTrailWayInput[], run: (input: ConstructorParameters<typeof SummitAttachmentGraphProvider>[0]) => Promise<void> | void): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'adaptive-summit-wrapper-'));
  const extractionPath = join(folder, 'extraction.sqlite'), cachePath = join(folder, 'graphs.sqlite');
  try {
    const extraction = new DatabaseSync(extractionPath);
    extraction.exec('CREATE TABLE ways(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE region_ways(region TEXT,way INTEGER,PRIMARY KEY(region,way)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);');
    for (const item of ways) {
      extraction.prepare('INSERT INTO ways VALUES(?,?)').run(item.id, JSON.stringify(item));
      extraction.prepare('INSERT INTO region_ways VALUES(?,?)').run('fixture', item.id);
    }
    extraction.prepare('INSERT INTO metadata VALUES(?,?)').run('complete', JSON.stringify({ identity: { datasetSha256: dataset.pbfSha256 } }));
    extraction.close();
    const input = { extractionPath, cachePath, dataset, identityHash };
    await prepareGraphCache({ ...input, blocks: [{ blockId: 'fixture' }] });
    await run(input);
  } finally {
    const resolvedFolder = await realpath(folder);
    const resolvedTemporaryRoot = await realpath(tmpdir());
    assert(resolvedFolder.startsWith(join(resolve(resolvedTemporaryRoot), 'adaptive-summit-wrapper-')));
    await rm(resolvedFolder, { recursive: true });
  }
}

test('summit wrapper applies only the explicit distance bound, reuses graph, and preserves true gap distance', async () => {
  await fixture([way(1, [[11, 10, 46], [12, 10.01, 46]])], input => {
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      const target = [10, 46.00054] as const;
      assert.equal(provider.get('fixture', target, 30).status, 'NO_SUMMIT_CONNECTION');
      assert.equal(provider.get('fixture', target, 50).status, 'NO_SUMMIT_CONNECTION');
      const found = provider.get('fixture', target, 100);
      assert.equal(found.status, 'READY');
      assert.equal(found.selectedAttachmentNode!.nodeId, 11);
      assert.equal(found.selectedAttachmentNode!.distanceMeters, calculateCoordinateDistanceMeters(target, [10, 46]));
      assert.equal(found.stats.snapDistanceM, found.selectedAttachmentNode!.distanceMeters);
      assert.equal(found.graph!.nodes.size, 2);
      assert.equal(found.graph!.edges.length, 2);
      assert.equal(provider.get('fixture', target, 100).stats.graphCacheHit, true);
      assert.equal(provider.stats.graphBuilds, 1);
      assert.equal(provider.stats.graphCacheHits, 1);
      assert(Number.isFinite(found.queryMs) && Number.isFinite(provider.constructorLoadMs));
      assert(provider.cacheIdentity.identity && provider.cacheIdentity.complete);
      assert.throws(() => provider.get('fixture', target, 151));
      assert.throws(() => provider.get('fixture', target, NaN));
    } finally { provider.close(); }
  });
});

test('summit wrapper sees only admitted real edges and keeps deterministic coincident-node ties', async () => {
  await fixture([
    way(1, [[20, 10, 46], [21, 10.01, 46]]),
    way(2, [[10, 10, 46], [11, 9.99, 46]]),
    way(3, [[30, 10, 46.00054], [31, 10.01, 46.00054]], { highway: 'path', foot: 'no' }),
    way(4, [[40, 10, 46.00054], [41, 10.01, 46.00054]], { highway: 'motorway', foot: 'yes' }),
  ], input => {
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      const target = [10, 46.00054] as const;
      assert.equal(provider.get('fixture', target, 30).status, 'NO_SUMMIT_CONNECTION');
      const found = provider.get('fixture', target, 100);
      assert.equal(found.status, 'READY');
      assert.equal(found.selectedAttachmentNode!.nodeId, 10);
      assert.equal(found.stats.componentId, 10);
      assert.deepEqual([...new Set(found.graph!.edges.map(edge => edge.wayId))], [2]);
    } finally { provider.close(); }
  });
});

test('summit wrapper keeps nearest oversized component and loads it with the raised bound', async () => {
  await fixture([
    way(1, [[11, 10, 46], [12, 10.01, 46]]),
    way(2, [[21, 10, 46.0008], [22, 10.01, 46.0008]]),
  ], input => {
    // Deliberately mark the synthetic nearest component oversized; the loader
    // must build it with the raised bound instead of rejecting it.
    const cache = new DatabaseSync(input.cachePath);
    cache.prepare('UPDATE components SET nodes=150001 WHERE block=? AND component=?').run('fixture', 11);
    cache.close();
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      const result = provider.get('fixture', [10, 46.0002], 100);
      assert.equal(result.status, 'READY');
      assert.equal(result.selectedAttachmentNode!.nodeId, 11);
      assert.equal(result.stats.componentNodes, 150001);
      assert.equal(result.loader, 'OVERSIZED');
      assert(result.rssMb && Number.isFinite(result.rssMb.beforeBuild) && Number.isFinite(result.rssMb.afterBuild));
      assert.equal(provider.stats.graphBuilds, 0);
      assert.equal(provider.oversizedStats.graphBuilds, 1);
      // Second request for the same oversized component reuses the cached graph.
      const reused = provider.get('fixture', [10, 46.0002], 100);
      assert.equal(reused.status, 'READY');
      assert.equal(reused.stats.graphCacheHit, true);
      assert.equal(provider.oversizedStats.graphCacheHits, 1);
      assert.equal(provider.oversizedStats.graphBuilds, 1);
    } finally { provider.close(); }
  });
});

test('oversized loader respects its bounded LRU and evicts the oldest component', async () => {
  await fixture([
    way(1, [[11, 10, 46], [12, 10.01, 46]]),
    way(2, [[21, 11, 46], [22, 11.01, 46]]),
    way(3, [[31, 12, 46], [32, 12.01, 46]]),
  ], input => {
    const cache = new DatabaseSync(input.cachePath);
    for (const component of [11, 21, 31]) {
      cache.prepare('UPDATE components SET nodes=150001 WHERE block=? AND component=?').run('fixture', component);
    }
    cache.close();
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      assert.equal(provider.get('fixture', [10, 46.0002], 100).status, 'READY');
      assert.equal(provider.get('fixture', [11, 46.0002], 100).status, 'READY');
      assert.equal(provider.get('fixture', [12, 46.0002], 100).status, 'READY');
      assert.equal(provider.oversizedStats.graphBuilds, 3);
      assert.equal(provider.oversizedStats.graphEvictions, 1);
      // Component 11 was evicted by the LRU; requesting it again rebuilds.
      assert.equal(provider.get('fixture', [10, 46.0002], 100).status, 'READY');
      assert.equal(provider.oversizedStats.graphBuilds, 4);
      assert.equal(provider.oversizedStats.graphEvictions, 2);
    } finally { provider.close(); }
  });
});

test('oversized loader decides on the real build, not the frozen table statistic', async () => {
  await fixture([way(1, [[11, 10, 46], [12, 10.01, 46]])], input => {
    // The table may claim far more nodes than the cache ever admitted; the
    // loader routes on that statistic but decides success on the actual build.
    const cache = new DatabaseSync(input.cachePath);
    cache.prepare('UPDATE components SET nodes=1200001 WHERE block=? AND component=?').run('fixture', 11);
    cache.close();
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      const result = provider.get('fixture', [10, 46.0002], 100);
      assert.equal(result.status, 'READY');
      assert.equal(result.loader, 'OVERSIZED');
      assert.equal(result.stats.componentNodes, 1200001);
      assert.equal(provider.oversizedStats.graphBuilds, 1);
      assert.equal(provider.oversizedStats.loadRequests, 1);
    } finally { provider.close(); }
  });
});

test('summit wrapper preserves directed graph edges and rechecks actual cached graph node identity', async () => {
  await fixture([way(1, [[11, 10, 46], [12, 10.01, 46]], { highway: 'path', 'oneway:foot': 'yes' })], input => {
    const provider = new SummitAttachmentGraphProvider(input);
    try {
      const result = provider.get('fixture', [10, 46.0004], 100);
      assert.equal(result.status, 'READY');
      assert.equal(result.graph!.neighbors(11).length, 1);
      assert.equal(result.graph!.neighbors(12).length, 0);
      // The wrapper must not trust LRU reuse without validating selected node identity.
      const node = result.graph!.node(11)!;
      (node as unknown as { coordinate: [number, number] }).coordinate = [11, 46];
      const corrupted = provider.get('fixture', [10, 46.0004], 100);
      assert.equal(corrupted.status, 'NO_SUMMIT_CONNECTION');
      assert(corrupted.stats.reasonCodes.includes('SUMMIT_ATTACHMENT_GRAPH_NODE_IDENTITY_MISMATCH'));
    } finally { provider.close(); }
  });
});
