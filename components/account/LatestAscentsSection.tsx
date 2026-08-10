import Link from "next/link";
import { ArrowRight, Map } from "lucide-react";
import { formatDate } from "@/Lib/utils";

import type {
  Ascent,
  Mountain,
} from "@/hooks/useAccount";

type LatestAscentsSectionProps = {
  ascents: Ascent[];
  getMountainName: (
    mountain: Mountain | null,
  ) => string;
};

export default function LatestAscentsSection({
  ascents,
  getMountainName,

}: LatestAscentsSectionProps) {
  return (
    <section className="border-b border-[var(--color-border-strong)] py-10 sm:py-12" aria-labelledby="latest-ascents-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            02 / Журнал
          </p>

          <h2 id="latest-ascents-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            Последние восхождения
          </h2>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/account/ascents" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)]">
            Все записи
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
          <Link href="/map" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-forest-hover)]">
            <Map aria-hidden="true" className="h-4 w-4" />
            Карта
          </Link>
        </div>
      </div>

      {ascents.length === 0 ? (
        <p className="border-y border-[var(--color-border)] py-8 text-[var(--color-text-muted)]">
          Пока нет сохранённых восхождений.
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
          {ascents.slice(0, 5).map((ascent) => (
            <article
              key={ascent.id}
              className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div>
                <h3 className="truncate font-bold text-[var(--color-text)]">
                  {getMountainName(ascent.mountains)}
                </h3>

                <p className="mt-1 [font-family:var(--font-technical)] text-xs text-[var(--color-text-muted)]">
                  {formatDate(
                    ascent.climbed_at ??
                      ascent.created_at,
                  )}
                </p>
              </div>

              <p className="[font-family:var(--font-technical)] font-bold tabular-nums text-[var(--color-forest)]">{ascent.mountains?.height ?? 0} м</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
