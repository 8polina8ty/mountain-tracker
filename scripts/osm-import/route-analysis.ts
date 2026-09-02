import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type MatchablePeak,
  type PeakMatchCandidate,
} from "./peak-matcher.ts";
import {
  calculateRouteQuality,
  classifyRouteSemantics,
  type ClassifiableRoute,
  type RouteSemanticClassification,
  type RouteSemanticType,
} from "./route-classifier.ts";

export type FinalSummitAssociation = "CONFIRMED" | "REVIEW" | "REJECTED";

export interface NearestEndpointPeak {
  peakSourceId: string;
  peakSourceUrl: string;
  peakName: string | null;
  peakElevation: number | null;
  coordinate: Coordinate;
  distanceMeters: number;
}

export interface ComponentEndpointAnalysis {
  componentIndex: number;
  start: Coordinate;
  end: Coordinate;
  nearestStartPeak: NearestEndpointPeak | null;
  nearestEndPeak: NearestEndpointPeak | null;
}

export interface FinalAssociationResult {
  peakSourceId: string;
  peakSourceUrl: string;
  peakName: string | null;
  peakElevation: number | null;
  geometricClassification: PeakMatchCandidate["classification"];
  geometricConfidence: number;
  minDistanceMeters: number;
  endpointDistanceMeters: number;
  nearEndpoint: boolean;
  routeSemanticType: RouteSemanticType;
  finalAssociation: FinalSummitAssociation;
  finalConfidence: number;
  reasons: string[];
}

export interface RouteAnalysisResult {
  routeSourceId: string;
  routeSourceUrl: string;
  routeName: string;
  semanticType: RouteSemanticType;
  semanticConfidence: number;
  semanticReasons: string[];
  qualityScore: number;
  qualityReasons: string[];
  routeMetadata: {
    ref: string | null;
    network: string | null;
    operator: string | null;
    routeType: string;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
    distanceMeters: number;
    coordinatePoints: number;
    geometryType: "LineString" | "MultiLineString";
    componentCount: number;
  };
  components: ComponentEndpointAnalysis[];
  summitAssociations: FinalAssociationResult[];
}

export type EndpointPeakResolver = (
  coordinate: Coordinate,
) => MatchablePeak | null;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimalPlaces: number): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

function routeComponents(route: ClassifiableRoute): Coordinate[][] {
  return route.geometry.type === "LineString"
    ? [route.geometry.coordinates]
    : route.geometry.coordinates;
}

function nearestPeakToCoordinate(
  coordinate: Coordinate,
  peaks: MatchablePeak[],
  resolver?: EndpointPeakResolver,
): NearestEndpointPeak | null {
  if (resolver) {
    const peak = resolver(coordinate);
    if (!peak) {
      return null;
    }
    return {
      peakSourceId: peak.sourceId,
      peakSourceUrl: peak.sourceUrl,
      peakName: peak.name,
      peakElevation: peak.elevationMeters,
      coordinate: peak.coordinates,
      distanceMeters: round(
        calculateCoordinateDistanceMeters(coordinate, peak.coordinates),
        1,
      ),
    };
  }

  let nearest:
    | { peak: MatchablePeak; distanceMeters: number }
    | undefined;

  for (const peak of peaks) {
    const distanceMeters = calculateCoordinateDistanceMeters(
      coordinate,
      peak.coordinates,
    );

    if (!nearest || distanceMeters < nearest.distanceMeters) {
      nearest = { peak, distanceMeters };
    }
  }

  if (!nearest) {
    return null;
  }

  return {
    peakSourceId: nearest.peak.sourceId,
    peakSourceUrl: nearest.peak.sourceUrl,
    peakName: nearest.peak.name,
    peakElevation: nearest.peak.elevationMeters,
    coordinate: nearest.peak.coordinates,
    distanceMeters: round(nearest.distanceMeters, 1),
  };
}

export function analyzeComponentEndpoints(
  route: ClassifiableRoute,
  peaks: MatchablePeak[],
  resolver?: EndpointPeakResolver,
): ComponentEndpointAnalysis[] {
  return routeComponents(route).map((component, componentIndex) => {
    if (component.length < 2) {
      throw new Error(
        `Route ${route.sourceId} component ${componentIndex} has no usable line segment`,
      );
    }

    const start = component[0];
    const end = component[component.length - 1];

    return {
      componentIndex,
      start,
      end,
      nearestStartPeak: nearestPeakToCoordinate(start, peaks, resolver),
      nearestEndPeak: nearestPeakToCoordinate(end, peaks, resolver),
    };
  });
}

function determineFinalAssociation(
  candidate: PeakMatchCandidate,
  semanticType: RouteSemanticType,
): FinalSummitAssociation {
  if (candidate.classification === "REJECTED") {
    return "REJECTED";
  }

  if (candidate.classification === "POSSIBLE") {
    return "REVIEW";
  }

  const exactEndpoint = candidate.endpointDistanceMeters <= 10;
  if (exactEndpoint && semanticType !== "long_distance_trail") {
    return "CONFIRMED";
  }

  return "REVIEW";
}

