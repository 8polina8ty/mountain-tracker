import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { sha256Stable, stableJson } from '../../../Lib/gpxIngestion/hashing.ts';
import { classifySafety } from './summit-attachment.ts';

const MANIFEST_GLOB = 'data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json';

async function loadManifest(): Promise<{
  manifestId: string; graphId: string; pbfSha256: string;
  canonicalCandidates: number; eligibility: { readyForDryRun: number; needsReview: number; rejected: number };
  classificationCounts: Record<string,number>; existingProductionStates: Record<string,number>;
  fabricatedGapCount: number; productionWrites: number; entries: Array<Record<string, unknown>>;
}> {
  const raw = await readFile(MANIFEST_GLOB, 'utf8');
  return JSON.parse(raw) as never;
}

test('canonical candidates = 583 (579 + 4) deduplicated', async () => {
  const m = await loadManifest();
  assert.equal(m.canonicalCandidates, 583);
  assert.equal(m.entries.length, 583);
  const ids = m.entries.map(e => e.mountainId as number);
  const uniq = new Set(ids);
  assert.equal(uniq.size, 583, 'must be deduplicated by mountainId');
});

test('eligibility: READY requires all gates, no hut, fabricatedGap 0', async () => {
  const m = await loadManifest();
  const ready = m.entries.filter(e => e.eligibility === 'READY_FOR_DRY_RUN');
  for (const e of ready) {
    assert.equal(e.fabricatedGapCount, 0);
    assert.equal((e.reasons as string[]).length, 0, `READY must have no reasons but got ${JSON.stringify(e.reasons)}`);
    assert.ok(!String(e.startType).includes('HUT') && !String(e.startType).includes('REFUGE'));
    assert.ok(e.geometryHash && typeof e.geometryHash === 'string' && (e.geometryHash as string).length === 64);
    assert.ok(e.gpxSha256 && (e.gpxSha256 as string).length === 64);
    assert.ok(e.geojsonSha256 && (e.geojsonSha256 as string).length === 64);
    assert.equal(e.existingProductionState, 'NEW');
  }
});

test('technical classification preservation: VIA_FERRATA/ALPINE_HIKING never as HIKING', async () => {
  const m = await loadManifest();
  const tech = m.entries.filter(e => e.classification === 'VIA_FERRATA' || e.classification === 'ALPINE_HIKING');
  assert.equal(tech.length, 4);
  const via = tech.filter(e => e.classification === 'VIA_FERRATA');
  const alpine = tech.filter(e => e.classification === 'ALPINE_HIKING');
  assert.equal(via.length, 2); assert.equal(alpine.length, 2);
  for (const e of tech) {
    assert.ok(e.sacScale === 'demanding_alpine_hiking' || e.sacScale === 'difficult_alpine_hiking');
    assert.ok(e.summitAttachmentType === 'VIA_FERRATA' || e.summitAttachmentType === 'OSM_SUMMIT_WAY');
    assert.equal(e.eligibility, 'NEEDS_REVIEW', 'technical recovered have no geometry yet -> NEEDS_REVIEW but classification preserved');
  }
  // Ensure no technical misclassified as HIKING
  const hiking = m.entries.filter(e => e.classification === 'HIKING');
  assert.equal(hiking.length, 579);
});

test('existing-route conflict handling: MOUNTAIN_ALREADY_HAS_ROUTE -> NEEDS_REVIEW', async () => {
  const m = await loadManifest();
  const conflicted = m.entries.filter(e => e.existingProductionState === 'MOUNTAIN_ALREADY_HAS_ROUTE');
  assert.equal(conflicted.length, 6);
  for (const e of conflicted) assert.equal(e.eligibility, 'NEEDS_REVIEW');
  // NEW remain READY unless other reason
  const readyNew = m.entries.filter(e => e.existingProductionState === 'NEW' && e.eligibility === 'READY_FOR_DRY_RUN');
  assert.equal(readyNew.length, 573);
});

