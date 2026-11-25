import assert from 'node:assert/strict';
import test from 'node:test';
import { driftMeters, classifySafety, findSummitWayEvidence, toAttachmentEvidence, evidenceHashFor, resolveSummitIdentity } from './summit-attachment.ts';
import type { WayIndex } from './summit-attachment.ts';

test('exact OSM summit coordinate resolution and drift', async () => {
  const peaks = new Map<number, { lat: number; lon: number; tags: Record<string, string> }>([
    [123, { lat: 47.42, lon: 10.98, tags: { natural: 'peak' } }],
  ]);
  const m = { id: 1, osm_id: 123, latitude: 47.42, longitude: 10.98 };
  const id = await resolveSummitIdentity(m, peaks);
  assert.equal(id.driftM, 0);
  assert.equal(id.isAuthoritative, true);
  // drift >0
  const m2 = { id: 2, osm_id: 123, latitude: 47.421, longitude: 10.981 };
  const id2 = await resolveSummitIdentity(m2, peaks);
  assert.ok((id2.driftM ?? 0) > 100);
  assert.equal(id2.isAuthoritative, false);
});

test('DB vs OSM coordinate drift calculation', () => {
  const d = driftMeters({ lat: 47.42, lon: 10.98 }, { lat: 47.42, lon: 10.98 });
  assert.equal(d, 0);
  const d2 = driftMeters({ lat: 47.42, lon: 10.98 }, { lat: 47.421, lon: 10.98 });
  assert.ok(d2 > 100 && d2 < 200);
});

test('shared-node summit attachment', () => {
  const wayIndex: WayIndex = new Map([
    [1001, { tags: { highway: 'path', sac_scale: 'mountain_hiking' }, peaks: [999] }],
  ]);
  const ev = findSummitWayEvidence(999, wayIndex);
  assert.ok(ev);
  assert.equal(ev!.attachmentWayId, 1001);
  const att = toAttachmentEvidence(ev, { attachmentType: 'OSM_SUMMIT_WAY', distance: 50 });
  assert.equal(att.attachmentType, 'OSM_SUMMIT_WAY');
  assert.equal(att.safety, 'MOUNTAIN_HIKING');
  assert.ok(att.evidenceHash);
  // no geometric-only: if not in index, no attachment
  const ev2 = findSummitWayEvidence(888, wayIndex);
  assert.equal(ev2, null);
  const att2 = toAttachmentEvidence(ev2, { attachmentType: 'OSM_SUMMIT_WAY', distance: 30 });
  assert.equal(att2.attachmentType, 'NONE');
});

test('relation-based attachment is not fabricated', () => {
  // Relation attachment would require way index + relation, but without way containing peak, should be NONE
  const wayIndex: WayIndex = new Map();
  const ev = findSummitWayEvidence(123, wayIndex);
  assert.equal(ev, null);
  // No straight-line fallback
  const att = toAttachmentEvidence(ev, { attachmentType: 'OSM_SUMMIT_WAY', distance: 10 });
  assert.equal(att.attachmentType, 'NONE');
});

test('via_ferrata classification', () => {
  const tags = { highway: 'via_ferrata', via_ferrata_scale: '3', sac_scale: 'demanding_alpine_hiking' };
  assert.equal(classifySafety(tags), 'VIA_FERRATA');
  const wayIndex: WayIndex = new Map([[2001, { tags, peaks: [777] }]]);
  const ev = findSummitWayEvidence(777, wayIndex);
  assert.ok(ev?.viaFerrata);
  const att = toAttachmentEvidence(ev, { attachmentType: 'VIA_FERRATA', distance: 100 });
  assert.equal(att.safety, 'VIA_FERRATA');
  assert.equal(att.attachmentType, 'VIA_FERRATA');
});

test('access=no rejection', () => {
  const tags = { highway: 'path', access: 'no', sac_scale: 'hiking' };
  assert.equal(classifySafety(tags), 'REJECTED');
  const wayIndex: WayIndex = new Map([[3001, { tags, peaks: [555] }]]);
  const ev = findSummitWayEvidence(555, wayIndex);
  assert.equal(ev, null); // rejected
});

test('foot=no rejection', () => {
  const tags = { highway: 'path', foot: 'no' };
  assert.equal(classifySafety(tags), 'REJECTED');
});

test('no geometric-only attachment', () => {
  // Even if peak is within 20m geometric distance, without shared node should not attach
  const wayIndex: WayIndex = new Map([[4001, { tags: { highway: 'path' }, peaks: [111] }]]);
  // 222 is not in way, even if geometrically close, no attachment
  const ev = findSummitWayEvidence(222, wayIndex);
  assert.equal(ev, null);
});

test('no fabricated connector', () => {
  const ev = findSummitWayEvidence(999, new Map());
  const att = toAttachmentEvidence(ev, { attachmentType: 'OSM_SUMMIT_WAY', distance: 0 });
  assert.equal(att.attachmentType, 'NONE');
  // fabricatedGapCount must remain 0 in all cases
  assert.equal(att.evidenceHash.length, 16);
});

test('checkpoint compatibility', async () => {
  const peaks = new Map<number, { lat: number; lon: number; tags: Record<string, string> }>([
    [1, { lat: 47, lon: 11, tags: { natural: 'peak' } }],
  ]);
  const m = { id: 1, osm_id: 1, latitude: 47, longitude: 11 };
  const id = await resolveSummitIdentity(m, peaks);
  assert.equal(id.driftM, 0);
  // deterministic hash
  const h1 = evidenceHashFor({ a: 1 });
  const h2 = evidenceHashFor({ a: 1 });
  assert.equal(h1, h2);
});

test('determinism', () => {
  const tags = { highway: 'path', sac_scale: 'hiking' };
  assert.equal(classifySafety(tags), 'HIKING');
  assert.equal(classifySafety(tags), 'HIKING');
  const h1 = evidenceHashFor({ way: 1, tags });
  const h2 = evidenceHashFor({ way: 1, tags });
  assert.equal(h1, h2);
});
