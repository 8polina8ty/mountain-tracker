import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateAchievements,
  isAchievementId,
  type AchievementId,
} from "./achievementRegistry";
import {
  normalizeAchievementGrantRecords,
  planAchievementBackfill,
  type AchievementGrantRecord,
} from "./achievementPersistence";
import { getAchievementSnapshot } from "./achievementSnapshot";

export type AchievementBackfillResult = {
  existingCount: number;
  satisfiedCount: number;
  overlapCount: number;
  missingCount: number;
  inserted: AchievementGrantRecord[];
  finalPersistedCount: number;
};

/**
 * Manual server orchestration only. This function is intentionally not imported
 * by account pages, providers, or normal mutation paths.
 */
export async function backfillAchievementsForCurrentUser(
  supabase: SupabaseClient,
): Promise<AchievementBackfillResult> {
  const [snapshot, persistedResult] = await Promise.all([
    getAchievementSnapshot(supabase),
    supabase.from("user_achievements").select("achievement_id"),
  ]);

  if (persistedResult.error) {
    throw new Error(
      `Unable to load persisted achievements: ${persistedResult.error.message}`,
      { cause: persistedResult.error },
    );
  }

  const existingIds = [...new Set(
    (persistedResult.data ?? [])
      .map((row) => row.achievement_id)
      .filter(isAchievementId),
  )];
  const satisfiedIds = evaluateAchievements(snapshot).unlockedIds;
  const existingSet = new Set<AchievementId>(existingIds);
  const overlapCount = satisfiedIds.filter((id) => existingSet.has(id)).length;
  const missingIds = planAchievementBackfill(satisfiedIds, existingIds);

  if (missingIds.length === 0) {
    return {
      existingCount: existingIds.length,
      satisfiedCount: satisfiedIds.length,
      overlapCount,
      missingCount: 0,
      inserted: [],
      finalPersistedCount: existingIds.length,
    };
  }

  const { data, error } = await supabase.rpc("backfill_user_achievements", {
    requested_achievement_ids: missingIds,
  });

  if (error) {
    throw new Error(`Unable to backfill achievements: ${error.message}`, {
      cause: error,
    });
  }

  const inserted = normalizeAchievementGrantRecords(data, isAchievementId)
    .filter(
      (record) =>
        record.grantSource === "backfill" &&
        record.definitionVersion === 2 &&
        record.notifiedAt !== null,
    );

  return {
    existingCount: existingIds.length,
    satisfiedCount: satisfiedIds.length,
    overlapCount,
    missingCount: missingIds.length,
    inserted,
    finalPersistedCount: existingIds.length + inserted.length,
  };
}
