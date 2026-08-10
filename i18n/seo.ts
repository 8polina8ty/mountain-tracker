import type { Metadata } from "next";

import { defaultLocale, locales, type Locale } from "./locales";

const ogLocales: Record<Locale, string> = {
  de: "de_DE",
  en: "en_US",
  ru: "ru_RU",
};

export function getSiteOrigin(): string | null {
  const configuredOrigin =
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL;

  if (!configuredOrigin) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(configuredOrigin)
    ? configuredOrigin
    : `https://${configuredOrigin}`;

  try {
    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function getLocalizedPath(locale: Locale, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${locale}${normalizedPath}`;
}

export function getAbsoluteUrl(pathname: string): string | null {
  const origin = getSiteOrigin();
  return origin ? new URL(pathname, origin).toString() : null;
}

export function getLanguageAlternates(
  pathname: string,
): Metadata["alternates"] | undefined {
  const origin = getSiteOrigin();

  if (!origin) {
    return undefined;
  }

  const languages = Object.fromEntries(
    locales.map((locale) => [
      locale,
      new URL(getLocalizedPath(locale, pathname), origin).toString(),
    ]),
  );

  return {
    languages: {
      ...languages,
      "x-default": new URL(
        getLocalizedPath(defaultLocale, pathname),
        origin,
      ).toString(),
    },
  };
}

export function getLocalizedSeoUrls(locale: Locale, pathname: string) {
  const canonical = getAbsoluteUrl(getLocalizedPath(locale, pathname));

  return {
    alternates: canonical
      ? {
          ...getLanguageAlternates(pathname),
          canonical,
        }
      : undefined,
    canonical,
  };
}

export function getOpenGraphLocale(locale: Locale): string {
  return ogLocales[locale];
}
