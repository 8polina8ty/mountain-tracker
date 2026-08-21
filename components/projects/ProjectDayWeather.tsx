import { CloudOff, Droplets, Snowflake, Wind } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { matchProjectDayWeather } from "@/Lib/projects/weather";
import type { MountainId, ProjectDay } from "@/Lib/projects/types";
import type { SummitWeather } from "@/Lib/weather/types";
import { WEATHER_CONDITION_ICONS } from "@/components/weather/WeatherConditionIcon";
import type { Locale } from "@/i18n/locales";

export default async function ProjectDayWeather({ locale, day, weatherByMountain }: { locale: Locale; day: ProjectDay; weatherByMountain: ReadonlyMap<MountainId, SummitWeather | null> }) {
  if (day.mountains.length === 0) return null;
  const [t, mountainT, format] = await Promise.all([
    getTranslations({ locale, namespace: "Projects.Weather" }),
    getTranslations({ locale, namespace: "Mountain" }),
    getFormatter({ locale }),
  ]);

  return (
    <section className="mt-5 border-t border-[var(--color-border-soft)] pt-4" aria-labelledby={`day-weather-${day.id}`}>
      <h4 id={`day-weather-${day.id}`} className="[font-family:var(--font-technical)] text-sm font-bold uppercase tracking-[0.09em] text-[var(--color-text)]">{t("weatherForecast")}</h4>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {day.mountains.map((mountain) => {
          const weather = weatherByMountain.get(mountain.id) ?? null;
          const result = matchProjectDayWeather(day.date, weather);
          const name = mountain.nameDe ?? mountain.name ?? t("unnamedMountain");
          if (result.state !== "available" || !result.forecast) {
            return <article key={mountain.id} className="flex min-w-0 items-start gap-3 border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"><CloudOff aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" size={18} /><div className="min-w-0"><h5 className="break-words text-sm font-bold">{name}</h5><p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">{t(result.state === "outside-horizon" ? "forecastUnavailableYet" : "forecastUnavailable")}</p></div></article>;
          }
          const forecast = result.forecast;
          const ConditionIcon = WEATHER_CONDITION_ICONS[forecast.condition];
          return <article key={mountain.id} className="min-w-0 border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-control)]">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h5 className="break-words text-sm font-bold text-[var(--color-text)]">{name}</h5><p className="mt-0.5 [font-family:var(--font-technical)] text-xs font-semibold tabular-nums text-[var(--color-text-muted)]">{format.number(mountain.heightM)} {mountainT("Units.meter")}</p></div><ConditionIcon aria-hidden="true" className="shrink-0 text-[var(--color-forest)]" size={24} /></div>
            <p className="mt-3 text-sm font-semibold text-[var(--color-text-secondary)]">{mountainT(`Weather.conditions.${forecast.condition}`)}</p>
            <p className="mt-1 [font-family:var(--font-technical)] text-lg font-bold tabular-nums"><span className="text-[var(--color-text-muted)]"><span className="sr-only">{t("temperatureMin")}: </span>{format.number(forecast.temperatureMinC, { maximumFractionDigits: 0 })}{mountainT("Units.degree")}</span><span aria-hidden="true"> · </span><span><span className="sr-only">{t("temperatureMax")}: </span>{format.number(forecast.temperatureMaxC, { maximumFractionDigits: 0 })}{mountainT("Units.degree")}</span></p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {forecast.precipitationProbabilityMaxPct !== null && <WeatherValue icon={Droplets} label={t("precipitation")} value={`${format.number(forecast.precipitationProbabilityMaxPct, { maximumFractionDigits: 0 })}${mountainT("Units.percent")}`} />}
              {forecast.windSpeedMaxKmh !== null && <WeatherValue icon={Wind} label={t("wind")} value={`${format.number(forecast.windSpeedMaxKmh, { maximumFractionDigits: 0 })} ${mountainT("Units.speed")}`} />}
              {forecast.windGustsMaxKmh !== null && <WeatherValue icon={Wind} label={t("gusts")} value={`${format.number(forecast.windGustsMaxKmh, { maximumFractionDigits: 0 })} ${mountainT("Units.speed")}`} />}
              {forecast.snowfallSumCm !== null && forecast.snowfallSumCm > 0 && <WeatherValue icon={Snowflake} label={t("snowfall")} value={`${format.number(forecast.snowfallSumCm, { maximumFractionDigits: 1 })} ${mountainT("Units.centimeter")}`} />}
            </dl>
            {weather && <p className="mt-3 border-t border-[var(--color-border-soft)] pt-2 text-xs text-[var(--color-text-muted)]">{t("updatedForecast", { date: format.dateTime(new Date(weather.generatedAt), { dateStyle: "short", timeStyle: "short", timeZone: weather.timezone }) })}</p>}
          </article>;
        })}
      </div>
    </section>
  );
}

function WeatherValue({ icon: Icon, label, value }: { icon: typeof Wind; label: string; value: string }) {
  return <div className="min-w-0"><dt className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"><Icon aria-hidden="true" size={13} />{label}</dt><dd className="mt-0.5 break-words [font-family:var(--font-technical)] text-sm font-bold tabular-nums">{value}</dd></div>;
}
