import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import MountainMap from "@/components/MountainMap/MountainMap";
import type { Locale } from "@/i18n/locales";
import {
  getLocalizedSeoUrls,
  getOpenGraphLocale,
} from "@/i18n/seo";

type MapPageProps = {
  params: Promise<{ locale: Locale }>;
};

export async function generateMetadata({
  params,
}: MapPageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata.Map" });
  const { alternates, canonical } = getLocalizedSeoUrls(locale, "/map");

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

export default async function MapPage({ params }: MapPageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata.Map" });

  return (
    <main aria-labelledby="map-page-title">
      <h1 id="map-page-title" className="sr-only">
        {t("pageHeading")}
      </h1>
      <MountainMap />
    </main>
  );
}
