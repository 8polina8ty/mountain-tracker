export type Coordinate = [longitude: number, latitude: number];
export type PeakClassification = "MATCHED" | "POSSIBLE" | "REJECTED";

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Coordinate[];
}

export interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: Coordinate[][];
}

export type RouteGeometry = LineStringGeometry | MultiLineStringGeometry;

export interface MatchableRoute {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  ref: string | null;
  network: string | null;
  operator: string | null;
  geometry: RouteGeometry;
  stats: {
    distanceMeters: number;
    coordinatePoints: number;
    componentCount: number;
  };
  metadata: {
    route: string;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
  };
}

export interface MatchablePeak {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  coordinates: Coordinate;
  elevationMeters: number | null;
}

export interface PeakMatchThresholds {
  candidateSearchMeters: number;
  directMatchMeters: number;
  endpointAssistedMatchMeters: number;
  nearEndpointMeters: number;
  possibleMeters: number;
}

export interface PeakMatchCandidate {
  peakSourceId: string;
  peakSourceUrl: string;
  peakName: string | null;
  peakElevation: number | null;
  peakCoordinate: Coordinate;
  minDistanceMeters: number;
  nearestRouteCoordinate: Coordinate;
  componentIndex: number;
  segmentIndex: number;
  projectionFraction: number;
  endpointDistanceMeters: number;
  nearestEndpointCoordinate: Coordinate;
  nearestEndpointComponentIndex: number;
  nearestEndpointPosition: "start" | "end";
  nearEndpoint: boolean;
  classification: PeakClassification;
  confidence: number;
  reasons: string[];
}

interface NearestSegmentResult {
  distanceMeters: number;
  coordinate: Coordinate;
  componentIndex: number;
  segmentIndex: number;
  projectionFraction: number;
}

interface NearestEndpointResult {
  distanceMeters: number;
  coordinate: Coordinate;
  componentIndex: number;
  position: "start" | "end";
}

export const DEFAULT_PEAK_MATCH_THRESHOLDS: Readonly<PeakMatchThresholds> = {
  candidateSearchMeters: 500,
  directMatchMeters: 30,
  endpointAssistedMatchMeters: 60,
  nearEndpointMeters: 100,
  possibleMeters: 150,
};

const EARTH_RADIUS_METERS = 6_371_008.8;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimalPlaces: number): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

function roundCoordinate(coordinate: Coordinate): Coordinate {
  return [round(coordinate[0], 7), round(coordinate[1], 7)];
}

function assertCoordinate(coordinate: Coordinate, context: string): void {
  if (
    coordinate.length !== 2 ||
    !Number.isFinite(coordinate[0]) ||
    !Number.isFinite(coordinate[1])
  ) {
    throw new Error(`${context} is not a finite longitude/latitude coordinate`);
  }
}

function getComponents(geometry: RouteGeometry): Coordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

