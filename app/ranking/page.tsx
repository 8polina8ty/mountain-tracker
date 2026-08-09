"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import Link from "next/link";

type RankingUser = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  ascents_count: number;
  total_height: number;
  highest_mountain_height: number;
  highest_mountain_name: string | null;
  achievements_count: number;
};

type SortMode =
  | "ascents"
  | "total-height"
  | "highest-mountain"
  | "achievements";

export default function RankingPage() {
  const [ranking, setRanking] = useState<RankingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortMode, setSortMode] =
    useState<SortMode>("ascents");

  useEffect(() => {
    let cancelled = false;

    async function loadRanking() {
      setLoading(true);
      setErrorMessage("");

      const supabase = createClient();

      const { data, error } = await supabase.rpc(
        "get_user_ranking",
      );

      if (cancelled) {
        return;
      }

      if (error) {
        console.error(error);
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

      const loadedRanking: RankingUser[] = (
  (data ?? []) as any[]
).map((row) => ({
        user_id: String(row.user_id),
        username: String(
          row.username ?? "Пользователь",
        ),
        avatar_url:
          typeof row.avatar_url === "string"
            ? row.avatar_url
            : null,
        ascents_count: Number(
          row.ascents_count ?? 0,
        ),
        total_height: Number(
          row.total_height ?? 0,
        ),
        highest_mountain_height: Number(
          row.highest_mountain_height ?? 0,
        ),
        highest_mountain_name:
          typeof row.highest_mountain_name === "string"
            ? row.highest_mountain_name
            : null,
        achievements_count: Number(
          row.achievements_count ?? 0,
        ),
      }));

      setRanking(loadedRanking);
      setLoading(false);
    }

    void loadRanking();

    return () => {
      cancelled = true;
    };
  }, []);

  const displayedRanking = useMemo(() => {
    const search = searchInput
      .trim()
      .toLocaleLowerCase("ru-RU");

    const result = ranking.filter((user) =>
      user.username
        .toLocaleLowerCase("ru-RU")
        .includes(search),
    );

    result.sort((first, second) => {
      switch (sortMode) {
        case "total-height":
          return (
            second.total_height -
            first.total_height
          );

        case "highest-mountain":
          return (
            second.highest_mountain_height -
            first.highest_mountain_height
          );

        case "achievements":
          return (
            second.achievements_count -
            first.achievements_count
          );

        default:
          return (
            second.ascents_count -
              first.ascents_count ||
            second.total_height -
              first.total_height
          );
      }
    });

    return result;
  }, [ranking, searchInput, sortMode]);

  const communityStats = useMemo(() => {
    return ranking.reduce(
      (stats, user) => {
        stats.totalUsers += 1;
        stats.totalAscents += user.ascents_count;
        stats.totalHeight += user.total_height;
        stats.totalAchievements +=
          user.achievements_count;

        return stats;
      },
      {
        totalUsers: 0,
        totalAscents: 0,
        totalHeight: 0,
        totalAchievements: 0,
      },
    );
  }, [ranking]);

  if (loading) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50">
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-4 font-medium text-gray-600 shadow-sm">
          Загружаю рейтинг…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <div>
          <p className="text-sm font-bold uppercase tracking-wider text-green-700">
            Сообщество
          </p>

          <h1 className="mt-2 text-4xl font-bold text-gray-900">
            Рейтинг пользователей
          </h1>

          <p className="mt-2 text-gray-500">
            Сравните количество восхождений, высоту и достижения участников.
          </p>
        </div>

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatisticCard
            label="Пользователей"
            value={communityStats.totalUsers}
            icon="👥"
          />

          <StatisticCard
            label="Покорённых вершин"
            value={communityStats.totalAscents}
            icon="🏔️"
          />

          <StatisticCard
            label="Суммарная высота"
            value={`${communityStats.totalHeight.toLocaleString(
              "ru-RU",
            )} м`}
            icon="📈"
          />

          <StatisticCard
            label="Достижений"
            value={communityStats.totalAchievements}
            icon="🏆"
          />
        </section>

        <section className="mt-6 grid gap-4 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-2">
          <input
            type="search"
            value={searchInput}
            onChange={(event) =>
              setSearchInput(event.target.value)
            }
            placeholder="🔍 Найти пользователя..."
            className="rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-green-500"
          />

          <select
            value={sortMode}
            onChange={(event) =>
              setSortMode(
                event.target.value as SortMode,
              )
            }
            className="rounded-xl border border-gray-300 px-4 py-3"
          >
            <option value="ascents">
              По количеству вершин
            </option>

            <option value="total-height">
              По суммарной высоте
            </option>

            <option value="highest-mountain">
              По самой высокой вершине
            </option>

            <option value="achievements">
              По достижениям
            </option>
          </select>
        </section>

        {errorMessage && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
            {errorMessage}
          </div>
        )}

        <section className="mt-6">
  {displayedRanking.length === 0 ? (
    <div className="rounded-3xl border border-gray-200 bg-white p-10 text-center text-gray-500 shadow-sm">
      Пользователи не найдены.
    </div>
  ) : (
    <div className="grid gap-5 lg:grid-cols-2">
      {displayedRanking.map((user, index) => (
        <RankingRow
          key={user.user_id}
          user={user}
          position={index + 1}
        />
      ))}
    </div>
  )}
