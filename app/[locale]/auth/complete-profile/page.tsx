import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadAuthProfile } from "@/Lib/auth/server";
import { needsProfileOnboarding, profileDestination } from "@/Lib/auth/profile";
import { safeAuthDestination } from "@/Lib/auth/redirects";
import { isValidUsername } from "@/Lib/username";
import { isLocale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import ProfileForm from "@/components/auth/ProfileForm";

export default async function CompleteProfilePage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ returnTo?: string; reason?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const returnTo = safeAuthDestination(query.returnTo, locale);
  const { user, profile, profileError } = await loadAuthProfile();
  if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (profile && !needsProfileOnboarding(profile)) redirect(profileDestination(profile, locale, returnTo));
  const t = await getTranslations({ locale, namespace: "Country" });
  const candidate: unknown = profile?.username ?? user.user_metadata?.username;
  const username = typeof candidate === "string" && isValidUsername(candidate) ? candidate.trim() : "";
  return <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 py-10 sm:px-8">
    <section className="w-full max-w-[480px] space-y-6 rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-pine)]">{t("almostReady") ?? "Almost ready"}</p>
        <h1 className="text-[28px] font-bold tracking-tight">{t("completeProfile")}</h1>
        <p className="text-[14px] leading-relaxed text-[var(--color-text-muted)]">{t("profileDescription")}</p>
        <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{t("countryHint") ?? "Your country determines your national ranking and country mountain progress. This is residence, not citizenship."}</p>
      </div>
      {profileError || !profile ? <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">{t("profileMissing")}</p> :
        <ProfileForm mode="onboarding" initialUsername={username} returnTo={returnTo}
          initialError={query.reason === "usernameUnavailable" ? "usernameUnavailable" : query.reason === "error" ? "error" : ""} />}
      <Link href="/map" className="ui-pressable inline-flex min-h-11 items-center text-sm font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-forest)] hover:underline">{t("backToMap")}</Link>
    </section>
  </main>;
}
