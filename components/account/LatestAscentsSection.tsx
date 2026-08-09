import Link from "next/link";
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
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
            История
          </p>

          <h2 className="mt-1 text-2xl font-bold text-gray-900">
            Последние восхождения
          </h2>
        </div>

        <div className="flex flex-wrap gap-2">
  <Link
    href="/account/ascents"
    className="rounded-xl border border-green-600 px-4 py-2 text-sm font-semibold text-green-700 transition hover:bg-green-50"
  >
    Все восхождения
  </Link>

  <Link
    href="/map"
    className="rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-700"
  >
    Открыть карту
  </Link>
</div>
      </div>

      {ascents.length === 0 ? (
        <p className="rounded-2xl bg-gray-50 p-5 text-gray-600">
          Пока нет сохранённых восхождений.
        </p>
      ) : (
        <div className="space-y-3">
          {ascents.slice(0, 5).map((ascent) => (
            <article
              key={ascent.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gray-200 p-4"
            >
              <div>
                <h3 className="font-bold text-gray-900">
                  {getMountainName(ascent.mountains)}
                </h3>

                <p className="mt-1 text-sm text-gray-500">
                  {formatDate(
                    ascent.climbed_at ??
                      ascent.created_at,
                  )}
                </p>
              </div>

              <p className="font-bold text-green-600">
                {ascent.mountains?.height ?? 0} м
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}