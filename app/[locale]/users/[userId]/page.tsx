"use client";

import Image from "next/image";
import { useParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import PublicAscentsMap from "@/components/users/PublicAscentsMap";
import { Link } from "@/i18n/navigation";

type PublicUserProfile = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  ascents_count: number;
  total_height: number;
  highest_mountain_height: number;
  highest_mountain_name: string | null;
  achievements_count: number;
};

type PublicAscent = {
  ascent_id: number;
  climbed_at: string | null;
  created_at: string;
  image_url: string | null;

  mountain_id: number;
  mountain_name: string | null;
  mountain_name_de: string | null;
  mountain_height: number;
  country_code: string | null;
  latitude: number;
  longitude: number;
  wikidata: string | null;
};

export default function PublicUserProfilePage() {
  const t = useTranslations("PublicProfile");
  const format = useFormatter();
  const params = useParams<{ locale: string; userId: string }>();

  const userId = params.userId;

  const [profile, setProfile] =
    useState<PublicUserProfile | null>(null);
    const [ascents, setAscents] = useState<PublicAscent[]>([]);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");



  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      if (!userId) {
        setErrorMessage(t("Status.missingUserId"));
        setLoading(false);
        return;
      }

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

      const rankingRows = (data ?? []) as unknown[];

      const profileRow = rankingRows.find((row) => {
        if (
          typeof row !== "object" ||
          row === null ||
          !("user_id" in row)
        ) {
          return false;
        }

        return String(row.user_id) === userId;
      });

      if (
        typeof profileRow !== "object" ||
        profileRow === null
      ) {
        setProfile(null);
        setLoading(false);
        return;
      }

      const row = profileRow as Record<string, unknown>;

      setProfile({
        user_id: String(row.user_id),
        username:
          typeof row.username === "string"
            ? row.username
            : t("Status.unknownUser"),
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
      });

const {
  data: ascentsData,
  error: ascentsError,
} = await supabase.rpc(
  "get_public_user_ascents",
  {
    target_user_id: userId,
  },
);

if (cancelled) {
  return;
}

if (ascentsError) {
  console.error(ascentsError);
  setErrorMessage(ascentsError.message);
  setLoading(false);
  return;
}

const loadedAscents: PublicAscent[] = (
  (ascentsData ?? []) as unknown[]
).map((item) => {
  const row = item as Record<string, unknown>;

  return {
    ascent_id: Number(row.ascent_id),
    climbed_at:
      typeof row.climbed_at === "string"
        ? row.climbed_at
        : null,
    created_at:
      typeof row.created_at === "string"
        ? row.created_at
        : "",
    image_url:
      typeof row.image_url === "string"
        ? row.image_url
        : null,

    mountain_id: Number(row.mountain_id),
    mountain_name:
      typeof row.mountain_name === "string"
        ? row.mountain_name
        : null,
    mountain_name_de:
      typeof row.mountain_name_de === "string"
        ? row.mountain_name_de
        : null,
    mountain_height: Number(
      row.mountain_height ?? 0,
    ),
    country_code:
      typeof row.country_code === "string"
        ? row.country_code
        : null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    wikidata:
      typeof row.wikidata === "string"
        ? row.wikidata
        : null,
  };
});

setAscents(loadedAscents);

      setLoading(false);
    }

    void loadProfile();

    return () => {
      cancelled = true;
    };
  }, [t, userId]);

  if (loading) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50">
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-4 font-medium text-gray-600 shadow-sm">
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50 px-4">
        <section className="w-full max-w-lg rounded-3xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <div className="text-5xl">⚠️</div>

          <h1 className="mt-4 text-2xl font-bold text-gray-900">
            {t("Status.loadFailed")}
          </h1>

          <p className="mt-2 text-red-600">
            {errorMessage}
          </p>

          <Link
            href="/ranking"
            className="mt-6 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
          >
            {t("Header.backToRanking")}
          </Link>
        </section>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50 px-4">
        <section className="w-full max-w-lg rounded-3xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="text-5xl">👤</div>

          <h1 className="mt-4 text-2xl font-bold text-gray-900">
            {t("Status.notFoundTitle")}
          </h1>

          <p className="mt-2 text-gray-500">
            {t("Status.notFoundDescription")}
          </p>

          <Link
            href="/ranking"
            className="mt-6 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
          >
            {t("Status.openRanking")}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/ranking"
          className="font-semibold text-green-700 transition hover:text-green-800 hover:underline"
        >
          ← {t("Header.backToRanking")}
        </Link>

        <section className="mt-6 overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm">
          <div className="bg-gradient-to-r from-green-700 to-green-500 px-6 py-10 sm:px-10">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-3xl border-4 border-white/70 bg-white text-4xl font-bold text-green-700 shadow-lg">
                {profile.avatar_url ? (
                  <Image
                    src={profile.avatar_url}
                    alt={t("Header.avatarAlt", {
                      username: profile.username,
                    })}
                    fill
                    sizes="112px"
                    className="object-cover"
                    priority
                  />
                ) : (
                  profile.username.charAt(0).toUpperCase()
                )}
              </div>

              <div className="text-white">
                <p className="text-sm font-bold uppercase tracking-wider text-white/75">
                  {t("Header.eyebrow")}
                </p>

                <h1 className="mt-2 text-3xl font-bold sm:text-4xl">
                  {profile.username}
                </h1>

                <p className="mt-2 text-white/80">
                  {t("Header.member")}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4 sm:p-8">
            <ProfileStatistic
              icon="🏔️"
              label={t("Statistics.ascents")}
              value={format.number(profile.ascents_count)}
            />

            <ProfileStatistic
              icon="📈"
              label={t("Statistics.totalElevation")}
              value={`${format.number(profile.total_height)} ${t("Units.meter")}`}
            />

            <ProfileStatistic
              icon="🗻"
              label={t("Statistics.highestSummit")}
              value={
                profile.highest_mountain_name
                  ? `${profile.highest_mountain_name} · ${format.number(profile.highest_mountain_height)} ${t("Units.meter")}`
                  : t("Statistics.noData")
              }
            />

            <ProfileStatistic
              icon="🏆"
              label={t("Statistics.achievements")}
              value={format.number(profile.achievements_count)}
            />
          </div>
        </section>

