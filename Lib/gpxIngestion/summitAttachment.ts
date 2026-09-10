import type { Coordinate } from './types.ts';

export const SUMMIT_ATTACHMENT_VERSION =
  'mountain-tracker/summit-attachment/v1' as const;

export type SummitAttachmentTier = 'DIRECT' | 'EXTENDED' | 'REVIEW_PROXIMITY' | 'NONE';

export interface SummitAttachmentPolicy {
  version: 'mountain-tracker/summit-attachment-policy/v1';
  directMeters: number;
  extendedMeters: number;
  reviewMeters: number;
}

export const DEFAULT_SUMMIT_ATTACHMENT_POLICY: Readonly<SummitAttachmentPolicy> = Object.freeze({
  version: 'mountain-tracker/summit-attachment-policy/v1',
  directMeters: 30,
  extendedMeters: 50,
  reviewMeters: 100,
});

export interface SummitAttachment {
  targetCoordinate: Coordinate;
  routeTerminalCoordinate: Coordinate;
  distanceMeters: number;
  tier: SummitAttachmentTier;
  autoEligible: boolean;
  reasonCodes: string[];
}

export const SUMMIT_ATTACHMENT_REASON_DIRECT = 'ADMITTED_SUMMIT_NODE_DIRECT';
export const SUMMIT_ATTACHMENT_REASON_EXTENDED = 'SUMMIT_SNAP_DISTANCE_WITHIN_EXTENDED_BOUND';
export const SUMMIT_ATTACHMENT_REASON_REVIEW = 'SUMMIT_SNAP_DISTANCE_REQUIRES_REVIEW';
export const SUMMIT_ATTACHMENT_REASON_NONE = 'NO_ADMITTED_EDGE_NODE_WITHIN_REVIEW_BOUND';

export function validateSummitAttachmentPolicy(policy: SummitAttachmentPolicy): void {
  if (!Number.isFinite(policy.directMeters) || policy.directMeters <= 0 ||
    !Number.isFinite(policy.extendedMeters) || policy.extendedMeters <= policy.directMeters ||
    !Number.isFinite(policy.reviewMeters) || policy.reviewMeters <= policy.extendedMeters) {
    throw new TypeError('INVALID_SUMMIT_ATTACHMENT_POLICY');
  }
}

export function summitAttachmentTier(distanceMeters: number, policy: SummitAttachmentPolicy = DEFAULT_SUMMIT_ATTACHMENT_POLICY): SummitAttachmentTier {
  validateSummitAttachmentPolicy(policy);
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) throw new TypeError('INVALID_SUMMIT_ATTACHMENT_DISTANCE');
  if (distanceMeters <= policy.directMeters) return 'DIRECT';
  if (distanceMeters <= policy.extendedMeters) return 'EXTENDED';
  if (distanceMeters <= policy.reviewMeters) return 'REVIEW_PROXIMITY';
  return 'NONE';
}

export function summitAutoEligible(tier: SummitAttachmentTier): boolean {
  return tier === 'DIRECT' || tier === 'EXTENDED';
}

export function summitAttachmentReasonCodes(tier: SummitAttachmentTier): string[] {
  switch (tier) {
    case 'DIRECT': return [SUMMIT_ATTACHMENT_REASON_DIRECT];
    case 'EXTENDED': return [SUMMIT_ATTACHMENT_REASON_EXTENDED];
    case 'REVIEW_PROXIMITY': return [SUMMIT_ATTACHMENT_REASON_REVIEW];
    case 'NONE': return [SUMMIT_ATTACHMENT_REASON_NONE];
  }
}

export function buildSummitAttachment(input: {
  targetCoordinate: Coordinate;
  routeTerminalCoordinate: Coordinate;
  distanceMeters: number;
  policy?: SummitAttachmentPolicy;
}): SummitAttachment {
  const tier = summitAttachmentTier(input.distanceMeters, input.policy);
  return {
    targetCoordinate: [input.targetCoordinate[0], input.targetCoordinate[1]],
    routeTerminalCoordinate: [input.routeTerminalCoordinate[0], input.routeTerminalCoordinate[1]],
    distanceMeters: input.distanceMeters,
    tier,
    autoEligible: summitAutoEligible(tier),
    reasonCodes: summitAttachmentReasonCodes(tier),
  };
}