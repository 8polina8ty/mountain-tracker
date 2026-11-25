import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { geometryReview, productReviewReasons, type ReviewPath } from './base-access-product-review.ts';
import { sha256Bytes } from '../../Lib/gpxIngestion/hashing.ts';

const south: ReviewPath = { nodes: [1, 2, 3], coordinates: [[11, 46.98], [11, 46.99], [11, 47]] };
const north: ReviewPath = { nodes: [4, 5, 3], coordinates: [[11, 47.02], [11, 47.01], [11, 47]] };
const base = { oldDistance: 4000, newDistance: 5000, serviceDistanceToMainRoad: 0,
  differentApproachSide: false, oldSharedFraction: 0.9, publicAccessVerified: true };
test('unchanged route has complete overlap and no side change', () => {
  const r = geometryReview(south, south);
  assert.equal(r.oldCoverage.sharedFraction, 1); assert.equal(r.newCoverage.sharedFraction, 1);
  assert.equal(r.substantiallyChanged, false); assert.equal(r.differentApproachSide, false);
});
test('full approach extension preserves the upper ascent side', () => {
  const extended: ReviewPath = { nodes: [6, ...south.nodes], coordinates: [[11, 46.96], ...south.coordinates] };
  const r = geometryReview(south, extended);
  assert.equal(r.oldCoverage.sharedFraction, 1); assert(r.newCoverage.sharedFraction < 0.75);
  assert.equal(r.differentApproachSide, false); assert.equal(r.exactOldStartVisited, true);
});
test('opposite upper approaches flag changed ascent without any mountain-name rule', () => {
  const r = geometryReview(south, north);
  assert.equal(r.sideDifferenceDegrees, 180); assert.equal(r.differentApproachSide, true);
  assert.deepEqual(productReviewReasons({ ...base, differentApproachSide: r.differentApproachSide, oldSharedFraction: 0 }), ['DIFFERENT_ASCENT_VARIANT_REVIEW']);
});
test('public road connection does not auto-clear substantial detours or remote service access', () => {
  assert.deepEqual(productReviewReasons({ ...base, newDistance: 14_000 }), ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW']);
  assert.deepEqual(productReviewReasons({ ...base, serviceDistanceToMainRoad: 1500 }), ['REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW']);
});
test('missing access evidence fails review; ordinary bounded public approach has no review reasons', () => {
  assert.deepEqual(productReviewReasons({ ...base, publicAccessVerified: false }), ['PRIMARY_ACCESS_NOT_VERIFIED']);
  assert.deepEqual(productReviewReasons(base), []);
});
test('geometry assessment is deterministic and does not mutate or fabricate route coordinates', () => {
  const before = JSON.stringify([south, north]);
  assert.deepEqual(geometryReview(south, north), geometryReview(south, north));
  assert.equal(JSON.stringify([south, north]), before);
});
test('completed review preserves every checkpoint file and supplies exact start/summit markers for all ten', () => {
  const root = 'data/gpx/base-access-start-v2';
  const report = JSON.parse(readFileSync(`${root}/final-review.json`, 'utf8')) as {
    ready: number; needsReview: number; regeneratedInThisCompletion: number; protectedArtifactHashes: Record<string, string>;
    rows: { mountainId: number; summitCoordinate: number[]; productStatus: string; reviewReasons: string[];
      new: { actualStartCoordinate: number[] }; old: { startCoordinate: number[] } }[] };
  assert.equal(report.rows.length, 10); assert.equal(report.ready + report.needsReview, 10);
  assert.equal(report.regeneratedInThisCompletion, 0);
  for (const [p, hash] of Object.entries(report.protectedArtifactHashes)) assert.equal(sha256Bytes(readFileSync(p)), hash, p);
  for (const row of report.rows) {
    assert.equal(row.productStatus, row.reviewReasons.length ? 'NEEDS_REVIEW' : 'AUTO_ELIGIBLE');
    const geo = JSON.parse(readFileSync(`${root}/${row.mountainId}-review.geojson`, 'utf8')) as {
      features: { properties: { role: string }; geometry: { type: string; coordinates: unknown } }[] };
    assert.equal(geo.features.length, 6);
    const marker = (role: string) => geo.features.find(f => f.properties.role === role)!.geometry;
    assert.deepEqual(marker('OLD_START'), { type: 'Point', coordinates: row.old.startCoordinate });
    assert.deepEqual(marker('V2_START'), { type: 'Point', coordinates: row.new.actualStartCoordinate });
    assert.deepEqual(marker('TARGET_SUMMIT'), { type: 'Point', coordinates: row.summitCoordinate });
  }
});
