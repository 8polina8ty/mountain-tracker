import type { ClassifiableRoute } from "./route-classifier.ts";

export const MOUNTAIN_ROUTE_TYPES = [
  "hiking",
  "mountaineering",
  "via_ferrata",
  "climbing",
  "ski_touring",
  "mixed",
  "other",
] as const;

export type MountainRouteType = (typeof MOUNTAIN_ROUTE_TYPES)[number];

export interface RouteActivityClassification {
  routeType: MountainRouteType;
  confidence: number;
  manualReviewRequired: boolean;
  evidence: string[];
  conflictingTypes: MountainRouteType[];
}

function evidenceText(route: ClassifiableRoute): string {
  const tags = route.metadata.tags ?? {};
  return [
    route.name,
    route.ref,
    route.network,
    route.operator,
    route.metadata.route,
    route.metadata.from,
    route.metadata.to,
    route.metadata.osmcSymbol,
    ...Object.entries(tags).flatMap(([key, value]) => [`${key}=${value}`, value]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" \n")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en");
}

function hasAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function classifyRouteActivity(
  route: ClassifiableRoute,
): RouteActivityClassification {
  const text = evidenceText(route);
  const tags = route.metadata.tags ?? {};
  const strong = new Map<MountainRouteType, string[]>();
  const add = (type: MountainRouteType, reason: string) => {
    strong.set(type, [...(strong.get(type) ?? []), reason]);
  };

  if (
    hasAny(text, [
      /\bvia[ _-]?ferrata\b/,
      /\bferrat[ae]\b/,
      /\bklettersteig(?:abschnitt)?\b/,
    ]) ||
    /^(?:EEA|EEA-F)$/i.test(tags.cai_scale ?? "") ||
    [tags.route, tags.sport, tags.highway].some((value) => value === "via_ferrata")
  ) {
    add("via_ferrata", "Explicit via-ferrata/Klettersteig identity or CAI EEA evidence.");
  }

  if (
    hasAny(text, [
      /\bski[ _-]?tour(?:ing)?\b/,
      /\bskitour\b/,
      /\bskialpin(?:ism|ismo)?\b/,
      /\bscialpin(?:ismo)?\b/,
    ]) ||
    tags.route === "ski" ||
    tags["piste:type"] === "skitour" ||
    tags.sport === "ski_touring"
  ) {
    add("ski_touring", "Explicit ski-tour activity evidence.");
  }

  const climbingText = text
    .replace(/\bvia[ _-]?ferrata\b/g, "")
    .replace(/\bklettersteig(?:abschnitt)?\b/g, "");
  if (
    hasAny(climbingText, [
      /\bclimb(?:ing)?(?:[ _-]route)?\b/,
      /\bkletterroute\b/,
      /\bescalade\b/,
      /\barrampicata\b/,
    ]) ||
    tags.route === "climbing" ||
    tags.sport === "climbing" ||
    Object.keys(tags).some((key) => key === "climbing" || key.startsWith("climbing:"))
  ) {
    add("climbing", "Explicit climbing activity evidence.");
  }

  if (
    hasAny(text, [
      /\bmountaineer(?:ing)?\b/,
      /\balpin(?:e|ism|ismo)[ _-]?(?:route|tour)?\b/,
      /\bhochtour\b/,
      /\balpinroute\b/,
    ]) ||
    tags.route === "mountaineering" ||
    ["alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking"].includes(
      tags.sac_scale ?? "",
    )
  ) {
    add("mountaineering", "Explicit mountaineering/alpine-route activity evidence.");
  }

  const technicalTypes = [...strong.keys()];
  if (technicalTypes.length > 1) {
    return {
      routeType: "mixed",
      confidence: 0.6,
      manualReviewRequired: true,
      evidence: technicalTypes.flatMap((type) => strong.get(type) ?? []),
      conflictingTypes: technicalTypes.sort(),
    };
  }
  if (technicalTypes.length === 1) {
    const routeType = technicalTypes[0];
    return {
      routeType,
      confidence: 0.95,
      manualReviewRequired: false,
      evidence: strong.get(routeType) ?? [],
      conflictingTypes: [],
    };
  }

  const walkingEvidence =
    route.metadata.route === "hiking" ||
    route.metadata.route === "foot" ||
    ["iwn", "nwn", "rwn", "lwn"].includes(route.network ?? "") ||
    tags.highway === "path" ||
    tags.sac_scale === "hiking" ||
    tags.sac_scale === "mountain_hiking";
  if (walkingEvidence) {
    return {
      routeType: "hiking",
      confidence: 0.9,
      manualReviewRequired: false,
      evidence: [
        "Walking/hiking route or network evidence is present and no technical activity evidence conflicts with it.",
      ],
      conflictingTypes: [],
    };
  }

  return {
    routeType: "other",
    confidence: 0.3,
    manualReviewRequired: true,
    evidence: ["No sufficiently specific activity evidence is available."],
    conflictingTypes: [],
  };
}
