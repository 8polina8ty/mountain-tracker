"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import AchievementNotification from "@/components/AchievementNotification";
import {
  advanceNotificationQueue,
  createNotificationQueueItems,
  enqueueUniqueNotifications,
  type AchievementNotificationCandidate,
  type AchievementNotificationQueueItem,
} from "@/Lib/achievementNotificationQueue";
import {
  ACHIEVEMENT_REGISTRY_BY_ID,
  isAchievementId,
  type AchievementId,
} from "@/Lib/achievementRegistry";
import {
  loadPendingAchievementNotificationIds,
  markAchievementNotificationDisplayed,
} from "@/Lib/achievementNotificationService";
import { ACHIEVEMENT_V2_RUNTIME_ENABLED } from "@/Lib/achievementRuntime";
import { createClient } from "@/Lib/supabase/client";

type LegacyNotificationInput = {
  id: AchievementId;
  icon: string;
};

type AchievementNotificationContextValue = {
  showAchievementNotification: (notification: LegacyNotificationInput) => void;
  enqueueAchievementIds: (ids: readonly AchievementId[]) => void;
  closeAchievementNotification: () => void;
};

const AchievementNotificationContext =
  createContext<AchievementNotificationContextValue | null>(null);

function candidateForId(
  id: AchievementId,
  durable: boolean,
  iconOverride?: string,
): AchievementNotificationCandidate | null {
  const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(id);
  if (!definition) return null;
  return {
    id,
    icon: iconOverride ?? definition.icon,
    translationKey: definition.translationKey,
    target: definition.metric === "gpsDistanceM"
      ? definition.target / 1000
      : definition.target,
    chainId: definition.chainId ?? null,
    tier: definition.tier ?? null,
    durable,
  };
}

export function AchievementNotificationProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<AchievementNotificationQueueItem[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const batchSequence = useRef(0);
  const current = queue[0] ?? null;

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const closeAchievementNotification = useCallback(() => {
    clearTimer();
    setQueue((items) => advanceNotificationQueue(items));
  }, [clearTimer]);

  const enqueueCandidates = useCallback(
    (candidates: readonly AchievementNotificationCandidate[]) => {
      if (candidates.length === 0) return;
      batchSequence.current += 1;
      const incoming = createNotificationQueueItems(
        candidates,
        String(batchSequence.current),
      );
      setQueue((items) => enqueueUniqueNotifications(items, incoming));
    },
    [],
  );

  const enqueueAchievementIds = useCallback(
    (ids: readonly AchievementId[]) => {
      enqueueCandidates(
        ids.flatMap((id) => {
          const candidate = candidateForId(id, true);
          return candidate ? [candidate] : [];
        }),
      );
    },
    [enqueueCandidates],
  );

  const showAchievementNotification = useCallback(
    (notification: LegacyNotificationInput) => {
      const candidate = candidateForId(
        notification.id,
        false,
        notification.icon,
      );
      if (candidate) enqueueCandidates([candidate]);
    },
    [enqueueCandidates],
  );

  useEffect(() => {
    if (!current) return;
    clearTimer();
    timeoutRef.current = window.setTimeout(() => {
      setQueue((items) => advanceNotificationQueue(items));
      timeoutRef.current = null;
    }, 5000);
    return clearTimer;
  }, [clearTimer, current]);

  useEffect(() => {
    if (
      !ACHIEVEMENT_V2_RUNTIME_ENABLED ||
      current?.kind !== "achievement" ||
      !current.durable
    ) return;

    void markAchievementNotificationDisplayed(createClient(), current.id).catch(
      (error) => console.error("Unable to mark achievement notification.", error),
    );
  }, [current]);

  useEffect(() => {
    if (!ACHIEVEMENT_V2_RUNTIME_ENABLED) return;
    void loadPendingAchievementNotificationIds(createClient())
      .then((ids) => enqueueAchievementIds(ids.filter(isAchievementId)))
      .catch((error) => console.error("Unable to load pending achievement notifications.", error));
  }, [enqueueAchievementIds]);

  useEffect(() => clearTimer, [clearTimer]);

  const contextValue = useMemo<AchievementNotificationContextValue>(
    () => ({
      showAchievementNotification,
      enqueueAchievementIds,
      closeAchievementNotification,
    }),
    [closeAchievementNotification, enqueueAchievementIds, showAchievementNotification],
  );

  return (
    <AchievementNotificationContext.Provider value={contextValue}>
      {children}
      <AchievementNotification
        notification={current}
        onClose={closeAchievementNotification}
      />
    </AchievementNotificationContext.Provider>
  );
}

export function useAchievementNotification() {
  const context = useContext(AchievementNotificationContext);
  if (!context) {
    throw new Error("useAchievementNotification must be used within AchievementNotificationProvider");
  }
  return context;
}
