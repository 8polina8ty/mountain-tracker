// A license label is evidence, not authorization. Only an explicit, current
// source-registry rights review may return ALLOWED.

import type {
  LicenseStatus,
  SourcePolicyStatus,
  SourceRightsPolicy,
} from "./types.ts";

const RECOGNIZED_LICENSES = new Set([
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "CC-BY-SA-4.0",
  "CC-BY-SA-3.0",
  "ODbL-1.0",
]);

const BLOCKED_PATTERNS = [
  /all rights reserved/i,
  /non[- ]?commercial/i,
  /no[- ]?derivatives/i,
  /CC-BY-NC(?:-|$)/i,
  /CC-BY-ND(?:-|$)/i,
];

export interface LicenseClassification {
  status: LicenseStatus;
  spdx: string | null;
  reason: string;
}

export interface SourcePolicyEvaluation {
  status: SourcePolicyStatus;
  mayDiscover: boolean;
  mayRetainRawGpx: boolean;
  mayPublishNormalizedGeometry: boolean;
  reasons: string[];
}

/**
 * Classifies declared text conservatively. Even recognized licenses require a
 * source-specific review of access terms, redistribution, attribution, and the
 * exact material being offered.
 */
export function classifyLicense(raw: string | null): LicenseClassification {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return {
      status: "BLOCKED",
      spdx: null,
      reason: "No license is declared.",
    };
  }
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      status: "BLOCKED",
      spdx: null,
      reason: "The declared terms contain a redistribution restriction.",
    };
  }
  if (RECOGNIZED_LICENSES.has(value)) {
    return {
      status: "REVIEW_REQUIRED",
      spdx: value,
      reason: "Recognized license; source-specific legal and contractual review is still required.",
    };
  }
  return {
    status: "REVIEW_REQUIRED",
    spdx: null,
    reason: "Unrecognized or custom terms require review.",
  };
}

export function evaluateSourcePolicy(policy: SourceRightsPolicy): SourcePolicyEvaluation {
  const reasons: string[] = [];
  const requiredStatuses = [
    policy.licenseStatus,
    policy.accessPermissionStatus,
    policy.redistributionPermissionStatus,
    policy.normalizedGeometryPublicationPermission,
  ];

  if (policy.lastVerifiedAt === null || !isValidTimestamp(policy.lastVerifiedAt)) {
    reasons.push("Rights review has no valid last-verified timestamp.");
  }
  if (policy.attributionRequired && !policy.attributionText?.trim()) {
    reasons.push("Required attribution text is missing.");
  }
  if (requiredStatuses.includes("BLOCKED")) {
    reasons.push("At least one required permission is blocked.");
  } else if (requiredStatuses.includes("REVIEW_REQUIRED")) {
    reasons.push("At least one required permission still needs review.");
  }

  const status: SourcePolicyStatus =
    requiredStatuses.includes("BLOCKED") ||
    (policy.attributionRequired && !policy.attributionText?.trim())
      ? "BLOCKED"
      : reasons.length > 0
        ? "REVIEW_REQUIRED"
        : "ALLOWED";

  return {
    status,
    mayDiscover: status === "ALLOWED",
    mayRetainRawGpx:
      status === "ALLOWED" && policy.rawGpxRetentionPermission === "ALLOWED",
    mayPublishNormalizedGeometry:
      status === "ALLOWED" &&
      policy.normalizedGeometryPublicationPermission === "ALLOWED",
    reasons,
  };
}

export function isPromotable(status: SourcePolicyStatus): boolean {
  return status === "ALLOWED";
}

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}
