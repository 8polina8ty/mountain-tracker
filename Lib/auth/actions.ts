"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/Lib/supabase/server";
import { isCountryCode } from "@/Lib/countries";
import { isLocale } from "@/i18n/locales";
import { profileErrorKey, validateProfileInput } from "./profile";
import { safeAuthDestination } from "./redirects";

export async function checkRegistrationInput(username: string, country: string): Promise<{ error: string | null }> {
  const invalid = validateProfileInput(username, country);
  if (invalid) return { error: invalid };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("is_profile_username_available", { requested_username: username.trim() });
    return { error: error ? "error" : data === true ? null : "usernameUnavailable" };
  } catch { return { error: "error" }; }
}

export async function completeProfile(input: { username: string; country: string; locale: string; returnTo?: string | null }) {
  if (!isLocale(input?.locale)) return { error: "error", destination: null };
  const invalid = validateProfileInput(input.username, input.country);
  if (invalid) return { error: invalid, destination: null };
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { error: "signInRequired", destination: null };
    const { error } = await supabase.rpc("complete_user_profile", {
      requested_username: input.username.trim(), requested_country_code: input.country,
    });
    if (error) return { error: profileErrorKey(error), destination: null };
    revalidatePath(`/${input.locale}/account`, "layout");
    return { error: null, destination: safeAuthDestination(input.returnTo, input.locale) };
  } catch { return { error: "error", destination: null }; }
}

export async function changeResidenceCountry(country: string, locale: string): Promise<{ error: string | null }> {
  if (!isLocale(locale) || !isCountryCode(country)) return { error: "countryRequired" };
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { error: "signInRequired" };
    const { error } = await supabase.rpc("update_my_residence_country", { requested_country_code: country });
    if (error) return { error: profileErrorKey(error) };
    revalidatePath(`/${locale}/account`, "layout");
    revalidatePath(`/${locale}/ranking`);
    return { error: null };
  } catch { return { error: "error" }; }
}

