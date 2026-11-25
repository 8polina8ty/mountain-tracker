import Image from "next/image";
import { getFormatter, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { SocialPost } from "@/Lib/socialFeed/types";

export default async function BlogCard({ post }: { post: SocialPost }) {
  const [t, format] = await Promise.all([getTranslations("Social.Blog"), getFormatter()]);
  const cover = post.media.find(m => m.position === 0);
  return <article className="overflow-hidden rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)]">
    {cover && <Image unoptimized src={`/api/social/posts/${post.id}/media/${cover.id}`} width={720} height={400} alt={post.title ?? t("cover")} className="aspect-[9/5] w-full object-cover" />}
    <div className="space-y-3 p-5"><h2 className="break-words text-2xl font-bold"><Link href={`/community/blog/${post.id}`}>{post.title}</Link></h2><p className="text-sm"><Link href={`/users/${post.author.userId}`}>{post.author.displayName ?? post.author.username}</Link> · <time dateTime={post.publishedAt ?? post.createdAt}>{format.dateTime(new Date(post.publishedAt ?? post.createdAt), { dateStyle: "medium" })}</time></p><p className="break-words text-[var(--color-text-muted)]">{post.body.slice(0, 240)}{post.body.length > 240 ? "…" : ""}</p><Link href={`/community/blog/${post.id}`} className="inline-flex min-h-11 items-center font-semibold">{t("open")}</Link></div>
  </article>;
}