export function calculateCoordinateDistanceMeters(
  start: Coordinate,
  end: Coordinate,
): number {
  const latitudeDelta = degreesToRadians(end[1] - start[1]);
  const longitudeDelta = degreesToRadians(end[0] - start[0]);
  const startLatitude = degreesToRadians(start[1]);
  const endLatitude = degreesToRadians(end[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function nearestPointOnSegment(
  peak: Coordinate,
  start: Coordinate,
  end: Coordinate,
): { distanceMeters: number; coordinate: Coordinate; fraction: number } {
  const latitudeScale = EARTH_RADIUS_METERS;
  const longitudeScale =
    EARTH_RADIUS_METERS * Math.cos(degreesToRadians(peak[1]));
  const startX = degreesToRadians(start[0] - peak[0]) * longitudeScale;
  const startY = degreesToRadians(start[1] - peak[1]) * latitudeScale;
  const endX = degreesToRadians(end[0] - peak[0]) * longitudeScale;
  const endY = degreesToRadians(end[1] - peak[1]) * latitudeScale;
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
  const fraction =
    segmentLengthSquared === 0
      ? 0
      : clamp(
          -(startX * segmentX + startY * segmentY) / segmentLengthSquared,
          0,
          1,
        );
  const nearestX = startX + fraction * segmentX;
  const nearestY = startY + fraction * segmentY;

  return {
    distanceMeters: Math.hypot(nearestX, nearestY),
    coordinate: [
      start[0] + fraction * (end[0] - start[0]),
      start[1] + fraction * (end[1] - start[1]),
    ],
    fraction,
  };
}

function findNearestSegment(
  geometry: RouteGeometry,
  peak: Coordinate,
): NearestSegmentResult {
  const components = getComponents(geometry);
  let nearest: NearestSegmentResult | null = null;

  components.forEach((component, componentIndex) => {
    component.forEach((coordinate, coordinateIndex) =>
      assertCoordinate(
        coordinate,
        `route component ${componentIndex} coordinate ${coordinateIndex}`,
      ),
    );

    for (let segmentIndex = 0; segmentIndex < component.length - 1; segmentIndex += 1) {
      const projection = nearestPointOnSegment(
        peak,
        component[segmentIndex],
        component[segmentIndex + 1],
      );

      if (!nearest || projection.distanceMeters < nearest.distanceMeters) {
        nearest = {
          distanceMeters: projection.distanceMeters,
          coordinate: projection.coordinate,
          componentIndex,
          segmentIndex,
          projectionFraction: projection.fraction,
        };
      }
    }
  });

  if (!nearest) {
    throw new Error("route geometry contains no line segment");
  }

  return nearest;
}

function findNearestEndpoint(
  geometry: RouteGeometry,
  peak: Coordinate,
): NearestEndpointResult {
  const components = getComponents(geometry);
  let nearest: NearestEndpointResult | null = null;

  components.forEach((component, componentIndex) => {
    if (component.length === 0) {
      return;
    }

    const endpoints: Array<{
      coordinate: Coordinate;
      position: "start" | "end";
    }> = [
      { coordinate: component[0], position: "start" },
      { coordinate: component[component.length - 1], position: "end" },
    ];

    endpoints.forEach(({ coordinate, position }) => {
      const distanceMeters = calculateCoordinateDistanceMeters(peak, coordinate);
      if (!nearest || distanceMeters < nearest.distanceMeters) {
        nearest = { distanceMeters, coordinate, componentIndex, position };
      }
    });
  });

  if (!nearest) {
    throw new Error("route geometry contains no endpoint");
  }

  return nearest;
}

export function classifyPeakCandidate(
  minDistanceMeters: number,
  endpointDistanceMeters: number,
  thresholds: PeakMatchThresholds = DEFAULT_PEAK_MATCH_THRESHOLDS,
): PeakClassification {
  if (minDistanceMeters <= thresholds.directMatchMeters) {
    return "MATCHED";
  }

  if (
    minDistanceMeters <= thresholds.endpointAssistedMatchMeters &&
    endpointDistanceMeters <= thresholds.nearEndpointMeters
  ) {
    return "MATCHED";
  }

  if (minDistanceMeters <= thresholds.possibleMeters) {
    return "POSSIBLE";
  }

  return "REJECTED";
}

export function calculatePeakMatchConfidence(
  minDistanceMeters: number,
  endpointDistanceMeters: number,
  thresholds: PeakMatchThresholds = DEFAULT_PEAK_MATCH_THRESHOLDS,
): number {
  let distanceScore: number;

  if (minDistanceMeters <= thresholds.directMatchMeters) {
    const progress = minDistanceMeters / thresholds.directMatchMeters;
    distanceScore = 0.98 - progress * 0.1;
  } else if (minDistanceMeters <= thresholds.possibleMeters) {
    const progress =
      (minDistanceMeters - thresholds.directMatchMeters) /
      (thresholds.possibleMeters - thresholds.directMatchMeters);
    distanceScore = 0.88 - progress * 0.63;
  } else {
    const progress =
      (minDistanceMeters - thresholds.possibleMeters) /
      (thresholds.candidateSearchMeters - thresholds.possibleMeters);
    distanceScore = 0.25 - clamp(progress, 0, 1) * 0.25;
  }

  const endpointProximity = clamp(
    1 - endpointDistanceMeters / thresholds.nearEndpointMeters,
    0,
    1,
  );
  const endpointBonus = endpointProximity * 0.05;

  return round(clamp(distanceScore + endpointBonus, 0, 1), 3);
}

function buildReasons(
  nearestSegment: NearestSegmentResult,
  nearestEndpoint: NearestEndpointResult,
  classification: PeakClassification,
  thresholds: PeakMatchThresholds,
): string[] {
  const reasons = [
    `Nearest point is ${round(nearestSegment.distanceMeters, 1)} m from route component ${nearestSegment.componentIndex}, segment ${nearestSegment.segmentIndex}.`,
    `Nearest component endpoint is ${round(nearestEndpoint.distanceMeters, 1)} m away.`,
  ];

  if (nearestEndpoint.distanceMeters <= thresholds.nearEndpointMeters) {
    reasons.push(
      `Endpoint proximity is within the ${thresholds.nearEndpointMeters} m endpoint threshold.`,
    );
  }

  if (classification === "MATCHED") {
    reasons.push(
      nearestSegment.distanceMeters <= thresholds.directMatchMeters
        ? `Classified MATCHED because route distance is within ${thresholds.directMatchMeters} m.`
        : `Classified MATCHED because route distance is within ${thresholds.endpointAssistedMatchMeters} m and endpoint distance is within ${thresholds.nearEndpointMeters} m.`,
    );
  } else if (classification === "POSSIBLE") {
    reasons.push(
      `Classified POSSIBLE because route distance is within ${thresholds.possibleMeters} m but did not meet a MATCHED rule.`,
    );
  } else {
    reasons.push(
      `Classified REJECTED because route distance exceeds ${thresholds.possibleMeters} m.`,
    );
  }

  return reasons;
}

export function matchPeakToRoute(
  route: MatchableRoute,
  peak: MatchablePeak,
  thresholds: PeakMatchThresholds = DEFAULT_PEAK_MATCH_THRESHOLDS,
): PeakMatchCandidate | null {
  assertCoordinate(peak.coordinates, `peak ${peak.sourceId}`);
  const nearestSegment = findNearestSegment(route.geometry, peak.coordinates);

  if (nearestSegment.distanceMeters > thresholds.candidateSearchMeters) {
    return null;
  }

  const nearestEndpoint = findNearestEndpoint(route.geometry, peak.coordinates);
  const classification = classifyPeakCandidate(
    nearestSegment.distanceMeters,
    nearestEndpoint.distanceMeters,
    thresholds,
  );

  return {
    peakSourceId: peak.sourceId,
    peakSourceUrl: peak.sourceUrl,
    peakName: peak.name,
    peakElevation: peak.elevationMeters,
    peakCoordinate: roundCoordinate(peak.coordinates),
    minDistanceMeters: round(nearestSegment.distanceMeters, 1),
    nearestRouteCoordinate: roundCoordinate(nearestSegment.coordinate),
    componentIndex: nearestSegment.componentIndex,
    segmentIndex: nearestSegment.segmentIndex,
    projectionFraction: round(nearestSegment.projectionFraction, 6),
    endpointDistanceMeters: round(nearestEndpoint.distanceMeters, 1),
    nearestEndpointCoordinate: roundCoordinate(nearestEndpoint.coordinate),
    nearestEndpointComponentIndex: nearestEndpoint.componentIndex,
    nearestEndpointPosition: nearestEndpoint.position,
    nearEndpoint:
      nearestEndpoint.distanceMeters <= thresholds.nearEndpointMeters,
    classification,
    confidence: calculatePeakMatchConfidence(
      nearestSegment.distanceMeters,
      nearestEndpoint.distanceMeters,
      thresholds,
    ),
    reasons: buildReasons(
      nearestSegment,
      nearestEndpoint,
      classification,
      thresholds,
    ),
  };
}

const CLASSIFICATION_ORDER: Record<PeakClassification, number> = {
  MATCHED: 0,
  POSSIBLE: 1,
  REJECTED: 2,
};

export function matchPeaksToRoute(
  route: MatchableRoute,
  peaks: MatchablePeak[],
  thresholds: PeakMatchThresholds = DEFAULT_PEAK_MATCH_THRESHOLDS,
): PeakMatchCandidate[] {
  return peaks
    .map((peak) => matchPeakToRoute(route, peak, thresholds))
    .filter((candidate): candidate is PeakMatchCandidate => candidate !== null)
    .sort(
      (left, right) =>
        CLASSIFICATION_ORDER[left.classification] -
          CLASSIFICATION_ORDER[right.classification] ||
        left.minDistanceMeters - right.minDistanceMeters ||
        left.peakSourceId.localeCompare(right.peakSourceId),
    );
}
