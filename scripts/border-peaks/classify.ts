import type { BorderCandidate } from "./types.ts";

/**
 * Classification rules — distance alone is insufficient.
 * CONFIRMED requires externally verified dual-country evidence for this mountain_id + country pair,
 * not just summit identity or proximity.
 * Stages: CANDIDATE -> GEOMETRICALLY_SUPPORTED -> EXTERNALLY_VERIFIED -> APPROVED (via reviewer)
 */
export function classifyCandidate(input: {
  distanceMeters: number | null;
  boundarySource: string | null;
  supportingReference: string | null; // must be dual-country evidence, e.g., reviewed OSM border relation + summit, not just summit node
  coordinateAccuracyMeters: number | null; // null = unknown
  boundaryPrecisionMeters: number | null; // null = generalized (e.g., Natural Earth)
  conflictingSources: boolean;
  disputed: boolean;
  hasInternationalGeometry?: boolean; // false if only near internal ADM1 internal edge
}): BorderCandidate["classification"] {
  const { distanceMeters, boundarySource, supportingReference, coordinateAccuracyMeters, boundaryPrecisionMeters, conflictingSources, disputed, hasInternationalGeometry } = input;
  if (hasInternationalGeometry === false) return "REJECTED"; // internal ADM1 only
  if (disputed || conflictingSources) return "REVIEW";
  if (boundarySource == null) return "REVIEW";
  // Summit-only reference does not prove country membership
  if (supportingReference != null && !/dual|border|country/i.test(supportingReference) && supportingReference.startsWith("OSM:summit")) {
    // summit node alone -> at most geometrically supported, never CONFIRMED
    if (distanceMeters != null && distanceMeters <= 200) return "REVIEW";
  }
  if (supportingReference == null) return "REVIEW";
  if (distanceMeters == null || boundaryPrecisionMeters == null || coordinateAccuracyMeters == null) return "REVIEW";
  // Natural Earth generalized ~5000m error -> never CONFIRMED
  if (boundaryPrecisionMeters > 500) return "REVIEW";
  const tolerance = (coordinateAccuracyMeters ?? 100) + (boundaryPrecisionMeters ?? 100);
  if (distanceMeters <= Math.min(30, tolerance * 0.5) && /dual|border/i.test(supportingReference)) return "CONFIRMED";
  if (distanceMeters <= 200) return "REVIEW";
  return "REJECTED";
}

export function evidenceTypeFor(classification: BorderCandidate["classification"], hasVerifiedRef: boolean): BorderCandidate["evidence_type"] {
  if (classification === "CONFIRMED" && hasVerifiedRef) return "EXTERNALLY_VERIFIED";
  if (classification === "CONFIRMED") return "GEOMETRICALLY_SUPPORTED";
  if (classification === "REVIEW") return "CANDIDATE";
  return null;
}

export function reasonFor(c: BorderCandidate["classification"], distance: number | null): string {
  if (c === "CONFIRMED") return `Summit on detailed shared border within ${distance ?? "?"}m and dual attribution verified.`;
  if (c === "REVIEW") return `Near-border (${distance ?? "?"}m) or conflicting/imprecise source; manual verification required. Distance alone is insufficient.`;
  return `Clearly inside primary country (>200m) or insufficient evidence.`;
}
