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
    <section className="mt-6 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <article className="flex min-h-[230px] flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Общий прогресс
          </p>

          <h2 className="mt-4 text-4xl font-bold text-gray-900">
            {ascentsCount}
          </h2>

          <p className="mt-1 text-sm text-gray-500">
            из {totalMountains} вершин
          </p>
        </div>

        <div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-green-600"
              style={{
                width: `${progressPercent}%`,
              }}
            />
          </div>

          <p className="mt-2 text-sm font-semibold text-green-700">
            {progressPercent.toFixed(2)}%
          </p>
        </div>
      </article>

      <article className="flex min-h-[230px] flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Самая высокая
          </p>

          <h3 className="mt-5 text-2xl font-bold text-gray-900">
            {highestMountain
              ? getMountainName(highestMountain)
              : "Пока нет"}
          </h3>
        </div>

        <p className="text-3xl font-bold text-green-600">
          {highestMountain
            ? `${highestMountain.height} м`
            : "—"}
        </p>
      </article>

      <article className="flex min-h-[230px] flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Средняя высота
          </p>

          <h3 className="mt-5 text-4xl font-bold text-gray-900">
            {averageHeight > 0
              ? `${averageHeight} м`
              : "—"}
          </h3>
        </div>

        <p className="text-sm text-gray-500">
          Среднее значение покорённых вершин
        </p>
      </article>

      <article className="flex min-h-[230px] flex-col justify-between rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Последнее восхождение
          </p>

          <h3 className="mt-5 text-2xl font-bold text-gray-900">
            {latestAscent
              ? getMountainName(latestAscent.mountains)
              : "Пока нет"}
          </h3>
        </div>

        <p className="text-sm text-gray-500">
          {latestAscent
            ? formatDate(
                latestAscent.climbed_at ??
                  latestAscent.created_at,
              )
            : "Нет данных"}
        </p>
      </article>
    </section>
  );
}