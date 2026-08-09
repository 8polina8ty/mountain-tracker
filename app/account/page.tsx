"use client";

import Link from "next/link";

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
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50">
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-4 font-medium text-gray-600 shadow-sm">
          Загружаю аккаунт…
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
            После входа здесь появятся ваша статистика и история восхождений.
          </p>

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Link
              href="/login"
              className="rounded-xl border border-gray-300 px-4 py-3 font-semibold text-gray-800 transition hover:bg-gray-50"
            >
              Войти
            </Link>

            <Link
              href="/register"
              className="rounded-xl bg-green-600 px-4 py-3 font-semibold text-white transition hover:bg-green-700"
            >
              Регистрация
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
   

    {/* Остальное содержимое страницы */}
      <div className="mx-auto max-w-6xl">
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
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
            {errorMessage}
          </div>
        )}

<AchievementsSection
  achievements={achievements}
  unlockedAchievementsCount={unlockedAchievementsCount}
/>

<FavoriteMountainsSection
  favoriteMountains={favoriteMountains}
  getMountainName={getMountainName}
/>

<LatestAscentsSection
  ascents={ascents}
  getMountainName={getMountainName}
/>

</div>
</main>
  );
}