"use client";

import Image from "next/image";
import { useParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import PublicAscentsMap from "@/components/users/PublicAscentsMap";
import PublicProfileRelationship from "@/components/social/PublicProfileRelationship";
import { Link } from "@/i18n/navigation";
import {
  normalizePublicAchievementSummary,
  type PublicAchievementSummary,
  type PublicFeaturedAchievement,
} from "@/Lib/publicAchievementSummary";

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
  const [achievementSummary, setAchievementSummary] =
    useState<PublicAchievementSummary | null>(null);

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

const [ascentsResult, achievementResult] = await Promise.all([
  supabase.rpc("get_public_user_ascents", { target_user_id: userId }),
  supabase.rpc("get_public_user_achievement_summary", { requested_user_id: userId }),
]);
const { data: ascentsData, error: ascentsError } = ascentsResult;

if (cancelled) {
  return;
}

if (ascentsError) {
  console.error(ascentsError);
  setErrorMessage(ascentsError.message);
  setLoading(false);
  return;
}

if (achievementResult.error) {
  console.error("Public achievement summary is unavailable.", achievementResult.error);
  setAchievementSummary(null);
} else {
  setAchievementSummary(normalizePublicAchievementSummary(achievementResult.data));
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
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)]">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4 font-medium text-[var(--color-text-muted)] shadow-[var(--shadow-control)]">
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  if (errorMessage) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4">
        <section className="w-full max-w-lg border border-[var(--color-danger-border)] bg-[var(--color-surface)] p-8 text-center shadow-[var(--shadow-card)]">
          <div className="text-5xl">⚠️</div>

          <h1 className="mt-4 text-2xl font-bold text-[var(--color-text)]">
            {t("Status.loadFailed")}
          </h1>

          <p className="mt-2 text-[var(--color-danger)]">
            {errorMessage}
          </p>

          <Link
            href="/ranking"
            className="ui-pressable mt-6 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-3 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
          >
            {t("Header.backToRanking")}
          </Link>
        </section>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4">
        <section className="w-full max-w-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center shadow-[var(--shadow-card)]">
          <div className="text-5xl">👤</div>

          <h1 className="mt-4 text-2xl font-bold text-[var(--color-text)]">
            {t("Status.notFoundTitle")}
          </h1>

          <p className="mt-2 text-[var(--color-text-muted)]">
            {t("Status.notFoundDescription")}
          </p>

          <Link
            href="/ranking"
            className="ui-pressable mt-6 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-3 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
          >
            {t("Status.openRanking")}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-8 lg:min-h-[calc(100dvh-66px)]">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/ranking"
          className="font-bold text-[var(--color-forest)] hover:underline"
        >
          ← {t("Header.backToRanking")}
        </Link>

        <section className="mt-6 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
          <div className="bg-[var(--color-surface-inverse)] px-6 py-10 sm:px-10">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-white/70 bg-[var(--color-surface-raised)] text-4xl font-bold text-[var(--color-forest)] shadow-[var(--shadow-card)]">
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

              <div className="text-[var(--color-text-inverse)]">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] opacity-75">
                  {t("Header.eyebrow")}
                </p>

                <h1 className="mt-2 text-3xl font-bold sm:text-4xl">
                  {profile.username}
                </h1>

                <p className="mt-2 opacity-80">
                  {t("Header.member")}
                </p>
                <PublicProfileRelationship profileUserId={profile.user_id} />
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

        {achievementSummary && (
          <PublicAchievementSummarySection summary={achievementSummary} />
        )}

<section className="mt-6">
  <div className="mb-4">
    <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] text-[var(--color-forest)]">
      {t("Map.eyebrow")}
    </p>

    <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">
      {t("Map.title")}
    </h2>

    <p className="mt-2 text-[var(--color-text-muted)]">
      {t("Map.description")}
    </p>
  </div>

  <PublicAscentsMap ascents={ascents} />
