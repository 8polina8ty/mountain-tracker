"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import SocialActions from "@/components/social/SocialActions";
import SocialUserRow from "@/components/social/SocialUserRow";
import { Link } from "@/i18n/navigation";
import {
  normalizeSocialUser,
  SOCIAL_SEARCH_MIN_LENGTH,
  type SocialUser,
} from "@/Lib/social";
import { createClient } from "@/Lib/supabase/client";

export default function FriendsClient() {
  const t = useTranslations("Social");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const searchGenerationRef = useRef(0);

  async function search(event: React.FormEvent) {
    event.preventDefault();

    const value = query.trim();

    if (value.length < SOCIAL_SEARCH_MIN_LENGTH) {
      setError(
        t("Search.minimum", {
          count: SOCIAL_SEARCH_MIN_LENGTH,
        })
      );
      return;
    }

    const generation = ++searchGenerationRef.current;

    setLoading(true);
    setError("");

    const response = await createClient().rpc("search_public_users", {
      search_text: value,
      result_limit: 20,
      cursor_username: null,
      cursor_user_id: null,
    });

    if (generation !== searchGenerationRef.current) {
      return;
    }

    setLoading(false);

    if (response.error) {
      setError(t("Errors.unavailable"));
      setResults([]);
      return;
    }

    const next = ((response.data ?? []) as unknown[])
      .map(normalizeSocialUser)
      .filter((row): row is SocialUser => row !== null);

    setResults(next);
  }

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:px-6 lg:py-8">
      <div className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
          {t("Friends.eyebrow")}
        </p>

        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-bold text-[var(--color-text)]">
              {t("Friends.title")}
            </h1>

            <p className="mt-2 text-[var(--color-text-muted)]">
              {t("Friends.description")}
            </p>
          </div>

          <nav
            className="flex gap-2"
            aria-label={t("Accessibility.sections")}
          >
            <Link
              className="ui-pressable min-h-11 px-3 py-2 font-semibold text-[var(--color-forest)]"
              href="/friends/requests"
            >
              {t("Requests.title")}
            </Link>

            <Link
              className="ui-pressable min-h-11 px-3 py-2 font-semibold text-[var(--color-text-secondary)]"
              href="/friends/blocked"
            >
              {t("Blocking.title")}
            </Link>
          </nav>
        </div>

        <section
          className="mt-8 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5"
          aria-labelledby="social-search-title"
        >
          <h2
            id="social-search-title"
            className="text-xl font-bold"
          >
            {t("Search.title")}
          </h2>

          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={search}
          >
            <label
              className="sr-only"
              htmlFor="user-search"
            >
              {t("Search.label")}
            </label>

            <div className="relative flex-1">
              <Search
                aria-hidden="true"
                className="absolute left-3 top-3 h-5 w-5 text-[var(--color-text-muted)]"
              />

              <input
                id="user-search"
                className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] pl-10 pr-3"
                value={query}
                maxLength={80}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setError("");
                }}
                placeholder={t("Search.placeholder")}
              />
            </div>

            <button
              type="submit"
              className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
            >
              {loading
                ? t("Common.loading")
                : t("Search.submit")}
            </button>
          </form>

          {error && (
            <p
              role="alert"
              className="mt-3 text-sm text-[var(--color-danger)]"
            >
              {error}
            </p>
          )}

          <ul className="mt-4">
            {results.map((user) => (
              <SocialUserRow
                key={user.userId}
                {...user}
                action={
                  <SocialActions
                    userId={user.userId}
                    requestId={user.requestId ?? undefined}
                    initialState={user.relationshipState}
                  />
                }
              />
            ))}
          </ul>
        </section>

        <FriendsList />
      </div>
    </main>
  );
}

function FriendsList() {
  const t = useTranslations("Social");

  const [rows, setRows] = useState<SocialUser[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadGenerationRef = useRef(0);

  async function load() {
    if (loading) {
      return;
    }

    const generation = ++loadGenerationRef.current;

    setLoading(true);
    setError("");

    const response = await createClient().rpc("list_friends", {
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
      setRows([]);
      return;
    }

    const next = ((response.data ?? []) as unknown[])
      .map(normalizeSocialUser)
      .filter((row): row is SocialUser => row !== null);

    setRows(next);
  }

  return (
    <section className="mt-8 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold">
          {t("Friends.accepted")}
        </h2>

        <button
          type="button"
          className="ui-pressable min-h-11 px-3 text-sm font-semibold text-[var(--color-forest)] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading
            ? t("Common.loading")
            : rows === null
              ? t("Common.load")
              : t("Common.refresh")}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      {rows &&
        (rows.length > 0 ? (
          <ul>
            {rows.map((user) => (
              <SocialUserRow
                key={user.userId}
                {...user}
                action={
                  <SocialActions
                    userId={user.userId}
                    initialState="friends"
                    onChanged={() => {
                      void load();
                    }}
                  />
                }
              />
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]">
            {t("Friends.empty")}
          </p>
        ))}
    </section>
  );
}