function calculateFinalConfidence(
  candidate: PeakMatchCandidate,
  semanticType: RouteSemanticType,
  finalAssociation: FinalSummitAssociation,
): number {
  if (finalAssociation === "REJECTED") {
    return round(clamp(candidate.confidence * 0.5, 0, 0.49), 3);
  }

  const exactEndpoint = candidate.endpointDistanceMeters <= 10;
  let confidence = candidate.confidence;

  if (candidate.classification === "POSSIBLE") {
    confidence -= 0.1;
  }

  if (exactEndpoint) {
    confidence += 0.05;
  }

  if (semanticType === "summit_route") {
    confidence += 0.05;
  } else if (semanticType === "long_distance_trail") {
    confidence -= exactEndpoint ? 0.1 : 0.25;
  } else if (semanticType === "via_ferrata") {
    confidence += 0.02;
  }

  return round(clamp(confidence, 0, 1), 3);
}

function buildAssociationReasons(
  candidate: PeakMatchCandidate,
  semantics: RouteSemanticClassification,
  finalAssociation: FinalSummitAssociation,
): string[] {
  const reasons = [
    `Phase 2 geometry is ${candidate.classification} at ${candidate.minDistanceMeters} m from the route.`,
    `Nearest component endpoint is ${candidate.endpointDistanceMeters} m from the peak.`,
    `Route semantic type is ${semantics.semanticType} (${semantics.confidence.toFixed(2)} confidence).`,
  ];

  if (candidate.endpointDistanceMeters <= 10) {
    reasons.push("Peak is within 10 m of a component endpoint.");
  }

  if (candidate.classification === "POSSIBLE") {
    reasons.push("POSSIBLE geometry cannot be automatically confirmed in Phase 3.");
  }

  if (semantics.semanticType === "long_distance_trail") {
    reasons.push(
      "Long-distance trail semantics prevent proximity alone from confirming a summit association.",
    );
  }

  if (finalAssociation === "CONFIRMED") {
    reasons.push(
      "Confirmed because MATCHED geometry ends extremely close to the summit and semantics do not indicate an unrelated long-distance trail.",
    );
  } else if (finalAssociation === "REVIEW") {
    reasons.push("Evidence is retained for human review but is not strong enough to confirm.");
  } else {
    reasons.push("Rejected because Phase 2 geometry exceeds the 150 m plausibility threshold.");
  }

  return reasons;
}

export function decideSummitAssociation(
  candidate: PeakMatchCandidate,
  semantics: RouteSemanticClassification,
): FinalAssociationResult {
  const finalAssociation = determineFinalAssociation(
    candidate,
    semantics.semanticType,
  );

  return {
    peakSourceId: candidate.peakSourceId,
    peakSourceUrl: candidate.peakSourceUrl,
    peakName: candidate.peakName,
    peakElevation: candidate.peakElevation,
    geometricClassification: candidate.classification,
    geometricConfidence: candidate.confidence,
    minDistanceMeters: candidate.minDistanceMeters,
    endpointDistanceMeters: candidate.endpointDistanceMeters,
    nearEndpoint: candidate.nearEndpoint,
    routeSemanticType: semantics.semanticType,
    finalAssociation,
    finalConfidence: calculateFinalConfidence(
      candidate,
      semantics.semanticType,
      finalAssociation,
    ),
    reasons: buildAssociationReasons(candidate, semantics, finalAssociation),
  };
}

export function analyzeRoute(
  route: ClassifiableRoute,
  peaks: MatchablePeak[],
  candidates: PeakMatchCandidate[],
  endpointPeakResolver?: EndpointPeakResolver,
): RouteAnalysisResult {
  const semantics = classifyRouteSemantics(route, candidates);
  const quality = calculateRouteQuality(route);

  return {
    routeSourceId: route.sourceId,
    routeSourceUrl: route.sourceUrl,
    routeName: route.name ?? route.ref ?? `OSM relation ${route.sourceId}`,
    semanticType: semantics.semanticType,
    semanticConfidence: semantics.confidence,
    semanticReasons: semantics.reasons,
    qualityScore: quality.score,
    qualityReasons: quality.reasons,
    routeMetadata: {
      ref: route.ref,
      network: route.network,
      operator: route.operator,
      routeType: route.metadata.route,
      from: route.metadata.from,
      to: route.metadata.to,
      roundtrip: route.metadata.roundtrip,
      osmcSymbol: route.metadata.osmcSymbol,
      distanceMeters: route.stats.distanceMeters,
      coordinatePoints: route.stats.coordinatePoints,
      geometryType: route.geometry.type,
      componentCount: route.stats.componentCount,
    },
    components: analyzeComponentEndpoints(route, peaks, endpointPeakResolver),
    summitAssociations: candidates.map((candidate) =>
      decideSummitAssociation(candidate, semantics),
    ),
  };
}
