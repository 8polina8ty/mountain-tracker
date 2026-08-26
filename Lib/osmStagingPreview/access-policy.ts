export interface PreviewAccessInput {
  nodeEnv: string | undefined;
  enabled: string | undefined;
  allowedUserIds: string | undefined;
  authenticatedUserId: string | null;
}

export interface PreviewAccessDecision {
  allowed: boolean;
  reason:
    | "PRODUCTION_DISABLED"
    | "PREVIEW_DISABLED"
    | "AUTHENTICATION_REQUIRED"
    | "ALLOWLIST_REQUIRED"
    | "USER_NOT_ALLOWLISTED"
    | "ALLOWED";
}

export function parseAllowedPreviewUserIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))]
    .sort();
}

export function evaluatePreviewAccess(input: PreviewAccessInput): PreviewAccessDecision {
  if (input.nodeEnv === "production") {
    return { allowed: false, reason: "PRODUCTION_DISABLED" };
  }
  if (input.enabled !== "true") {
    return { allowed: false, reason: "PREVIEW_DISABLED" };
  }
  if (!input.authenticatedUserId) {
    return { allowed: false, reason: "AUTHENTICATION_REQUIRED" };
  }
  const allowedUserIds = parseAllowedPreviewUserIds(input.allowedUserIds);
  if (allowedUserIds.length === 0) {
    return { allowed: false, reason: "ALLOWLIST_REQUIRED" };
  }
  if (!allowedUserIds.includes(input.authenticatedUserId)) {
    return { allowed: false, reason: "USER_NOT_ALLOWLISTED" };
  }
  return { allowed: true, reason: "ALLOWED" };
}
