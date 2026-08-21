import { CloudOff, CloudSun, ShieldAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { ProjectWeatherSummary as Summary } from "@/Lib/projects/types";
import type { Locale } from "@/i18n/locales";

export default async function ProjectWeatherSummary({ locale, summary }: { locale: Locale; summary: Summary }) {
  const t = await getTranslations({ locale, namespace: "Projects.Weather" });
  const entirelyOutside = summary.assignedDayCount > 0 && summary.outsideHorizonDayCount === summary.assignedDayCount;
  return <section aria-labelledby="project-weather-summary" className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-control)] sm:p-5">
    <div className="flex items-center gap-2"><CloudSun aria-hidden="true" className="text-[var(--color-forest)]" size={19} /><h2 id="project-weather-summary" className="text-lg font-bold">{t("weather")}</h2></div>
    {summary.assignedDayCount === 0 ? <p className="mt-3 text-sm leading-6 text-[var(--color-text-muted)]">{t("noMountainAssigned")}</p> : entirelyOutside ? <div className="mt-3 flex items-start gap-2"><CloudOff aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" size={17} /><p className="text-sm leading-6 text-[var(--color-text-muted)]">{t("forecastUnavailableYet")}</p></div> : summary.availableDayCount === 0 ? <div className="mt-3 flex items-start gap-2"><CloudOff aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" size={17} /><p className="text-sm leading-6 text-[var(--color-text-muted)]">{t("forecastUnavailable")}</p></div> : <dl className="mt-4 grid grid-cols-2 gap-3"><div><dt className="text-xs text-[var(--color-text-muted)]">{t("forecastDaysAvailable")}</dt><dd className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums">{summary.availableDayCount} / {summary.totalDayCount}</dd></div><div><dt className="text-xs text-[var(--color-text-muted)]">{t("mountainsWithForecast")}</dt><dd className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums">{summary.availableMountainCount}</dd></div></dl>}
    <div className="mt-4 flex items-start gap-2 border-t border-[var(--color-border-soft)] pt-3"><ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-warning)]" size={16} /><p className="text-xs leading-5 text-[var(--color-text-muted)]">{t("weatherDisclaimer")}</p></div>
  </section>;
}
