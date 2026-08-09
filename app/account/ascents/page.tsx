"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { useAccount } from "../../../hooks/useAccount";
import AscentMountainThumbnail from "@/components/account/AscentMountainThumbnail";
import ChangeAscentPhotoButton from "@/components/account/ChangeAscentPhotoButton";
import AscentPhotoPrivacyToggle from "@/components/account/AscentPhotoPrivacyToggle";

    export default function AscentsPage() {
        const [searchInput, setSearchInput] = useState("");
    const [selectedYear, setSelectedYear] = useState("all");

    const [sortMode, setSortMode] = useState<
    "date-desc" | "date-asc" | "height-desc" | "height-asc" | "name"
    >("date-desc");
    const {
        user,
        loading,
        errorMessage,
        ascents,
        getMountainName,
    } = useAccount();

    const [customImageUrls, setCustomImageUrls] = useState<
  Record<number, string>
>({});

const [photoPrivacy, setPhotoPrivacy] = useState<
  Record<number, boolean>
>({});

    const displayedAscents = useMemo(() => {
  let result = [...ascents];


  // Поиск
  if (searchInput.trim() !== "") {
    const search = searchInput.toLowerCase();

    result = result.filter((ascent) =>
      getMountainName(ascent.mountains)
        .toLowerCase()
        .includes(search),
    );
  }


  // Фильтр по году
  if (selectedYear !== "all") {
    result = result.filter((ascent) => {
      const date = new Date(
        ascent.climbed_at ?? ascent.created_at ?? "",
      );

      return (
        !isNaN(date.getTime()) &&
        date.getFullYear().toString() === selectedYear
      );
    });
  }

  // Сортировка
  result.sort((a, b) => {
    switch (sortMode) {
      case "date-asc":
        return (
          new Date(a.climbed_at ?? a.created_at ?? "").getTime() -
          new Date(b.climbed_at ?? b.created_at ?? "").getTime()
        );

      case "height-desc":
        return (
          (b.mountains?.height ?? 0) -
          (a.mountains?.height ?? 0)
        );

      case "height-asc":
        return (
          (a.mountains?.height ?? 0) -
          (b.mountains?.height ?? 0)
        );

      case "name":
        return getMountainName(a.mountains).localeCompare(
          getMountainName(b.mountains),
        );

      default:
        return (
          new Date(b.climbed_at ?? b.created_at ?? "").getTime() -
          new Date(a.climbed_at ?? a.created_at ?? "").getTime()
        );
    }
  });

  return result;
}, [
  ascents,
  searchInput,
  selectedYear,
  sortMode,
  getMountainName,
]);

if (loading) {
  return (
    <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50">
      <div className="rounded-2xl border border-gray-200 bg-white px-6 py-4 font-medium text-gray-600 shadow-sm">
        Загружаю восхождения…
      </div>
    </main>
  );
}

if (!user) {
  return (
    <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50 px-4">
      <section className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="text-5xl">🔐</div>

        <h1 className="mt-4 text-2xl font-bold text-gray-900">
          Войдите в аккаунт
        </h1>

        <p className="mt-2 text-gray-500">
          После входа здесь появится полный список ваших восхождений.
        </p>

        <Link
          href="/login"
          className="mt-6 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
        >
          Войти
        </Link>
      </section>
    </main>
  );
}

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/account"
          className="font-semibold text-green-700 transition hover:text-green-800 hover:underline"
        >
          ← Вернуться в аккаунт
        </Link>

        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-green-700">
              История
            </p>

            <h1 className="mt-2 text-3xl font-bold text-gray-900 sm:text-4xl">
              Мои восхождения
            </h1>

            <p className="mt-2 text-gray-500">
              Все вершины, которые вы отметили как покорённые.
            </p>
          </div>

          <div className="flex flex-wrap items-stretch gap-3">

  <Link
    href="/account/ascents/map"
    className="inline-flex items-center justify-center rounded-2xl bg-green-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-green-700"
  >
    🗺️ Карта восхождений
  </Link>

  <Link
  href="/account/tracks"
  className="inline-flex items-center justify-center rounded-xl border border-green-600 bg-white px-4 py-2 font-semibold text-green-700 transition hover:bg-green-50"
>
  Мои GPS-треки
</Link>

  <Link
  href="/account/tracks/import"
  className="inline-flex items-center justify-center rounded-xl bg-green-600 px-4 py-2 font-semibold text-white transition hover:bg-green-700"
>
  Импортировать GPS-трек
</Link>

  <div className="rounded-2xl border border-gray-200 bg-white px-5 py-3 shadow-sm">
    <span className="text-sm text-gray-500">
      Всего восхождений
    </span>

    <div className="mt-1 text-3xl font-bold text-green-600">
      {displayedAscents.length}
    </div>
  </div>
</div>
        </div>

        {errorMessage && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
            {errorMessage}
          </div>
        )}

