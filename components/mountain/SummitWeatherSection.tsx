import type { LucideIcon } from "lucide-react";
import {
  Clock3,
  Cloud,
  CloudOff,
  Droplets,
  Eye,
  MountainSnow,
  ShieldAlert,
  Snowflake,
  Sunrise,
  Sunset,
  Wind,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/locales";
import { zonedTimeToUtc } from "@/Lib/weather/summitWeather";
import type { SummitWeather, WeatherCondition } from "@/Lib/weather/types";
import { WEATHER_CONDITION_ICONS } from "@/components/weather/WeatherConditionIcon";

const HOURLY_WINDOW_HOURS = 24;

type StatRowProps = {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
};

function StatRow({ icon: Icon, label, value, sub }: StatRowProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="flex items-center gap-1.5 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {label}
      </dt>
      <dd className="min-w-0 break-words [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
        {value}
        {sub && (
          <span className="block text-xs font-semibold text-[var(--color-text-muted)]">
            {sub}
          </span>
        )}
      </dd>
    </div>
  );
}

export default async function SummitWeatherSection({
  locale,
  weather,
}: {
  locale: Locale;
  weather: SummitWeather | null;
}) {
  const t = await getTranslations({ locale, namespace: "Mountain" });
  const format = await getFormatter({ locale });

  if (!weather) {
    return (
      <section aria-labelledby="summit-weather-title">
        <div className="border-b border-[var(--color-border-strong)] pb-5">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("Weather.sectionLabel")}
          </p>
          <h2
            id="summit-weather-title"
            className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
          >
            {t("Weather.title")}
          </h2>
        </div>

        <div className="mt-6 flex items-start gap-3 border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-4 sm:px-5">
          <CloudOff
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--color-text-muted)]"
            size={20}
          />
          <div>
            <h3 className="font-bold text-[var(--color-text)]">
              {t("Weather.unavailableTitle")}
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              {t("Weather.unavailableDescription")}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const conditionLabel = (condition: WeatherCondition) =>
    t(`Weather.conditions.${condition}`);
  const noData = t("Status.noData");
  const CurrentConditionIcon =
    WEATHER_CONDITION_ICONS[weather.current.condition];

  return (
    <section aria-labelledby="summit-weather-title">
      <div className="border-b border-[var(--color-border-strong)] pb-5">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
          {t("Weather.sectionLabel")}
        </p>
        <h2
          id="summit-weather-title"
          className="mt-2 text-3xl font-bold text-[var(--color-text)] sm:text-4xl"
        >
          {t("Weather.title")}
        </h2>
        <p className="mt-3 max-w-2xl text-[var(--color-text-secondary)]">
          {t("Weather.subtitle", {
            elevation: format.number(weather.elevationM),
          })}
        </p>
      </div>

      <div className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-8 p-5 sm:p-6 xl:flex-row xl:items-stretch xl:justify-between xl:gap-10">
          <div className="flex min-w-0 items-center gap-5">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[var(--radius-panel)] bg-[var(--color-surface-muted)] text-[var(--color-forest)]">
              <CurrentConditionIcon
                aria-hidden="true"
                className="h-8 w-8"
              />
            </span>

            <div className="min-w-0">
              <p className="text-xl font-bold text-[var(--color-text)]">
                {conditionLabel(weather.current.condition)}
              </p>
              <p className="mt-1 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                {t("Weather.temperature")}
              </p>
              <p className="mt-1 [font-family:var(--font-technical)] text-[clamp(2.5rem,6vw,3.5rem)] font-bold leading-none tabular-nums text-[var(--color-text)]">
                {format.number(weather.current.temperatureC, {
                  maximumFractionDigits: 0,
                })}
                <span className="ml-1 text-[0.45em] font-semibold text-[var(--color-text-subtle)]">
                  {t("Units.degree")}
                </span>
              </p>
              <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                {t("Weather.feelsLike")}:{" "}
                {format.number(weather.current.apparentTemperatureC, {
                  maximumFractionDigits: 0,
                })}{" "}
                {t("Units.degree")}
              </p>
            </div>
          </div>

          <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:max-w-xl xl:grid-cols-2 2xl:grid-cols-3">
            <StatRow
              icon={Wind}
              label={t("Weather.wind")}
              value={
                weather.current.windSpeedKmh !== null
                  ? `${format.number(weather.current.windSpeedKmh, { maximumFractionDigits: 0 })} ${t("Units.speed")}`
                  : noData
              }
              sub={
                weather.current.windDirectionDeg !== null
                  ? `${t("Weather.windDirection")}: ${format.number(weather.current.windDirectionDeg, { maximumFractionDigits: 0 })}°`
                  : undefined
              }
            />
            <StatRow
              icon={Wind}
              label={t("Weather.gusts")}
              value={
                weather.current.windGustsKmh !== null
                  ? `${format.number(weather.current.windGustsKmh, { maximumFractionDigits: 0 })} ${t("Units.speed")}`
                  : noData
              }
            />
            <StatRow
              icon={Droplets}
              label={t("Weather.precipitation")}
              value={
                weather.current.precipitationMm !== null
                  ? `${format.number(weather.current.precipitationMm, { maximumFractionDigits: 1 })} ${t("Units.precipitation")}`
                  : noData
              }
            />
            <StatRow
              icon={Snowflake}
              label={t("Weather.snowfall")}
              value={
                weather.current.snowfallCm !== null
                  ? `${format.number(weather.current.snowfallCm, { maximumFractionDigits: 1 })} ${t("Units.centimeter")}`
                  : noData
              }
            />
            <StatRow
              icon={Cloud}
              label={t("Weather.cloudCover")}
              value={
                weather.current.cloudCoverPct !== null
                  ? `${format.number(weather.current.cloudCoverPct, { maximumFractionDigits: 0 })}${t("Units.percent")}`
                  : noData
              }
            />
            <StatRow
              icon={Eye}
              label={t("Weather.visibility")}
              value={
                weather.current.visibilityKm !== null
                  ? `${format.number(weather.current.visibilityKm, { maximumFractionDigits: 0 })} ${t("Units.kilometer")}`
                  : noData
              }
            />
            <StatRow
              icon={MountainSnow}
              label={t("Weather.freezingLevel")}
              value={
                weather.current.freezingLevelM !== null
                  ? `${format.number(weather.current.freezingLevelM, { maximumFractionDigits: 0 })} ${t("Units.meter")}`
                  : noData
              }
            />
            <StatRow
              icon={Clock3}
              label={t("Weather.updated")}
              value={format.dateTime(new Date(weather.generatedAt), {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: weather.timezone,
              })}
            />
          </dl>
        </div>
      </div>

      {weather.hourly.length > 0 && (
        <div className="mt-8">
          <h3 className="text-2xl font-bold text-[var(--color-text)]">
            {t("Weather.hourlyForecast")}
          </h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {t("Weather.hourlyRange", {
              count: Math.min(weather.hourly.length, HOURLY_WINDOW_HOURS),
            })}
          </p>

          <div
            role="region"
            aria-label={t("Weather.hourlyForecast")}
            tabIndex={0}
            className="mt-4 -mx-1 overflow-x-auto px-1 pb-2"
          >
            <ol className="flex snap-x snap-mandatory gap-2">
              {weather.hourly.slice(0, HOURLY_WINDOW_HOURS).map((hour) => {
                const HourIcon = WEATHER_CONDITION_ICONS[hour.condition];

                return (
                  <li
                    key={hour.time}
                    className="w-[82px] shrink-0 snap-start scroll-mb-2 border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-2 py-3 text-center"
                  >
                    <time
                      dateTime={hour.time}
                      className="block [font-family:var(--font-technical)] text-[var(--font-size-caption)] font-bold tabular-nums text-[var(--color-text-muted)]"
                    >
                      {format.dateTime(new Date(hour.time), {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: weather.timezone,
                      })}
                    </time>
                    <HourIcon
                      aria-hidden="true"
                      className="mx-auto mt-2.5 h-5 w-5 text-[var(--color-forest)]"
                    />
                    <p className="mt-1.5 truncate text-xs text-[var(--color-text-muted)]">
                      {conditionLabel(hour.condition)}
                    </p>
                    <p className="mt-1.5 [font-family:var(--font-technical)] text-base font-bold tabular-nums text-[var(--color-text)]">
                      {format.number(hour.temperatureC, {
                        maximumFractionDigits: 0,
                      })}
                      <span className="ml-0.5 text-[0.7em] font-semibold text-[var(--color-text-subtle)]">
                        {t("Units.degree")}
                      </span>
                    </p>
                    {hour.precipitationProbabilityPct !== null && (
                      <p className="mt-1 flex items-center justify-center gap-0.5 text-[var(--font-size-caption)] font-semibold tabular-nums text-[var(--color-glacier)]">
                        <Droplets aria-hidden="true" className="h-3 w-3" />
                        {format.number(
                          hour.precipitationProbabilityPct,
                          { maximumFractionDigits: 0 },
                        )}
                        {t("Units.percent")}
                      </p>
                    )}
                    {hour.windGustsKmh !== null && (
                      <p className="mt-1 flex items-center justify-center gap-0.5 text-[var(--font-size-caption)] font-semibold tabular-nums text-[var(--color-text-muted)]">
                        <Wind aria-hidden="true" className="h-3 w-3" />
                        {format.number(hour.windGustsKmh, {
                          maximumFractionDigits: 0,
                        })}
                        <span className="sr-only">{t("Units.speed")}</span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}

      {weather.daily.length > 0 && (
        <div className="mt-10">
          <h3 className="text-2xl font-bold text-[var(--color-text)]">
            {t("Weather.dailyForecast")}
          </h3>

          <div className="mt-4 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {weather.daily.map((day) => {
              const anchorIso =
                zonedTimeToUtc(`${day.date}T12:00`, weather.timezone) ??
                `${day.date}T00:00:00Z`;
              const anchor = new Date(anchorIso);
              const DayIcon = WEATHER_CONDITION_ICONS[day.condition];
              const showPrecipitationProbability =
                day.precipitationProbabilityMaxPct !== null;
              const showPrecipitationSum =
                day.precipitationSumMm !== null;
              const showSnowfallSum =
                day.snowfallSumCm !== null && day.snowfallSumCm > 0;

              return (
                <article
                  key={day.date}
                  className="bg-[var(--color-surface)] p-4"
                >
                  <p className="text-xs font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                    {format.dateTime(anchor, {
                      weekday: "short",
                      timeZone: weather.timezone,
                    })}
                    <span className="ml-2 normal-case">
                      {format.dateTime(anchor, {
                        day: "numeric",
                        month: "short",
                        timeZone: weather.timezone,
                      })}
                    </span>
                  </p>

                  <div className="mt-3 flex items-center gap-2.5">
                    <DayIcon
                      aria-hidden="true"
                      className="h-6 w-6 shrink-0 text-[var(--color-forest)]"
                    />
                    <p className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">
                      {conditionLabel(day.condition)}
                    </p>
                  </div>

                  <p className="mt-3 flex items-baseline gap-2 [font-family:var(--font-technical)] text-base font-bold tabular-nums text-[var(--color-text)]">
                    <span className="text-[var(--color-text-muted)]">
                      {t("Weather.temperatureMin")}{" "}
                      {format.number(day.temperatureMinC, {
                        maximumFractionDigits: 0,
                      })}
                      {t("Units.degree")}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {t("Weather.temperatureMax")}{" "}
                      {format.number(day.temperatureMaxC, {
                        maximumFractionDigits: 0,
                      })}
                      {t("Units.degree")}
                    </span>
                  </p>

                  <dl className="mt-3 space-y-1.5 text-[var(--font-size-caption)] text-[var(--color-text-secondary)]">
                    {showPrecipitationProbability && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[var(--color-text-muted)]">
                          {t("Weather.precipitation")}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          {format.number(
                            day.precipitationProbabilityMaxPct as number,
                            { maximumFractionDigits: 0 },
                          )}
                          {t("Units.percent")}
                        </dd>
                      </div>
                    )}
                    {showPrecipitationSum && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[var(--color-text-muted)]">
                          {t("Weather.precipitationSum")}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          {format.number(day.precipitationSumMm as number, {
                            maximumFractionDigits: 1,
                          })}{" "}
                          {t("Units.precipitation")}
                        </dd>
                      </div>
                    )}
                    {showSnowfallSum && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[var(--color-text-muted)]">
                          {t("Weather.snowfall")}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          {format.number(day.snowfallSumCm as number, {
                            maximumFractionDigits: 1,
                          })}{" "}
                          {t("Units.centimeter")}
                        </dd>
                      </div>
                    )}
                    {day.windGustsMaxKmh !== null && (
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[var(--color-text-muted)]">
                          {t("Weather.gusts")}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          {format.number(day.windGustsMaxKmh, {
                            maximumFractionDigits: 0,
                          })}{" "}
                          {t("Units.speed")}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {(day.sunriseUtc || day.sunsetUtc) && (
                    <p className="mt-3 flex items-center gap-3 border-t border-[var(--color-border-soft)] pt-2.5 text-[var(--font-size-caption)] font-semibold tabular-nums text-[var(--color-text-muted)]">
                      {day.sunriseUtc && (
                        <span className="flex items-center gap-1">
                          <Sunrise aria-hidden="true" className="h-3.5 w-3.5" />
                          <span className="sr-only">
                            {t("Weather.sunrise")}
                          </span>
                          {format.dateTime(new Date(day.sunriseUtc), {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: weather.timezone,
                          })}
                        </span>
                      )}
                      {day.sunsetUtc && (
                        <span className="flex items-center gap-1">
                          <Sunset aria-hidden="true" className="h-3.5 w-3.5" />
                          <span className="sr-only">{t("Weather.sunset")}</span>
                          {format.dateTime(new Date(day.sunsetUtc), {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: weather.timezone,
                          })}
                        </span>
                      )}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 flex items-start gap-3 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-4 sm:px-5">
        <ShieldAlert
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[var(--color-warning)]"
          size={18}
        />
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          <strong className="text-[var(--color-text)]">
            {t("Weather.safetyNoticeTitle")}
          </strong>{" "}
          {t("Weather.safetyNotice")}
        </p>
      </div>
    </section>
  );
}
