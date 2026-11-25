import { isCountryCode } from "../countries.ts";
import { isValidUsername, validateUsername } from "../username.ts";
import { safeAuthDestination } from "./redirects.ts";

export type AuthProfile = { username: string | null; country_code: string | null; onboarding_required: boolean };

export function isProfileComplete(profile: AuthProfile | null): boolean {
  return Boolean(profile && typeof profile.username === "string" &&
    isValidUsername(profile.username) && profile.username === profile.username.trim() && isCountryCode(profile.country_code));
}

export function needsProfileOnboarding(profile: AuthProfile | null): boolean {
  // Missing rows fail closed; NULL country alone never locks out a legacy account.
  return !profile || (profile.onboarding_required && !isProfileComplete(profile));
}

export function profileDestination(profile: AuthProfile, locale: string, returnTo: unknown): string {
  const destination = safeAuthDestination(returnTo, locale);
  return needsProfileOnboarding(profile)
    ? `/${locale}/auth/complete-profile?returnTo=${encodeURIComponent(destination)}` : destination;
}

export function validateProfileInput(username: unknown, country: unknown) {
  if (typeof username !== "string") return "usernameRequired" as const;
  return validateUsername(username) ?? (isCountryCode(country) ? null : "countryRequired" as const);
}

export function profileErrorKey(error: { message?: string; code?: string } | null): string {
  if (error?.message?.includes("username_unavailable") || error?.code === "23505") return "usernameUnavailable";
  if (error?.message?.includes("username_invalid")) return "usernameInvalid";
  if (error?.message?.includes("country_invalid")) return "countryRequired";
  if (error?.message?.includes("profile_already_completed")) return "alreadyCompleted";
  if (error?.message?.includes("profile_incomplete")) return "profileIncomplete";
  if (error?.message?.includes("auth_required")) return "signInRequired";
  return "error";
}
