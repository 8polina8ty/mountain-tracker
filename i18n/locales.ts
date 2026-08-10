export const locales = ["de", "en", "ru"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "de";

export function isLocale(value: string | undefined): value is Locale {
  return locales.some((locale) => locale === value);
}
