import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { getPublicBlog } from "@/Lib/socialFeed/publicBlog";
import { createClient } from "@/Lib/supabase/server";
import { Link } from "@/i18n/navigation";
import FollowButton from "@/components/social/FollowButton";
import PostCard from "@/components/social/feed/PostCard";
import { ExpeditionAttachment } from "@/components/social/feed/ActivityAttachments";
import { BlogArticleGallery } from "@/components/social/blog/BlogMediaGallery";
import BackButton from "@/components/navigation/BackButton";

type Props = { params: Promise<{ locale: string; postId: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, postId } = await params;
  const post = await getPublicBlog(postId);
  if (!post) return { robots: { index: false, follow: false } };
  return { title: post.title, description: post.body.slice(0, 160), alternates: { canonical: `/${locale}/community/blog/${post.id}` }, robots: { index: true, follow: true }, openGraph: { type: "article", title: post.title ?? undefined, description: post.body.slice(0, 160), url: `/${locale}/community/blog/${post.id}`, publishedTime: post.publishedAt ?? undefined, modifiedTime: post.updatedAt, images: [] } };
}
export default async function BlogArticle({ params }: Props) {
  const { postId } = await params;
  const post = await getPublicBlog(postId);
  if (!post) notFound();
  const supabase = await createClient();
  const [t, format, auth, summary, tBlog] = await Promise.all([getTranslations("Social.Blog"), getFormatter(), supabase.auth.getUser(), supabase.rpc("get_social_follow_summary", { requested_user_id: post.author.userId }), getTranslations("Social.Blog")]);
  const user = auth.data.user;
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-8"><BackButton fallback="/community/blog" /><article className="space-y-6 rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 sm:p-8 shadow-sm">
    <header className="space-y-4"><h1 className="break-words text-3xl font-bold leading-tight sm:text-4xl">{post.title}</h1><div className="flex flex-wrap items-center gap-3"><Link href={`/users/${post.author.userId}`} className="ui-pressable inline-flex min-h-11 items-center rounded-full bg-[var(--color-surface-muted)] px-4 text-sm font-semibold ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-bg-secondary)]">{post.author.displayName ?? post.author.username}</Link><FollowButton userId={post.author.userId} currentUserId={user?.id ?? null} initialFollowing={summary.data?.isFollowing === true} /><time dateTime={post.publishedAt!} className="text-sm text-[var(--color-text-muted)]">{format.dateTime(new Date(post.publishedAt!), { dateStyle: "long" })}</time></div>{user?.id === post.author.userId && <Link href={`/community/blog/${post.id}/edit`} className="ui-pressable inline-flex min-h-10 items-center justify-center rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 text-sm font-semibold hover:bg-[var(--color-bg-secondary)] active:translate-y-[1px] active:scale-[0.98]">{t("edit")}</Link>}</header>
    <BlogArticleGallery media={post.media} postId={post.id} title={post.title ?? null} t={(k:string)=>tBlog(k as never) as string} />
    <p className="whitespace-pre-wrap break-words text-[15px] leading-7 sm:text-[16px] sm:leading-8">{post.body}</p>
    <div className="flex flex-wrap gap-2">
      {post.mountainAttachment && <Link href={`/mountain/${post.mountainAttachment.mountainId}`} className="ui-pressable inline-flex min-h-10 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 text-sm font-semibold hover:bg-[var(--color-bg-secondary)] active:translate-y-[1px] active:scale-[0.98]">{post.mountainAttachment.mountainName}</Link>}
      {post.expeditionAttachment?.available && <ExpeditionAttachment expedition={post.expeditionAttachment} />}
    </div>
  </article>{user ? <PostCard post={post} currentUserId={user.id} interactionsOnly /> : <Link href="/auth/login" className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[14px] bg-[var(--color-forest)] px-6 text-sm font-bold text-white shadow-sm hover:bg-[var(--color-forest-hover)] active:translate-y-[1px] active:scale-[0.98]">{t("login")}</Link>}</main>;
}
