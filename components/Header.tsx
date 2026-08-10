"use client";

import type { User } from "@supabase/supabase-js";
import {
  LogIn,
  LogOut,
  Menu,
  Mountain,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { createClient } from "@/Lib/supabase/client";

const standardEasing = [0.2, 0, 0, 1] as const;

const navigationLinks = [
  { href: "/map", label: "Карта", primary: true },
  { href: "/ranking", label: "Рейтинг", primary: false },
  {
    href: "/account/ascents",
    label: "Мои восхождения",
    primary: false,
  },
] as const;

const guestNavigationLinks = [
  ...navigationLinks,
  { href: "/account", label: "Аккаунт", primary: false },
] as const;

function isRouteActive(pathname: string, href: string) {
  if (href === "/account") {
    return (
      pathname === href || pathname.startsWith("/account/tracks")
    );
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Header() {
  const pathname = usePathname();
  const shouldReduceMotion = useReducedMotion();
  const menuDialogRef = useRef<HTMLDialogElement | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

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

  useEffect(() => {
    const dialog = menuDialogRef.current;

    if (!dialog) {
      return;
    }

    if (menuOpen && !dialog.open) {
      dialog.showModal();
    } else if (!menuOpen && dialog.open && shouldReduceMotion) {
      dialog.close();
    }
  }, [menuOpen, shouldReduceMotion]);

  useEffect(() => {
    const desktopMedia = window.matchMedia("(min-width: 1024px)");

    function closeMenuOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) {
        setMenuOpen(false);
      }
    }

    desktopMedia.addEventListener("change", closeMenuOnDesktop);

    return () => {
      desktopMedia.removeEventListener("change", closeMenuOnDesktop);
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

  function handleMenuExitComplete() {
    const dialog = menuDialogRef.current;

    if (!menuOpen && dialog?.open) {
      dialog.close();
    }
  }

  function handleMenuNavigation() {
    setMenuOpen(false);

    const dialog = menuDialogRef.current;

    if (dialog?.open) {
      dialog.close();
    }
  }

  const username =
    user?.user_metadata?.username ||
    user?.email?.split("@")[0] ||
    "Пользователь";

  const accountIsActive = isRouteActive(pathname, "/account");
  const visibleNavigationLinks = user
    ? navigationLinks
    : guestNavigationLinks;

  return (
    <header className="sticky top-0 z-[100] h-[58px] w-full border-b border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] lg:h-[66px]">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-3 px-3 sm:px-4 lg:gap-6 lg:px-6">
        <Link
          href="/map"
          className="ui-pressable flex h-11 min-w-0 shrink-0 items-center gap-2 px-1 text-[var(--color-text)] hover:text-[var(--color-forest)]"
          aria-label="Mountain Tracker, открыть карту"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-forest)] shadow-[var(--shadow-control)]">
            <Mountain aria-hidden="true" size={21} strokeWidth={2} />
          </span>

          <span className="truncate [font-family:var(--font-display)] text-base font-bold tracking-[0.01em] sm:text-lg">
            Mountain Tracker
          </span>
        </Link>

        <nav
          className="hidden h-full min-w-0 flex-1 items-stretch justify-center lg:flex"
          aria-label="Основная навигация"
        >
          {visibleNavigationLinks.map((link) => {
            const isActive = isRouteActive(pathname, link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`ui-pressable relative flex h-full items-center border-b-2 px-4 text-sm font-semibold ${
                  isActive
                    ? "border-[var(--color-forest)] text-[var(--color-text)]"
                    : link.primary
                      ? "border-transparent text-[var(--color-forest)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-forest-hover)]"
                      : "border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          {loading ? (
            <div
              className="h-10 w-28 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)]"
              aria-hidden="true"
            />
          ) : user ? (
            <>
              <Link
                href="/account"
                aria-current={accountIsActive ? "page" : undefined}
                className={`ui-pressable flex h-10 max-w-48 items-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm font-semibold ${
                  accountIsActive
                    ? "border-[var(--color-forest)] bg-[var(--color-surface-muted)] text-[var(--color-text)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                }`}
              >
                <UserRound aria-hidden="true" size={17} />
                <span className="truncate">{username}</span>
              </Link>

              <button
                type="button"
                onClick={handleLogout}
                className="ui-pressable flex h-10 min-w-10 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-transparent px-2.5 text-sm font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                aria-label="Выйти из аккаунта"
              >
                <LogOut aria-hidden="true" size={18} />
                <span className="hidden xl:inline">Выйти</span>
              </button>
            </>
          ) : (
            <>
              <Link
                href="/auth/login"
                className="ui-pressable flex h-10 items-center px-3 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
              >
                Войти
              </Link>

              <Link
                href="/auth/sign-up"
                className="ui-pressable flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
              >
                Регистрация
              </Link>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 lg:hidden">
          {loading ? (
            <div
              className="h-11 w-11 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)]"
              aria-hidden="true"
            />
          ) : user ? (
            <Link
              href="/account"
              aria-label={`Аккаунт: ${username}`}
              aria-current={accountIsActive ? "page" : undefined}
              className={`ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border ${
                accountIsActive
                  ? "border-[var(--color-forest)] bg-[var(--color-surface-muted)] text-[var(--color-forest)]"
                  : "border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
              }`}
            >
              <UserRound aria-hidden="true" size={20} />
            </Link>
          ) : (
            <Link
              href="/auth/login"
              aria-label="Войти в аккаунт"
              className="ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
            >
              <LogIn aria-hidden="true" size={20} />
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-transparent text-[var(--color-text)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
            aria-label="Открыть навигацию"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
          >
            <Menu aria-hidden="true" size={22} />
          </button>
        </div>
      </div>

      <dialog
        ref={menuDialogRef}
        id="mobile-navigation"
        aria-labelledby="mobile-navigation-title"
        onCancel={(event) => {
          event.preventDefault();
          setMenuOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setMenuOpen(false);
          }
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-[var(--color-text)] backdrop:bg-transparent lg:hidden"
      >
        <AnimatePresence
          initial={false}
          onExitComplete={handleMenuExitComplete}
        >
          {menuOpen && (
            <motion.div
              key="mobile-navigation-backdrop"
              initial={{ opacity: shouldReduceMotion ? 1 : 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: shouldReduceMotion ? 1 : 0 }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.18,
                ease: standardEasing,
              }}
              className="pointer-events-none absolute inset-0 bg-[#17211c]/40"
              aria-hidden="true"
            />
          )}

          {menuOpen && (
            <motion.div
              key="mobile-navigation-drawer"
              initial={{
                opacity: shouldReduceMotion ? 1 : 0.92,
                x: shouldReduceMotion ? 0 : 28,
              }}
              animate={{
                opacity: 1,
                x: 0,
                transition: shouldReduceMotion
                  ? { duration: 0 }
                  : {
                      x: {
                        type: "spring",
                        stiffness: 400,
                        damping: 38,
                        mass: 0.9,
                      },
                      opacity: {
                        duration: 0.18,
                        ease: standardEasing,
                      },
                    },
              }}
              exit={{
                opacity: shouldReduceMotion ? 1 : 0,
                x: shouldReduceMotion ? 0 : 20,
                transition: {
                  duration: shouldReduceMotion ? 0 : 0.17,
                  ease: standardEasing,
                },
              }}
              className="absolute inset-y-0 right-0 flex h-dvh w-[min(22rem,calc(100%-1rem))] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)]"
            >
              <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4">
                <div>
                  <p
                    id="mobile-navigation-title"
                    className="[font-family:var(--font-display)] text-lg font-bold"
                  >
                    Навигация
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Mountain Tracker
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="ui-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                  aria-label="Закрыть навигацию"
                >
                  <X aria-hidden="true" size={22} />
                </button>
              </div>

              <nav
                className="flex-1 overflow-y-auto py-3"
                aria-label="Мобильная навигация"
              >
                {visibleNavigationLinks.map((link) => {
                  const isActive = isRouteActive(pathname, link.href);

                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={handleMenuNavigation}
                      aria-current={isActive ? "page" : undefined}
                      className={`ui-pressable mx-3 flex min-h-13 items-center border-l-2 px-4 text-base font-semibold ${
                        isActive
                          ? "border-[var(--color-forest)] bg-[var(--color-surface-muted)] text-[var(--color-text)]"
                          : link.primary
                            ? "border-transparent text-[var(--color-forest)] hover:bg-[var(--color-surface-muted)]"
                            : "border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </nav>

              <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
                {loading ? (
                  <div
                    className="h-11 w-full animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)]"
                    aria-hidden="true"
                  />
                ) : user ? (
                  <div className="grid gap-2">
                    <Link
                      href="/account"
                      onClick={handleMenuNavigation}
                      className="ui-pressable flex min-h-11 min-w-0 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                    >
                      <UserRound
                        aria-hidden="true"
                        className="shrink-0 text-[var(--color-forest)]"
                        size={20}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {username}
                        </span>
                        <span className="block truncate text-xs text-[var(--color-text-muted)]">
                          {user.email}
                        </span>
                      </span>
                    </Link>

                    <button
                      type="button"
                      onClick={handleLogout}
                      className="ui-pressable flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    >
                      <LogOut aria-hidden="true" size={18} />
                      Выйти
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      href="/auth/login"
                      onClick={handleMenuNavigation}
                      className="ui-pressable flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
                    >
                      Войти
                    </Link>

                    <Link
                      href="/auth/sign-up"
                      onClick={handleMenuNavigation}
                      className="ui-pressable flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 text-sm font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]"
                    >
                      Регистрация
                    </Link>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </dialog>
    </header>
  );
}
