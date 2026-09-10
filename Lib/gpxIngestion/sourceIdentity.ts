import { sha256Stable } from "./hashing.ts";
import type { NormalizedGpxMetadata } from "./types.ts";

export interface RecordIdentityInput {
  sourceKey: string;
  sourceSnapshotKey: string;
  sourceNativeId: string;
  metadata: NormalizedGpxMetadata;
  rawContentHash: string;
  normalizedGeometryHash: string;
}

export interface RecordIdentity {
  canonicalSourceRecordKey: string;
  sourceRecordHash: string;
  recordIdempotencyKey: string;
}

export function normalizeSourceKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(normalized)) {
    throw new Error("sourceKey must be a stable lowercase slug.");
  }
  return normalized;
}

export function normalizeSourceNativeId(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 500) {
    throw new Error("sourceNativeId must contain 1-500 characters.");
  }
  return normalized;
}

export function buildRecordIdentity(input: RecordIdentityInput): RecordIdentity {
  const sourceKey = normalizeSourceKey(input.sourceKey);
  const sourceSnapshotKey = input.sourceSnapshotKey.normalize("NFKC").trim();
  const sourceNativeId = normalizeSourceNativeId(input.sourceNativeId);
  if (sourceSnapshotKey.length === 0 || sourceSnapshotKey.length > 200) {
    throw new Error("sourceSnapshotKey must contain 1-200 characters.");
  }
  for (const [name, hash] of [
    ["rawContentHash", input.rawContentHash],
    ["normalizedGeometryHash", input.normalizedGeometryHash],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`${name} must be a lowercase SHA-256 digest.`);
    }
  }

  const canonicalSourceRecordKey = `${sourceKey}:${sha256Stable(sourceNativeId)}`;
  const sourceRecordHash = sha256Stable({
    metadata: input.metadata,
    normalizedGeometryHash: input.normalizedGeometryHash,
    rawContentHash: input.rawContentHash,
  });
  const recordIdempotencyKey = sha256Stable({
    sourceKey,
    sourceSnapshotKey,
    sourceNativeId,
  });

  return {
    canonicalSourceRecordKey,
    sourceRecordHash,
    recordIdempotencyKey,
  };
}
