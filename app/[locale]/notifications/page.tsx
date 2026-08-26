import { getTranslations } from "next-intl/server";
import ProjectNotifications from "@/components/projects/ProjectNotifications";
import { requireProjectUser } from "@/Lib/projects/auth";
import { listProjectNotifications } from "@/Lib/projects/notifications";
import type { Locale } from "@/i18n/locales";
import { PageHero } from "@/components/ui-v2";

export default async function NotificationsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const { supabase } = await requireProjectUser(locale, "/notifications");
  const [t, page] = await Promise.all([
    getTranslations({ locale, namespace: "Notifications" }),
    listProjectNotifications(supabase),
  ]);

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-3xl space-y-10">
        <PageHero
          eyebrow={t("eyebrow") ?? "Notifications"}
          title={t("title") ?? "Project notifications"}
          subtitle={t("description") ?? "Activity and updates from your expedition projects."}
        />
        <ProjectNotifications initialPage={page} />
      </div>
    </main>
  );
}