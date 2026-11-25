import { NextResponse, type NextRequest } from "next/server";
import { loadAuthProfile } from "@/Lib/auth/server";
import { profileDestination } from "@/Lib/auth/profile";
import { safeAuthDestination } from "@/Lib/auth/redirects";
import { isLocale } from "@/i18n/locales";

export async function GET(request: NextRequest, context: { params: Promise<{ locale: string }> }) {
  const { locale } = await context.params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });
  const returnTo = safeAuthDestination(request.nextUrl.searchParams.get("returnTo"), locale);
  let destination = `/${locale}/auth/login?authError=callback`;
  try {
    const { user, profile, profileError } = await loadAuthProfile();
    if (!user) destination = `/${locale}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    else if (profileError || !profile) destination = `/${locale}/auth/complete-profile?profileError=1`;
    else destination = profileDestination(profile, locale, returnTo);
  } catch { /* Return a fixed, localized retry destination; never log session data. */ }
  const response = new NextResponse(null, { status: 303, headers: { Location: destination } });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
