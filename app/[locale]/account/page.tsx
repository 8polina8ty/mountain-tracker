"use client";

import type { ReactNode } from "react";
import { Activity, ArrowRight, ArrowUpRight, BadgeCheck, Camera, ChevronRight, Map, MapPin, Mountain, Plus, Route, TrendingUp, Trophy, Upload } from "lucide-react";

import AccountNavigation from "@/components/account/AccountNavigation";
import { useAccount } from "@/hooks/useAccount";
import { ACHIEVEMENT_MESSAGE_KEYS } from "@/Lib/achievements";
import { Link } from "@/i18n/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Avatar, Eyebrow, MetricRow, SectionHeading, StatusPill } from "@/components/ui-v2";

export default function AccountPage() {
  const t = useTranslations("Account");
  const achievementT = useTranslations("Achievements");
  const ascentPhotoT = useTranslations("Ascents.Privacy");
  const format = useFormatter();

  const {
    user,
    loading,
    errorMessage,

    avatarUrl,
    avatarUploading,
    avatarMessage,
    handleAvatarUpload,

    username,

    ascents,
    favoriteMountains,
    achievements,

    highestMountain,
    totalHeight,
    unlockedAchievementsCount,

    getMountainName,

  } = useAccount();

  if (loading) {
    return (
      <main className="flex min-h-[calc(100dvh-64px)] items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="border-l-2 border-[var(--color-pine)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]" role="status">
          {t("Status.loading")}
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-[calc(100dvh-64px)] items-center justify-center bg-[var(--color-bg)] px-4">
        <section className="w-full max-w-lg border-y border-[var(--color-border-strong)] py-10 text-center">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-pine)]">{t("Header.eyebrow")}</p>
          <h1 className="mt-3 text-3xl font-bold text-[var(--color-text)]">
            {t("Status.loginTitle")}
          </h1>

          <p className="mt-3 text-[var(--color-text-muted)]">
            {t("Status.loginDescription")}
          </p>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Link
              href="/auth/login"
              className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
            >
              {t("Status.login")}
            </Link>

            <Link
              href="/auth/sign-up"
              className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 py-2 font-semibold text-white hover:bg-[var(--color-pine-hover)]"
            >
              {t("Status.signUp")}
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <AccountNavigation />
      <div className="mx-auto max-w-7xl space-y-10">
        {/* Profile Hero */}
        <div className="relative overflow-hidden rounded-[var(--radius-panel)] bg-gradient-to-br from-[var(--color-bg-secondary)] to-[var(--color-bg)]">
          <div className="flex flex-col gap-8 p-6 sm:p-10 md:flex-row md:items-center md:justify-between lg:p-12">
            <div className="flex items-center gap-6">
              <Avatar initials={username.charAt(0).toUpperCase()} size="xl" src={avatarUrl ?? undefined} />
              <div>
                <Eyebrow>{t("Profile.eyebrow")}</Eyebrow>
                <h1 className="mt-2 text-[32px] font-bold tracking-tight sm:text-[40px]">{username}</h1>
                <div className="mt-3 flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]">
                  <MapPin size={15} strokeWidth={2} />
                  <span>{user.email ?? t("Profile.emailUnavailable")}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <StatusPill tone="success" size="small">
                    <BadgeCheck size={12} className="mr-1" />
                    {t("Profile.complete")}
                  </StatusPill>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 md:items-end">
              <label
                aria-disabled={avatarUploading}
                className={`ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[13px] font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-control)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-pine)] ${
                  avatarUploading
                    ? "cursor-wait opacity-60"
                    : "cursor-pointer hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                }`}
              >
                <Camera aria-hidden="true" size={16} strokeWidth={2} />
                {avatarUploading
                  ? t("Profile.uploading")
                  : t("Profile.changeAvatar")}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={avatarUploading}
                  onChange={handleAvatarUpload}
                  className="sr-only"
                />
              </label>
              {avatarMessage && (
                <p
                  className="max-w-xs text-sm text-[var(--color-text-muted)] md:text-right"
                  role="status"
                >
                  {avatarMessage}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Key Stats */}
        <MetricRow
          metrics={[
            { label: t("Statistics.ascents"), value: format.number(ascents.length), icon: Mountain },
            { label: t("Statistics.highestPoint"), value: highestMountain ? `${format.number(highestMountain.height)} m` : "—", icon: ArrowUpRight },
            { label: t("Statistics.totalElevation"), value: `${format.number(totalHeight)} m`, icon: TrendingUp },
            { label: t("Statistics.achievements"), value: format.number(unlockedAchievementsCount), icon: Activity },
          ]}
        />

        <div className="grid gap-10 lg:grid-cols-[1.4fr_0.8fr]">
          {/* Recent Ascents */}
          <section>
            <SectionHeading
              eyebrow={t("Ascents.eyebrow")}
              title={t("Ascents.title")}
              action={
                <Link
                  href="/map"
                  className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 text-[13px] font-semibold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-pine-hover)]"
                >
                  <Plus aria-hidden="true" size={16} strokeWidth={2} />
                  {t("Ascents.record")}
                </Link>
              }
            />
            <div className="mt-6 space-y-3">
              {ascents.length > 0 ? (
                ascents.slice(0, 5).map((a, i) => {
                  const row = (
                    <>
                    <span className="technical text-[14px] font-bold text-[var(--color-text-subtle)]">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[16px] font-bold">{getMountainName(a.mountains)}</h3>
                      <p className="technical text-[14px] font-semibold text-[var(--color-pine)]">{format.number(a.mountains.height)} m</p>
                    </div>
                    <div className="hidden text-right sm:block">
                      <p className="technical text-[12px] text-[var(--color-text-muted)]">{a.climbed_at ? format.dateTime(new Date(a.climbed_at), { day: "2-digit", month: "short", year: "numeric" }).toUpperCase() : "—"}</p>
                      <div className="mt-1.5">
                        <StatusPill tone={a.is_photo_public ? "success" : "neutral"} size="small">
                          {ascentPhotoT(a.is_photo_public ? "public" : "private")}
                        </StatusPill>
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-[var(--color-text-subtle)]" strokeWidth={2} />
                    </>
                  );
                  const rowClassName =
                    "ui-pressable flex items-center gap-5 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]";
                  const mountainId = a.mountains?.id;

                  return mountainId == null ? (
                    <div key={a.id} className={rowClassName}>
                      {row}
                    </div>
                  ) : (
                    <Link
                      key={a.id}
                      href={`/mountain/${mountainId}`}
                      className={`${rowClassName} hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-pine)]`}
                    >
                      {row}
                    </Link>
                  );
                })
              ) : (
                <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-10 text-center">
                  <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-pine)]">
                    <Mountain size={28} strokeWidth={1.5} />
                  </div>
                  <h3 className="mt-5 text-[18px] font-bold">{t("Ascents.emptyTitle")}</h3>
                  <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-text-muted)]">
                    {t("Ascents.emptyDescription")}
                  </p>
                  <div className="mt-6">
                    <Link
                      href="/map"
                      className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-5 text-[14px] font-semibold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-pine-hover)]"
                    >
                      <Plus aria-hidden="true" size={18} strokeWidth={2} />
                      {t("Ascents.record")}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Achievements & Favorite Mountains */}
          <section>
            <SectionHeading eyebrow={t("Achievements.eyebrow")} title={t("Achievements.title")} />
            <div className="mt-6 grid grid-cols-2 gap-4">
              {achievements.length > 0 ? (
                achievements.slice(0, 4).map((a) => (
                  <div
                    key={a.id}
                    className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]"
                  >
                    <Trophy size={22} className="text-[var(--color-ochre)]" strokeWidth={2} />
                    <p className="mt-3 text-[14px] font-bold">
                      {achievementT(`Definitions.${ACHIEVEMENT_MESSAGE_KEYS[a.id]}.title`)}
                    </p>
                  </div>
                ))
              ) : (
                [
                  { label: t("Achievements.milestone1"), icon: Mountain },
                  { label: t("Achievements.milestone2"), icon: Mountain },
                  { label: t("Achievements.milestone3"), icon: TrendingUp },
                  { label: t("Achievements.milestone4"), icon: ArrowUpRight },
                ].map((item) => (
                  <div key={item.label} className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)] opacity-50">
                    <item.icon size={22} className="text-[var(--color-ochre)]" strokeWidth={2} />
                    <p className="mt-3 text-[14px] font-bold">{item.label}</p>
                  </div>
                ))
              )}
            </div>

            {/* Favorite Mountains */}
            {favoriteMountains.length > 0 && (
              <div className="mt-10">
                <SectionHeading eyebrow={t("Favorites.eyebrow")} title={t("Favorites.title")} />
                <div className="mt-6 space-y-3">
                  {favoriteMountains.slice(0, 3).map((m) => {
                    const card = (
                      <>
                      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--color-bg-terrain)] text-[var(--color-pine)]">
                        <Mountain size={20} strokeWidth={2} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{getMountainName(m.mountain)}</p>
                        <p className="technical text-[12px] text-[var(--color-text-muted)]">{format.number(m.mountain.height)} m</p>
                      </div>
                      <ChevronRight size={18} className="text-[var(--color-text-subtle)]" strokeWidth={2} />
                      </>
                    );
                    const cardClassName =
                      "ui-pressable flex items-center gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]";
                    const mountainId = m.mountain?.id;

                    return mountainId == null ? (
                      <div key={m.id} className={cardClassName}>
                        {card}
                      </div>
                    ) : (
                      <Link
                        key={m.id}
                        href={`/mountain/${mountainId}`}
                        className={`${cardClassName} hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-pine)]`}
                      >
                        {card}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>

        {errorMessage && (
          <div className="rounded-[var(--radius-card)] border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-5 text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </div>
        )}

        {/* Logbook Navigation */}
        <section className="grid gap-px border-y border-[var(--color-border-strong)] bg-[var(--color-border-soft)] sm:grid-cols-3" aria-labelledby="account-logbook-title">
          <h2 id="account-logbook-title" className="sr-only">{t("Logbook.accessibleLabel")}</h2>
          <LogbookLink href="/account/ascents" icon={<Map aria-hidden="true" className="h-5 w-5" />} label={t("Logbook.ascentHistory")} detail={t("Logbook.ascentHistoryDetail")} />
          <LogbookLink href="/account/tracks" icon={<Route aria-hidden="true" className="h-5 w-5" />} label={t("Logbook.gpsTracks")} detail={t("Logbook.gpsTracksDetail")} />
          <LogbookLink href="/account/tracks/import" icon={<Upload aria-hidden="true" className="h-5 w-5" />} label={t("Logbook.importRoute")} detail={t("Logbook.importRouteDetail")} />
        </section>
      </div>
    </main>
  );
}

type LogbookLinkProps = {
  href: string;
  icon: ReactNode;
  label: string;
  detail: string;
};

function LogbookLink({ href, icon, label, detail }: LogbookLinkProps) {
  return (
    <Link href={href} className="group flex min-h-28 items-start gap-4 bg-[var(--color-surface)] p-5 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-surface-raised)]">
      <span className="mt-0.5 text-[var(--color-pine)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[var(--color-text)]">{label}</span>
        <span className="mt-1 block text-sm text-[var(--color-text-muted)]">{detail}</span>
      </span>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)] transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5" />
    </Link>
  );
}
