import type { AchievementId } from "./achievementRegistry";

export const ACHIEVEMENT_GRANT_SOURCES = [
  "legacy",
  "event",
  "reconciliation",
  "backfill",
] as const;

export type AchievementGrantSource =
  (typeof ACHIEVEMENT_GRANT_SOURCES)[number];

export type AchievementGrantRecord = {
  achievementId: AchievementId;
  unlockedAt: string;
  grantSource: AchievementGrantSource;
  definitionVersion: number;
  notifiedAt: string | null;
};

type GrantRecordRow = Record<string, unknown>;
type AchievementIdGuard = (value: unknown) => value is AchievementId;

const GRANT_SOURCE_SET = new Set<string>(ACHIEVEMENT_GRANT_SOURCES);

function isRecord(value: unknown): value is GrantRecordRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isGrantSource(value: unknown): value is AchievementGrantSource {
  return typeof value === "string" && GRANT_SOURCE_SET.has(value);
}

export function uniqueAchievementIds(
  achievementIds: readonly AchievementId[],
): AchievementId[] {
  return [...new Set(achievementIds)];
}

export function getUnknownAchievementIds(
  values: readonly unknown[],
  isKnownId: AchievementIdGuard,
): unknown[] {
  return values.filter((value) => !isKnownId(value));
}

export function planAchievementReconciliation(
  unlockedIds: readonly AchievementId[],
  existingIds: readonly AchievementId[],
): AchievementId[] {
  const existing = new Set(existingIds);
  return uniqueAchievementIds(unlockedIds).filter((id) => !existing.has(id));
}

export function normalizeAchievementGrantRecords(
  value: unknown,
  isKnownId: AchievementIdGuard,
): AchievementGrantRecord[] {
  if (!Array.isArray(value)) return [];

  const records = new Map<AchievementId, AchievementGrantRecord>();

  for (const row of value) {
    if (!isRecord(row)) continue;

    const achievementId = row.achievement_id;
    const unlockedAt = row.unlocked_at;
    const grantSource = row.grant_source;
    const definitionVersion = row.definition_version;
    const notifiedAt = row.notified_at;

    if (
      !isKnownId(achievementId) ||
      !validTimestamp(unlockedAt) ||
      !isGrantSource(grantSource) ||
      typeof definitionVersion !== "number" ||
      !Number.isInteger(definitionVersion) ||
      definitionVersion < 1 ||
      !(notifiedAt === null || validTimestamp(notifiedAt))
    ) {
      continue;
    }

    if (!records.has(achievementId)) {
      records.set(achievementId, {
        achievementId,
        unlockedAt,
        grantSource,
        definitionVersion,
        notifiedAt,
      });
    }
  }

  return [...records.values()];
}
