import type {
  Ascent,
  Mountain,
} from "@/hooks/useAccount";
import { formatDate } from "@/Lib/utils";

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
  return (
    <section className="py-10 sm:py-12" aria-labelledby="account-statistics-title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            01 / Сводка
          </p>
          <h2 id="account-statistics-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            Экспедиционная статистика
          </h2>
        </div>
        <p className="hidden text-sm text-[var(--color-text-muted)] sm:block">
          Личный журнал вершин
        </p>
      </div>

      <dl className="mt-6 grid grid-cols-2 border-y border-[var(--color-border-strong)] lg:grid-cols-4">
        <Metric label="Восхождения" value={ascentsCount.toLocaleString("ru-RU")} />
        <Metric
          label="Высшая точка"
          value={highestMountain ? `${highestMountain.height.toLocaleString("ru-RU")} м` : "—"}
          detail={highestMountain ? getMountainName(highestMountain) : "Нет данных"}
        />
        <Metric label="Средняя высота" value={averageHeight > 0 ? `${averageHeight.toLocaleString("ru-RU")} м` : "—"} />
        <Metric
          label="Последняя запись"
          value={latestAscent ? getMountainName(latestAscent.mountains) : "—"}
          detail={latestAscent ? formatDate(latestAscent.climbed_at ?? latestAscent.created_at) : "Нет данных"}
        />
      </dl>

      <div className="grid gap-4 border-b border-[var(--color-border)] py-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-semibold text-[var(--color-text-secondary)]">Общий прогресс каталога</span>
            <span className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-forest)]">
              {progressPercent.toFixed(2)}%
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
            <div className="h-full rounded-full bg-[var(--color-forest)]" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
        <p className="[font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
          {ascentsCount.toLocaleString("ru-RU")} / {totalMountains.toLocaleString("ru-RU")} вершин
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
