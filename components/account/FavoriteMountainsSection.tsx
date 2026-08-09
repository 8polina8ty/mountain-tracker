"use client";

import Link from "next/link";

import type {
  FavoriteMountain,
  Mountain,
} from "@/hooks/useAccount";


type FavoriteMountainsSectionProps = {
  favoriteMountains: FavoriteMountain[];
  getMountainName: (
    mountain: Mountain | null,
  ) => string;
};



export default function FavoriteMountainsSection({
  favoriteMountains,
  getMountainName,
}: FavoriteMountainsSectionProps) {
  return (
    <section className="mt-8 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-yellow-600">
            Избранное
          </p>

          <h2 className="mt-1 text-2xl font-bold text-gray-900">
            Избранные вершины
          </h2>

          <p className="mt-2 text-sm text-gray-500">
            Вершины, которые вы сохранили для будущих
            восхождений.
          </p>
        </div>

        <div className="rounded-full bg-yellow-50 px-4 py-2 text-sm font-bold text-yellow-700">
          {favoriteMountains.length}
        </div>
      </div>

      {favoriteMountains.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-6 py-10 text-center">
          <div className="text-5xl">☆</div>

          <h3 className="mt-4 text-lg font-bold text-gray-900">
            Пока нет избранных вершин
          </h3>

          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Откройте карту, выберите вершину и нажмите
            «Добавить в избранное».
          </p>

          <Link
            href="/map"
            className="mt-5 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
          >
            Перейти к карте
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {favoriteMountains.map((favorite) => {
            const mountainName = getMountainName(
              favorite.mountain,
            );

            return (
              <Link
                key={favorite.id}
                href={`/mountain/${favorite.mountain.id}`}
                className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-5 transition hover:-translate-y-1 hover:border-yellow-300 hover:shadow-lg"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-green-100 text-2xl">
                    🏔️
                  </div>

                  <span
                    className="text-2xl text-yellow-500"
                    aria-label="В избранном"
                  >
                    ★
                  </span>
                </div>

                <h3 className="mt-5 truncate text-lg font-bold text-gray-900 transition group-hover:text-green-700">
                  {mountainName}
                </h3>

                <p className="mt-1 text-2xl font-bold text-green-600">
                  {favorite.mountain.height} м
                </p>

                <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
                  <span className="text-sm font-semibold text-gray-500">
                    Открыть вершину
                  </span>

                  <span className="text-lg font-bold text-green-600 transition group-hover:translate-x-1">
                    →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}