</section>

        <section className="mt-6 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 sm:p-8">
  <div className="flex flex-wrap items-end justify-between gap-4">
    <div>
      <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] text-[var(--color-forest)]">
        {t("Ascents.eyebrow")}
      </p>

      <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">
        {t("Ascents.title")}
      </h2>
    </div>

    <div className="border-l border-[var(--color-border)] px-4 py-3">
      <p className="text-sm text-[var(--color-text-muted)]">
        {t("Ascents.totalLabel")}
      </p>

      <p className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums text-[var(--color-forest)]">
        {t("Ascents.count", { count: ascents.length })}
      </p>
    </div>
  </div>

  {ascents.length === 0 ? (
    <div className="mt-6 border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] p-8 text-center">
      <div className="text-5xl">🏔️</div>

      <h3 className="mt-4 text-xl font-bold text-[var(--color-text)]">
        {t("Ascents.emptyTitle")}
      </h3>

      <p className="mt-2 text-[var(--color-text-muted)]">
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
            className="flex flex-col gap-4 border-t border-[var(--color-border)] p-4 first:border-t-0 hover:bg-[var(--color-surface-muted)] sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h3 className="text-lg font-bold text-[var(--color-text)]">
                {mountainName}
              </h3>

              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 [font-family:var(--font-technical)] text-xs tabular-nums text-[var(--color-text-muted)]">
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
              className="ui-pressable inline-flex min-h-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-4 py-2 font-bold text-[var(--color-forest)] hover:bg-[var(--color-surface-muted)]"
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

function PublicAchievementSummarySection({ summary }: { summary: PublicAchievementSummary }) {
  const t = useTranslations("PublicProfile.Achievements");
  const format = useFormatter();
  return (
    <section className="mt-6 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-6 sm:px-7" aria-labelledby="public-achievement-summary-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-forest)]">{t("eyebrow")}</p>
          <h2 id="public-achievement-summary-title" className="mt-1 text-2xl font-bold text-[var(--color-text)]">{t("title")}</h2>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("subtitle")}</p>
        </div>
        <p className="[font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]" aria-label={t("accessibleSummary", {
          unlockedCount: summary.unlockedCount,
          totalDefinitions: summary.totalDefinitions,
          milestonePoints: summary.milestonePoints,
          completionPercent: summary.completionPercent,
        })}>
          {format.number(summary.unlockedCount)} / {format.number(summary.totalDefinitions)}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] sm:grid-cols-3 lg:grid-cols-6">
        <PublicAchievementMetric label={t("unlocked")} value={`${format.number(summary.unlockedCount)} / ${format.number(summary.totalDefinitions)}`} />
        <PublicAchievementMetric label={t("points")} value={format.number(summary.milestonePoints)} />
        <PublicAchievementMetric label={t("completion")} value={`${format.number(summary.completionPercent)}%`} />
        <PublicAchievementMetric label={t("distinguished")} value={format.number(summary.distinguishedCount)} />
        <PublicAchievementMetric label={t("exceptional")} value={format.number(summary.exceptionalCount)} />
        <PublicAchievementMetric label={t("lifetime")} value={format.number(summary.lifetimeCount)} />
      </dl>

      <div className="mt-6">
        <h3 className="text-sm font-bold text-[var(--color-text)]">{t("featured")}</h3>
        {summary.featured.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("noFeatured")}</p>
        ) : (
          <div className="mt-3 grid gap-px border-y border-[var(--color-border)] bg-[var(--color-border-soft)] md:grid-cols-3">
            {summary.featured.map((achievement) => (
              <PublicFeaturedAchievementRecord key={achievement.id} achievement={achievement} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PublicAchievementMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[var(--color-surface)] p-3">
      <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-1 [font-family:var(--font-technical)] text-lg font-bold tabular-nums text-[var(--color-text)]">{value}</dd>
    </div>
  );
}

function PublicFeaturedAchievementRecord({ achievement }: { achievement: PublicFeaturedAchievement }) {
  const t = useTranslations("Achievements");
  const profileT = useTranslations("PublicProfile.Achievements");
  const format = useFormatter();
  return (
    <article className="min-w-0 bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-lg text-[var(--color-text-muted)]">{achievement.icon}</span>
        <div className="min-w-0">
          <h4 className="break-words font-bold text-[var(--color-text)]">{t(`Definitions.${achievement.translationKey}.title`, { target: achievement.target })}</h4>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t(`Categories.${achievement.category}`)} · {t(`Rarity.${achievement.rarity}`)}</p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{profileT("unlockedOn", { date: format.dateTime(new Date(achievement.unlockedAt), { year: "numeric", month: "short", day: "numeric" }) })}</p>
        </div>
      </div>
    </article>
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
    <article className="border-t border-[var(--color-border-soft)] p-5 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <div className="text-3xl">{icon}</div>

      <p className="mt-4 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </p>

      <p className="mt-2 [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-text)]">
        {value}
      </p>
    </article>
  );
}
