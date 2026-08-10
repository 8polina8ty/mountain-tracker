"use client";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { toggleFavoriteMountain } from "@/app/[locale]/mountain/[id]/actions";
import { useAchievementNotification } from "@/components/achievements/AchievementNotificationProvider";
import type { Locale } from "@/i18n/locales";

type FavoriteMountainToggleProps = {
  mountainId: number;
  mountainName: string;
  locale: Locale;
  isFavorite: boolean;
};

export default function FavoriteMountainToggle({
  mountainId,
  mountainName,
  locale,
  isFavorite,
}: FavoriteMountainToggleProps) {
  const t = useTranslations("Mountain");
  const [pending, startTransition] = useTransition();
  const { enqueueAchievementIds } = useAchievementNotification();

  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const grantedIds = await toggleFavoriteMountain(mountainId, locale);
          enqueueAchievementIds(grantedIds);
        });
      }}
    >
      <button
        type="submit"
        disabled={pending}
        aria-label={
          isFavorite
            ? t("Accessibility.removeFavorite", { mountainName })
            : t("Accessibility.addFavorite", { mountainName })
        }
        className={`ui-pressable flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 text-sm font-bold disabled:opacity-60 ${
          isFavorite
            ? "ui-destructive border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
        }`}
      >
        <Star aria-hidden="true" size={17} fill={isFavorite ? "currentColor" : "none"} />
        {isFavorite ? t("Favorite.remove") : t("Favorite.add")}
      </button>
    </form>
  );
}
