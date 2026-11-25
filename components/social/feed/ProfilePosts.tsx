"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/Lib/supabase/client";
import type { SocialPost } from "@/Lib/socialFeed/types";
import PostCard from "./PostCard";
import { useTranslations } from "next-intl";
import { normalizeSocialPost } from "@/Lib/socialFeed/normalize";

export default function ProfilePosts({ userId, currentUserId }: { userId: string; currentUserId: string | null }) {
  const t = useTranslations("Social.Feed");
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<{ createdAt:string; postId:string }|null>(null);
  const [hasMore, setHasMore] = useState(true);
  async function load(reset=false){
    const supabase=createClient();
    if(reset){ setPosts([]); setCursor(null); setHasMore(true); }
    const c=reset?null:cursor;
    setLoading(true);
    const { data } = await supabase.rpc("list_social_feed_phase4",{ requested_mode: "profile", requested_user_id:userId, cursor_created_at: c?.createdAt ?? null, cursor_post_id: c?.postId ?? null, result_limit:21 });
    const rows=(data ?? []) as unknown[];
    const mapped=rows.slice(0,20).map(normalizeSocialPost).filter((p): p is SocialPost=>p!==null);
    setPosts((prev)=>reset?mapped:[...prev,...mapped]);
    if(rows.length>20 && mapped.at(-1)) setCursor({createdAt:mapped.at(-1)!.createdAt, postId:mapped.at(-1)!.id}); else setHasMore(false);
    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial profile posts load after mount
  useEffect(()=>{ void load(true); },[userId]);
  if(loading && posts.length===0) return <div className="h-24 animate-pulse rounded-[20px] bg-[var(--color-surface-muted)]" />;
  if(!loading && posts.length===0) return <p className="rounded-[20px] border border-dashed p-6 text-center text-sm text-[var(--color-text-muted)]">{t("noPosts")}</p>;
  return <div className="space-y-4">{posts.map((p)=><PostCard key={p.id} post={p} currentUserId={currentUserId} onDeleted={()=>setPosts(prev=>prev.filter(x=>x.id!==p.id))} />)}{hasMore && <button disabled={loading} onClick={()=>load()} className="ui-pressable mx-auto flex min-h-11 items-center rounded-full border px-6 font-semibold">{t("loadMore")}</button>}</div>;
}
