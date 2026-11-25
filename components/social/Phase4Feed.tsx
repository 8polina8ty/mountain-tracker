"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { listPhase4Posts, type FeedMode } from "@/Lib/socialFeed/phase4";
import type { SocialFeedPage } from "@/Lib/socialFeed/types";
import { Link } from "@/i18n/navigation";
import PostCard from "./feed/PostCard";

export default function Phase4Feed({ mode, userId, currentUserId, initial }: { mode: FeedMode; userId?: string; currentUserId: string | null; initial?: SocialFeedPage }) {
  const t = useTranslations("Social.Discover");
  const [page, setPage] = useState<SocialFeedPage>(initial ?? { posts: [], nextCursor: null });
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (initial) return;
    let active = true;
    void listPhase4Posts(createClient(), mode, { userId }).then(next => { if (active) setPage(next); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initial, mode, userId]);
  async function more() {
    if (loading) return;
    setLoading(true); setError(false);
    try { const next = await listPhase4Posts(createClient(), mode, { userId, cursor: page.nextCursor }); setPage(prev => ({ posts: [...prev.posts, ...next.posts], nextCursor: next.nextCursor })); }
    catch { setError(true); }
    finally { setLoading(false); }
  }
  return <div className="space-y-4">{page.posts.map(post => <PostCard key={post.id} post={post} currentUserId={currentUserId} onDeleted={() => setPage(prev => ({ ...prev, posts: prev.posts.filter(p => p.id !== post.id) }))} />)}{loading && <p role="status">{t("loading")}</p>}{error && <p role="alert">{t("error")}</p>}{!loading && !error && !page.posts.length && <p className="rounded-xl border border-dashed p-6">{t(mode === "following" ? "noFollowing" : "empty")} <Link href="/community/discover" className="underline">{t("exploreAuthors")}</Link></p>}{(page.nextCursor || error) && <button disabled={loading} className="min-h-11 rounded-full border px-5" onClick={() => void more()}>{t("more")}</button>}</div>;
}
