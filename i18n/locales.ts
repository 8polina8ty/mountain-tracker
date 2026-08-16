export const locales = ["de", "en", "ru", "fr", "it", "es"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "de";

export function isLocale(value: string | undefined): value is Locale {
  return locales.some((locale) => locale === value);
}
