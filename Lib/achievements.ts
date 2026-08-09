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
  title: string;
  description: string;
  unlockedDescription: string;
  icon: string;
};

export type AchievementView = {
  id: AchievementId;
  title: string;
  description: string;
  icon: string;
  unlocked: boolean;
  progress: number;
  target: number;
  progressLabel: string;
  unlockedAt: string | null;
};

export type BuildAchievementsInput = AchievementStats & {
  unlockedAtById: Map<string, string>;
};

export function buildAchievements({
  ascentsCount,
  totalHeight,
  hasMountainAbove2000,
  hasZugspitze,
  unlockedAtById,
}: BuildAchievementsInput): AchievementView[] {
  return [
    {
      id: "first-ascent",
      title: "Первый шаг",
      description: "Покорите свою первую вершину.",
      icon: "🥾",
      unlocked: ascentsCount >= 1,
      progress: Math.min(ascentsCount, 1),
      target: 1,
      progressLabel: `${Math.min(ascentsCount, 1)} из 1`,
      unlockedAt: unlockedAtById.get("first-ascent") ?? null,
    },
    {
      id: "five-ascents",
      title: "Начинающий альпинист",
      description: "Покорите 5 вершин.",
      icon: "🏔️",
      unlocked: ascentsCount >= 5,
      progress: Math.min(ascentsCount, 5),
      target: 5,
      progressLabel: `${Math.min(ascentsCount, 5)} из 5`,
      unlockedAt: unlockedAtById.get("five-ascents") ?? null,
    },
    {
      id: "ten-ascents",
      title: "Покоритель вершин",
      description: "Покорите 10 вершин.",
      icon: "🥉",
      unlocked: ascentsCount >= 10,
      progress: Math.min(ascentsCount, 10),
      target: 10,
      progressLabel: `${Math.min(ascentsCount, 10)} из 10`,
      unlockedAt: unlockedAtById.get("ten-ascents") ?? null,
    },
    {
      id: "twenty-five-ascents",
      title: "Опытный альпинист",
      description: "Покорите 25 вершин.",
      icon: "🥈",
      unlocked: ascentsCount >= 25,
      progress: Math.min(ascentsCount, 25),
      target: 25,
      progressLabel: `${Math.min(ascentsCount, 25)} из 25`,
      unlockedAt:
        unlockedAtById.get("twenty-five-ascents") ?? null,
    },
    {
      id: "fifty-ascents",
      title: "Мастер высоты",
      description: "Покорите 50 вершин.",
      icon: "🥇",
      unlocked: ascentsCount >= 50,
      progress: Math.min(ascentsCount, 50),
      target: 50,
      progressLabel: `${Math.min(ascentsCount, 50)} из 50`,
      unlockedAt: unlockedAtById.get("fifty-ascents") ?? null,
    },
    {
      id: "above-clouds",
      title: "Выше облаков",
      description: "Покорите вершину высотой не менее 2000 м.",
      icon: "☁️",
      unlocked: hasMountainAbove2000,
      progress: hasMountainAbove2000 ? 1 : 0,
      target: 1,
      progressLabel: hasMountainAbove2000
        ? "Выполнено"
        : "Нужна вершина от 2000 м",
      unlockedAt: unlockedAtById.get("above-clouds") ?? null,
    },
    {
      id: "zugspitze",
      title: "Крыша Германии",
      description: "Покорите Zugspitze.",
      icon: "🇩🇪",
      unlocked: hasZugspitze,
      progress: hasZugspitze ? 1 : 0,
      target: 1,
      progressLabel: hasZugspitze
        ? "Выполнено"
        : "Zugspitze ещё не покорена",
      unlockedAt: unlockedAtById.get("zugspitze") ?? null,
    },
    {
      id: "ten-thousand-height",
      title: "10 000 метров",
      description: "Наберите суммарно 10 000 метров высоты.",
      icon: "📏",
      unlocked: totalHeight >= 10_000,
      progress: Math.min(totalHeight, 10_000),
      target: 10_000,
      progressLabel: `${totalHeight.toLocaleString("ru-RU")} из 10 000 м`,
      unlockedAt:
        unlockedAtById.get("ten-thousand-height") ?? null,
    },
  ];
}

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  {
    id: "first-ascent",
    title: "Первый шаг",
    description: "Покорите свою первую вершину.",
    unlockedDescription: "Вы покорили свою первую вершину.",
    icon: "🥾",
  },
  {
    id: "five-ascents",
    title: "Начинающий альпинист",
    description: "Покорите 5 вершин.",
    unlockedDescription: "Вы покорили 5 вершин.",
    icon: "🏔️",
  },
  {
    id: "ten-ascents",
    title: "Покоритель вершин",
    description: "Покорите 10 вершин.",
    unlockedDescription: "Вы покорили 10 вершин.",
    icon: "🥉",
  },
  {
    id: "twenty-five-ascents",
    title: "Опытный альпинист",
    description: "Покорите 25 вершин.",
    unlockedDescription: "Вы покорили 25 вершин.",
    icon: "🥈",
  },
  {
    id: "fifty-ascents",
    title: "Мастер высоты",
    description: "Покорите 50 вершин.",
    unlockedDescription: "Вы покорили 50 вершин.",
    icon: "🥇",
  },
  {
    id: "above-clouds",
    title: "Выше облаков",
    description: "Покорите вершину высотой не менее 2000 м.",
    unlockedDescription: "Вы покорили вершину высотой от 2000 м.",
    icon: "☁️",
  },
  {
    id: "zugspitze",
    title: "Крыша Германии",
    description: "Покорите Zugspitze.",
    unlockedDescription: "Вы покорили Zugspitze.",
    icon: "🇩🇪",
  },
  {
    id: "ten-thousand-height",
    title: "10 000 метров",
    description: "Наберите суммарно 10 000 метров высоты.",
    unlockedDescription:
      "Сумма высот ваших вершин достигла 10 000 м.",
    icon: "📏",
  },
];

export const ACHIEVEMENT_DEFINITIONS_BY_ID = new Map(
  ACHIEVEMENT_DEFINITIONS.map((achievement) => [
    achievement.id,
    achievement,
  ]),
);

export type AchievementStats = {
  ascentsCount: number;
  totalHeight: number;
  hasMountainAbove2000: boolean;
  hasZugspitze: boolean;
};

export function getEarnedAchievementIds(
  stats: AchievementStats,
): AchievementId[] {
  const earnedAchievementIds: AchievementId[] = [];

  if (stats.ascentsCount >= 1) {
    earnedAchievementIds.push("first-ascent");
  }

  if (stats.ascentsCount >= 5) {
    earnedAchievementIds.push("five-ascents");
  }

  if (stats.ascentsCount >= 10) {
    earnedAchievementIds.push("ten-ascents");
  }

  if (stats.ascentsCount >= 25) {
    earnedAchievementIds.push("twenty-five-ascents");
  }

  if (stats.ascentsCount >= 50) {
    earnedAchievementIds.push("fifty-ascents");
  }

  if (stats.hasMountainAbove2000) {
    earnedAchievementIds.push("above-clouds");
  }

  if (stats.hasZugspitze) {
    earnedAchievementIds.push("zugspitze");
  }

  if (stats.totalHeight >= 10_000) {
    earnedAchievementIds.push("ten-thousand-height");
  }

  return earnedAchievementIds;
}