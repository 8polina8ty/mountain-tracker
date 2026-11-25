import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/Lib/supabase/server";
import { profileDestination, type AuthProfile } from "@/Lib/auth/profile";
import { isLocale } from "@/i18n/locales";

export async function GET(request: NextRequest, context: { params: Promise<{ locale: string }> }) {
  const { locale } = await context.params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });
  const respond = (path: string) => {
    // Relative Location stays on this origin without trusting Host/forwarded headers.
    const response = new NextResponse(null, { status: 303, headers: { Location: path } });
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };
  const failed = () => respond(`/${locale}/auth/login?authError=callback`);
  const code = request.nextUrl.searchParams.get("code");
  if (request.nextUrl.searchParams.has("error") || !code || code.length > 4096) return failed();
  try {
    const supabase = await createClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) return failed();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return failed();
    const { data: profile, error } = await supabase.from("profiles")
      .select("username,country_code,onboarding_required").eq("id", user.id).maybeSingle();
    if (error || !profile || typeof profile.onboarding_required !== "boolean") {
      return respond(`/${locale}/auth/complete-profile?profileError=1`);
    }
    return respond(profileDestination(profile as AuthProfile, locale, request.nextUrl.searchParams.get("returnTo")));
  } catch { return failed(); }
}
