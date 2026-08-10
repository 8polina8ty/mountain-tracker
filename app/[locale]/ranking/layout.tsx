import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { isLocale } from "@/i18n/locales";
import {
  getLocalizedSeoUrls,
  getOpenGraphLocale,
} from "@/i18n/seo";

type RankingLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }
  const t = await getTranslations({ locale, namespace: "Metadata.Ranking" });
  const { alternates, canonical } = getLocalizedSeoUrls(locale, "/ranking");

  return {
    title: t("title"),
    description: t("description"),
    alternates,
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: canonical ?? undefined,
      locale: getOpenGraphLocale(locale),
      type: "website",
    },
  };
}

export default function RankingLayout({ children }: RankingLayoutProps) {
  return children;
}
