import { getRequestConfig } from "next-intl/server";

import { defaultLocale, isLocale } from "./locales";

const messageFiles = [
  "common",
  "navigation",
  "auth",
  "map",
  "mountain",
  "account",
  "ascents",
  "tracks",
  "achievements",
  "ranking",
  "publicProfile",
  "metadata",
  "errors",
] as const;

async function loadMessages(locale: string) {
  const modules = await Promise.all(
    messageFiles.map((file) => import(`../messages/${locale}/${file}.json`)),
  );

  return Object.assign({}, ...modules.map((module) => module.default));
}

export default getRequestConfig(async ({ locale, requestLocale }) => {
  const requestedLocale = locale ?? (await requestLocale);
  const activeLocale = isLocale(requestedLocale)
    ? requestedLocale
    : defaultLocale;

  return {
    locale: activeLocale,
    messages: await loadMessages(activeLocale),
  };
});
