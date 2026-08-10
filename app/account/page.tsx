"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Map, Route, Upload } from "lucide-react";

import AccountNavigation from "@/components/account/AccountNavigation";
import AchievementsSection from "@/components/account/AchievementsSection";
import LatestAscentsSection from "@/components/account/LatestAscentsSection";
import ProfileCard from "@/components/account/ProfileCard";
import StatisticsSection from "@/components/account/StatisticsSection";
import { useAccount } from "../../hooks/useAccount";
import FavoriteMountainsSection from "@/components/account/FavoriteMountainsSection";

export default function AccountPage() {

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
  averageHeight,
  latestAscent,

  unlockedAchievementsCount,
  totalMountains,
  progressPercent,

  getMountainName,

} = useAccount();

  if (loading) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <div className="border-l-2 border-[var(--color-forest)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]" role="status">
          Загружаю аккаунт…
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <section className="w-full max-w-lg border-y border-[var(--color-border-strong)] py-10 text-center">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">Личный журнал</p>
          <h1 className="mt-3 text-3xl font-bold text-[var(--color-text)]">
            Войдите в аккаунт
          </h1>

          <p className="mt-3 text-[var(--color-text-muted)]">
            После входа здесь появятся ваша статистика и история восхождений.
          </p>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              Войти
            </Link>

            <Link
              href="/register"
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-2 font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)]"
            >
              Регистрация
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <ProfileCard
  username={username}
  email={user.email ?? null}
  avatarUrl={avatarUrl}
  avatarUploading={avatarUploading}
  avatarMessage={avatarMessage}
  handleAvatarUpload={handleAvatarUpload}
/>

<StatisticsSection
  ascentsCount={ascents.length}
  totalMountains={totalMountains}
  progressPercent={progressPercent}
  highestMountain={highestMountain}
  averageHeight={averageHeight}
  latestAscent={latestAscent}
  getMountainName={getMountainName}
/>

        {errorMessage && (
          <div className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </div>
        )}

        <section className="grid gap-px border-y border-[var(--color-border-strong)] bg-[var(--color-border-soft)] sm:grid-cols-3" aria-labelledby="account-logbook-title">
          <h2 id="account-logbook-title" className="sr-only">Разделы экспедиционного журнала</h2>
          <LogbookLink href="/account/ascents" icon={<Map aria-hidden="true" className="h-5 w-5" />} label="История восхождений" detail="Полный журнал и карта вершин" />
          <LogbookLink href="/account/tracks" icon={<Route aria-hidden="true" className="h-5 w-5" />} label="GPS-треки" detail="Записанные маршруты и показатели" />
          <LogbookLink href="/account/tracks/import" icon={<Upload aria-hidden="true" className="h-5 w-5" />} label="Импорт маршрута" detail="Добавить новую GPX-запись" />
        </section>

<LatestAscentsSection
  ascents={ascents}
  getMountainName={getMountainName}
/>

<AchievementsSection
  achievements={achievements}
  unlockedAchievementsCount={unlockedAchievementsCount}
/>

<FavoriteMountainsSection
  favoriteMountains={favoriteMountains}
  getMountainName={getMountainName}
/>

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
      <span className="mt-0.5 text-[var(--color-forest)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[var(--color-text)]">{label}</span>
        <span className="mt-1 block text-sm text-[var(--color-text-muted)]">{detail}</span>
      </span>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-1" />
    </Link>
  );
}