<div className="mb-6 grid gap-4 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-3">

  <input
    type="text"
    placeholder="🔍 Поиск вершины..."
    value={searchInput}
    onChange={(event) =>
      setSearchInput(event.target.value)
    }
    className="rounded-xl border border-gray-300 px-4 py-3 outline-none transition focus:border-green-500"
  />

  <select
    value={sortMode}
    onChange={(event) =>
      setSortMode(event.target.value as typeof sortMode)
    }
    className="rounded-xl border border-gray-300 px-4 py-3"
  >
    <option value="date-desc">📅 Сначала новые</option>
    <option value="date-asc">📅 Сначала старые</option>
    <option value="height-desc">🏔 Высота ↓</option>
    <option value="height-asc">🏔 Высота ↑</option>
    <option value="name">🔤 По алфавиту</option>
  </select>

  <select
    value={selectedYear}
    onChange={(event) =>
      setSelectedYear(event.target.value)
    }
    className="rounded-xl border border-gray-300 px-4 py-3"
  >
    <option value="all">Все годы</option>

    {[
      ...new Set(
        ascents
          .map((a) =>
            a.climbed_at ?? a.created_at,
          )
          .filter(Boolean)
          .map((date) =>
            new Date(date!).getFullYear(),
          ),
      ),
    ]
      .sort((a, b) => b - a)
      .map((year) => (
        <option key={year} value={year.toString()}>
          {year}
        </option>
      ))}
  </select>

</div>

        {displayedAscents.length === 0 ? (
          <section className="mt-8 rounded-3xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <div className="text-5xl">🏔️</div>

            <h2 className="mt-4 text-2xl font-bold text-gray-900">
              Пока нет восхождений
            </h2>

            <p className="mx-auto mt-2 max-w-lg text-gray-500">
              Откройте карту, выберите вершину и нажмите кнопку
              «Взошёл на вершину».
            </p>

            <Link
              href="/map"
              className="mt-6 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
            >
              Открыть карту
            </Link>
          </section>
        ) : (
          <section className="mt-8 grid gap-4">
            {displayedAscents.map((ascent, index) => {
              const mountainName = getMountainName(ascent.mountains);

              const customImageUrl =
  customImageUrls[ascent.id] ??
  ascent.image_url ??
  null;

  const isPhotoPublic =
  photoPrivacy[ascent.id] ??
  ascent.is_photo_public;

              const climbedDate = ascent.climbed_at
  ? new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(new Date(ascent.climbed_at))
  : "Дата не указана";

              return (
                <article
                  key={ascent.id}
                  className="flex flex-col gap-5 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-1 flex-col gap-4 sm:flex-row sm:items-center">
  <AscentMountainThumbnail
  wikidataId={ascent.mountains?.wikidata ?? null}
  mountainName={mountainName}
  customImageUrl={customImageUrl}
/>

  <div className="flex items-start gap-4">

  </div>

                    <div>
                      <h2 className="text-xl font-bold text-gray-900">
                        {mountainName}
                      </h2>

                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-500">
                        <span>
                          ⛰ {ascent.mountains?.height ?? "—"} м
                        </span>

                        <span>
                          📅 {climbedDate}
                        </span>
                      </div>
                    </div>
                  </div>
                
<div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
  <ChangeAscentPhotoButton
    ascentId={ascent.id}
    onPhotoChanged={(imageUrl) => {
      setCustomImageUrls((currentUrls) => ({
        ...currentUrls,
        [ascent.id]: imageUrl,
      }));
    }}
  />

  <AscentPhotoPrivacyToggle
  ascentId={ascent.id}
  initialIsPublic={isPhotoPublic}
  hasCustomPhoto={Boolean(customImageUrl)}
  onPrivacyChanged={(nextIsPublic) => {
    setPhotoPrivacy((currentPrivacy) => ({
      ...currentPrivacy,
      [ascent.id]: nextIsPublic,
    }));
  }}
/>

                 {ascent.mountains?.id ? (
  <Link
    href={`/mountain/${ascent.mountains.id}`}
    className="inline-flex shrink-0 items-center justify-center rounded-xl border border-green-600 px-4 py-2 font-semibold text-green-700 transition hover:bg-green-50"
  >
    Открыть вершину →
  </Link>
) : (
  <span className="inline-flex shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 font-semibold text-gray-400">
    Вершина недоступна
  </span>
)}
</div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}