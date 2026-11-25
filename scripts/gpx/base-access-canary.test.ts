import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { CanaryManifest, Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { serializeGpx, candidateEligible, type FrozenRow } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { primaryBaseAccess } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { sha256Bytes } from '../../Lib/gpxIngestion/hashing.ts';

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const source = 'data/gpx/generated-route-publication';
const out = 'data/gpx/base-access-start-v2';
const manifest = read<CanaryManifest>(`${source}/generated-route-canary-v1.json`);
const oldRows = read<FrozenRow[]>('data/gpx/adaptive-start-pilot/adaptive-start-component-v2-results.json');

test('recalibration covers exactly the ten immutable production canary IDs with zero writes', () => {
  const report = read<{ productionWrites: number; externalRequests: number; sourceManifestSha256: string; rows: { mountainId: number }[] }>(`${out}/comparison.json`);
  assert.equal(report.productionWrites, 0); assert.equal(report.externalRequests, 0);
  assert.deepEqual(report.rows.map(r => r.mountainId), manifest.entries.map(e => e.request.mountainRoute.mountain_id));
  assert.equal(report.sourceManifestSha256, sha256Bytes(readFileSync(`${source}/generated-route-canary-v1.json`)));
  for (const e of manifest.entries) for (const kind of ['gpx', 'geojson'] as const)
    assert.equal(sha256Bytes(readFileSync(`${source}/${e.files[kind].path}`)), e.files[kind].sha256, 'LIVE_PREVIEW_CHANGED');
});

for (const id of [138, 150, 12895, 55190]) {
  test(`mountain ${id}: obsolete hut/junction has no primary approval; regenerated start requires public context`, () => {
    const entry = manifest.entries.find(e => e.request.mountainRoute.mountain_id === id)!;
    const old = oldRows.find(r => r.mountainId === entry.request.provenance.sourceMountainIdentity)!;
    assert.equal(candidateEligible(old, old.candidates.find(c => c.id === entry.request.provenance.start.candidateId)!), false);
    const result = read<AdaptiveStartDiscoveryResult>(`${out}/${id}-evaluation.json`);
    assert.equal(result.request.summit.id, entry.request.provenance.sourceMountainIdentity);
    assert.equal(result.fabricatedGapCount, 0);
    for (const c of result.candidates) {
      assert.equal(c.startRole, 'PRIMARY_BASE_ACCESS');
      assert(primaryBaseAccess(c.accessEvidence));
      assert(!/HUT|REFUGE/.test(c.kind));
      assert.equal(c.safety, 'SAFE');
      assert.equal(c.route!.osmNodeIds[0], c.accessEvidence!.startNodeId);
    }
  });
}
test('every selected GPX is the complete reconstructed OSM LineString with exact endpoints', () => {
  for (const entry of manifest.entries) {
    const id = entry.request.mountainRoute.mountain_id;
    const r = read<AdaptiveStartDiscoveryResult>(`${out}/${id}-evaluation.json`);
    const c = r.candidates[0];
    if (!c) continue; // A failed mountain stays explicitly unresolved; no synthetic GPX.
    const geometry = c.route!.geometry as Line;
    assert.equal(geometry.type, 'LineString');
    assert.equal(geometry.coordinates.length, c.route!.osmNodeIds.length);
    assert.deepEqual(geometry.coordinates[0].slice(0, 2), c.anchor!.coordinate!.slice(0, 2));
    assert.equal(readFileSync(`${out}/${id}.gpx`, 'utf8'), serializeGpx(`${c.name} → ${r.request.summit.name}`, geometry));
  }
});
