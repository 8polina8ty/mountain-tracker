"use client";

import Link from "next/link";
import { BookOpen, Mountain, Route } from "lucide-react";
import { usePathname } from "next/navigation";

const accountSections = [
  {
    href: "/account",
    label: "Обзор",
    icon: BookOpen,
    isActive: (pathname: string) => pathname === "/account",
  },
  {
    href: "/account/ascents",
    label: "Восхождения",
    icon: Mountain,
    isActive: (pathname: string) =>
      pathname.startsWith("/account/ascents"),
  },
  {
    href: "/account/tracks",
    label: "GPS-треки",
    icon: Route,
    isActive: (pathname: string) =>
      pathname.startsWith("/account/tracks"),
  },
];

export default function AccountNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Разделы аккаунта"
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
                "relative inline-flex min-h-11 items-center gap-2 px-4 py-3 text-sm font-semibold transition-colors duration-[var(--duration-fast)]",
                active
                  ? "text-[var(--color-forest)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              ].join(" ")}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {section.label}
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
