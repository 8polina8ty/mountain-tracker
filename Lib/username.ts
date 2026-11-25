/**
 * Canonical Mountain Tracker username contract (new users, Phase 3).
 * - trim before validation
 * - length 3..20 Unicode codepoints
 * - allowed: A-Z a-z 0-9 _ . -
 * - first/last: A-Z a-z 0-9 _
 * - case-insensitive identity (lower() unique is future, not yet enforced)
 */
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$/;

export type UsernameValidationError =
  | "usernameRequired"
  | "usernameTooShort"
  | "usernameTooLong"
  | "usernameInvalidChars"
  | "usernameInvalidEdges";

export function normalizeUsername(input: string): string {
  return input.trim();
}

export function validateUsername(input: string): UsernameValidationError | null {
  const value = normalizeUsername(input);
  if (!value) return "usernameRequired";
  const len = [...value].length;
  if (len < 3) return "usernameTooShort";
  if (len > 20) return "usernameTooLong";
  if (!USERNAME_RE.test(value)) {
    // Distinguish invalid chars vs edges for better i18n, but both map to invalidChars if needed
    if (/^[A-Za-z0-9_.-]+$/.test(value) === false) return "usernameInvalidChars";
    return "usernameInvalidEdges";
  }
  return null;
}

export function isValidUsername(input: string): boolean {
  return validateUsername(input) === null;
}

// Legacy usernames outside canonical 3..20 may exist (permissive sign-up before Phase 3).
// They remain valid accounts but are not @mentionable until a future normalization migration.
// Mention parser intentionally matches only canonical 3..20 to stay aligned.