<section className="mt-6">
  <div className="mb-4">
    <p className="text-sm font-bold uppercase tracking-wider text-green-700">
      {t("Map.eyebrow")}
    </p>

    <h2 className="mt-2 text-2xl font-bold text-gray-900">
      {t("Map.title")}
    </h2>

    <p className="mt-2 text-gray-500">
      {t("Map.description")}
    </p>
  </div>

  <PublicAscentsMap ascents={ascents} />
</section>

        <section className="mt-6 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
  <div className="flex flex-wrap items-end justify-between gap-4">
    <div>
      <p className="text-sm font-bold uppercase tracking-wider text-green-700">
        {t("Ascents.eyebrow")}
      </p>

      <h2 className="mt-2 text-2xl font-bold text-gray-900">
        {t("Ascents.title")}
      </h2>
    </div>

    <div className="rounded-2xl bg-green-50 px-4 py-3">
      <p className="text-sm text-gray-500">
        {t("Ascents.totalLabel")}
      </p>

      <p className="mt-1 text-2xl font-bold text-green-700">
        {t("Ascents.count", { count: ascents.length })}
      </p>
    </div>
  </div>

  {ascents.length === 0 ? (
    <div className="mt-6 rounded-2xl bg-gray-50 p-8 text-center">
      <div className="text-5xl">🏔️</div>

      <h3 className="mt-4 text-xl font-bold text-gray-900">
        {t("Ascents.emptyTitle")}
      </h3>

      <p className="mt-2 text-gray-500">
        {t("Ascents.emptyDescription")}
      </p>
    </div>
  ) : (
    <div className="mt-6 space-y-3">
      {ascents.map((ascent) => {
        const mountainName =
          ascent.mountain_name_de ??
          ascent.mountain_name ??
          t("Ascents.unnamedMountain");

        const ascentDate =
          ascent.climbed_at ?? ascent.created_at;

        return (
          <article
            key={ascent.ascent_id}
            className="flex flex-col gap-4 rounded-2xl border border-gray-200 p-4 transition hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h3 className="text-lg font-bold text-gray-900">
                {mountainName}
              </h3>

              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-500">
                <span>
                  ⛰ {format.number(ascent.mountain_height)} {t("Units.meter")}
                </span>

                <span>
                  📅{" "}
                  {ascentDate
                    ? format.dateTime(new Date(ascentDate), {
                        day: "2-digit",
                        month: "long",
                        year: "numeric",
                      })
                    : t("Ascents.dateUnknown")}
                </span>

                {ascent.country_code && (
                  <span>
                    📍 {ascent.country_code}
                  </span>
                )}
              </div>
            </div>

            <Link
              href={`/mountain/${ascent.mountain_id}`}
              className="inline-flex shrink-0 items-center justify-center rounded-xl border border-green-600 px-4 py-2 font-semibold text-green-700 transition hover:bg-green-50"
            >
              {t("Ascents.openMountain")}
            </Link>
          </article>
        );
      })}
    </div>
  )}
</section>
      </div>
    </main>
  );
}

type ProfileStatisticProps = {
  icon: string;
  label: string;
  value: string | number;
};

function ProfileStatistic({
  icon,
  label,
  value,
}: ProfileStatisticProps) {
  return (
    <article className="rounded-2xl bg-gray-50 p-5">
      <div className="text-3xl">{icon}</div>

      <p className="mt-4 text-sm font-medium text-gray-500">
        {label}
      </p>

      <p className="mt-2 text-xl font-bold text-gray-900">
        {value}
      </p>
    </article>
  );
}
