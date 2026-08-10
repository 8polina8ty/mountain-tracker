import type { SupabaseClient } from "@supabase/supabase-js";

import { reconcileAchievementsForCurrentUser } from "./achievementReconciliation";
import type { AchievementGrantRecord } from "./achievementPersistence";

/** Enable only after both Phase B/C SQL artifacts are deployed and verified. */
export const ACHIEVEMENT_V2_RUNTIME_ENABLED = true;

let reconciliationFailureReported = false;

export async function reconcileAchievementsAfterUserAction(
  supabase: SupabaseClient,
): Promise<AchievementGrantRecord[]> {
  if (!ACHIEVEMENT_V2_RUNTIME_ENABLED) return [];

  try {
    const result = await reconcileAchievementsForCurrentUser(supabase);
    return result.newlyGranted;
  } catch (error) {
    if (!reconciliationFailureReported) {
      reconciliationFailureReported = true;
      console.error("Achievement v2 reconciliation is unavailable.", error);
    }
    return [];
  }
}
