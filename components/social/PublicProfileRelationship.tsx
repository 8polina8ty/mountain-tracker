"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import SocialActions from "@/components/social/SocialActions";
import { normalizeSocialUser, type SocialUser } from "@/Lib/social";
import { createClient } from "@/Lib/supabase/client";

export default function PublicProfileRelationship({
  profileUserId,
}: {
  profileUserId: string;
}) {
  const t = useTranslations("Social");

  const [supabase] = useState(() => createClient());

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<SocialUser | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (generation !== loadGenerationRef.current) {
      return;
    }

    if (authError) {
      setCurrentUserId(null);
      setRelationship(null);
      setUnavailable(true);
      return;
    }

    const userId = user?.id ?? null;

    setCurrentUserId(userId);

    if (!userId || userId === profileUserId) {
      setRelationship(null);
      setUnavailable(false);
      return;
    }

    const result = await supabase.rpc("get_friendship_state", {
      requested_user_id: profileUserId,
    });

    if (generation !== loadGenerationRef.current) {
      return;
    }

    if (result.error) {
      setRelationship(null);
      setUnavailable(true);
      return;
    }

    const raw = Array.isArray(result.data)
      ? result.data[0]
      : result.data;

    const normalized = normalizeSocialUser(raw);

    if (!normalized) {
      setRelationship(null);
      setUnavailable(true);
      return;
    }

    setRelationship(normalized);
    setUnavailable(false);
  }, [profileUserId, supabase]);

  useEffect(() => {
  queueMicrotask(() => {
    void load();
  });

  return () => {
    loadGenerationRef.current += 1;
  };
}, [load]);

  async function blockUser() {
    if (busy) {
      return;
    }

    if (!window.confirm(t("Blocking.confirm"))) {
      return;
    }

    setBusy(true);
    setMessage("");

    const result = await supabase.rpc("block_user", {
      requested_user_id: profileUserId,
    });

    setBusy(false);

    if (result.error) {
      setMessage(t("Errors.actionFailed"));
      return;
    }

    setMessage(t("Common.updated"));
    await load();
  }

  async function unblockUser() {
    if (busy) {
      return;
    }

    setBusy(true);
    setMessage("");

    const result = await supabase.rpc("unblock_user", {
      requested_user_id: profileUserId,
    });

    setBusy(false);

    if (result.error) {
      setMessage(t("Errors.actionFailed"));
      return;
    }

    setMessage(t("Common.updated"));
    await load();
  }

  if (!currentUserId || currentUserId === profileUserId) {
    return null;
  }

  if (unavailable) {
    return (
      <p className="mt-4 text-sm text-white/75">
        {t("Errors.unavailable")}
      </p>
    );
  }

  if (!relationship) {
    return null;
  }

  if (relationship.canUnblock) {
    return (
      <div className="mt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void unblockUser()}
          className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-white/60 px-4 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("Common.unblock")}
        </button>

        {message && (
          <span role="status" aria-live="polite" className="sr-only">
            {message}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-white p-2 text-[var(--color-text)]"
      aria-label={t("Accessibility.relationshipControls")}
    >
      <SocialActions
        key={`${relationship.relationshipState}:${relationship.requestId ?? "none"}`}
        userId={profileUserId}
        requestId={relationship.requestId ?? undefined}
        initialState={relationship.relationshipState}
        onChanged={() => {
          void load();
        }}
      />

      {relationship.relationshipState !== "blocked_or_unavailable" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void blockUser()}
          className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-danger-border)] px-3 text-sm font-semibold text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("Common.block")}
        </button>
      )}

      {message && (
        <span role="status" aria-live="polite" className="sr-only">
          {message}
        </span>
      )}
    </div>
  );
}