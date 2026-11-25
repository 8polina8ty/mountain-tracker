"use client";

import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useCallback, useState } from "react";
import { getPreviousInternalPath } from "./BackNavigationProvider";

type BackButtonProps = {
  fallback: string;
  label?: string;
  className?: string;
};

export default function BackButton({ fallback, label, className }: BackButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const tNav = useTranslations("Navigation");
  const tDiscover = useTranslations("Social.Discover");
  const [navigating, setNavigating] = useState(false);

  // Prefer Navigation.back, fallback to Discover.back for legacy
  let backLabel: string;
  try {
    backLabel = tNav("back");
  } catch {
    backLabel = tDiscover("back");
  }
  if (label) backLabel = label;

  const handleBack = useCallback(() => {
    if (navigating) return;
    setNavigating(true);

    // Check for safe internal previous path from our history
    const previous = getPreviousInternalPath(pathname, fallback);

    if (previous) {
      // Use router.back() to preserve scroll, filters, pagination, search params
      router.back();
      // Safety net: if back didn't change route after 400ms (e.g., history was external), fallback
      window.setTimeout(() => {
        // pathname is stale closure, check current location
        if (window.location.pathname === pathname) {
          router.push(fallback);
        }
        setNavigating(false);
      }, 400);
      return;
    }

    // No safe internal history → explicit fallback
    // Prevent pushing same route
    if (pathname !== fallback) {
      router.push(fallback);
    }
    setNavigating(false);
  }, [fallback, navigating, pathname, router]);

  return (
    <button
      type="button"
      onClick={handleBack}
      disabled={navigating}
      aria-label={backLabel}
      className={
        className ??
        "ui-pressable inline-flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-[14px] border border-[var(--color-border-soft)] bg-[var(--color-success-soft)] px-4 py-2 text-sm font-semibold text-[var(--color-success)] shadow-sm ring-1 ring-[var(--color-success-border)]/60 hover:bg-[var(--color-success-border)]/20 hover:text-[var(--color-pine)] active:translate-y-[1px] active:scale-[0.97] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
      }
    >
      <ArrowLeft size={18} aria-hidden="true" strokeWidth={2.2} />
      <span>{backLabel}</span>
    </button>
  );
}
