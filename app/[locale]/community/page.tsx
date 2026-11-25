import { redirect } from "next/navigation";
import { createClient } from "@/Lib/supabase/server";
import CommunityFeedClient from "@/components/social/feed/CommunityFeedClient";
import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function CommunityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Social.Discover" });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/community/discover`);
  return (
    <main className="min-h-[calc(100dvh-66px)] bg-[var(--color-bg)] px-4 py-6 lg:px-6">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[240px_minmax(0,680px)_280px]">
        <aside className="hidden lg:block">
          <nav className="sticky top-[72px] space-y-2 rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
            <Link href={`/users/${user.id}`} className="ui-pressable flex min-h-11 items-center rounded-full px-4 font-semibold hover:bg-[var(--color-surface-muted)]">{t("profile")}</Link>
            <Link href="/friends" className="ui-pressable flex min-h-11 items-center rounded-full px-4 font-semibold hover:bg-[var(--color-surface-muted)]">{t("friends")}</Link>
            <Link href="/messages" className="ui-pressable flex min-h-11 items-center rounded-full px-4 font-semibold hover:bg-[var(--color-surface-muted)]">{t("messages")}</Link>
          </nav>
        </aside>
        <section>
          <CommunityFeedClient currentUserId={user.id} />
        </section>
        <aside className="hidden lg:block">
          <div className="sticky top-[72px] rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
            <h2 className="font-bold">{t("community")}</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("description")}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
