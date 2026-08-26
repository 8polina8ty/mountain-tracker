"use client";

import { Search, UserPlus, MessageSquare, UserCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import SocialActions from "@/components/social/SocialActions";
import type { RelationshipState } from "@/Lib/social";
import { Avatar, PageHero, SectionHeading, StatusPill, SecondaryButton } from "@/components/ui-v2";

export default function FriendsClient() {
  const searchParams = useSearchParams();
  const t = useTranslations("Friends");

  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") ?? "");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; username: string; avatar_url: string | null; relationship: RelationshipState; request_id?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [friends, setFriends] = useState<Array<{ id: string; username: string; avatar_url: string | null }>>([]);
  const [pendingRequests, setPendingRequests] = useState<Array<{ id: string; requester_id: string; requester_username: string; requester_avatar_url: string | null }>>([]);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const supabase = createClient();

  const loadFriends = useCallback(async () => {
    setLoadingFriends(true);
    try {
      const { data, error } = await supabase.rpc("list_friends");
      if (error) throw error;
      setFriends(data ?? []);
    } catch (err) {
      console.error(err);
      setErrorMessage(t("Errors.loadFriendsFailed"));
    } finally {
      setLoadingFriends(false);
    }
  }, [supabase, t]);

  const loadPendingRequests = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("list_incoming_friend_requests");
      if (error) throw error;
      setPendingRequests(data ?? []);
    } catch (err) {
      console.error(err);
      setErrorMessage(t("Errors.loadRequestsFailed"));
    }
  }, [supabase, t]);

  useEffect(() => {
    // Use setTimeout to avoid synchronous state updates in effect
    const timer = setTimeout(() => {
      loadFriends();
      loadPendingRequests();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadFriends, loadPendingRequests]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.rpc("search_public_users", {
        search_query: query,
        result_limit: 10,
      });
      if (error) throw error;
      setSearchResults(data ?? []);
    } catch (err) {
      console.error(err);
      setErrorMessage(t("Errors.searchFailed"));
    } finally {
      setSearching(false);
    }
  }, [supabase, t]);

  useEffect(() => {
    const timeout = setTimeout(() => handleSearch(searchQuery), 250);
    return () => clearTimeout(timeout);
  }, [searchQuery, handleSearch]);

  const handleFriendAction = useCallback(() => {
    loadFriends();
    loadPendingRequests();
  }, [loadFriends, loadPendingRequests]);

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl space-y-10">
        {/* Page Hero */}
        <PageHero
          eyebrow={t("eyebrow") ?? "Community"}
          title={t("title") ?? "Friends"}
          subtitle={t("description") ?? "Connect with fellow alpinists and share your expeditions."}
        />

        {/* Search Section */}
        <section>
          <SectionHeading
            eyebrow={t("Search.eyebrow") ?? "Discover"}
            title={t("Search.title") ?? "Find alpinists"}
          />
          <div className="mt-6">
            <div className="relative max-w-md">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--color-text-muted)]" strokeWidth={2} />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("Search.placeholder") ?? "Search by username..."}
                className="ui-field w-full pl-11 pr-4"
                aria-label={t("Search.placeholder") ?? "Search by username"}
              />
            </div>

            {searching && (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]" role="status">
                {t("Search.searching") ?? "Searching…"}
              </p>
            )}

            {searchResults.length > 0 && (
              <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] overflow-hidden">
                {searchResults.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center justify-between gap-4 border-b border-[var(--color-border-soft)] p-4 last:border-0 hover:bg-[var(--color-surface-muted)]"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <Avatar initials={user.username.charAt(0).toUpperCase()} size="md" src={user.avatar_url ?? undefined} />
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{user.username}</p>
                        <p className="technical text-[12px] text-[var(--color-text-muted)]">
                          {user.relationship === "friends" && t("Search.alreadyFriends")}
                          {user.relationship === "outgoing_pending" && t("Search.requestSent")}
                          {user.relationship === "incoming_pending" && t("Search.pendingRequest")}
                        </p>
                      </div>
                    </div>
                    <SocialActions
                      userId={user.id}
                      initialState={user.relationship}
                      requestId={user.request_id}
                      onChanged={handleFriendAction}
                    />
                  </div>
                ))}
              </div>
            )}

            {searchQuery && !searching && searchResults.length === 0 && (
              <div className="mt-4 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center">
                <UserPlus className="mx-auto h-12 w-12 text-[var(--color-text-muted)]" strokeWidth={1.5} />
                <p className="mt-4 text-[var(--color-text-secondary)]">
                  {t("Search.noResults") ?? "No users found matching"} <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
                </p>
              </div>
            )}

            {errorMessage && (
              <div className="mt-4 rounded-[var(--radius-card)] border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-[var(--color-danger)] text-sm" role="alert">
                {errorMessage}
              </div>
            )}
          </div>
        </section>

        {/* Friend Requests */}
        {pendingRequests.length > 0 && (
          <section>
            <SectionHeading
              eyebrow={t("Requests.eyebrow") ?? "Incoming"}
              title={t("Requests.title") ?? "Friend requests"}
            />
            <div className="mt-6 space-y-3">
              {pendingRequests.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <Avatar initials={req.requester_username.charAt(0).toUpperCase()} size="md" src={req.requester_avatar_url ?? undefined} />
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{req.requester_username}</p>
                      <p className="technical text-[12px] text-[var(--color-text-muted)]">
                        {t("Requests.wantsToConnect") ?? "Wants to connect"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusPill tone="info" size="small">
                      {t("Requests.pending") ?? "Pending"}
                    </StatusPill>
                    <SocialActions
                      userId={req.requester_id}
                      initialState="incoming_pending"
                      requestId={req.id}
                      onChanged={handleFriendAction}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Friends List */}
        <section>
          <SectionHeading
            eyebrow={t("List.eyebrow") ?? "Network"}
            title={t("List.title") ?? "Your friends"}
            description={friends.length === 0 ? t("List.emptyDescription") ?? "Start searching to add friends" : undefined}
          />
          <div className="mt-6">
            {loadingFriends ? (
              <div className="space-y-3" aria-busy="true">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="flex items-center gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 animate-pulse">
                    <div className="h-11 w-11 rounded-full bg-[var(--color-surface-muted)]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/12 bg-[var(--color-surface-muted)] rounded" />
                      <div className="h-3 w-2/12 bg-[var(--color-surface-muted)] rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : friends.length === 0 ? (
              <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-10 text-center">
                <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-pine)]">
                  <UserCheck size={28} strokeWidth={1.5} />
                </div>
                <h3 className="mt-5 text-[20px] font-bold">{t("List.emptyTitle") ?? "No friends yet"}</h3>
                <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                  {t("List.emptyDescription") ?? "Search for alpinists above to build your network."}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {friends.map((friend) => (
                  <article
                    key={friend.id}
                    className="ui-pressable group flex items-center gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)]"
                  >
                    <Avatar initials={friend.username.charAt(0).toUpperCase()} size="lg" src={friend.avatar_url ?? undefined} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold truncate">{friend.username}</p>
                      <p className="technical text-[12px] text-[var(--color-text-muted)]">
                        {t("List.friendSince") ?? "Friend"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusPill tone="success" size="small">
                        <UserCheck size={10} className="mr-1" />
                        {t("Common.friends") ?? "Friends"}
                      </StatusPill>
                      <a href={`/messages?user=${friend.id}`}>
                        <SecondaryButton size="small" icon={MessageSquare}>{t("List.message") ?? "Message"}</SecondaryButton>
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}