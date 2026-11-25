"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/Lib/supabase/client";
import type { SocialPost } from "@/Lib/socialFeed/types";
import PostCard from "./PostCard";
import { useTranslations } from "next-intl";
import { normalizeSocialPost } from "@/Lib/socialFeed/normalize";

export default function CommunityFeed({ currentUserId }: { currentUserId: string | null }) {
  const t = useTranslations("Social.Feed");
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; postId: string } | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  async function load(reset=false){
    const supabase=createClient();
    if(reset){ setPosts([]); setCursor(null); setHasMore(true); }
    const c = reset ? null : cursor;
    setLoading(true);
    setFailed(false);
    const { data, error } = await supabase.rpc("list_social_feed_phase4", { requested_mode: "all", cursor_created_at: c?.createdAt ?? null, cursor_post_id: c?.postId ?? null, result_limit: 21 });
    if(error){ setLoading(false); setFailed(true); return; }
    const rows=(data ?? []) as unknown[];
    const mapped = rows.slice(0,20).map(normalizeSocialPost).filter((p): p is SocialPost => p!==null);
    setPosts((prev)=> reset ? mapped : [...prev, ...mapped]);
    if(rows.length>20 && mapped.at(-1)){ setCursor({ createdAt: mapped.at(-1)!.createdAt, postId: mapped.at(-1)!.id }); } else setHasMore(false);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial feed load after mount
  useEffect(()=>{ void load(true); },[]);

  if(loading && posts.length===0) return <div className="space-y-3"><div className="h-32 animate-pulse rounded-[20px] bg-[var(--color-surface-muted)]" /></div>;
  if(failed) return <div role="alert"><p>{t("postFailed")}</p><button className="min-h-11 rounded-full border px-4" onClick={() => void load(posts.length === 0)}>{t("loadMore")}</button></div>;
  if(!loading && posts.length===0) return <div className="rounded-[20px] border border-dashed p-8 text-center text-[var(--color-text-muted)]">{t("noPosts")}</div>;
  return (
    <div className="space-y-4">
      {posts.map((p)=> <PostCard key={p.id} post={p} currentUserId={currentUserId} onDeleted={()=>setPosts((prev)=>prev.filter(x=>x.id!==p.id))} />)}
      {hasMore && <button onClick={()=>load()} disabled={loading} className="ui-pressable mx-auto flex min-h-11 items-center rounded-full border px-6 font-semibold">{t("loadMore")}</button>}
    </div>
  );
}
