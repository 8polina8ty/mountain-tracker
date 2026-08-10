import type {
  Ascent,
  Mountain,
} from "@/hooks/useAccount";
import { useFormatter, useTranslations } from "next-intl";

type StatisticsSectionProps = {
  ascentsCount: number;
  totalMountains: number;
  progressPercent: number;
  highestMountain: Mountain | null;
  averageHeight: number;
  latestAscent: Ascent | null;
  getMountainName: (
    mountain: Mountain | null,
  ) => string;
  
};

export default function StatisticsSection({
  ascentsCount,
  totalMountains,
  progressPercent,
  highestMountain,
  averageHeight,
  latestAscent,
  getMountainName,
}: StatisticsSectionProps) {
  const t = useTranslations("Account.Statistics");
  const format = useFormatter();
  return (
    <section className="py-10 sm:py-12" aria-labelledby="account-statistics-title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {t("sectionLabel")}
          </p>
          <h2 id="account-statistics-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            {t("title")}
          </h2>
        </div>
        <p className="hidden text-sm text-[var(--color-text-muted)] sm:block">
          {t("subtitle")}
        </p>
      </div>

      <dl className="mt-6 grid grid-cols-2 border-y border-[var(--color-border-strong)] lg:grid-cols-4">
        <Metric label={t("ascents")} value={format.number(ascentsCount)} />
        <Metric
          label={t("highestPoint")}
          value={highestMountain ? `${format.number(highestMountain.height)} ${t("meterUnit")}` : "—"}
          detail={highestMountain ? getMountainName(highestMountain) : t("noData")}
        />
        <Metric label={t("averageElevation")} value={averageHeight > 0 ? `${format.number(averageHeight)} ${t("meterUnit")}` : "—"} />
        <Metric
          label={t("latestRecord")}
          value={latestAscent ? getMountainName(latestAscent.mountains) : "—"}
          detail={latestAscent ? format.dateTime(new Date(latestAscent.climbed_at ?? latestAscent.created_at), { year: "numeric", month: "long", day: "numeric" }) : t("noData")}
        />
      </dl>

      <div className="grid gap-4 border-b border-[var(--color-border)] py-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-semibold text-[var(--color-text-secondary)]">{t("catalogProgress")}</span>
            <span className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-forest)]">
              {progressPercent.toFixed(2)}%
            </span>
          </div>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
            role="progressbar"
            aria-label={t("catalogProgress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Number(progressPercent.toFixed(2))}
          >
            <div className="ui-progress-fill h-full rounded-full bg-[var(--color-forest)]" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
        <p className="[font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
          {t("catalogCount", { ascents: ascentsCount, total: totalMountains })}
        </p>
      </div>
    </section>
  );
}

type MetricProps = {
  label: string;
  value: string;
  detail?: string;
};

function Metric({ label, value, detail }: MetricProps) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] px-4 py-5 odd:border-r lg:border-b-0 lg:border-r lg:first:pl-0 lg:last:border-r-0 lg:last:pr-0">
      <dt className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
        {label}
      </dt>
      <dd className="mt-2 break-words [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-text)] sm:text-2xl">
        <span className="block">{value}</span>
        {detail && <span className="mt-1 block truncate [font-family:var(--font-ui)] text-xs font-normal text-[var(--color-text-muted)]">{detail}</span>}
      </dd>
    </div>
  );
}