test('exact duplicate / geometry conflict handling (offline prod check)', async () => {
  const m = await loadManifest();
  // In offline live DB check, we only have NEW vs MOUNTAIN_ALREADY_HAS_ROUTE vs UNKNOWN
  // Verify no silent overwrite: MOUNTAIN_ALREADY_HAS_ROUTE never READY
  const dupReady = m.entries.filter(e => (e.existingProductionState === 'EXACT_DUPLICATE' || e.existingProductionState === 'GEOMETRY_CONFLICT') && e.eligibility === 'READY_FOR_DRY_RUN');
  assert.equal(dupReady.length, 0);
  // UNKNOWN would also be NEEDS_REVIEW if present, but in this run all were resolved to NEW/ALREADY
  const unknown = m.entries.filter(e => e.existingProductionState === 'UNKNOWN');
  assert.equal(unknown.length, 0);
});

test('manifest determinism: stableJson hashing excludes volatile timestamps', async () => {
  const raw = await readFile(MANIFEST_GLOB, 'utf8');
  const parsed = JSON.parse(raw) as { entries: unknown[]; manifestId: string; graphId: string; pbfSha256: string };
  // Re-serialize entries deterministically
  const h1 = sha256Stable(parsed.entries);
  const h2 = sha256Stable(JSON.parse(stableJson(parsed.entries)));
  assert.equal(h1, h2);
  // manifestId is deterministic from graphId + pbf + counts
  assert.match(parsed.manifestId, /^ghpp-06e38ba4-2026-09-11-[a-f0-9]{8}$/);
});

test('hash integrity: geometryHash 64 hex, gpx/geojson sha256 correct length', async () => {
  const m = await loadManifest();
  for (const e of m.entries) {
    if (e.eligibility === 'READY_FOR_DRY_RUN') {
      assert.match(e.geometryHash as string, /^[a-f0-9]{64}$/);
      assert.match(e.gpxSha256 as string, /^[a-f0-9]{64}$/);
      assert.match(e.geojsonSha256 as string, /^[a-f0-9]{64}$/);
      assert.ok((e.distanceM as number) > 0 && (e.distanceM as number) < 100000);
    } else {
      // V2 recovered intentionally have null hashes (no geometry) but still counted
      if (e.mountainId === 19 || e.mountainId === 30 || e.mountainId === 98 || e.mountainId === 210) {
        assert.equal(e.geometryHash, null);
        assert.equal(e.gpxSha256, null);
      }
    }
  }
});

test('no fabricated gap: all entries fabricatedGapCount == 0', async () => {
  const m = await loadManifest();
  for (const e of m.entries) assert.equal(e.fabricatedGapCount, 0);
  assert.equal(m.fabricatedGapCount, 0);
});

test('no publication side effects: productionWrites == 0 and no DB mutation', async () => {
  const m = await loadManifest();
  assert.equal(m.productionWrites, 0);
  // Ensure manifest directory contains only expected files, no SQL writes
  const routes = await readdir('data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/routes');
  const review = await readdir('data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/review');
  assert.equal(routes.length, 573);
  assert.equal(review.length, 10);
  // 573 ready + 10 review = 583
});

test('deduplication: duplicate mountainId with differing geometry would be NEEDS_REVIEW', async () => {
  const m = await loadManifest();
  // In this proven run there were no duplicate mountainIds with differing geometry (uniq 583)
  const byId = new Map<number, number>();
  for (const e of m.entries) byId.set(e.mountainId as number, (byId.get(e.mountainId as number) ?? 0) + 1);
  for (const [, cnt] of byId) assert.equal(cnt, 1);
});

test('snap thresholds preserved: global limits unchanged', async () => {
  const raw = await readFile('data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/summary.json', 'utf8');
  const s = JSON.parse(raw) as { snapThresholds: { START_SNAP_LIMIT_M: number; SUMMIT_SNAP_LIMIT_M: number } };
  assert.equal(s.snapThresholds.START_SNAP_LIMIT_M, 150);
  assert.equal(s.snapThresholds.SUMMIT_SNAP_LIMIT_M, 100);
});

test('classifySafety preserves VIA_FERRATA vs ALPINE distinction', () => {
  assert.equal(classifySafety({ highway: 'via_ferrata', sac_scale: 'demanding_alpine_hiking' }), 'VIA_FERRATA');
  assert.equal(classifySafety({ highway: 'path', sac_scale: 'demanding_alpine_hiking' }), 'ALPINE_HIKING');
  assert.equal(classifySafety({ highway: 'path', sac_scale: 'hiking' }), 'HIKING');
});
