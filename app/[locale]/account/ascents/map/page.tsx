"use client";

import { List } from "lucide-react";

import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import ClimbedMountainsMap from "@/components/account/ClimbedMountainsMap";
import { useAccount } from "@/hooks/useAccount";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export default function ClimbedMountainsMapPage() {
  const t = useTranslations("Ascents.MapPage");
  const {
    user,
    loading,
    ascents,
    getMountainName,
  } = useAccount();

  if (loading) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <div className="border-l-2 border-[var(--color-forest)] bg-[var(--color-surface)] px-5 py-4 text-sm font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]" role="status">
          {t("loading")}
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 lg:min-h-[calc(100dvh-66px)]">
        <section className="w-full max-w-lg border-y border-[var(--color-border-strong)] py-10 text-center">
          <h1 className="text-3xl font-bold text-[var(--color-text)]">
            {t("loginTitle")}
          </h1>

          <Link
            href="/auth/login"
            className="mt-5 inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white"
          >
            {t("login")}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
          metric={{ label: t("markedPeaks"), value: t("peakCount", { count: ascents.length }) }}
          actions={
            <Link href="/account/ascents" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)]">
              <List aria-hidden="true" className="h-4 w-4" />
              {t("openJournal")}
            </Link>
          }
        />

        <section className="py-8" aria-label={t("sectionLabel")}>
          <ClimbedMountainsMap ascents={ascents} getMountainName={getMountainName} />
        </section>
      </div>
    </main>
  );
}
