"use client";

import { Globe, Mountain } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { getCountryName } from "@/Lib/countries";
import type { CountryProgress } from "@/Lib/countryProgress";

export default function CountryProgressCard({ progress }: { progress: CountryProgress }) {
  const t = useTranslations("Country");
  const locale = useLocale();
  const format = useFormatter();
  const flag = (code: string | null) => {
    if (!code) return null;
    try { return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))); } catch { return null; }
  };
  if (!progress.countryCode) return <section className="rounded-[var(--radius-panel)] border border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] p-6 shadow-[var(--shadow-xs)]">
    <div className="flex gap-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--color-surface)] text-[var(--color-warning)] shadow-[var(--shadow-xs)]"><Globe size={20} /></span>
      <div>
        <h2 className="text-[16px] font-bold">{t("choose")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">{t("legacyPrompt")}</p>
        <Link href="/account/settings" className="ui-pressable mt-4 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-forest-hover)] active:translate-y-px active:scale-[0.98]">{t("choose")}</Link>
      </div>
    </div>
  </section>;
  return <section className="rounded-[var(--radius-panel)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-pine)]">{t("residence")}</p>
        <h2 className="mt-1 flex items-center gap-2 text-[22px] font-bold tracking-tight"><span aria-hidden="true" className="text-[22px]">{flag(progress.countryCode)}</span><span className="truncate">{getCountryName(progress.countryCode, locale)} <span className="font-normal text-[var(--color-text-muted)]">· {progress.countryCode}</span></span></h2>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("coverage").slice(0, 80)}…</p>
      </div>
      <Link href="/account/settings" className="ui-pressable inline-flex min-h-11 items-center text-sm font-semibold text-[var(--color-forest)] underline hover:text-[var(--color-forest-hover)]">{t("changeCountry")}</Link>
    </div>
    <div className="mt-6 rounded-[var(--radius-card)] bg-[var(--color-surface-muted)]/60 p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("progress")}</p>
      <p className="mt-2 text-[36px] font-bold leading-none tabular-nums tracking-tight">{format.number(progress.climbedMountains)} <span className="text-[18px] font-semibold text-[var(--color-text-muted)]">/ {format.number(progress.totalMountains)}</span> <span className="align-middle text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{t("climbed")}</span></p>
      {progress.progressPercent !== null ? <>
        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-border-soft)]" role="progressbar" aria-valuenow={progress.climbedMountains} aria-valuemin={0} aria-valuemax={progress.totalMountains} aria-label={t("progress")}>
          <div className="h-full rounded-full bg-[var(--color-forest)]" style={{ width: `${Math.min(100, progress.progressPercent)}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-semibold tabular-nums text-[var(--color-forest)]">{format.number(progress.progressPercent, { maximumFractionDigits: 2 })}%</span>
          <span className="text-[var(--color-text-muted)] tabular-nums">{t("remainingCount", { count: progress.remainingMountains })}</span>
        </div>
      </> : <p className="mt-4 text-sm text-[var(--color-text-muted)]">{t("catalogEmpty")}</p>}
    </div>
    <p className="mt-4 max-w-2xl text-xs leading-relaxed text-[var(--color-text-muted)]">{t("coverage")}</p>
    <Link href="/account/country-mountains" className="ui-pressable mt-4 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-forest-hover)] active:translate-y-px active:scale-[0.98]"><Mountain size={16} aria-hidden="true" />{t("countryMountains")}</Link>
  </section>;
}
