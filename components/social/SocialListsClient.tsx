"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import SocialActions from "@/components/social/SocialActions";
import SocialUserRow from "@/components/social/SocialUserRow";
import {
  normalizeFriendRequest,
  normalizeSocialUser,
  type FriendRequest,
  type SocialUser,
} from "@/Lib/social";
import { createClient } from "@/Lib/supabase/client";

export function RequestsClient() {
  const t = useTranslations("Social");
  const format = useFormatter();

  const [supabase] = useState(() => createClient());

  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;

    setLoading(true);
    setError("");

    const [incomingResult, outgoingResult] = await Promise.all([
      supabase.rpc("list_friend_requests", {
        direction: "incoming",
        result_limit: 20,
        cursor_created_at: null,
        cursor_request_id: null,
      }),
      supabase.rpc("list_friend_requests", {
        direction: "outgoing",
        result_limit: 20,
        cursor_created_at: null,
        cursor_request_id: null,
      }),
    ]);

    if (generation !== loadGenerationRef.current) {
      return;
    }

    setLoading(false);

    if (incomingResult.error || outgoingResult.error) {
      setError(t("Errors.unavailable"));
      return;
    }

    const nextIncoming = ((incomingResult.data ?? []) as unknown[])
      .map(normalizeFriendRequest)
      .filter((row): row is FriendRequest => row !== null);

    const nextOutgoing = ((outgoingResult.data ?? []) as unknown[])
      .map(normalizeFriendRequest)
      .filter((row): row is FriendRequest => row !== null);

    setIncoming(nextIncoming);
    setOutgoing(nextOutgoing);
  }, [supabase, t]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });

    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  function renderList(
    rows: FriendRequest[],
    direction: "incoming" | "outgoing"
  ) {
    if (loading && rows.length === 0) {
      return (
        <p className="py-5 text-sm text-[var(--color-text-muted)]">
          {t("Common.loading")}
        </p>
      );
    }

    if (rows.length === 0) {
      return (
        <p className="py-5 text-sm text-[var(--color-text-muted)]">
          {t(
            direction === "incoming"
              ? "Requests.emptyIncoming"
              : "Requests.emptyOutgoing"
          )}
        </p>
      );
    }

    return (
      <ul>
        {rows.map((row) => (
          <SocialUserRow
            key={row.requestId}
            {...row}
            detail={format.dateTime(new Date(row.createdAt), {
              dateStyle: "medium",
            })}
            action={
              <SocialActions
                key={`${row.requestId}:${direction}`}
                userId={row.userId}
                requestId={row.requestId}
                initialState={
                  direction === "incoming"
                    ? "incoming_pending"
                    : "outgoing_pending"
                }
                onChanged={() => {
                  void load();
                }}
              />
            }
          />
        ))}
      </ul>
    );
  }

  return (
    <SocialPageShell
      title={t("Requests.title")}
      description={t("Friends.description")}
    >
      {error && (
        <p
          role="alert"
          className="mb-4 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <section className="border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
        <h2 className="text-xl font-bold">
          {t("Requests.incoming")}
        </h2>

        {renderList(incoming, "incoming")}
      </section>

      <section className="mt-6 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
        <h2 className="text-xl font-bold">
          {t("Requests.outgoing")}
        </h2>

        {renderList(outgoing, "outgoing")}
      </section>
    </SocialPageShell>
  );
}

export function BlockedClient() {
  const t = useTranslations("Social");

  const [supabase] = useState(() => createClient());

  const [rows, setRows] = useState<SocialUser[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;

    setLoading(true);
    setError("");

    const response = await supabase.rpc("list_blocked_users", {
      result_limit: 20,
      cursor_username: null,
      cursor_user_id: null,
    });

    if (generation !== loadGenerationRef.current) {
      return;
    }

    setLoading(false);

    if (response.error) {
      setError(t("Errors.unavailable"));
      return;
    }

    const next = ((response.data ?? []) as unknown[])
      .map(normalizeSocialUser)
      .filter((row): row is SocialUser => row !== null);

    setRows(next);
  }, [supabase, t]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });

    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  async function unblock(userId: string) {
    if (busyUserId) {
      return;
    }

    setBusyUserId(userId);
    setError("");
    setMessage("");

    const { error: rpcError } = await supabase.rpc("unblock_user", {
      requested_user_id: userId,
    });

    setBusyUserId(null);

    if (rpcError) {
      setError(t("Errors.actionFailed"));
      return;
    }

    setMessage(t("Common.updated"));
    await load();
  }

  return (
    <SocialPageShell
      title={t("Blocking.title")}
      description={t("Blocking.description")}
    >
      <section className="border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
        {error && (
          <p
            role="alert"
            className="mb-4 text-sm text-[var(--color-danger)]"
          >
            {error}
          </p>
        )}

        {loading && rows.length === 0 ? (
          <p className="py-5 text-sm text-[var(--color-text-muted)]">
            {t("Common.loading")}
          </p>
        ) : rows.length > 0 ? (
          <ul>
            {rows.map((row) => (
              <SocialUserRow
                key={row.userId}
                {...row}
                action={
                  <button
                    type="button"
                    disabled={busyUserId !== null}
                    className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void unblock(row.userId)}
                  >
                    {busyUserId === row.userId
                      ? t("Common.loading")
                      : t("Common.unblock")}
                  </button>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="py-5 text-sm text-[var(--color-text-muted)]">
            {t("Blocking.empty")}
          </p>
        )}

        {message && (
          <span
            role="status"
            aria-live="polite"
            className="sr-only"
          >
            {message}
          </span>
        )}
      </section>
    </SocialPageShell>
  );
}

function SocialPageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:px-6 lg:py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-3xl font-bold">
          {title}
        </h1>

        <p className="mt-2 mb-8 text-[var(--color-text-muted)]">
          {description}
        </p>

        {children}
      </div>
    </main>
  );
}