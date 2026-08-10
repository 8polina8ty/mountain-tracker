import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { isLocale } from "@/i18n/locales";
import {
  getLocalizedSeoUrls,
  getOpenGraphLocale,
} from "@/i18n/seo";

type PublicProfileLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string; userId: string }>;
}>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; userId: string }>;
}): Promise<Metadata> {
  const { locale, userId } = await params;

  if (!isLocale(locale)) {
    notFound();
  }
  const t = await getTranslations({
    locale,
    namespace: "Metadata.PublicProfile",
  });
  const { alternates, canonical } = getLocalizedSeoUrls(
    locale,
    `/users/${encodeURIComponent(userId)}`,
  );

  return {
    title: t("title"),
    description: t("description"),
    alternates,
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: canonical ?? undefined,
      locale: getOpenGraphLocale(locale),
      type: "profile",
    },
  };
}

export default function PublicProfileLayout({
  children,
}: PublicProfileLayoutProps) {
  return children;
}
