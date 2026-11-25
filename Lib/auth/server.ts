import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/Lib/supabase/server";
import { needsProfileOnboarding, profileDestination, type AuthProfile } from "./profile";
import { safeAuthDestination } from "./redirects";
import type { Locale } from "@/i18n/locales";

export const loadAuthProfile = cache(async () => {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { supabase, user: null, profile: null, profileError: false };
  const { data, error } = await supabase.from("profiles")
    .select("username,country_code,onboarding_required").eq("id", user.id).maybeSingle();
  const valid = data && typeof data.onboarding_required === "boolean";
  return { supabase, user, profile: valid ? data as AuthProfile : null, profileError: Boolean(error || !valid) };
});

export async function requireCountryUser(locale: Locale, returnTo: string) {
  const state = await loadAuthProfile();
  const destination = safeAuthDestination(returnTo, locale);
  if (!state.user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent(destination)}`);
  if (state.profileError || !state.profile) redirect(`/${locale}/auth/complete-profile?profileError=1`);
  if (needsProfileOnboarding(state.profile)) redirect(profileDestination(state.profile, locale, destination));
  return { ...state, user: state.user, profile: state.profile };
}
