import type {
  MatchableRoute,
  PeakMatchCandidate,
} from "./peak-matcher.ts";

export type RouteSemanticType =
  | "summit_route"
  | "long_distance_trail"
  | "via_ferrata"
  | "local_hike"
  | "approach"
  | "unknown";

export interface ClassifiableRoute extends Omit<MatchableRoute, "metadata"> {
  metadata: MatchableRoute["metadata"] & {
    tags?: Record<string, string>;
  };
}

export interface RouteSemanticClassification {
  semanticType: RouteSemanticType;
  confidence: number;
  reasons: string[];
}

export interface RouteQualityResult {
  score: number;
  reasons: string[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedEvidence(route: ClassifiableRoute): string {
  const tags = route.metadata.tags ?? {};

  return [
    route.name,
    route.ref,
    route.metadata.from,
    route.metadata.to,
    tags.description,
    tags.note,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase("de");
}

function hasStrongLongDistanceIdentity(evidence: string): boolean {
  return (
    /\bvia\s+alpina\b/.test(evidence) ||
    /\bnordalpenweg\b/.test(evidence) ||
    /\bfernwander/.test(evidence) ||
    /\beurop[aä]ischer\s+fernwanderweg\b/.test(evidence) ||
    /(?:^|\W)e\s*4(?:\W|$)/.test(evidence)
  );
}

function matchingSummitEndpoint(
  candidates: PeakMatchCandidate[],
): PeakMatchCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.classification === "MATCHED" &&
      candidate.minDistanceMeters <= 30 &&
      candidate.endpointDistanceMeters <= 10,
  );
}

export function classifyRouteSemantics(
  route: ClassifiableRoute,
  candidates: PeakMatchCandidate[],
): RouteSemanticClassification {
  const evidence = normalizedEvidence(route);
  const strongLongDistanceIdentity = hasStrongLongDistanceIdentity(evidence);
  const internationalOrNationalNetwork =
    route.network === "iwn" || route.network === "nwn";
  const endpointMatch = matchingSummitEndpoint(candidates);

  if (strongLongDistanceIdentity) {
    const reasons = [
      "Name/ref metadata identifies a recognized long-distance trail family.",
    ];
    let confidence = 0.9;

    if (internationalOrNationalNetwork) {
      confidence += 0.05;
      reasons.push(
        `OSM network ${route.network} supports international/national trail semantics.`,
      );
    }

    if (route.stats.distanceMeters >= 40_000) {
      confidence += 0.03;
      reasons.push(
        `Route length ${Math.round(route.stats.distanceMeters / 1_000)} km supports long-distance use.`,
      );
    }

    if (endpointMatch) {
      reasons.push(
        `An exact summit endpoint exists at ${endpointMatch.peakName ?? endpointMatch.peakSourceId}, but trail identity remains long-distance.`,
      );
    }

    return {
      semanticType: "long_distance_trail",
      confidence: clamp(confidence, 0, 0.99),
      reasons,
    };
  }

  if (endpointMatch) {
    return {
      semanticType: "summit_route",
      confidence: 0.96,
      reasons: [
        `${endpointMatch.peakName ?? endpointMatch.peakSourceId} is MATCHED and lies within 10 m of a component endpoint.`,
        "An exact natural=peak endpoint is strong deterministic summit-route evidence.",
      ],
    };
  }

  const explicitFerrataIdentity = /\b(klettersteig|via\s+ferrata|ferrata)\b/.test(
    evidence,
  );
  const ferrataSupport =
    route.stats.distanceMeters <= 30_000 &&
    (Boolean(route.metadata.osmcSymbol) ||
      route.network === "lwn" ||
      route.network === "rwn" ||
      Boolean(route.ref));

  if (explicitFerrataIdentity && ferrataSupport) {
    return {
      semanticType: "via_ferrata",
      confidence: 0.88,
      reasons: [
        "Name/ref metadata explicitly identifies a klettersteig or via ferrata.",
        "Local-scale length plus route metadata supports the ferrata interpretation.",
      ],
    };
  }

  if (/\b(zustieg|approach|access\s+route|h[üu]ttenzustieg)\b/.test(evidence)) {
    return {
      semanticType: "approach",
      confidence: 0.86,
      reasons: [
        "Name/ref metadata explicitly describes an approach or access route.",
      ],
    };
  }

  const usefulIdentity = Boolean(route.name || route.ref);
  const localScale =
    route.stats.distanceMeters >= 250 && route.stats.distanceMeters <= 50_000;
  const localNetwork = route.network === "lwn" || route.network === "rwn";

  if (usefulIdentity && localScale && (localNetwork || Boolean(route.name))) {
    const reasons = [
      `Route length ${Math.round(route.stats.distanceMeters / 1_000)} km is compatible with a local hike.`,
      route.name
        ? "A useful route name is present."
        : "A useful local route reference is present.",
    ];

    if (localNetwork) {
      reasons.push(`OSM network ${route.network} supports local/regional use.`);
    }

    if (/\bsteig\b/.test(evidence) && !explicitFerrataIdentity) {
      reasons.push(
        "A generic 'Steig' name alone is insufficient for via_ferrata classification.",
      );
    }

    return {
      semanticType: "local_hike",
      confidence: localNetwork ? 0.8 : 0.72,
      reasons,
    };
  }

  return {
    semanticType: "unknown",
    confidence: 0.35,
    reasons: [
      "Available name, network, length, and summit evidence do not support a safer specific semantic type.",
    ],
  };
}

function geometryComponents(route: ClassifiableRoute) {
  return route.geometry.type === "LineString"
    ? [route.geometry.coordinates]
    : route.geometry.coordinates;
}

export function calculateRouteQuality(
  route: ClassifiableRoute,
): RouteQualityResult {
  const reasons: string[] = [];
  const components = geometryComponents(route);
  const actualCoordinatePoints = components.reduce(
    (total, component) => total + component.length,
    0,
  );
  let score = 35;

  if (route.name) {
    score += 15;
    reasons.push("+15 useful route name");
  } else {
    score -= 10;
    reasons.push("-10 missing route name");
  }

  if (route.ref) {
    score += 5;
    reasons.push("+5 route reference");
  }

  if (route.network) {
    score += 5;
    reasons.push("+5 OSM hiking network");
  }

  if (route.operator) {
    score += 4;
    reasons.push("+4 route operator");
  }

  if (route.metadata.from && route.metadata.to) {
    score += 6;
    reasons.push("+6 explicit from/to endpoints");
  } else if (route.metadata.from || route.metadata.to) {
    score += 3;
    reasons.push("+3 one explicit named endpoint");
  }

  if (route.metadata.osmcSymbol) {
    score += 5;
    reasons.push("+5 OSM route symbol metadata");
  }

  if (route.metadata.roundtrip) {
    score += 2;
    reasons.push("+2 explicit roundtrip metadata");
  }

  if (components.length === 1) {
    score += 20;
    reasons.push("+20 connected LineString geometry");
  } else if (components.length === 2) {
    score += 10;
    reasons.push("+10 limited fragmentation with two components");
  } else if (components.length <= 5) {
    const penalty = (components.length - 2) * 3;
    score -= penalty;
    reasons.push(`-${penalty} geometry split across ${components.length} components`);
  } else {
    const penalty = Math.min(30, (components.length - 1) * 3);
    score -= penalty;
    reasons.push(`-${penalty} heavily fragmented ${components.length}-component geometry`);
  }

  if (components.length >= 10) {
    score -= 10;
    reasons.push("-10 extreme relation fragmentation");
  }

  if (components.every((component) => component.length >= 2)) {
    score += 5;
    reasons.push("+5 every component has clear start/end coordinates");
  } else {
    score -= 20;
    reasons.push("-20 component without a usable line segment");
  }

  if (
    route.stats.distanceMeters >= 500 &&
    route.stats.distanceMeters <= 100_000
  ) {
    score += 10;
    reasons.push("+10 route length is reasonable for this prototype");
  } else if (route.stats.distanceMeters < 100) {
    score -= 15;
    reasons.push("-15 suspiciously short route geometry");
  } else if (route.stats.distanceMeters > 500_000) {
    score -= 10;
    reasons.push("-10 exceptionally long relation for a local-area prototype");
  } else {
    score += 2;
    reasons.push("+2 usable but atypical route length");
  }

  if (actualCoordinatePoints !== route.stats.coordinatePoints) {
    score -= 10;
    reasons.push("-10 stored coordinate count does not match geometry");
  }

  return { score: Math.round(clamp(score, 0, 100)), reasons };
}