</section>
      </div>
    </main>
  );
}

type StatisticCardProps = {
  label: string;
  value: string | number;
  icon: string;
};

function StatisticCard({
  label,
  value,
  icon,
}: StatisticCardProps) {
  return (
    <article className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="text-3xl">{icon}</div>

      <p className="mt-4 text-sm font-medium text-gray-500">
        {label}
      </p>

      <p className="mt-1 text-3xl font-bold text-gray-900">
        {value}
      </p>
    </article>
  );
}

type RankingRowProps = {
  user: RankingUser;
  position: number;
};

function RankingRow({
  user,
  position,
}: RankingRowProps) {
  const medal =
    position === 1
      ? "🥇"
      : position === 2
        ? "🥈"
        : position === 3
          ? "🥉"
          : `№${position}`;

  return (
    <article className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-green-100 text-2xl font-bold text-green-700">
            {user.avatar_url ? (
              <Image
                src={user.avatar_url}
                alt={`Аватар ${user.username}`}
                fill
                sizes="64px"
                className="object-cover"
              />
            ) : (
              user.username.charAt(0).toUpperCase()
            )}
          </div>

          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-green-600">
              Пользователь
            </p>

            <h2 className="mt-1 text-xl font-bold text-gray-900">
              {user.username}
            </h2>
          </div>
        </div>

        <div className="rounded-2xl bg-gray-100 px-3 py-2 text-lg font-bold text-gray-800">
          {medal}
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <RankingValue
          label="Вершины"
          value={user.ascents_count}
        />

        <RankingValue
          label="Суммарная высота"
          value={`${user.total_height.toLocaleString(
            "ru-RU",
          )} м`}
        />

        <RankingValue
          label="Самая высокая"
          value={
            user.highest_mountain_name
              ? `${user.highest_mountain_name} · ${user.highest_mountain_height.toLocaleString(
                  "ru-RU",
                )} м`
              : "Нет данных"
          }
        />

        <RankingValue
          label="Достижения"
          value={user.achievements_count}
        />
      </div>

      <div className="mt-6">
        <Link
  href={`/users/${user.user_id}`}
  className="inline-flex w-full items-center justify-center rounded-xl bg-green-600 px-4 py-3 font-semibold text-white transition hover:bg-green-700"
>
  Открыть профиль
</Link>
      </div>
    </article>
  );
}

type RankingValueProps = {
  label: string;
  value: string | number;
};

function RankingValue({
  label,
  value,
}: RankingValueProps) {
  return (
    <div className="rounded-2xl bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>

      <p className="mt-2 text-lg font-bold text-gray-900">
        {value}
      </p>
    </div>
  );
}