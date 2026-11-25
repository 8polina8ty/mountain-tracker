import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractSignal, readJson, OUTPUT, withoutTrailingQualifier, type Corpus, type Facts, type Plan } from './phase12d-calibration.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { buildOsmTrailGraph } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { solveGraphPathAStar, type GraphSearchDiagnostics } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';

const facts: Facts = { relationTags: { from: 'Alpine Village', to: 'Summit', name: null, ref: '100' }, summits: [{ id: '12', name: 'Summit' }] };
test('semantic extraction needs a named start, never uses a ref as an anchor', () => {
  assert.equal(extractSignal('1', facts).signal?.startHint.name, 'Alpine Village');
  const missing = { ...facts, relationTags: { ref: '100' } };
  assert.equal(extractSignal('1', missing).reason, 'NO_NON_GEOMETRIC_START_NAME');
});
test('exact summit endpoint supports semantic reversal without trackpoint inspection', () => {
  const signal = extractSignal('1', { ...facts, relationTags: { from: 'Summit', to: 'Alpine Village' } }).signal;
  assert.equal(signal?.startHint.name, 'Alpine Village');
  assert.equal(signal?.summitHint.name, 'Summit');
});
test('name parsing refuses three-part paths and does not invent intermediate vias', () => {
  assert.equal(extractSignal('1', { ...facts, relationTags: { name: 'Village - Hut - Summit' } }).signal, null);
  const signal = extractSignal('1', { ...facts, relationTags: { name: 'Village - Summit' } }).signal;
  assert.equal(signal?.startHint.name, 'Village'); assert.deepEqual(signal?.viaHints, []);
});
test('missing or multiple summit identities fail before routing', () => {
  assert.equal(extractSignal('1', { ...facts, summits: [] }).signal, null);
  assert.equal(extractSignal('1', { ...facts, summits: [...facts.summits, { id: '13', name: 'Second' }] }).signal, null);
});
test('unsafe source fields remain a signal-stage failure', () => {
  assert.equal(extractSignal('1', { ...facts, relationTags: { from: '<script>' } }).signal, null);
});
test('versioned qualifier normalization is general and leaves ordinary names intact', () => {
  assert.equal(withoutTrailingQualifier('Village (Town hall)'), 'Village');
  assert.equal(withoutTrailingQualifier('Village, centro paese'), 'Village');
  assert.equal(withoutTrailingQualifier('Bivio sopra Malga Moren'), 'Bivio sopra Malga Moren');
  assert.equal(withoutTrailingQualifier('Hut on the ridge'), 'Hut on the ridge');
});
test('qualifier resolver changes only NOT_FOUND starts and preserves ambiguous originals', async () => {
  const v1 = await readJson<Plan>(`${OUTPUT}/phase12d-semantic-plan.json`);
  const v2 = await readJson<Plan>(`${OUTPUT}/phase12d-semantic-plan-v2.json`);
  for (const before of v1.records) {
    const after = v2.records.find(r => r.relationId === before.relationId)!;
    assert.deepEqual(after.signal, before.signal);
    assert.deepEqual(after.summit, before.summit);
    if (before.start?.status !== 'NOT_FOUND') assert.deepEqual(after.start, before.start);
    if (before.start?.status === 'NOT_FOUND' && after.start?.status === 'RESOLVED') {
      assert(after.start.anchor.resolutionEvidence.includes('phase12d/exact-name-qualifier-fallback/v2'));
    }
  }
});
test('geometry and start labels cannot influence the semantic extractor', () => {
  const poison = { ...facts, geometry: { coordinates: [[99, 99]] }, startCoordinate: [1, 2], labels: { startContext: 'BASE_START' } };
  assert.deepEqual(extractSignal('1', poison), extractSignal('1', facts));
});
test('frozen corpus includes exactly 44 approved, 245 GREEN and a disjoint fixed 30/14 split', async () => {
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  const gold = corpus.records.filter(r => r.humanApproved);
  assert.equal(gold.length, 44); assert.equal(corpus.records.filter(r => r.machineGreen).length, 245);
  assert.equal(gold.filter(r => r.split === 'TRAIN').length, 30);
  assert.equal(gold.filter(r => r.split === 'HOLDOUT').length, 14);
  const byId = Object.fromEntries(gold.map(r => [r.relationId, r.split]));
  for (const [context, trainCount] of [['BASE_START', 16], ['HUT_START', 14]] as const) {
    const ids = gold.filter(r => r.labels.startContext === context).map(r => r.relationId)
      .sort((a, b) => createHash('sha256').update(`phase12d/split/v1:${a}`).digest('hex')
        .localeCompare(createHash('sha256').update(`phase12d/split/v1:${b}`).digest('hex')));
    ids.forEach((id, i) => assert.equal(byId[id], i < trainCount ? 'TRAIN' : 'HOLDOUT'));
  }
  assert.equal(sha256Stable(byId), corpus.splitHash);
  assert(corpus.records.find(r => r.relationId === '274491')?.negativeReasons.includes('START_HIGH_MOUNTAIN'));
});
test('every persisted semantic plan is reproducible solely from allowed facts', async () => {
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  const plan = await readJson<Plan>(`${OUTPUT}/phase12d-semantic-plan.json`);
  for (const member of corpus.records) {
    const row = plan.records.find(r => r.relationId === member.relationId)!;
    assert.deepEqual(extractSignal(member.relationId, member.facts), { signal: row.signal, contributedFields: row.contributedFields, reason: row.reason });
  }
  assert.equal(plan.planHash, sha256Stable({ identity: plan.identity, records: plan.records }));
});
const dataset = { datasetKey: 'synthetic', region: 'synthetic', snapshotTimestamp: '2026-08-24T21:21:08.000Z', pbfSha256: 'a'.repeat(64) };
test('search-limit diagnostics distinguish exhausted graph from bounded search without changing A*', () => {
  const graph = buildOsmTrailGraph(dataset, [{ id: 1, tags: { highway: 'path' }, nodes: [1, 2, 3].map(id => ({ nodeId: id, coordinate: [11 + id * .001, 47] })) }]);
  const diagnostic: GraphSearchDiagnostics = { visitedNodes: 0, outcome: 'EXHAUSTED' };
  const options = { maximumVisitedNodesPerLeg: 1, maximumLegCost: 1e6 };
  assert.equal(solveGraphPathAStar(graph, 1, 3, options, diagnostic), null);
  assert.equal(diagnostic.outcome, 'SEARCH_LIMIT_EXCEEDED'); assert.equal(diagnostic.visitedNodes, 2);
  assert.deepEqual(solveGraphPathAStar(graph, 1, 3), solveGraphPathAStar(graph, 1, 3, undefined, diagnostic));
  assert.equal(diagnostic.outcome, 'SOLVED');
});
test('adversarial motorway/link/private/foot=no controls stay excluded under any snap search', () => {
  for (const tags of [{ highway: 'motorway' }, { highway: 'motorway_link' }, { highway: 'path', access: 'private' },
    { highway: 'path', foot: 'no' }, { highway: 'path', access: 'permit' }] as Record<string, string>[]) {
    const graph = buildOsmTrailGraph(dataset, [{ id: 1, tags, nodes: [{ nodeId: 1, coordinate: [11, 47] }, { nodeId: 2, coordinate: [11.01, 47] }] }]);
    assert.equal(graph.edges.length, 0); assert.equal(graph.findNearestNode([11, 47], 300), null);
  }
});
test('completed shards lock all versions and detect result tampering', async () => {
  const dirs = await readdir(`${OUTPUT}/checkpoints`);
  for (const dir of dirs) {
    const identity = await readJson(`${OUTPUT}/checkpoints/${dir}/identity.json`);
    for (const file of (await readdir(`${OUTPUT}/checkpoints/${dir}`)).filter(f => /^\d+\.json$/.test(f))) {
      const shard = await readJson<{ identityHash: string; resultHash: string; result: Record<string, unknown> }>(`${OUTPUT}/checkpoints/${dir}/${file}`);
      assert.equal(shard.identityHash, sha256Stable(identity)); assert.equal(shard.resultHash, sha256Stable(shard.result));
      assert.notEqual(shard.resultHash, sha256Stable({ ...shard.result, relationId: 'tampered' }));
    }
  }
});
test('Phase12C closing disposition and its three limitations remain intact', async () => {
  const closing = JSON.parse(await readFile('data/gpx/phase12c/phase12c-closing-decision.json', 'utf8'));
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  assert.equal(closing.phase12cAcceptance, 'STRICT_NEGATIVE_ACCEPTED');
  assert.equal(closing.documentedLimitations.length, 3);
  assert.deepEqual(corpus.phase12cLimitations, closing.documentedLimitations);
});
test('source snapshots retain the exact code measured by the original baseline', async () => {
  const snapshot = await readJson<{ files: Record<string, { sha256: string; source: string }> }>(`${OUTPUT}/phase12d-baseline-source-snapshot.json`);
  assert(Object.keys(snapshot.files).length >= 10);
  for (const source of Object.values(snapshot.files)) {
    assert.equal(createHash('sha256').update(source.source).digest('hex'), source.sha256);
  }
});
test('negative label provenance does not invent observed start contexts for topology controls', async () => {
  const provenance = await readJson<{ records: { relationId: string; observedFrozenStartContext: string | null; analysisStartContext: string }[] }>(`${OUTPUT}/phase12d-negative-label-provenance.json`);
  assert.equal(provenance.records.length, 19);
  const missing = provenance.records.filter(r => r.observedFrozenStartContext === null);
  assert.equal(missing.length, 6); assert(missing.every(r => r.analysisStartContext === 'UNKNOWN'));
  assert.equal(provenance.records.find(r => r.relationId === '274491')?.observedFrozenStartContext, 'HIGH_MOUNTAIN_START');
});
