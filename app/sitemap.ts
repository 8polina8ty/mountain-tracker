import type { MetadataRoute } from "next";

import { defaultLocale, locales, type Locale } from "@/i18n/locales";
import { getLocalizedPath, getSiteOrigin } from "@/i18n/seo";

const publicStaticPaths = [
  { pathname: "/map", changeFrequency: "weekly", priority: 1 },
  { pathname: "/ranking", changeFrequency: "daily", priority: 0.7 },
  { pathname: "/explore", changeFrequency: "daily", priority: 0.8 },
] as const;

function getAlternates(origin: string, pathname: string) {
  return {
    languages: {
      ...Object.fromEntries(
        locales.map((locale) => [
          locale,
          new URL(getLocalizedPath(locale, pathname), origin).toString(),
        ]),
      ),
      "x-default": new URL(
        getLocalizedPath(defaultLocale, pathname),
        origin,
      ).toString(),
    },
  };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getSiteOrigin();

  if (!origin) {
    return [];
  }

  return publicStaticPaths.flatMap((route) =>
    locales.map((locale: Locale) => ({
      url: new URL(getLocalizedPath(locale, route.pathname), origin).toString(),
      changeFrequency: route.changeFrequency,
      priority: route.priority,
      alternates: getAlternates(origin, route.pathname),
    })),
  );
}
