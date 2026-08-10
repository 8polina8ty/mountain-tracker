export type AchievementId =
  | "first-ascent"
  | "five-ascents"
  | "ten-ascents"
  | "twenty-five-ascents"
  | "fifty-ascents"
  | "above-clouds"
  | "zugspitze"
  | "ten-thousand-height";

export type AchievementDefinition = {
  id: AchievementId;
  icon: string;
};

export type AchievementView = AchievementDefinition & {
  unlocked: boolean;
  progress: number;
  target: number;
  unlockedAt: string | null;
};

export type AchievementStats = {
  ascentsCount: number;
  totalHeight: number;
  hasMountainAbove2000: boolean;
  hasZugspitze: boolean;
};

export type BuildAchievementsInput = AchievementStats & {
  unlockedAtById: Map<string, string>;
};

export type AchievementMessageKey =
  | "firstAscent"
  | "fiveAscents"
  | "tenAscents"
  | "twentyFiveAscents"
  | "fiftyAscents"
  | "aboveClouds"
  | "zugspitze"
  | "tenThousandHeight";

export const ACHIEVEMENT_MESSAGE_KEYS: Record<
  AchievementId,
  AchievementMessageKey
> = {
  "first-ascent": "firstAscent",
  "five-ascents": "fiveAscents",
  "ten-ascents": "tenAscents",
  "twenty-five-ascents": "twentyFiveAscents",
  "fifty-ascents": "fiftyAscents",
  "above-clouds": "aboveClouds",
  zugspitze: "zugspitze",
  "ten-thousand-height": "tenThousandHeight",
};

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  { id: "first-ascent", icon: "\u{1F97E}" },
  { id: "five-ascents", icon: "\u{1F3D4}\u{FE0F}" },
  { id: "ten-ascents", icon: "\u{1F949}" },
  { id: "twenty-five-ascents", icon: "\u{1F948}" },
  { id: "fifty-ascents", icon: "\u{1F947}" },
  { id: "above-clouds", icon: "\u{2601}\u{FE0F}" },
  { id: "zugspitze", icon: "\u{1F1E9}\u{1F1EA}" },
  { id: "ten-thousand-height", icon: "\u{1F4CF}" },
];

export const ACHIEVEMENT_DEFINITIONS_BY_ID = new Map(
  ACHIEVEMENT_DEFINITIONS.map((achievement) => [achievement.id, achievement]),
);

export function buildAchievements({
  ascentsCount,
  totalHeight,
  hasMountainAbove2000,
  hasZugspitze,
  unlockedAtById,
}: BuildAchievementsInput): AchievementView[] {
  return [
    { id: "first-ascent", icon: "\u{1F97E}", unlocked: ascentsCount >= 1, progress: Math.min(ascentsCount, 1), target: 1, unlockedAt: unlockedAtById.get("first-ascent") ?? null },
    { id: "five-ascents", icon: "\u{1F3D4}\u{FE0F}", unlocked: ascentsCount >= 5, progress: Math.min(ascentsCount, 5), target: 5, unlockedAt: unlockedAtById.get("five-ascents") ?? null },
    { id: "ten-ascents", icon: "\u{1F949}", unlocked: ascentsCount >= 10, progress: Math.min(ascentsCount, 10), target: 10, unlockedAt: unlockedAtById.get("ten-ascents") ?? null },
    { id: "twenty-five-ascents", icon: "\u{1F948}", unlocked: ascentsCount >= 25, progress: Math.min(ascentsCount, 25), target: 25, unlockedAt: unlockedAtById.get("twenty-five-ascents") ?? null },
    { id: "fifty-ascents", icon: "\u{1F947}", unlocked: ascentsCount >= 50, progress: Math.min(ascentsCount, 50), target: 50, unlockedAt: unlockedAtById.get("fifty-ascents") ?? null },
    { id: "above-clouds", icon: "\u{2601}\u{FE0F}", unlocked: hasMountainAbove2000, progress: hasMountainAbove2000 ? 1 : 0, target: 1, unlockedAt: unlockedAtById.get("above-clouds") ?? null },
    { id: "zugspitze", icon: "\u{1F1E9}\u{1F1EA}", unlocked: hasZugspitze, progress: hasZugspitze ? 1 : 0, target: 1, unlockedAt: unlockedAtById.get("zugspitze") ?? null },
    { id: "ten-thousand-height", icon: "\u{1F4CF}", unlocked: totalHeight >= 10_000, progress: Math.min(totalHeight, 10_000), target: 10_000, unlockedAt: unlockedAtById.get("ten-thousand-height") ?? null },
  ];
}

export function getEarnedAchievementIds(stats: AchievementStats): AchievementId[] {
  const earnedAchievementIds: AchievementId[] = [];
  if (stats.ascentsCount >= 1) earnedAchievementIds.push("first-ascent");
  if (stats.ascentsCount >= 5) earnedAchievementIds.push("five-ascents");
  if (stats.ascentsCount >= 10) earnedAchievementIds.push("ten-ascents");
  if (stats.ascentsCount >= 25) earnedAchievementIds.push("twenty-five-ascents");
  if (stats.ascentsCount >= 50) earnedAchievementIds.push("fifty-ascents");
  if (stats.hasMountainAbove2000) earnedAchievementIds.push("above-clouds");
  if (stats.hasZugspitze) earnedAchievementIds.push("zugspitze");
  if (stats.totalHeight >= 10_000) earnedAchievementIds.push("ten-thousand-height");
  return earnedAchievementIds;
}
