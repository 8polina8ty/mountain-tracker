import type { ApprovedStagingRouteListItem } from "./core.ts";
import { classifyRouteActivity } from "../../scripts/osm-import/route-activity-classifier.ts";

export type AutoQaRecommendation = "GREEN" | "YELLOW" | "RED";
export const AUTO_APPROVAL_ENABLED = false as const;

export interface AutoQaRecommendationResult {
  recommendation: AutoQaRecommendation;
  score: number;
  reasonCodes: string[];
  explanation: string;
}

export interface AutoQaReasonCode {
  code: string;
  label: string;
  description: string;
  category: "positive" | "warning" | "blocking";
  weight: number;
}

export const AUTO_QA_REASON_CODES: AutoQaReasonCode[] = [
  {
    code: "CONFIRMED_SUMMIT",
    label: "Confirmed summit",
    description: "Summit has CONFIRMED final association with EXACT_MOUNTAIN_MATCH",
    category: "positive",
    weight: 10,
  },
  {
    code: "EXACT_MOUNTAIN_MATCH",
    label: "Exact mountain match",
    description: "Summit resolves to Mountain Tracker mountain via OSM ID",
    category: "positive",
    weight: 10,
  },
  {
    code: "SIMPLE_TOPOLOGY",
    label: "Simple topology",
    description: "Single LineString component, no branching or disconnected geometry",
    category: "positive",
    weight: 6,
  },
  {
    code: "QUALITY_100",
    label: "Quality 100",
    description: "Maximum quality score (100/100)",
    category: "positive",
    weight: 6,
  },
  {
    code: "NO_WARNINGS",
    label: "No warnings",
    description: "No audit flags or topology warnings",
    category: "positive",
    weight: 10,
  },
  {
    code: "ACTIVITY_SAFE",
    label: "Activity classification safe",
    description: "Activity is hiking with manualReviewRequired=false",
    category: "positive",
    weight: 6,
  },
  {
    code: "SEMANTIC_SUMMIT_ROUTE",
    label: "Summit route semantic type",
    description: "Route semantic type is summit_route (not local_hike/approach)",
    category: "positive",
    weight: 5,
  },
  {
    code: "VALID_GEOMETRY",
    label: "Valid geometry",
    description: "Geometry is valid LineString with finite coordinates",
    category: "positive",
    weight: 3,
  },
  {
    code: "MANUAL_REVIEW_FALSE",
    label: "Manual review not required",
    description: "Activity classification has manualReviewRequired=false",
    category: "positive",
    weight: 5,
  },
  {
    code: "HIGH_CONFIDENCE_ACTIVITY",
    label: "High activity confidence",
    description: "Activity classification confidence >= 0.95",
    category: "positive",
    weight: 3,
  },
  {
    code: "ADMIN_ASSIGNED",
    label: "Admin boundary assigned",
    description: "Administrative boundary status is ASSIGNED",
    category: "positive",
    weight: 2,
  },

  {
    code: "WARNING_PRESENT",
    label: "Has warnings",
    description: "Route has audit flags or topology warnings",
    category: "warning",
    weight: -20,
  },
  {
    code: "AUDIT_FLAGS_PRESENT",
    label: "Audit flags present",
    description: "Route has audit evidence flags requiring attention",
    category: "warning",
    weight: -15,
  },
  {
    code: "TOPOLOGY_WARNING",
    label: "Topology warning",
    description: "Route has endpoint selection ambiguity (BRANCHING/DISCONNECTED)",
    category: "warning",
    weight: -15,
  },
  {
    code: "QUALITY_BELOW_90",
    label: "Quality below 90",
    description: "Quality score is 80-89 (below optimal)",
    category: "warning",
    weight: -10,
  },
  {
    code: "QUALITY_BELOW_80",
    label: "Quality below 80",
    description: "Quality score is below 80 (below threshold)",
    category: "warning",
    weight: -30,
  },
  {
    code: "ACTIVITY_REQUIRES_REVIEW",
    label: "Activity requires manual review",
    description: "Activity classification has manualReviewRequired=true",
    category: "warning",
    weight: -20,
  },
  {
    code: "NON_HIKING_ACTIVITY",
    label: "Non-hiking activity",
    description: "Activity classification is not hiking",
    category: "warning",
    weight: -15,
  },
  {
    code: "ADMIN_UNASSIGNED",
    label: "Admin boundary unassigned",
    description: "Administrative boundary status is UNASSIGNED or AMBIGUOUS",
    category: "warning",
    weight: -8,
  },
  {
    code: "MULTIPLE_CONFIRMED_SUMMITS",
    label: "Multiple confirmed summits",
    description: "Route has multiple CONFIRMED summits (increases complexity)",
    category: "warning",
    weight: -5,
  },
  {
    code: "CONFIDENCE_BELOW_09",
    label: "Low activity confidence",
    description: "Activity classification confidence < 0.9",
    category: "warning",
    weight: -8,
  },

  {
    code: "NO_CONFIRMED_SUMMIT",
    label: "No confirmed summit",
    description: "No summit with CONFIRMED final association",
    category: "blocking",
    weight: -60,
  },
  {
    code: "NO_EXACT_MOUNTAIN_MATCH",
    label: "No exact mountain match",
    description: "Summit lacks EXACT_MOUNTAIN_MATCH classification",
    category: "blocking",
    weight: -60,
  },
  {
    code: "ACTIVITY_MANUAL_REVIEW_REQUIRED",
    label: "Activity requires manual review",
    description: "Activity classification has manualReviewRequired=true",
    category: "blocking",
    weight: -40,
  },
  {
    code: "NON_HIKING_ROUTE_TYPE",
    label: "Non-hiking route type",
    description: "Activity route type is not hiking (via_ferrata, climbing, etc.)",
    category: "blocking",
    weight: -40,
  },
  {
    code: "COMPLEX_TOPOLOGY",
    label: "Complex topology",
    description: "MultiLineString or branching/disconnected topology",
    category: "blocking",
    weight: -40,
  },
  {
    code: "QUALITY_BELOW_THRESHOLD",
    label: "Quality below threshold",
    description: "Quality score below 80 (minimum for publication)",
    category: "blocking",
    weight: -50,
  },
  {
    code: "INVALID_GEOMETRY",
    label: "Invalid geometry",
    description: "Geometry is invalid or has non-finite coordinates",
    category: "blocking",
    weight: -60,
  },
  {
    code: "DUPLICATE_RELATION",
    label: "Duplicate relation",
    description: "Canonical source relation already exists in production",
    category: "blocking",
    weight: -50,
  },
  {
    code: "SEMANTIC_NOT_SUMMIT_ROUTE",
    label: "Not a summit route",
    description: "Semantic type is not summit_route",
    category: "blocking",
    weight: -60,
  },
];

