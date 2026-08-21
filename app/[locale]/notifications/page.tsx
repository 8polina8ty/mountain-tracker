import { Bell } from "lucide-react";
import { getTranslations } from "next-intl/server";
import ProjectNotifications from "@/components/projects/ProjectNotifications";
import { requireProjectUser } from "@/Lib/projects/auth";
import { listProjectNotifications } from "@/Lib/projects/notifications";
import type { Locale } from "@/i18n/locales";
export default async function NotificationsPage({params}:{params:Promise<{locale:Locale}>}){const {locale}=await params;const {supabase}=await requireProjectUser(locale,"/notifications");const [t,page]=await Promise.all([getTranslations({locale,namespace:"Notifications"}),listProjectNotifications(supabase)]);return <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-9"><div className="mx-auto max-w-3xl"><header className="border-b border-[var(--color-border-strong)] pb-7"><p className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] text-[var(--color-forest)]"><Bell aria-hidden size={16}/>{t("eyebrow")}</p><h1 className="mt-2 text-4xl font-bold sm:text-5xl">{t("title")}</h1><p className="mt-3 text-[var(--color-text-muted)]">{t("description")}</p></header><ProjectNotifications initialPage={page}/></div></main>}
