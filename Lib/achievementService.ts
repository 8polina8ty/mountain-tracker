import type { SupabaseClient } from "@supabase/supabase-js";

import type { AchievementId } from "@/Lib/achievements";

export type UserAchievementRecord = {
  achievement_id: AchievementId;
  unlocked_at: string;
};

type SyncAchievementsInput = {
  supabase: SupabaseClient;
  userId: string;
  earnedAchievementIds: AchievementId[];
  savedAchievements: UserAchievementRecord[];
};

type SyncAchievementsResult = {
  achievements: UserAchievementRecord[];
  newAchievements: UserAchievementRecord[];
};

export async function loadUserAchievements(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserAchievementRecord[]> {
  const { data, error } = await supabase
    .from("user_achievements")
    .select("achievement_id, unlocked_at")
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  return (data ?? []) as UserAchievementRecord[];
}

export async function syncUserAchievements({
  supabase,
  userId,
  earnedAchievementIds,
  savedAchievements,
}: SyncAchievementsInput): Promise<SyncAchievementsResult> {
  const savedAchievementIds = new Set(
    savedAchievements.map(
      (achievement) => achievement.achievement_id,
    ),
  );

  const newAchievementIds = earnedAchievementIds.filter(
    (achievementId) => !savedAchievementIds.has(achievementId),
  );

  if (newAchievementIds.length === 0) {
    return {
      achievements: savedAchievements,
      newAchievements: [],
    };
  }

  const { data, error } = await supabase
    .from("user_achievements")
    .upsert(
      newAchievementIds.map((achievementId) => ({
        user_id: userId,
        achievement_id: achievementId,
      })),
      {
        onConflict: "user_id,achievement_id",
        ignoreDuplicates: true,
      },
    )
    .select("achievement_id, unlocked_at");

  if (error) {
    throw error;
  }

  const insertedAchievements =
    (data ?? []) as UserAchievementRecord[];

  return {
    achievements: [
      ...savedAchievements,
      ...insertedAchievements,
    ],
    newAchievements: insertedAchievements,
  };
}