"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import StartConversationButton from "@/components/messages/StartConversationButton";
import { createClient } from "@/Lib/supabase/client";
import type { RelationshipState } from "@/Lib/social";

type Props = {
  userId: string;
  initialState: RelationshipState;
  requestId?: string;
  onChanged?: () => void;
};

export default function SocialActions({
  userId,
  initialState,
  requestId,
  onChanged,
}: Props) {
  const t = useTranslations("Social");

  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function call(
    name: string,
    args: Record<string, unknown>,
    next: RelationshipState
  ) {
    if (busy) {
      return;
    }

    setBusy(true);
    setMessage("");

    const { error } = await createClient().rpc(name, args);

    setBusy(false);

    if (error) {
      setMessage(t("Errors.actionFailed"));
      return;
    }

    setState(next);
    setMessage(t("Common.updated"));
    onChanged?.();
  }

  async function removeFriend() {
    if (!window.confirm(t("Common.removeFriendConfirm"))) {
      return;
    }

    await call(
      "remove_friend",
      {
        requested_user_id: userId,
      },
      "none"
    );
  }

  const button =
    "ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === "none" && (
        <button
          type="button"
          className={`${button} bg-[var(--color-forest)] text-white`}
          disabled={busy}
          onClick={() =>
            void call(
              "send_friend_request",
              {
                requested_user_id: userId,
              },
              "outgoing_pending"
            )
          }
        >
          {t("Common.addFriend")}
        </button>
      )}

      {state === "outgoing_pending" && (
        <>
          <span className="text-sm text-[var(--color-text-muted)]">
            {t("Common.requestSent")}
          </span>

          {requestId && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void call(
                  "cancel_friend_request",
                  {
                    request_id: requestId,
                  },
                  "none"
                )
              }
            >
              {t("Common.cancel")}
            </button>
          )}
        </>
      )}

      {state === "incoming_pending" && requestId && (
        <>
          <button
            type="button"
            className={`${button} bg-[var(--color-forest)] text-white`}
            disabled={busy}
            onClick={() =>
              void call(
                "respond_to_friend_request",
                {
                  request_id: requestId,
                  response: "accepted",
                },
                "friends"
              )
            }
          >
            {t("Common.accept")}
          </button>

          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() =>
              void call(
                "respond_to_friend_request",
                {
                  request_id: requestId,
                  response: "rejected",
                },
                "none"
              )
            }
          >
            {t("Common.reject")}
          </button>
        </>
      )}

      {state === "friends" && (
        <>
          <span className="text-sm font-semibold text-[var(--color-success)]">
            {t("Common.friends")}
          </span>

          <StartConversationButton userId={userId} />

          <button
            type="button"
            className={`${button} text-[var(--color-danger)]`}
            disabled={busy}
            onClick={() => void removeFriend()}
          >
            {t("Common.removeFriend")}
          </button>
        </>
      )}

      {state === "blocked_or_unavailable" && (
        <span className="text-sm text-[var(--color-text-muted)]">
          {t("Common.unavailable")}
        </span>
      )}

      {message && (
        <span role="status" aria-live="polite" className="sr-only">
          {message}
        </span>
      )}
    </div>
  );
}