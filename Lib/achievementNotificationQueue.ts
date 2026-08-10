import type { AchievementId } from "./achievementRegistry";

export type AchievementNotificationCandidate = {
  id: AchievementId;
  icon: string;
  translationKey: string;
  target: number;
  chainId: string | null;
  tier: number | null;
  durable: boolean;
};

export type AchievementNotificationQueueItem =
  | ({ kind: "achievement"; key: string } & AchievementNotificationCandidate)
  | { kind: "summary"; key: string; count: number };

export type AchievementNotificationBatch = {
  details: AchievementNotificationCandidate[];
  summaryCount: number;
};

export function selectAchievementNotificationBatch(
  candidates: readonly AchievementNotificationCandidate[],
  maximumDetails = 2,
): AchievementNotificationBatch {
  const unique = new Map<AchievementId, AchievementNotificationCandidate>();
  for (const candidate of candidates) unique.set(candidate.id, candidate);

  const highestByChain = new Map<string, AchievementNotificationCandidate>();
  const unchained: AchievementNotificationCandidate[] = [];

  for (const candidate of unique.values()) {
    if (!candidate.chainId) {
      unchained.push(candidate);
      continue;
    }
    const current = highestByChain.get(candidate.chainId);
    if (!current || (candidate.tier ?? 0) > (current.tier ?? 0)) {
      highestByChain.set(candidate.chainId, candidate);
    }
  }

  const preferred = [...highestByChain.values(), ...unchained]
    .sort((first, second) => (second.tier ?? 0) - (first.tier ?? 0));
  const details = preferred.slice(0, Math.max(0, maximumDetails));

  return {
    details,
    summaryCount: Math.max(0, unique.size - details.length),
  };
}

export function createNotificationQueueItems(
  candidates: readonly AchievementNotificationCandidate[],
  batchKey: string,
): AchievementNotificationQueueItem[] {
  const batch = selectAchievementNotificationBatch(candidates);
  const items: AchievementNotificationQueueItem[] = batch.details.map(
    (candidate) => ({
      ...candidate,
      kind: "achievement",
      key: `achievement:${candidate.id}`,
    }),
  );

  if (batch.summaryCount > 0) {
    items.push({
      kind: "summary",
      key: `summary:${batchKey}`,
      count: batch.summaryCount,
    });
  }
  return items;
}

export function enqueueUniqueNotifications(
  queue: readonly AchievementNotificationQueueItem[],
  incoming: readonly AchievementNotificationQueueItem[],
): AchievementNotificationQueueItem[] {
  const keys = new Set(queue.map((item) => item.key));
  return [
    ...queue,
    ...incoming.filter((item) => {
      if (keys.has(item.key)) return false;
      keys.add(item.key);
      return true;
    }),
  ];
}

export function advanceNotificationQueue(
  queue: readonly AchievementNotificationQueueItem[],
): AchievementNotificationQueueItem[] {
  return queue.slice(1);
}

export type AchievementMutationEvent =
  | "ascent-created"
  | "ascent-removed"
  | "photo-changed"
  | "favorite-changed"
  | "gps-ready"
  | "gps-mountain-changed"
  | "gps-track-deleted";

export function shouldReconcileAchievementMutation(input: {
  event: AchievementMutationEvent;
  succeeded: boolean;
  gpsStatus?: string;
}): boolean {
  if (!input.succeeded) return false;
  return input.event !== "gps-ready" || input.gpsStatus === "ready";
}
