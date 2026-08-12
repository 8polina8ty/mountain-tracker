"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/Lib/supabase/client";
import { normalizeSocialInboxSummary, type SocialInboxSummary } from "@/Lib/socialMessaging";

type RealtimeState = "connecting" | "connected" | "unavailable";
type SocialInboxContextValue = SocialInboxSummary & {
  realtimeState: RealtimeState;
  revision: number;
  refresh: () => Promise<void>;
};

const emptySummary: SocialInboxSummary = { totalUnreadMessages: 0, unreadConversations: {} };
const SocialInboxContext = createContext<SocialInboxContextValue>({ ...emptySummary, realtimeState: "connecting", revision: 0, refresh: async () => undefined });



export function SocialInboxProvider({ children }: { children: React.ReactNode }) {
  const [summary, setSummary] = useState(emptySummary);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("connecting");
  const [revision, setRevision] = useState(0);
  const [supabase] = useState(() => createClient());
  const userIdRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
  const expectedUserId = userIdRef.current;
  const requestGeneration = ++refreshGenerationRef.current;

  if (!expectedUserId) {
    setSummary(emptySummary);
    return;
  }

  const { data, error } = await supabase.rpc(
    "get_social_inbox_summary"
  );

  if (
    error ||
    requestGeneration !== refreshGenerationRef.current ||
    userIdRef.current !== expectedUserId
  ) {
    return;
  }

  const normalized = normalizeSocialInboxSummary(data);

  if (normalized) {
    setSummary(normalized);
  }
}, [supabase]);

const scheduleRefresh = useCallback(() => {
  if (refreshTimerRef.current) {
    clearTimeout(refreshTimerRef.current);
  }

  refreshTimerRef.current = setTimeout(() => {
    refreshTimerRef.current = null;
    void refresh();
  }, 150);
}, [refresh]);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let disposed = false;
    let generation = 0;

    function removeChannel() {
      if (channel) void supabase.removeChannel(channel);
      channel = null;
    }

    async function initialize(userId: string | null) {
      const currentGeneration = ++generation;

      refreshGenerationRef.current += 1;
      removeChannel();
      userIdRef.current = userId;
      setSummary(emptySummary);
      setRevision((value) => value + 1);
      if (!userId || disposed) {
        setRealtimeState("connecting");
        return;
      }
      setRealtimeState("connecting");
      await refresh();
      if (disposed || currentGeneration !== generation || userIdRef.current !== userId) return;
        channel = supabase
          .channel(`social-inbox:${userId}`)
                    .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "messages" },
              () => {
                setRevision((value) => value + 1);
                scheduleRefresh();
              }
            )
                .on(
                  "postgres_changes",
                  { event: "UPDATE", schema: "public", table: "messages" },
                  () => {
                    setRevision((value) => value + 1);
                    scheduleRefresh();
                  }
                )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            setRealtimeState("connected");
            setRevision((value) => value + 1);
            void refresh();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setRealtimeState("unavailable");
          }
        });
    }

    void supabase.auth.getUser().then(({ data }) => initialize(data.user?.id ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => void initialize(session?.user?.id ?? null));
    return () => {
      disposed = true;
      subscription.unsubscribe();
      removeChannel();
    };
  }, [refresh, scheduleRefresh, supabase]);

  const value = useMemo(() => ({ ...summary, realtimeState, revision, refresh }), [summary, realtimeState, revision, refresh]);
  return <SocialInboxContext.Provider value={value}>{children}</SocialInboxContext.Provider>;
}

export function useSocialInbox() {
  return useContext(SocialInboxContext);
}
