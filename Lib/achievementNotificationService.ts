import type { SupabaseClient } from "@supabase/supabase-js";

import { isAchievementId, type AchievementId } from "./achievementRegistry";

export async function loadPendingAchievementNotificationIds(
  supabase: SupabaseClient,
): Promise<AchievementId[]> {
  const { data, error } = await supabase.rpc("get_pending_achievement_notifications");
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const id = (row as Record<string, unknown>).achievement_id;
    return isAchievementId(id) ? [id] : [];
  });
}

export async function markAchievementNotificationDisplayed(
  supabase: SupabaseClient,
  achievementId: AchievementId,
): Promise<void> {
  const { error } = await supabase.rpc("mark_achievement_notification_notified", {
    requested_achievement_id: achievementId,
  });
  if (error) throw error;
}