function reasonCode(code: string): AutoQaReasonCode | undefined {
  return AUTO_QA_REASON_CODES.find((r) => r.code === code);
}

function applyReasonCodes(codes: string[]): number {
  return codes.reduce((sum, code) => sum + (reasonCode(code)?.weight ?? 0), 0);
}

export function computeAutoQaRecommendation(
  route: ApprovedStagingRouteListItem,
  activity: ReturnType<typeof classifyRouteActivity>,
): AutoQaRecommendationResult {
  const codes: string[] = [];

  if (route.summit.finalAssociation === "CONFIRMED") {
    codes.push("CONFIRMED_SUMMIT");
  } else {
    codes.push("NO_CONFIRMED_SUMMIT");
  }

  if (route.summit.matchClassification === "EXACT_MOUNTAIN_MATCH") {
    codes.push("EXACT_MOUNTAIN_MATCH");
  } else {
    codes.push("NO_EXACT_MOUNTAIN_MATCH");
  }

  if (route.diagnostics.topologyClassification === "SIMPLE") {
    codes.push("SIMPLE_TOPOLOGY");
    codes.push("VALID_GEOMETRY");
  } else {
    codes.push("COMPLEX_TOPOLOGY");
    codes.push("INVALID_GEOMETRY");
  }

  if (route.qualityScore === 100) {
    codes.push("QUALITY_100");
  } else if (route.qualityScore >= 90) {
    codes.push("QUALITY_90_PLUS");
  } else if (route.qualityScore < 80) {
    codes.push("QUALITY_BELOW_THRESHOLD");
  } else if (route.qualityScore < 90) {
    codes.push("QUALITY_BELOW_90");
  }

  if (route.warnings.length === 0 && route.auditFlags.length === 0) {
    codes.push("NO_WARNINGS");
  } else {
    codes.push("WARNING_PRESENT");
    if (route.auditFlags.length > 0) codes.push("AUDIT_FLAGS_PRESENT");
    if (route.diagnostics.endpointSelectionWarning) codes.push("TOPOLOGY_WARNING");
  }

  if (activity.routeType === "hiking") {
    codes.push("ACTIVITY_SAFE");
  } else {
    codes.push("NON_HIKING_ACTIVITY");
    codes.push("NON_HIKING_ROUTE_TYPE");
  }

  if (activity.manualReviewRequired) {
    codes.push("ACTIVITY_MANUAL_REVIEW_REQUIRED");
    codes.push("ACTIVITY_REQUIRES_REVIEW");
  } else {
    codes.push("MANUAL_REVIEW_FALSE");
  }

  if (activity.confidence >= 0.95) {
    codes.push("HIGH_CONFIDENCE_ACTIVITY");
  } else if (activity.confidence < 0.9) {
    codes.push("CONFIDENCE_BELOW_09");
  }

  if (route.semanticType === "summit_route") {
    codes.push("SEMANTIC_SUMMIT_ROUTE");
  } else {
    codes.push("SEMANTIC_NOT_SUMMIT_ROUTE");
  }

  if (route.administrationStatus === "ASSIGNED") {
    codes.push("ADMIN_ASSIGNED");
  } else {
    codes.push("ADMIN_UNASSIGNED");
  }

  if (route.qualityScore < 80) codes.push("QUALITY_BELOW_THRESHOLD");
  if (route.qualityScore < 90 && route.qualityScore >= 80) codes.push("QUALITY_BELOW_90");

  const score = Math.max(0, Math.min(100, 25 + applyReasonCodes(codes)));

  let recommendation: AutoQaRecommendation;
  if (score >= 70) recommendation = "GREEN";
  else if (score >= 40) recommendation = "YELLOW";
  else recommendation = "RED";

  const positiveReasons = codes.filter((c) => reasonCode(c)?.category === "positive").map((c) => reasonCode(c)!.label);
  const warningReasons = codes.filter((c) => reasonCode(c)?.category === "warning").map((c) => reasonCode(c)!.label);
  const blockingReasons = codes.filter((c) => reasonCode(c)?.category === "blocking").map((c) => reasonCode(c)!.label);

  let explanation = "";
  if (recommendation === "GREEN") {
    explanation = `Strong evidence for approval: ${positiveReasons.join(", ")}`;
  } else if (recommendation === "YELLOW") {
    explanation = `Caution: ${warningReasons.join(", ")}`;
  } else {
    explanation = `Blocked: ${blockingReasons.join(", ")}`;
  }

  return {
    recommendation,
    score,
    reasonCodes: codes,
    explanation,
  };
}

export function getRecommendationDisplayInfo(rec: AutoQaRecommendationResult): {
  color: "success" | "warning" | "danger";
  label: string;
  description: string;
} {
  switch (rec.recommendation) {
    case "GREEN":
      return { color: "success", label: "GREEN — Recommended for approval", description: rec.explanation };
    case "YELLOW":
      return { color: "warning", label: "YELLOW — Review carefully", description: rec.explanation };
    case "RED":
      return { color: "danger", label: "RED — Not recommended", description: rec.explanation };
  }
}
