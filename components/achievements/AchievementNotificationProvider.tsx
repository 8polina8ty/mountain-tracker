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
import {
  ACHIEVEMENT_V2_RUNTIME_ENABLED,
  reconcileAchievementsAfterUserAction,
} from "@/Lib/achievementRuntime";
import { createClient } from "@/Lib/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

type LegacyNotificationInput = {
  id: AchievementId;
  icon: string;
};

type AchievementNotificationContextValue = {
  showAchievementNotification: (notification: LegacyNotificationInput) => void;
  enqueueAchievementIds: (ids: readonly AchievementId[]) => void;
  reconcileAfterUserAction: (supabase: SupabaseClient) => Promise<void>;
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
  const pendingLoadUserId = useRef<string | null>(null);
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

  const claimAchievementIds = useCallback(
    async (supabase: SupabaseClient, ids: readonly AchievementId[]) => {
      const candidates = ids.flatMap((id) => {
        const candidate = candidateForId(id, true);
        return candidate ? [candidate] : [];
      });
      const claimed = await Promise.all(
        candidates.map(async (candidate) =>
          await markAchievementNotificationDisplayed(supabase, candidate.id)
            ? candidate
            : null,
        ),
      );
      return claimed.filter(
        (candidate): candidate is AchievementNotificationCandidate => candidate !== null,
      );
    },
    [],
  );

  const enqueueAchievementIds = useCallback(
    (ids: readonly AchievementId[]) => {
      const supabase = createClient();
      void claimAchievementIds(supabase, ids)
        .then(enqueueCandidates)
        .catch((error) =>
          console.error("Unable to acknowledge achievement notification batch.", error),
        );
    },
    [claimAchievementIds, enqueueCandidates],
  );

  const reconcileAfterUserAction = useCallback(
    async (supabase: SupabaseClient) => {
      const grants = await reconcileAchievementsAfterUserAction(supabase);
      try {
        const candidates = await claimAchievementIds(
          supabase,
          grants.map((grant) => grant.achievementId),
        );
        enqueueCandidates(candidates);
      } catch (error) {
        console.error("Unable to acknowledge achievement notification batch.", error);
      }
    },
    [claimAchievementIds, enqueueCandidates],
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
    if (!ACHIEVEMENT_V2_RUNTIME_ENABLED) return;

    const supabase = createClient();
    let active = true;
    let authEventObserved = false;
    let sessionGeneration = 0;
    let scheduledLoad: number | null = null;

    const handleSession = (userId: string | null) => {
      if (!userId) {
        sessionGeneration += 1;
        pendingLoadUserId.current = null;
        if (scheduledLoad !== null) window.clearTimeout(scheduledLoad);
        scheduledLoad = null;
        clearTimer();
        setQueue([]);
        return;
      }
      if (pendingLoadUserId.current === userId) return;

      sessionGeneration += 1;
      const loadGeneration = sessionGeneration;
      pendingLoadUserId.current = userId;
      if (scheduledLoad !== null) window.clearTimeout(scheduledLoad);
      scheduledLoad = window.setTimeout(() => {
        scheduledLoad = null;
        if (!active || sessionGeneration !== loadGeneration || pendingLoadUserId.current !== userId) return;
        void loadPendingAchievementNotificationIds(supabase)
          .then(async (ids) => {
            if (active && sessionGeneration === loadGeneration && pendingLoadUserId.current === userId) {
              try {
                const candidates = await claimAchievementIds(
                  supabase,
                  ids.filter(isAchievementId),
                );
                if (active && sessionGeneration === loadGeneration && pendingLoadUserId.current === userId) {
                  enqueueCandidates(candidates);
                }
              } catch (error) {
                console.error("Unable to acknowledge achievement notification batch.", error);
              }
            }
          })
          .catch((error) => {
            if (active && sessionGeneration === loadGeneration && pendingLoadUserId.current === userId) {
              pendingLoadUserId.current = null;
            }
            console.error("Unable to load pending achievement notifications.", error);
          });
      }, 0);
    };

    void supabase.auth.getSession()
      .then(({ data }) => {
        if (active && !authEventObserved) handleSession(data.session?.user?.id ?? null);
      })
      .catch((error) => console.error("Unable to restore achievement notification session.", error));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventObserved = true;
      handleSession(session?.user?.id ?? null);
    });

    return () => {
      active = false;
      sessionGeneration += 1;
      if (scheduledLoad !== null) window.clearTimeout(scheduledLoad);
      subscription.unsubscribe();
    };
  }, [claimAchievementIds, clearTimer, enqueueCandidates]);

  useEffect(() => clearTimer, [clearTimer]);

  const contextValue = useMemo<AchievementNotificationContextValue>(
    () => ({
      showAchievementNotification,
      enqueueAchievementIds,
      reconcileAfterUserAction,
      closeAchievementNotification,
    }),
    [closeAchievementNotification, enqueueAchievementIds, reconcileAfterUserAction, showAchievementNotification],
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
