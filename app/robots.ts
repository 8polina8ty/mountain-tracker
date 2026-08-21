import type { MetadataRoute } from "next";

import { locales } from "@/i18n/locales";
import { getSiteOrigin } from "@/i18n/seo";

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();
  const privateSegments = [
    "account",
    "auth",
    "database-test",
    "friends",
    "messages",
    "notifications",
    "projects",
  ];
  const disallow = [
    ...privateSegments.flatMap((segment) => [`/${segment}`, `/${segment}/`]),
    ...locales.flatMap((locale) =>
      privateSegments.flatMap((segment) => [
        `/${locale}/${segment}`,
        `/${locale}/${segment}/`,
      ]),
    ),
  ];

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow,
    },
    sitemap: origin ? new URL("/sitemap.xml", origin).toString() : undefined,
  };
}
