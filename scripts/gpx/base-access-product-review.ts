/** Review-only measurements over completed routes. Never routes, snaps, or adds edges. */
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import type { Coordinate } from '../../Lib/gpxIngestion/types.ts';

const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const round = (n: number) => Math.round(n * 1000) / 1000;
export interface ReviewPath { nodes: number[]; coordinates: Coordinate[] }
function pointBeforeTerminal(path: ReviewPath, distance = 1000): Coordinate {
  let traversed = 0;
  for (let i = path.coordinates.length - 1; i > 0; i--) {
    const a = path.coordinates[i], b = path.coordinates[i - 1];
    const length = calculateCoordinateDistanceMeters(a, b);
    if (traversed + length >= distance && length > 0) {
      const f = (distance - traversed) / length;
      // Measurement only. This interpolated point is never part of a route artifact.
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    traversed += length;
  }
  return path.coordinates[0];
}
function bearing(from: Coordinate, to: Coordinate): number {
  return (Math.atan2((to[0] - from[0]) * Math.cos(from[1] * Math.PI / 180), to[1] - from[1]) * 180 / Math.PI + 360) % 360;
}
export function geometryReview(old: ReviewPath, next: ReviewPath) {
  const edges = (p: ReviewPath) => new Set(p.nodes.slice(1).map((n, i) => edgeKey(p.nodes[i], n)));
  const oldEdges = edges(old), nextEdges = edges(next);
  const overlap = (p: ReviewPath, other: Set<string>) => {
    let shared = 0, total = 0;
    for (let i = 1; i < p.nodes.length; i++) {
      const length = calculateCoordinateDistanceMeters(p.coordinates[i - 1], p.coordinates[i]);
      total += length;
      if (other.has(edgeKey(p.nodes[i - 1], p.nodes[i]))) shared += length;
    }
    return { lengthMeters: round(total), sharedLengthMeters: round(shared), sharedFraction: round(shared / total) };
  };
  const oldCoverage = overlap(old, nextEdges), newCoverage = overlap(next, oldEdges);
  const terminal = next.coordinates.at(-1)!;
  const oldBearing = bearing(terminal, pointBeforeTerminal(old)), newBearing = bearing(terminal, pointBeforeTerminal(next));
  const delta = Math.abs(oldBearing - newBearing);
  const sideDifferenceDegrees = round(Math.min(delta, 360 - delta));
  return { oldCoverage, newCoverage, substantiallyChanged: Math.min(oldCoverage.sharedFraction, newCoverage.sharedFraction) < 0.75,
    upperApproachOldBearing: round(oldBearing), upperApproachNewBearing: round(newBearing), sideDifferenceDegrees,
    differentApproachSide: sideDifferenceDegrees >= 60, measurementDistanceBeforeTerminalMeters: 1000,
    exactOldStartVisited: next.nodes.includes(old.nodes[0]) };
}

export const PRODUCT_REVIEW_RULES = Object.freeze({
  version: 'mountain-tracker/base-access-canary-product-review/v1',
  substantialDistanceRatio: 2,
  substantialAddedDistanceMeters: 5000,
  remoteServiceAccessMeters: 1000,
  differentSideDegrees: 60,
  minimumOldOverlapForSameVariant: 0.5,
});
export function productReviewReasons(input: {
  oldDistance: number; newDistance: number; serviceDistanceToMainRoad: number;
  differentApproachSide: boolean; oldSharedFraction: number; publicAccessVerified: boolean;
}): string[] {
  const r: string[] = [];
  if (!input.publicAccessVerified) r.push('PRIMARY_ACCESS_NOT_VERIFIED');
  if (input.newDistance / input.oldDistance > PRODUCT_REVIEW_RULES.substantialDistanceRatio &&
    input.newDistance - input.oldDistance > PRODUCT_REVIEW_RULES.substantialAddedDistanceMeters) r.push('SUBSTANTIALLY_LONGER_APPROACH_REVIEW');
  if (input.serviceDistanceToMainRoad > PRODUCT_REVIEW_RULES.remoteServiceAccessMeters) r.push('REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW');
  if (input.differentApproachSide && input.oldSharedFraction < PRODUCT_REVIEW_RULES.minimumOldOverlapForSameVariant)
    r.push('DIFFERENT_ASCENT_VARIANT_REVIEW');
  return r;
}
