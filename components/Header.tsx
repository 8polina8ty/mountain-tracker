"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/Lib/supabase/client";

const links = [
  { href: "/map", label: "Карта" },
  { href: "/ranking", label: "Рейтинг" },
  {href: "/account/ascents", label: "Мои восхождения",},
  { href: "/account", label: "Аккаунт" },
];

export default function Header() {
  const pathname = usePathname();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    async function loadUser() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      setUser(user);
      setLoading(false);
    }

    void loadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  async function handleLogout() {
    const supabase = createClient();

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error(error);
      return;
    }

    window.location.href = "/map";
  }

  const username =
    user?.user_metadata?.username ||
    user?.email?.split("@")[0] ||
    "Пользователь";

  return (
    <header className="relative z-[100] w-full border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-20 max-w-7xl items-center justify-between gap-6 px-6">
        <Link
          href="/map"
          className="flex h-12 shrink-0 items-center rounded-xl px-4 text-xl font-bold text-green-700 transition hover:bg-gray-100"
        >
          🏔 Mountain Tracker
        </Link>

        <nav className="flex h-12 items-center gap-1 rounded-2xl border border-gray-200 bg-white p-1 shadow-sm">
          {links.map((link) => {
            const isActive = pathname === link.href;

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex h-10 items-center rounded-xl px-5 text-sm font-semibold transition ${
                  isActive
                    ? "bg-green-600 text-white"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex h-12 shrink-0 items-center gap-3">
          {loading ? (
            <div className="h-10 w-28 animate-pulse rounded-xl bg-gray-100" />
          ) : user ? (
            <>
              <Link
                href="/account"
                className="flex h-12 items-center rounded-xl border border-gray-300 px-5 text-sm font-semibold text-gray-800 transition hover:bg-gray-100"
              >
                {username}
              </Link>

              <button
                type="button"
                onClick={handleLogout}
                className="flex h-12 items-center rounded-xl bg-gray-900 px-5 text-sm font-semibold text-white transition hover:bg-gray-800"
              >
                Выйти
              </button>
            </>
          ) : (
            <>
              <Link
                href="/auth/login"
                className="flex h-12 items-center rounded-xl border border-gray-900 px-5 text-sm font-semibold text-gray-900 transition hover:bg-gray-100"
              >
                Войти
              </Link>

              <Link
                href="/auth/sign-up"
                className="flex h-12 items-center rounded-xl bg-green-600 px-5 text-sm font-semibold text-white transition hover:bg-green-700"
              >
                Регистрация
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}