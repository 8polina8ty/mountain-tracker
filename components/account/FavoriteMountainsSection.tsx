"use client";

import Link from "next/link";
import { ArrowUpRight, Star } from "lucide-react";

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
    <section className="border-b border-[var(--color-border-strong)] py-10 sm:py-12" aria-labelledby="favorite-mountains-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-warning)]">
            04 / Планирование
          </p>

          <h2 id="favorite-mountains-title" className="mt-2 text-3xl font-bold text-[var(--color-text)]">
            Избранные вершины
          </h2>

          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            Вершины, которые вы сохранили для будущих
            восхождений.
          </p>
        </div>

        <div className="[font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-warning)]">
          {favoriteMountains.length}
        </div>
      </div>

      {favoriteMountains.length === 0 ? (
        <div className="mt-6 border-y border-dashed border-[var(--color-border)] px-6 py-10 text-center">
          <Star aria-hidden="true" className="mx-auto h-8 w-8 text-[var(--color-ochre)]" />

          <h3 className="mt-4 text-xl font-bold text-[var(--color-text)]">
            Пока нет избранных вершин
          </h3>

          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-text-muted)]">
            Откройте карту, выберите вершину и нажмите
            «Добавить в избранное».
          </p>

          <Link
            href="/map"
            className="mt-5 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)]"
          >
            Перейти к карте
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] sm:grid-cols-2">
          {favoriteMountains.map((favorite) => {
            const mountainName = getMountainName(
              favorite.mountain,
            );

            return (
              <Link
                key={favorite.id}
                href={`/mountain/${favorite.mountain.id}`}
                className="group flex min-w-0 items-center gap-4 bg-[var(--color-surface)] p-5 transition-colors hover:bg-[var(--color-surface-raised)]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-warning-soft)] text-[var(--color-ochre)]">
                  <Star aria-label="В избранном" className="h-4 w-4 fill-current" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-bold text-[var(--color-text)] group-hover:text-[var(--color-forest)]">{mountainName}</h3>
                  <p className="mt-1 [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text-muted)]">{favorite.mountain.height} м</p>
                </div>
                <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
