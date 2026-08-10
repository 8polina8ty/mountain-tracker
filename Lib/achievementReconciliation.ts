import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACHIEVEMENT_DEFINITION_VERSION,
  evaluateAchievements,
  isAchievementId,
  type AchievementEvaluationResult,
} from "./achievementRegistry";
import {
  getUnknownAchievementIds,
  normalizeAchievementGrantRecords,
  uniqueAchievementIds,
  type AchievementGrantRecord,
} from "./achievementPersistence";
import { getAchievementSnapshot } from "./achievementSnapshot";

export type AchievementReconciliationResult = {
  newlyGranted: AchievementGrantRecord[];
  alreadyUnlockedCount: number;
  evaluation: AchievementEvaluationResult;
};

async function grantAchievementsForCurrentUser(
  supabase: SupabaseClient,
  requestedIds: readonly unknown[],
): Promise<AchievementGrantRecord[]> {
  const unknownIds = getUnknownAchievementIds(requestedIds, isAchievementId);

  if (unknownIds.length > 0) {
    throw new Error("Achievement reconciliation received an unregistered ID.");
  }

  const achievementIds = uniqueAchievementIds(
    requestedIds.filter(isAchievementId),
  );

  if (achievementIds.length === 0) return [];

  const { data, error } = await supabase.rpc("reconcile_user_achievements", {
    requested_achievement_ids: achievementIds,
  });

  if (error) {
    throw new Error(`Unable to reconcile achievements: ${error.message}`, {
      cause: error,
    });
  }

  return normalizeAchievementGrantRecords(data, isAchievementId).filter(
    (record) => record.definitionVersion === ACHIEVEMENT_DEFINITION_VERSION,
  );
}

/**
 * Explicit server orchestration boundary. It is intentionally not called by the
 * account runtime until the Phase B and C RPC artifacts have been deployed.
 */
export async function reconcileAchievementsForCurrentUser(
  supabase: SupabaseClient,
): Promise<AchievementReconciliationResult> {
  const snapshot = await getAchievementSnapshot(supabase);
  const evaluation = evaluateAchievements(snapshot);
  const newlyGranted = await grantAchievementsForCurrentUser(
    supabase,
    evaluation.unlockedIds,
  );

  return {
    newlyGranted,
    alreadyUnlockedCount: Math.max(
      0,
      evaluation.unlockedIds.length - newlyGranted.length,
    ),
    evaluation,
  };
}
