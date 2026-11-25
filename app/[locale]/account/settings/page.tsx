import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireCountryUser } from "@/Lib/auth/server";
import { isLocale } from "@/i18n/locales";
import { getCountryName } from "@/Lib/countries";
import { Link } from "@/i18n/navigation";
import AccountNavigation from "@/components/account/AccountNavigation";
import BackButton from "@/components/navigation/BackButton";
import ProfileForm from "@/components/auth/ProfileForm";

export default async function AccountSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const { profile } = await requireCountryUser(locale, "/account/settings");
  const t = await getTranslations({ locale, namespace: "Country" });
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
    <AccountNavigation /><BackButton fallback="/account" />
    <div className="space-y-1">
      <h1 className="text-[28px] font-bold tracking-tight">{t("settingsTitle")}</h1>
      <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">{t("settingsSubtitle") ?? "Manage your profile and residence country."}</p>
    </div>
    <section className="space-y-5 rounded-[var(--radius-panel)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-bold">{t("residence")}</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{getCountryName(profile.country_code, locale) ? `${getCountryName(profile.country_code, locale)} · ${profile.country_code}` : t("legacyPrompt")}</p>
        </div>
        <Link href="/account/country-mountains" className="ui-pressable inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 text-sm font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]">{t("countryMountains")}</Link>
      </div>
      <div className="rounded-[var(--radius-card)] bg-[var(--color-surface-muted)]/60 p-4 sm:p-5">
        <ProfileForm mode="country" initialCountry={profile.country_code ?? ""} />
      </div>
    </section>
  </main>;
}
