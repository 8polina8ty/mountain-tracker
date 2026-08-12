"use client";

import { Award, BookOpen, MessageCircle, Mountain, Route, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

const accountSections = [
  {
    href: "/friends",
    labelKey: "friends",
    icon: Users,
    isActive: (pathname: string) => pathname.startsWith("/friends"),
  },
  {
    href: "/messages",
    labelKey: "messages",
    icon: MessageCircle,
    isActive: (pathname: string) => pathname.startsWith("/messages"),
  },
  {
    href: "/account",
    labelKey: "overview",
    icon: BookOpen,
    isActive: (pathname: string) => pathname === "/account",
  },
  {
    href: "/account/ascents",
    labelKey: "ascents",
    icon: Mountain,
    isActive: (pathname: string) =>
      pathname.startsWith("/account/ascents"),
  },
  {
    href: "/account/achievements",
    labelKey: "achievements",
    icon: Award,
    isActive: (pathname: string) =>
      pathname.startsWith("/account/achievements"),
  },
  {
    href: "/account/tracks",
    labelKey: "gpsTracks",
    icon: Route,
    isActive: (pathname: string) =>
      pathname.startsWith("/account/tracks"),
  },
];

export default function AccountNavigation() {
  const t = useTranslations("Account.Navigation");
  const pathname = usePathname();

  return (
    <nav
      aria-label={t("accessibleLabel")}
      className="overflow-x-auto border-b border-[var(--color-border-strong)]"
    >
      <div className="flex min-w-max gap-1">
        {accountSections.map((section) => {
          const active = section.isActive(pathname);
          const Icon = section.icon;

          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={active ? "location" : undefined}
              className={[
                "ui-pressable relative inline-flex min-h-11 items-center gap-2 px-4 py-3 text-sm font-semibold",
                active
                  ? "text-[var(--color-forest)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              ].join(" ")}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {t(section.labelKey)}
              {active && (
                <span className="absolute inset-x-3 bottom-0 h-0.5 bg-[var(--color-forest)]" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
