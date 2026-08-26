"use client";

import type { User } from "@supabase/supabase-js";
import {
  Bell,
  Compass,
  LogOut,
  Menu,
  Moon,
  Mountain,
  Sun,
  Trophy,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import LocaleSwitcher from "@/components/LocaleSwitcher";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";
import { createClient } from "@/Lib/supabase/client";
import { formatUnreadBadge } from "@/Lib/socialMessaging";

const standardEasing = [0.2, 0, 0, 1] as const;

/* ========================================
   V2 NAVIGATION STRUCTURE
   ======================================== */

// Primary desktop navigation - 4 main areas
const primaryNavItems = [
  { href: "/explore", labelKey: "explore", icon: Compass },
  { href: "/map", labelKey: "map", icon: Mountain },
  { href: "/projects", labelKey: "projects", icon: Mountain },
  { href: "/ranking", labelKey: "community", icon: Users },
] as const;

// Mobile bottom navigation
const mobileNavItems = [
  { href: "/explore", labelKey: "explore", icon: Compass },
  { href: "/map", labelKey: "map", icon: Mountain },
  { href: "/projects", labelKey: "projects", icon: Mountain },
  { href: "/ranking", labelKey: "community", icon: Trophy },
] as const;

// Secondary destinations reachable from Community
const communityNavItems = [
  { href: "/ranking", labelKey: "ranking" },
  { href: "/friends", labelKey: "friends" },
  { href: "/messages", labelKey: "messages" },
  { href: "/notifications", labelKey: "notifications" },
] as const;

function isRouteActive(pathname: string, href: string) {
  // Primary nav active states
  if (href === "/explore") {
    return pathname === "/explore" || pathname.startsWith("/mountain/");
  }
  if (href === "/projects") {
    return pathname === "/projects" || pathname.startsWith("/projects/");
  }
  if (href === "/ranking") {
    return (
      pathname === "/ranking" ||
      pathname.startsWith("/friends") ||
      pathname.startsWith("/messages") ||
      pathname.startsWith("/notifications") ||
      pathname.startsWith("/users/")
    );
  }
  if (href === "/account") {
    return pathname === "/account" || pathname.startsWith("/account/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Header() {
  const t = useTranslations("Navigation");
  const tAccessibility = useTranslations("Accessibility");
  const tSocialAccessibility = useTranslations("Social.Accessibility");
  const { totalUnreadMessages, totalUnreadProjectNotifications } = useSocialInbox();
  const pathname = usePathname();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  const menuDialogRef = useRef<HTMLDialogElement | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(false);

  // Theme management
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  // Auth state management (preserved from production)
  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let authGeneration = 0;

    async function loadUser() {
      const generation = authGeneration;

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!active || generation !== authGeneration) {
        return;
      }

      setUser(user);
      setLoading(false);
    }

    void loadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authGeneration += 1;

      if (!active) {
        return;
      }

      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      authGeneration += 1;
      subscription.unsubscribe();
    };
  }, []);

  // Dialog management
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

    router.replace("/map");
    router.refresh();
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
    t("userFallback");

  const accountIsActive = isRouteActive(pathname, "/account");
  const isAuthPage = pathname === "/auth/login" || pathname === "/auth/sign-up";

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--color-border-soft)] bg-[var(--color-surface)]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link
          href="/map"
          className="ui-pressable flex shrink-0 items-center gap-3"
          aria-label={tAccessibility("openMap")}
        >
          <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] bg-[var(--color-pine)] text-white shadow-[var(--shadow-control)]">
            <Mountain size={20} strokeWidth={2} />
          </span>
          <div className="hidden sm:block">
            <span className="block text-[15px] font-bold tracking-tight">Mountain Tracker</span>
          </div>
        </Link>

        {/* Primary Navigation - Desktop */}
        <nav
          className="hidden flex-1 items-center justify-center gap-1 lg:flex"
          aria-label={tAccessibility("mainNavigation")}
        >
          {primaryNavItems.map((item) => {
            const isActive = isRouteActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`ui-pressable relative flex min-h-[44px] items-center gap-2.5 rounded-[var(--radius-control)] px-5 text-[14px] font-semibold transition-colors ${
                  isActive
                    ? "text-[var(--color-pine)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]/60"
                }`}
              >
                <Icon size={18} strokeWidth={2} />
                {t(item.labelKey)}
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute inset-x-2 -bottom-[1px] h-[2px] rounded-full bg-[var(--color-pine)]"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Right Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Language - Desktop */}
          <div className="hidden lg:block">
            <LocaleSwitcher />
          </div>

          {/* Theme Toggle */}
          <button
            type="button"
            onClick={() => setDark((v) => !v)}
            className="ui-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]/60"
            aria-label={dark ? t("switchToLight") : t("switchToDark")}
          >
            {dark ? <Sun size={18} strokeWidth={2} /> : <Moon size={18} strokeWidth={2} />}
          </button>

          {/* Notifications */}
          <Link
            href="/notifications"
            className="ui-pressable relative grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]/60"
            aria-label={totalUnreadProjectNotifications > 0 ? tSocialAccessibility("unreadNotifications", { count: totalUnreadProjectNotifications }) : t("notifications")}
          >
            <Bell size={18} strokeWidth={2} />
            {totalUnreadProjectNotifications > 0 && (
              <span className="absolute right-2.5 top-2.5 h-2.5 w-2.5 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-surface)]" />
            )}
          </Link>

          {/* Profile / Auth - Desktop */}
          {loading ? (
            <div
              className="ml-1 hidden h-10 w-28 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] sm:block"
              aria-hidden="true"
            />
          ) : user ? (
            <Link
              href="/account"
              aria-current={accountIsActive ? "page" : undefined}
              aria-label={tAccessibility("accountFor", { username })}
              className={`ui-pressable ml-1 hidden items-center gap-3 rounded-[var(--radius-control)] p-1.5 pr-4 hover:bg-[var(--color-surface-muted)]/60 sm:flex ${
                accountIsActive ? "bg-[var(--color-surface-muted)]/60" : ""
              }`}
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[var(--color-pine)] to-[var(--color-forest-light)] text-[12px] font-bold text-white">
                {username.slice(0, 2).toUpperCase()}
              </span>
              <span className="text-[14px] font-semibold">{username}</span>
            </Link>
          ) : (
            <div className="ml-1 hidden items-center gap-2 sm:flex">
              <Link
                href="/auth/login"
                className="ui-pressable flex h-10 items-center px-3 text-[14px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-pine)]"
              >
                {t("login")}
              </Link>
              <Link
                href="/auth/sign-up"
                className="ui-pressable flex h-10 items-center rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 text-[14px] font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-pine-hover)]"
              >
                {t("signUp")}
              </Link>
            </div>
          )}

          {/* Mobile Menu Toggle */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="ui-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]/60 lg:hidden"
            aria-label={tAccessibility("openNavigation")}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
          >
            {menuOpen ? <X size={20} strokeWidth={2} /> : <Menu size={20} strokeWidth={2} />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Dialog */}
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
              className="absolute inset-y-0 right-0 flex h-dvh w-[min(22rem,calc(100%-1rem))] flex-col border-l border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)]"
            >
              <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] px-5">
                <div>
                  <p
                    id="mobile-navigation-title"
                    className="text-[15px] font-bold"
                  >
                    {t("navigationTitle")}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Mountain Tracker
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="ui-pressable grid h-11 w-11 place-items-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                  aria-label={tAccessibility("closeNavigation")}
                >
                  <X aria-hidden="true" size={22} />
                </button>
              </div>

              <nav
                className="flex-1 overflow-y-auto py-3"
                aria-label={tAccessibility("mobileNavigation")}
              >
                {/* Primary Navigation */}
                <div className="mb-4">
                  <p className="px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                    {t("primary")}
                  </p>
                  {primaryNavItems.map((link) => {
                    const isActive = isRouteActive(pathname, link.href);
                    const Icon = link.icon;
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={handleMenuNavigation}
                        aria-current={isActive ? "page" : undefined}
                        className={`ui-pressable mx-3 flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-4 text-[14px] font-semibold ${
                          isActive
                            ? "bg-[var(--color-surface-muted)] text-[var(--color-pine)]"
                            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <Icon size={18} strokeWidth={2} />
                        {t(link.labelKey)}
                      </Link>
                    );
                  })}
                </div>

                {/* Community Section */}
                <div className="mb-4">
                  <p className="px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                    {t("community")}
                  </p>
                  {communityNavItems.map((link) => {
                    const isActive = isRouteActive(pathname, link.href);
                    const showUnreadBadge =
                      (link.href === "/messages" && totalUnreadMessages > 0) ||
                      (link.href === "/notifications" && totalUnreadProjectNotifications > 0);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={handleMenuNavigation}
                        aria-current={isActive ? "page" : undefined}
                        aria-label={link.href === "/messages" && totalUnreadMessages > 0 ? tSocialAccessibility("unreadMessages", { count: totalUnreadMessages }) : link.href === "/notifications" && totalUnreadProjectNotifications > 0 ? t("unreadNotifications", { count: totalUnreadProjectNotifications }) : undefined}
                        className={`ui-pressable mx-3 flex min-h-11 items-center justify-between rounded-[var(--radius-control)] px-4 text-[14px] font-semibold ${
                          isActive
                            ? "bg-[var(--color-surface-muted)] text-[var(--color-pine)]"
                            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span>{t(link.labelKey)}</span>
                        {showUnreadBadge && (
                          <UnreadBadge count={link.href === "/messages" ? totalUnreadMessages : totalUnreadProjectNotifications} />
                        )}
                      </Link>
                    );
                  })}
                </div>

                {/* Account Section */}
                <div>
                  <p className="px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                    {t("account")}
                  </p>
                  <Link
                    href="/account"
                    onClick={handleMenuNavigation}
                    aria-current={accountIsActive ? "page" : undefined}
                    className={`ui-pressable mx-3 flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-4 text-[14px] font-semibold ${
                      accountIsActive
                        ? "bg-[var(--color-surface-muted)] text-[var(--color-pine)]"
                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    <UserRound size={18} strokeWidth={2} />
                    {t("account")}
                  </Link>
                  <Link
                    href="/account/ascents"
                    onClick={handleMenuNavigation}
                    className="ui-pressable mx-3 flex min-h-11 items-center rounded-[var(--radius-control)] px-4 text-[14px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                  >
                    {t("myAscents")}
                  </Link>
                  <Link
                    href="/account/tracks"
                    onClick={handleMenuNavigation}
                    className="ui-pressable mx-3 flex min-h-11 items-center rounded-[var(--radius-control)] px-4 text-[14px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                  >
                    {t("tracks")}
                  </Link>
                </div>
              </nav>

              <div className="shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-secondary)] p-4">
                <div className="mb-3">
                  <LocaleSwitcher />
                </div>
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
                      className="ui-pressable flex min-h-11 min-w-0 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                    >
                      <UserRound
                        aria-hidden="true"
                        className="shrink-0 text-[var(--color-pine)]"
                        size={20}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">
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
                      className="ui-pressable flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 text-[14px] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    >
                      <LogOut aria-hidden="true" size={18} />
                      {t("logout")}
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      href="/auth/login"
                      onClick={handleMenuNavigation}
                      className="ui-pressable flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]"
                    >
                      {t("login")}
                    </Link>

                    <Link
                      href="/auth/sign-up"
                      onClick={handleMenuNavigation}
                      className="ui-pressable flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-pine)] px-3 text-[14px] font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-pine-hover)]"
                    >
                      {t("signUp")}
                    </Link>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </dialog>

      {/* Mobile Bottom Navigation */}
      {!isAuthPage && (
        <nav
          className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)]/95 backdrop-blur-xl lg:hidden"
          aria-label={tAccessibility("mobileNavigation")}
        >
          <div className="flex items-stretch justify-around safe-area-inset-bottom">
            {mobileNavItems.map((item) => {
              const isActive = isRouteActive(pathname, item.href);
              const Icon = item.icon;
              const showUnreadBadge =
                (item.href === "/ranking" && (totalUnreadMessages > 0 || totalUnreadProjectNotifications > 0));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`ui-pressable relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 transition-colors ${
                    isActive ? "text-[var(--color-pine)]" : "text-[var(--color-text-muted)]"
                  }`}
                >
                  <div className="relative">
                    <Icon size={22} strokeWidth={2} />
                    {showUnreadBadge && (
                      <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-surface)]" />
                    )}
                  </div>
                  <span className="text-[11px] font-semibold">{t(item.labelKey)}</span>
                  {isActive && (
                    <motion.div
                      layoutId="mobile-nav-indicator"
                      className="absolute -top-[1px] h-[2px] w-12 rounded-full bg-[var(--color-pine)]"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </header>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--color-pine)] px-1.5 py-0.5 text-[0.6875rem] font-bold leading-none text-white"
    >
      {formatUnreadBadge(count)}
    </span>
  );
}
