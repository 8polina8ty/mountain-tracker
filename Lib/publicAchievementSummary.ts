import {
  ACHIEVEMENT_REGISTRY_BY_ID,
  isAchievementId,
  type AchievementCategory,
  type AchievementId,
  type AchievementRarity,
} from "./achievementRegistry";

export type PublicFeaturedAchievement = {
  id: AchievementId;
  translationKey: string;
  category: AchievementCategory;
  rarity: AchievementRarity;
  icon: string;
  target: number;
  unlockedAt: string;
};

export type PublicAchievementSummary = {
  unlockedCount: number;
  totalDefinitions: number;
  milestonePoints: number;
  completionPercent: number;
  distinguishedCount: number;
  exceptionalCount: number;
  lifetimeCount: number;
  featured: PublicFeaturedAchievement[];
};

const rarityPriority: Record<AchievementRarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function normalizePublicAchievementSummary(
  value: unknown,
): PublicAchievementSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const safeRows = Array.isArray(record.safeAchievements) ? record.safeAchievements : [];

  const featured = safeRows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const candidate = row as Record<string, unknown>;
    if (!isAchievementId(candidate.id) || typeof candidate.unlockedAt !== "string") return [];
    if (!Number.isFinite(Date.parse(candidate.unlockedAt))) return [];
    const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(candidate.id);
    if (!definition || definition.publicVisibility !== "safe") return [];
    if (definition.category === "planning" || definition.category === "photography") return [];
    return [{
      id: definition.id,
      translationKey: definition.translationKey,
      category: definition.category,
      rarity: definition.rarity,
      icon: definition.icon,
      target: definition.metric === "gpsDistanceM" ? definition.target / 1000 : definition.target,
      unlockedAt: candidate.unlockedAt,
      chainId: definition.chainId ?? definition.id,
      tier: definition.tier ?? 0,
    }];
  });

  const highestByChain = new Map<string, (typeof featured)[number]>();
  for (const candidate of featured) {
    const current = highestByChain.get(candidate.chainId);
    if (!current || candidate.tier > current.tier ||
      (candidate.tier === current.tier && Date.parse(candidate.unlockedAt) > Date.parse(current.unlockedAt))) {
      highestByChain.set(candidate.chainId, candidate);
    }
  }
  const selected = [...highestByChain.values()];
  selected.sort((first, second) =>
    rarityPriority[second.rarity] - rarityPriority[first.rarity] ||
    second.tier - first.tier ||
    Date.parse(second.unlockedAt) - Date.parse(first.unlockedAt),
  );

  return {
    unlockedCount: nonNegativeInteger(record.unlockedCount),
    totalDefinitions: nonNegativeInteger(record.totalDefinitions),
    milestonePoints: nonNegativeInteger(record.milestonePoints),
    completionPercent: Math.min(100, nonNegativeInteger(record.completionPercent)),
    distinguishedCount: nonNegativeInteger(record.distinguishedCount),
    exceptionalCount: nonNegativeInteger(record.exceptionalCount),
    lifetimeCount: nonNegativeInteger(record.lifetimeCount),
    featured: selected.slice(0, 3).map((item) => ({
      id: item.id,
      translationKey: item.translationKey,
      category: item.category,
      rarity: item.rarity,
      icon: item.icon,
      target: item.target,
      unlockedAt: item.unlockedAt,
    })),
  };
}
