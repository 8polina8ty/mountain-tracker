import { defaultLocale, isLocale, type Locale } from "../../i18n/locales.ts";

/** Only app destinations are accepted; auth endpoints cannot become callback loops. */
const destinationRoots = new Set([
  "map", "account", "ranking", "mountain", "users", "projects", "expeditions",
  "explore", "friends", "messages", "notifications", "community", "routes",
]);

export function safeAuthDestination(input: unknown, requestedLocale: string): string {
  const locale: Locale = isLocale(requestedLocale) ? requestedLocale : defaultLocale;
  const fallback = `/${locale}/map`;
  if (typeof input !== "string" || input.length > 2048 || !input.startsWith("/") ||
      input.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(input)) return fallback;

  try {
    const url = new URL(input, "https://mountain-tracker.invalid");
    if (url.origin !== "https://mountain-tracker.invalid") return fallback;
    // Reject encoded path separators, controls and dot segments, including nested encodings.
    // Query strings are preserved as data; they are never used as a second redirect target.
    if (/%|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(input.split(/[?#]/, 1)[0])) return fallback;
    const segments = url.pathname.slice(1).split("/");
    if (isLocale(segments[0])) segments.shift();
    if (!destinationRoots.has(segments[0])) return fallback;
    return `/${locale}/${segments.join("/")}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
