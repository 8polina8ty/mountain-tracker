import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/Lib/supabase/server";
import { listPhase4Posts, parseDiscoverySearch } from "@/Lib/socialFeed/phase4";
import { Link } from "@/i18n/navigation";
import BlogCard from "@/components/social/blog/BlogCard";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Social.Blog" });
  return { title: t("directory"), description: t("description"), alternates: { canonical: `/${locale}/community/blog` }, robots: { index: true, follow: true }, openGraph: { title: t("directory"), description: t("description"), url: `/${locale}/community/blog`, images: [] } };
}
export default async function BlogDirectory({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = parseDiscoverySearch(await searchParams);
  const supabase = await createClient();
  const [t, d, page] = await Promise.all([getTranslations("Social.Blog"), getTranslations("Social.Discover"), listPhase4Posts(supabase, "blog", search)]);
  const query = page.nextCursor ? new URLSearchParams({ q: search.q, sort: search.sort, date: page.nextCursor.createdAt, after: page.nextCursor.postId }) : null;
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8"><div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-bold">{t("directory")}</h1><Link href="/community/blog/new" className="inline-flex min-h-11 items-center rounded-full border px-5">{t("write")}</Link></div><p>{t("description")}</p><nav className="flex flex-wrap gap-4"><Link className="inline-flex min-h-11 items-center" href="/community">{d("community")}</Link><Link className="inline-flex min-h-11 items-center" href="/community/discover">{d("title")}</Link></nav>
    <form className="flex flex-wrap gap-3"><input name="q" aria-label={d("search")} placeholder={d("search")} maxLength={80} defaultValue={search.q} className="ui-field min-h-11 flex-1 px-3" /><select name="sort" aria-label={d("sort")} defaultValue={search.sort} className="ui-field min-h-11 px-3"><option value="newest">{d("newest")}</option><option value="oldest">{d("oldest")}</option></select><button className="min-h-11 rounded-full border px-5">{d("search")}</button></form>
    <div className="grid gap-5 md:grid-cols-2">{page.posts.map(post => <BlogCard key={post.id} post={post} />)}</div>{!page.posts.length && <p>{t("empty")}</p>}{query && <Link className="inline-flex min-h-11 items-center rounded-full border px-5" href={`/community/blog?${query}`}>{d("more")}</Link>}
  </main>;
}
