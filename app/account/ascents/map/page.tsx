"use client";

import Link from "next/link";

import ClimbedMountainsMap from "@/components/account/ClimbedMountainsMap";
import { useAccount } from "@/hooks/useAccount";

export default function ClimbedMountainsMapPage() {
  const {
    user,
    loading,
    ascents,
    getMountainName,
  } = useAccount();

  if (loading) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50">
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-4 font-medium text-gray-600 shadow-sm">
          Загружаю карту восхождений…
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-[calc(100vh-80px)] items-center justify-center bg-gray-50 px-4">
        <section className="rounded-3xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">
            Войдите в аккаунт
          </h1>

          <Link
            href="/login"
            className="mt-5 inline-flex rounded-xl bg-green-600 px-5 py-3 font-semibold text-white"
          >
            Войти
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              href="/account/ascents"
              className="font-semibold text-green-700 hover:underline"
            >
              ← Вернуться к восхождениям
            </Link>

            <p className="mt-6 text-sm font-bold uppercase tracking-wider text-green-700">
              Карта
            </p>

            <h1 className="mt-2 text-3xl font-bold text-gray-900 sm:text-4xl">
              Покорённые вершины
            </h1>

            <p className="mt-2 text-gray-500">
              На карте отмечены все ваши восхождения.
            </p>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-3 shadow-sm">
            <div className="text-sm text-gray-500">
              Всего вершин
            </div>

            <div className="mt-1 text-3xl font-bold text-green-600">
              {ascents.length}
            </div>
          </div>
        </div>

        <ClimbedMountainsMap
          ascents={ascents}
          getMountainName={getMountainName}
        />
      </div>
    </main>
  );
}