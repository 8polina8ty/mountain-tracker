"use client";
import Image from "next/image";
import { Heart, MessageCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import type { SocialPost } from "@/Lib/socialFeed/types";
import { createClient } from "@/Lib/supabase/client";
import { likePost, unlikePost } from "@/Lib/socialFeed/mutations";
import PostComments from "./PostComments";
import { AscentAttachment, AchievementAttachment, ExpeditionAttachment } from "./ActivityAttachments";

export default function PostCard({ post, currentUserId, onDeleted, interactionsOnly = false }: { post: SocialPost; currentUserId: string | null; onDeleted?: () => void; interactionsOnly?: boolean }) {
  const t = useTranslations("Social.Feed");
  const b = useTranslations("Social.Blog");
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState(false);
  const [liked, setLiked] = useState(post.viewerLiked);
  const [count, setCount] = useState(post.likeCount);
  const [busy, setBusy] = useState(false);
  async function toggleLike() {
    if (!currentUserId || busy) return;
    setError(false);
    setBusy(true);
    const supabase = createClient();
    try {
      if (liked) { await unlikePost(supabase, post.id); setLiked(false); setCount((c)=>Math.max(0,c-1)); }
      else { await likePost(supabase, post.id); setLiked(true); setCount((c)=>c+1); }
    } catch { setError(true); }
    setBusy(false);
  }
  async function handleDelete() {
    if (!confirm(b("deleteConfirm"))) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("delete_social_post", { requested_post_id: post.id });
    if (!error) { onDeleted?.(); router.refresh(); }
    else setError(true);
  }
  return (
    <article className="overflow-hidden rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
      {!interactionsOnly && <><header className="flex items-center gap-3 p-4">
        <div className="h-10 w-10 overflow-hidden rounded-full bg-[var(--color-surface-muted)] flex items-center justify-center font-bold text-[var(--color-forest)]">
          {post.author.avatarUrl ? <Image src={post.author.avatarUrl} alt={post.author.username} width={40} height={40} className="h-full w-full object-cover" /> : post.author.username.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <Link href={`/users/${post.author.userId}`} className="inline-flex min-h-11 items-center truncate text-sm font-bold">{post.author.username}</Link>
          <p className="text-xs text-[var(--color-text-muted)]"><Link href={post.postType === "blog" ? `/community/blog/${post.id}${post.publishedAt ? "" : "/edit"}` : `/community/posts/${post.id}`} className="inline-flex min-h-11 items-center">{format.dateTime(new Date(post.createdAt), { dateStyle: "medium" })}</Link> · {t(post.visibility)}</p>
        </div>
        {post.author.userId === currentUserId && <button onClick={handleDelete} aria-label={t("deletePost")} className="ui-pressable flex h-11 w-11 items-center justify-center rounded-full hover:bg-[var(--color-surface-muted)]"><Trash2 size={16} /></button>}
      </header>
      {post.postType === "blog" && <div className="px-4 pb-3"><Link className="inline-flex min-h-11 items-center text-xl font-bold" href={post.publishedAt ? `/community/blog/${post.id}` : `/community/blog/${post.id}/edit`}>{post.title ?? b("open")}</Link>{post.author.userId === currentUserId && <Link className="ml-3 inline-flex min-h-11 items-center underline" href={`/community/blog/${post.id}/edit`}>{b("edit")}</Link>}</div>}
      {post.body && <p className="whitespace-pre-wrap break-words px-4 pb-3 text-sm leading-6">{post.postType === "blog" ? post.body.slice(0, 320) : post.body}</p>}
      {post.postType === "ascent" && (
        <div className="px-4 pb-3">
          <AscentAttachment ascent={post.ascentAttachment ?? null} />
        </div>
      )}
      {post.postType === "achievement" && (
        <div className="px-4 pb-3">
          <AchievementAttachment achievement={post.achievementAttachment ?? null} />
        </div>
      )}
      {post.postType === "expedition" && (
        <div className="px-4 pb-3">
          <ExpeditionAttachment expedition={post.expeditionAttachment ?? null} />
        </div>
      )}
      {post.media.length > 0 && (
        <div className={`grid gap-1 ${post.media.length===1 ? "grid-cols-1" : post.media.length===2 ? "grid-cols-2" : post.media.length===3 ? "grid-cols-2" : "grid-cols-2"}`}>
          {post.media.slice(0,4).map((m,i)=> (
            <div key={m.id} className="relative aspect-[4/3] overflow-hidden bg-[var(--color-surface-muted)]">
              <Image src={`/api/social/posts/${post.id}/media/${m.id}`} alt={t("photoOfPost")} fill unoptimized className="object-cover" />
              {i===3 && post.media.length>4 && <div className="absolute inset-0 grid place-items-center bg-black/50 text-white font-bold text-lg">+{post.media.length-4}</div>}
            </div>
          ))}
        </div>
      )}
      </>}
      {error && <p role="alert" className="p-4 text-[var(--color-danger)]">{t("postFailed")}</p>}
      <div className="flex items-center gap-4 border-t border-[var(--color-border-soft)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
        <span>{count} {t("likes")}</span><span>{post.commentCount} {t("comments")}</span>
      </div>
      <div className="flex border-t border-[var(--color-border-soft)]">
        <button onClick={toggleLike} disabled={!currentUserId || busy} aria-pressed={liked} aria-label={liked ? t("unlikePost") : t("likePost")} className="ui-pressable flex min-h-11 flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold hover:bg-[var(--color-surface-muted)] disabled:opacity-50"><Heart size={16} className={liked ? "fill-[var(--color-danger)] text-[var(--color-danger)]" : ""} />{liked ? t("unlike") : t("like")}</button>
        <a href={`#comments-${post.id}`} className="ui-pressable flex min-h-11 flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold hover:bg-[var(--color-surface-muted)]"><MessageCircle size={16} />{t("comment")}</a>
      </div>
      <div id={`comments-${post.id}`}><PostComments postId={post.id} currentUserId={currentUserId} postAuthorId={post.author.userId} /></div>
    </article>
  );
}
