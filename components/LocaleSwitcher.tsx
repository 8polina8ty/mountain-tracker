"use client";

import { useLocale, useTranslations } from "next-intl";
import type { ChangeEvent } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { locales, type Locale } from "@/i18n/locales";

const localeNames: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  ru: "Русский",
};

function getSafeSearch(): string {
  const searchParams = new URLSearchParams(window.location.search);
  const next = searchParams.get("next");

  if (next && (!next.startsWith("/") || next.startsWith("//"))) {
    searchParams.delete("next");
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export default function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("LocaleSwitcher");

  function handleLocaleChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextLocale = event.target.value as Locale;

    router.replace(`${pathname}${getSafeSearch()}`, { locale: nextLocale });
  }

  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">{t("language")}</span>
      <select
        value={locale}
        onChange={handleLocaleChange}
        aria-label={t("language")}
        className="ui-pressable h-10 min-w-0 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 text-sm font-semibold text-[var(--color-text-secondary)] outline-none hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] focus-visible:border-[var(--color-forest)]"
      >
        {locales.map((availableLocale) => (
          <option key={availableLocale} value={availableLocale}>
            {localeNames[availableLocale]}
          </option>
        ))}
      </select>
    </label>
  );
}
