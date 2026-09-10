import { createHash } from "node:crypto";

import type { Coordinate, NormalizedTrackGeometry } from "./types.ts";

export const GEOMETRY_HASH_CONTRACT_VERSION =
  "mountain-tracker/gpx-geometry-hash/v1";

/** Canonical JSON for the JSON-compatible values used by ingestion contracts. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON rejects non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Level 2 identity: normalized geometry with direction and segments intact. */
export function sha256GeometryHash(geometry: NormalizedTrackGeometry): string {
  return sha256Stable({
    version: GEOMETRY_HASH_CONTRACT_VERSION,
    geometry,
  });
}

/** Level 3 identity: the smaller canonical representation of forward/reverse. */
export function sha256DirectionNeutralGeometryHash(
  geometry: NormalizedTrackGeometry,
): string {
  const reversed = reverseGeometry(geometry);
  const forwardJson = stableJson(geometry);
  const reversedJson = stableJson(reversed);
  const canonicalGeometry = forwardJson <= reversedJson ? geometry : reversed;
  return sha256Stable({
    version: GEOMETRY_HASH_CONTRACT_VERSION,
    geometry: canonicalGeometry,
  });
}

function reverseGeometry(geometry: NormalizedTrackGeometry): NormalizedTrackGeometry {
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: [...geometry.coordinates].reverse() };
  }
  return {
    type: "MultiLineString",
    coordinates: [...geometry.coordinates]
      .reverse()
      .map((segment) => [...segment].reverse()),
  };
}

/** Deterministic coordinate precision used before geometry hashing. */
export function normalizeCoordinateForHash(coordinate: Coordinate): Coordinate {
  const longitude = round(coordinate[0], 7);
  const latitude = round(coordinate[1], 7);
  return coordinate.length === 3
    ? [longitude, latitude, round(coordinate[2], 3)]
    : [longitude, latitude];
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
