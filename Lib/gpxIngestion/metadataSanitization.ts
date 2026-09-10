// Phase 12A metadata sanitization for external GPX records.
//
// External datasets are untrusted input. Before any metadata is hashed, staged,
// or (later) promoted, it is normalized and bounded so that:
//   * identical logical content always hashes identically (trim, collapse ws),
//   * fields cannot exceed the DB char_length constraints mirrored in
//     database/gpx_source_tracks.sql,
//   * no control characters or unprintable bytes leak into the DB.

import type { NormalizedGpxMetadata } from "./types.ts";

const FIELD_LIMITS = {
  name: 200,
  description: 8000,
  activityType: 40,
  routeType: 40,
  difficultySystem: 40,
  difficultyValue: 40,
  bestSeason: 500,
  equipment: 4000,
  warnings: 4000,
  attribution: 2000,
  sourceUrl: 1000,
} as const;

function sanitizeScalar(value: string | null, maxLength: number): string | null {
  if (value === null) {
    return null;
  }
  // strip control chars, then collapse internal whitespace and trim
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") {
    return null;
  }
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function sanitizeHttpUrl(value: string | null, maxLength: number): string | null {
  const scalar = sanitizeScalar(value, maxLength);
  if (scalar === null) return null;
  try {
    const url = new URL(scalar);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    if (url.username !== "" || url.password !== "") return null;
    const normalized = url.toString();
    return normalized.length <= maxLength ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Return a sanitized copy of the metadata. The input object is not mutated.
 *
 * Unknown keys are dropped so that only the fields mirrored in the DB schema
 * survive; this keeps the hashed payload stable and bounded.
 */
export function sanitizeMetadata(
  input: Readonly<Partial<NormalizedGpxMetadata>>,
): NormalizedGpxMetadata {
  return {
    name: sanitizeScalar(input.name ?? null, FIELD_LIMITS.name),
    description: sanitizeScalar(
      input.description ?? null,
      FIELD_LIMITS.description,
    ),
    activityType: sanitizeScalar(
      input.activityType ?? null,
      FIELD_LIMITS.activityType,
    ),
    routeType: sanitizeScalar(input.routeType ?? null, FIELD_LIMITS.routeType),
    difficultySystem: sanitizeScalar(
      input.difficultySystem ?? null,
      FIELD_LIMITS.difficultySystem,
    ),
    difficultyValue: sanitizeScalar(
      input.difficultyValue ?? null,
      FIELD_LIMITS.difficultyValue,
    ),
    bestSeason: sanitizeScalar(input.bestSeason ?? null, FIELD_LIMITS.bestSeason),
    equipment: sanitizeScalar(input.equipment ?? null, FIELD_LIMITS.equipment),
    warnings: sanitizeScalar(input.warnings ?? null, FIELD_LIMITS.warnings),
    attribution: sanitizeScalar(
      input.attribution ?? null,
      FIELD_LIMITS.attribution,
    ),
    sourceUrl: sanitizeHttpUrl(input.sourceUrl ?? null, FIELD_LIMITS.sourceUrl),
  };
}

/** Bounds/length contract used by tests and by SQL mirroring. */
export const METADATA_FIELD_LIMITS = FIELD_LIMITS;
