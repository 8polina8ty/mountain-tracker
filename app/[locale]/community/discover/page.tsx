import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/Lib/supabase/server";
import { listPhase4Posts, parseDiscoverySearch, SOCIAL_UUID } from "@/Lib/socialFeed/phase4";
import { parsePublicExpeditionSearch, searchPublicExpeditions } from "@/Lib/projects/discovery";
import { Link } from "@/i18n/navigation";
import BlogCard from "@/components/social/blog/BlogCard";
import FollowButton from "@/components/social/FollowButton";
import PostCard from "@/components/social/feed/PostCard";
import CommunityBackButton from "@/components/social/CommunityBackButton";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params; const t = await getTranslations({ locale, namespace: "Social.Discover" });
  return { title: t("title"), description: t("description"), robots: { index: true, follow: true }, alternates: { canonical: `/${locale}/community/discover` } };
}
export default async function Discover({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const search = parseDiscoverySearch(raw);
  const one = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
  const section = ["blog", "activity", "authors", "expeditions"].includes(one("section")) ? one("section") : "";
  const supabase = await createClient();
  const [t, b, auth, blogs, activity, authors, expeditions] = await Promise.all([
    getTranslations("Social.Discover"), getTranslations("Social.Blog"), supabase.auth.getUser(),
    listPhase4Posts(supabase, "blog", { ...search, cursor: section === "blog" ? search.cursor : null }),
    listPhase4Posts(supabase, "activity", { ...search, cursor: section === "activity" ? search.cursor : null }),
    supabase.rpc("discover_social_authors", { search_text: search.q, cursor_name: section === "authors" && SOCIAL_UUID.test(one("author")) ? one("name").slice(0, 200) : null, cursor_user_id: section === "authors" && SOCIAL_UUID.test(one("author")) ? one("author") : null, result_limit: 21 }),
    searchPublicExpeditions(supabase, parsePublicExpeditionSearch({ q: search.q, cursor: section === "expeditions" ? one("cursor") : "", after: section === "expeditions" ? one("slug") : "" })),
  ]);
  if (authors.error) throw authors.error;
  const authorRows = (authors.data ?? []) as { user_id: string; username: string; display_name: string | null; sort_name: string; is_following: boolean }[];
  const href = (kind: string, extra: Record<string, string>) => `/community/discover?${new URLSearchParams({ q: search.q, sort: search.sort, section: kind, ...extra })}#${kind}`;
  return <main className="mx-auto max-w-7xl space-y-8 px-4 py-8"><CommunityBackButton /><header><h1 className="text-3xl font-bold">{t("title")}</h1><p className="mt-3">{t("description")}</p><nav className="mt-3 flex gap-5"><Link className="inline-flex min-h-11 items-center" href="/community">{t("community")}</Link><Link className="inline-flex min-h-11 items-center" href="/community/blog">{b("directory")}</Link></nav></header>
    <form className="flex flex-wrap gap-3"><input name="q" defaultValue={search.q} maxLength={80} placeholder={t("search")} aria-label={t("search")} className="ui-field min-h-11 flex-1 px-3" /><select name="sort" aria-label={t("sort")} defaultValue={search.sort} className="ui-field min-h-11 px-3"><option value="newest">{t("newest")}</option><option value="oldest">{t("oldest")}</option></select><button className="min-h-11 rounded-full border px-5">{t("search")}</button></form>
    <section id="blog" className="space-y-4"><h2 className="text-2xl font-bold">{b("latest")}</h2><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{blogs.posts.map(post => <BlogCard key={post.id} post={post} />)}</div>{!blogs.posts.length && <p>{b("empty")}</p>}{blogs.nextCursor && <Link className="inline-flex min-h-11 items-center" href={href("blog", { date: blogs.nextCursor.createdAt, after: blogs.nextCursor.postId })}>{t("more")}</Link>}</section>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><section id="activity" className="space-y-4"><h2 className="text-2xl font-bold">{t("activity")}</h2>{activity.posts.map(post => <PostCard key={post.id} post={post} currentUserId={auth.data.user?.id ?? null} />)}{!activity.posts.length && <p>{t("empty")}</p>}{activity.nextCursor && <Link className="inline-flex min-h-11 items-center" href={href("activity", { date: activity.nextCursor.createdAt, after: activity.nextCursor.postId })}>{t("more")}</Link>}</section>
    <section id="authors" className="space-y-4"><h2 className="text-2xl font-bold">{t("authors")}</h2><p className="text-sm">{t("nameSort")}</p>{authorRows.slice(0, 20).map(author => <article key={author.user_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-[var(--color-surface)] p-4"><Link className="inline-flex min-h-11 items-center break-words font-bold" href={`/users/${author.user_id}`}>{author.display_name ?? author.username}</Link><FollowButton userId={author.user_id} currentUserId={auth.data.user?.id ?? null} initialFollowing={author.is_following} /></article>)}{!authorRows.length && <p>{t("empty")}</p>}{authorRows.length > 20 && <Link className="inline-flex min-h-11 items-center" href={href("authors", { name: authorRows[19].sort_name, author: authorRows[19].user_id })}>{t("more")}</Link>}</section></div>
    <section id="expeditions" className="space-y-4"><h2 className="text-2xl font-bold">{t("expeditions")}</h2><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{expeditions.cards.map(card => <article key={card.slug} className="rounded-xl border bg-[var(--color-surface)] p-5"><Link className="inline-flex min-h-11 items-center text-lg font-bold" href={`/expeditions/${card.slug}`}>{card.name}</Link><p>{card.mountainNames.join(" · ")}</p></article>)}</div>{!expeditions.cards.length && <p>{t("empty")}</p>}{expeditions.next && <Link className="inline-flex min-h-11 items-center" href={href("expeditions", { cursor: String(expeditions.next.value), slug: expeditions.next.slug })}>{t("more")}</Link>}<Link className="inline-flex min-h-11 items-center" href="/explore">{t("exploreExpeditions")}</Link></section>
  </main>;
}
