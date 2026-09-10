import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSummitAttachment, DEFAULT_SUMMIT_ATTACHMENT_POLICY,
  summitAttachmentReasonCodes, summitAttachmentTier, summitAutoEligible,
  validateSummitAttachmentPolicy,
} from './summitAttachment.ts';

test('summit attachment boundaries classify every policy tier deterministically', () => {
  assert.equal(summitAttachmentTier(0), 'DIRECT');
  assert.equal(summitAttachmentTier(29), 'DIRECT');
  assert.equal(summitAttachmentTier(30), 'DIRECT');
  assert.equal(summitAttachmentTier(30.001), 'EXTENDED');
  assert.equal(summitAttachmentTier(31), 'EXTENDED');
  assert.equal(summitAttachmentTier(50), 'EXTENDED');
  assert.equal(summitAttachmentTier(50.001), 'REVIEW_PROXIMITY');
  assert.equal(summitAttachmentTier(51), 'REVIEW_PROXIMITY');
  assert.equal(summitAttachmentTier(100), 'REVIEW_PROXIMITY');
  assert.equal(summitAttachmentTier(100.001), 'NONE');
  assert.equal(summitAttachmentTier(101), 'NONE');
});

test('only DIRECT and EXTENDED are auto-eligible attachment tiers', () => {
  assert.equal(summitAutoEligible('DIRECT'), true);
  assert.equal(summitAutoEligible('EXTENDED'), true);
  assert.equal(summitAutoEligible('REVIEW_PROXIMITY'), false);
  assert.equal(summitAutoEligible('NONE'), false);
});

test('reason codes are part of a stable versioned contract', () => {
  assert.deepEqual(summitAttachmentReasonCodes('DIRECT'), ['ADMITTED_SUMMIT_NODE_DIRECT']);
  assert.deepEqual(summitAttachmentReasonCodes('EXTENDED'), ['SUMMIT_SNAP_DISTANCE_WITHIN_EXTENDED_BOUND']);
  assert.deepEqual(summitAttachmentReasonCodes('REVIEW_PROXIMITY'), ['SUMMIT_SNAP_DISTANCE_REQUIRES_REVIEW']);
  assert.deepEqual(summitAttachmentReasonCodes('NONE'), ['NO_ADMITTED_EDGE_NODE_WITHIN_REVIEW_BOUND']);
});

test('buildSummitAttachment preserves both coordinates and persisted proximity', () => {
  const attachment = buildSummitAttachment({
    targetCoordinate: [11.5, 47.1], routeTerminalCoordinate: [11.5004, 47.1], distanceMeters: 37.2,
  });
  assert.deepEqual(attachment, {
    targetCoordinate: [11.5, 47.1], routeTerminalCoordinate: [11.5004, 47.1],
    distanceMeters: 37.2, tier: 'EXTENDED', autoEligible: true,
    reasonCodes: ['SUMMIT_SNAP_DISTANCE_WITHIN_EXTENDED_BOUND'],
  });
});

test('the default policy is frozen with the documented 30/50/100 m bounds', () => {
  assert.deepEqual(DEFAULT_SUMMIT_ATTACHMENT_POLICY, {
    version: 'mountain-tracker/summit-attachment-policy/v1',
    directMeters: 30, extendedMeters: 50, reviewMeters: 100,
  });
  assert.ok(Object.isFrozen(DEFAULT_SUMMIT_ATTACHMENT_POLICY));
  validateSummitAttachmentPolicy(DEFAULT_SUMMIT_ATTACHMENT_POLICY);
});

test('invalid policies and distances fail explicitly', () => {
  assert.throws(() => validateSummitAttachmentPolicy({ ...DEFAULT_SUMMIT_ATTACHMENT_POLICY, directMeters: 0 }), /INVALID_SUMMIT_ATTACHMENT_POLICY/);
  assert.throws(() => validateSummitAttachmentPolicy({ ...DEFAULT_SUMMIT_ATTACHMENT_POLICY, extendedMeters: 30 }), /INVALID_SUMMIT_ATTACHMENT_POLICY/);
  assert.throws(() => validateSummitAttachmentPolicy({ ...DEFAULT_SUMMIT_ATTACHMENT_POLICY, reviewMeters: 50 }), /INVALID_SUMMIT_ATTACHMENT_POLICY/);
  assert.throws(() => summitAttachmentTier(-1), /INVALID_SUMMIT_ATTACHMENT_DISTANCE/);
  assert.throws(() => summitAttachmentTier(NaN), /INVALID_SUMMIT_ATTACHMENT_DISTANCE/);
});