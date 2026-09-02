import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type RouteGeometry,
} from "./peak-matcher.ts";
import {
  DEFAULT_GEOMETRY_NORMALIZATION_OPTIONS,
  normalizeRouteGeometry,
  type NormalizedRouteGeometry,
} from "./route-geometry.ts";

export type RouteSimilarityClassification =
  | "EXACT_DUPLICATE"
  | "NEAR_DUPLICATE"
  | "SAME_VARIANT"
  | "DIFFERENT_VARIANT"
  | "UNRELATED";

export interface RouteSummitEvidence {
  confirmedPeakIds: string[];
  associatedPeakIds: string[];
}

export interface ComparableRoute {
  sourceId: string;
  name: string;
  geometry: RouteGeometry;
  summitEvidence: RouteSummitEvidence;
}

export interface RouteSimilarityThresholds {
  resampleIntervalMeters: number;
  coverageDistanceMeters: number;
  endpointScaleMeters: number;
  closedLoopEndpointToleranceMeters: number;
  identityCoverageDistanceMeters: number;
  identityLengthRatio: number;
  identitySymmetricCoverage: number;
  identityBoundingBoxAgreement: number;
  exactLengthRatio: number;
  exactSymmetricCoverage: number;
  exactEndpointScore: number;
  nearLengthRatio: number;
  nearSymmetricCoverage: number;
  nearEndpointScore: number;
  sameVariantCoverage: number;
  sameVariantEndpointCoverage: number;
}

export interface RouteSimilarityMetrics {
  routeALengthMeters: number;
  routeBLengthMeters: number;
  lengthRatio: number;
  routeASampleCount: number;
  routeBSampleCount: number;
  componentCountA: number;
  componentCountB: number;
  endpointForwardDistanceMeters: number;
  endpointReversedDistanceMeters: number;
  directionIndependentEndpointDistanceMeters: number;
  endpointScore: number;
  componentEndpointCoverage: number;
  routeAIsClosedLoop: boolean;
  routeBIsClosedLoop: boolean;
  coverageAByB: number;
  coverageBByA: number;
  symmetricCoverage: number;
  identityCoverageAByB: number;
  identityCoverageBByA: number;
  identitySymmetricCoverage: number;
  boundingBoxAgreement: number;
  geometricIdentityScore: number;
  strongGeometricIdentity: boolean;
  approximateShapeSimilarity: number;
  sharedConfirmedSummitIds: string[];
  sharedAssociatedSummitIds: string[];
}

export interface RouteSimilarityResult {
  routeA: { sourceId: string; name: string };
  routeB: { sourceId: string; name: string };
  metrics: RouteSimilarityMetrics;
  classification: RouteSimilarityClassification;
  confidence: number;
  reasons: string[];
}

interface MetricPoint {
  x: number;
  y: number;
  z: number;
}

class SpatialPointIndex {
  readonly cellSizeMeters: number;
  readonly cells = new Map<string, MetricPoint[]>();

  constructor(coordinates: Coordinate[], cellSizeMeters: number) {
    this.cellSizeMeters = cellSizeMeters;
    coordinates.forEach((coordinate) => {
      const point = coordinateToEarthCenteredPoint(coordinate);
      const key = this.keyForPoint(point);
      const cell = this.cells.get(key);
      if (cell) {
        cell.push(point);
      } else {
        this.cells.set(key, [point]);
      }
    });
  }

  private cellCoordinate(value: number): number {
    return Math.floor(value / this.cellSizeMeters);
  }

  private key(x: number, y: number, z: number): string {
    return `${x}:${y}:${z}`;
  }

  private keyForPoint(point: MetricPoint): string {
    return this.key(
      this.cellCoordinate(point.x),
      this.cellCoordinate(point.y),
      this.cellCoordinate(point.z),
    );
  }

  hasPointWithin(coordinate: Coordinate, thresholdMeters: number): boolean {
    const point = coordinateToEarthCenteredPoint(coordinate);
    const centerX = this.cellCoordinate(point.x);
    const centerY = this.cellCoordinate(point.y);
    const centerZ = this.cellCoordinate(point.z);
    const cellRadius = Math.ceil(thresholdMeters / this.cellSizeMeters);
    const thresholdSquared = thresholdMeters ** 2;

    for (let xOffset = -cellRadius; xOffset <= cellRadius; xOffset += 1) {
      for (let yOffset = -cellRadius; yOffset <= cellRadius; yOffset += 1) {
        for (let zOffset = -cellRadius; zOffset <= cellRadius; zOffset += 1) {
          const points = this.cells.get(
            this.key(
              centerX + xOffset,
              centerY + yOffset,
              centerZ + zOffset,
            ),
          );

          if (
            points?.some(
              (candidate) =>
                (candidate.x - point.x) ** 2 +
                  (candidate.y - point.y) ** 2 +
                  (candidate.z - point.z) ** 2 <=
                thresholdSquared,
            )
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }
}

export interface PreparedComparableRoute extends ComparableRoute {
  normalizedGeometry: NormalizedRouteGeometry;
  flattenedSamples: Coordinate[];
  spatialIndex: SpatialPointIndex;
}

export const DEFAULT_ROUTE_SIMILARITY_THRESHOLDS: Readonly<RouteSimilarityThresholds> = {
  resampleIntervalMeters: 25,
  coverageDistanceMeters: 40,
  endpointScaleMeters: 250,
  closedLoopEndpointToleranceMeters: 25,
  identityCoverageDistanceMeters: 15,
  identityLengthRatio: 0.995,
  identitySymmetricCoverage: 0.995,
  identityBoundingBoxAgreement: 0.995,
  exactLengthRatio: 0.98,
  exactSymmetricCoverage: 0.98,
  exactEndpointScore: 0.95,
  nearLengthRatio: 0.9,
  nearSymmetricCoverage: 0.9,
  nearEndpointScore: 0.75,
  sameVariantCoverage: 0.4,
  sameVariantEndpointCoverage: 0.45,
};

const EARTH_RADIUS_METERS = 6_371_008.8;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function coordinateToEarthCenteredPoint(coordinate: Coordinate): MetricPoint {
  const longitude = degreesToRadians(coordinate[0]);
  const latitude = degreesToRadians(coordinate[1]);
  const latitudeRadius = EARTH_RADIUS_METERS * Math.cos(latitude);

  return {
    x: latitudeRadius * Math.cos(longitude),
    y: latitudeRadius * Math.sin(longitude),
    z: EARTH_RADIUS_METERS * Math.sin(latitude),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimalPlaces: number): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort();
}

function normalizedEndpoints(geometry: NormalizedRouteGeometry): {
  start: Coordinate;
  end: Coordinate;
  all: Coordinate[];
} {
  const nonEmptyComponents = geometry.components.filter(
    (component) => component.length > 0,
  );
  const first = nonEmptyComponents[0];
  const last = nonEmptyComponents[nonEmptyComponents.length - 1];

  if (!first || !last) {
    throw new Error("normalized route geometry has no coordinates");
  }

  return {
    start: first[0],
    end: last[last.length - 1],
    all: nonEmptyComponents.flatMap((component) => [
      component[0],
      component[component.length - 1],
    ]),
  };
}

function endpointPairDistance(
  startA: Coordinate,
  endA: Coordinate,
  startB: Coordinate,
  endB: Coordinate,
): number {
  return (
    calculateCoordinateDistanceMeters(startA, startB) +
    calculateCoordinateDistanceMeters(endA, endB)
  ) / 2;
}

function endpointSetCoverage(
  source: Coordinate[],
  target: Coordinate[],
  thresholdMeters: number,
): number {
  if (source.length === 0 || target.length === 0) {
    return 0;
  }

  const covered = source.filter((sourceEndpoint) =>
    target.some(
      (targetEndpoint) =>
        calculateCoordinateDistanceMeters(sourceEndpoint, targetEndpoint) <=
        thresholdMeters,
    ),
  ).length;

  return covered / source.length;
}

function geometryCoverage(
  source: Coordinate[],
  target: SpatialPointIndex,
  thresholdMeters: number,
): number {
  if (source.length === 0) {
    return 0;
  }

  let covered = 0;
  for (const coordinate of source) {
    if (target.hasPointWithin(coordinate, thresholdMeters)) {
      covered += 1;
    }
  }

  return covered / source.length;
}

interface GeometryBoundingBox {
  southWest: Coordinate;
  northWest: Coordinate;
  southEast: Coordinate;
  northEast: Coordinate;
}

function routeCoordinates(geometry: RouteGeometry): Coordinate[] {
  return geometry.type === "LineString"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

function geometryBoundingBox(coordinates: Coordinate[]): GeometryBoundingBox {
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  const minimumLongitude = Math.min(...longitudes);
  const maximumLongitude = Math.max(...longitudes);
  const minimumLatitude = Math.min(...latitudes);
  const maximumLatitude = Math.max(...latitudes);
  return {
    southWest: [minimumLongitude, minimumLatitude],
    northWest: [minimumLongitude, maximumLatitude],
    southEast: [maximumLongitude, minimumLatitude],
    northEast: [maximumLongitude, maximumLatitude],
  };
}

function boundingBoxAgreement(
  coordinatesA: Coordinate[],
  coordinatesB: Coordinate[],
): number {
  const boxA = geometryBoundingBox(coordinatesA);
  const boxB = geometryBoundingBox(coordinatesB);
  const maximumCornerDistance = Math.max(
    calculateCoordinateDistanceMeters(boxA.southWest, boxB.southWest),
    calculateCoordinateDistanceMeters(boxA.northWest, boxB.northWest),
    calculateCoordinateDistanceMeters(boxA.southEast, boxB.southEast),
    calculateCoordinateDistanceMeters(boxA.northEast, boxB.northEast),
  );
  const extentScale = Math.max(
    1,
    calculateCoordinateDistanceMeters(boxA.southWest, boxA.northEast),
    calculateCoordinateDistanceMeters(boxB.southWest, boxB.northEast),
  );
  return clamp(1 - maximumCornerDistance / extentScale, 0, 1);
}

function isClosedGeometry(
  geometry: NormalizedRouteGeometry,
  toleranceMeters: number,
): boolean {
  const componentEndpoints = geometry.components
    .filter((component) => component.length > 0)
    .flatMap((component) => [component[0], component[component.length - 1]]);
  if (componentEndpoints.length < 2) {
    return false;
  }
  return componentEndpoints.every((endpoint, endpointIndex) =>
    componentEndpoints.some(
      (candidate, candidateIndex) =>
        candidateIndex !== endpointIndex &&
        calculateCoordinateDistanceMeters(endpoint, candidate) <=
          toleranceMeters,
    ),
  );
}

export function prepareRouteForSimilarity(
  route: ComparableRoute,
  thresholds: RouteSimilarityThresholds = DEFAULT_ROUTE_SIMILARITY_THRESHOLDS,
): PreparedComparableRoute {
  const normalizedGeometry = normalizeRouteGeometry(route.geometry, {
    ...DEFAULT_GEOMETRY_NORMALIZATION_OPTIONS,
    resampleIntervalMeters: thresholds.resampleIntervalMeters,
  });
  const flattenedSamples = normalizedGeometry.components.flat();

  return {
    ...route,
    normalizedGeometry,
    flattenedSamples,
    spatialIndex: new SpatialPointIndex(
      flattenedSamples,
      thresholds.coverageDistanceMeters,
    ),
  };
}

function calculateMetrics(
  routeA: PreparedComparableRoute,
  routeB: PreparedComparableRoute,
  thresholds: RouteSimilarityThresholds,
): RouteSimilarityMetrics {
  const lengthA = routeA.normalizedGeometry.lengthMeters;
  const lengthB = routeB.normalizedGeometry.lengthMeters;
  const lengthRatio =
    Math.max(lengthA, lengthB) === 0
      ? 1
      : Math.min(lengthA, lengthB) / Math.max(lengthA, lengthB);
  const endpointsA = normalizedEndpoints(routeA.normalizedGeometry);
  const endpointsB = normalizedEndpoints(routeB.normalizedGeometry);
  const forwardEndpointDistance = endpointPairDistance(
    endpointsA.start,
    endpointsA.end,
    endpointsB.start,
    endpointsB.end,
  );
  const reversedEndpointDistance = endpointPairDistance(
    endpointsA.start,
    endpointsA.end,
    endpointsB.end,
    endpointsB.start,
  );
  const directionIndependentEndpointDistance = Math.min(
    forwardEndpointDistance,
    reversedEndpointDistance,
  );
  const endpointScore = clamp(
    1 - directionIndependentEndpointDistance / thresholds.endpointScaleMeters,
    0,
    1,
  );
  const endpointCoverageAB = endpointSetCoverage(
    endpointsA.all,
    endpointsB.all,
    thresholds.endpointScaleMeters,
  );
  const endpointCoverageBA = endpointSetCoverage(
    endpointsB.all,
    endpointsA.all,
    thresholds.endpointScaleMeters,
  );
  const componentEndpointCoverage = Math.min(
    endpointCoverageAB,
    endpointCoverageBA,
  );
  const coverageAByB = geometryCoverage(
    routeA.flattenedSamples,
    routeB.spatialIndex,
    thresholds.coverageDistanceMeters,
  );
  const coverageBByA = geometryCoverage(
    routeB.flattenedSamples,
    routeA.spatialIndex,
    thresholds.coverageDistanceMeters,
  );
  const symmetricCoverage = Math.min(coverageAByB, coverageBByA);
  const identityCoverageAByB = geometryCoverage(
    routeA.flattenedSamples,
    routeB.spatialIndex,
    thresholds.identityCoverageDistanceMeters,
  );
  const identityCoverageBByA = geometryCoverage(
    routeB.flattenedSamples,
    routeA.spatialIndex,
    thresholds.identityCoverageDistanceMeters,
  );
  const identitySymmetricCoverage = Math.min(
    identityCoverageAByB,
    identityCoverageBByA,
  );
  const extentAgreement = boundingBoxAgreement(
    routeCoordinates(routeA.geometry),
    routeCoordinates(routeB.geometry),
  );
  const geometricIdentityScore = Math.min(
    identitySymmetricCoverage,
    lengthRatio,
    extentAgreement,
  );
  const strongGeometricIdentity =
    lengthRatio >= thresholds.identityLengthRatio &&
    identitySymmetricCoverage >= thresholds.identitySymmetricCoverage &&
    extentAgreement >= thresholds.identityBoundingBoxAgreement;
  const approximateShapeSimilarity =
    symmetricCoverage * 0.65 +
    componentEndpointCoverage * 0.2 +
    lengthRatio * 0.15;

  return {
    routeALengthMeters: round(lengthA, 1),
    routeBLengthMeters: round(lengthB, 1),
    lengthRatio: round(lengthRatio, 4),
    routeASampleCount: routeA.normalizedGeometry.sampleCount,
    routeBSampleCount: routeB.normalizedGeometry.sampleCount,
    componentCountA: routeA.normalizedGeometry.components.length,
    componentCountB: routeB.normalizedGeometry.components.length,
    endpointForwardDistanceMeters: round(forwardEndpointDistance, 1),
    endpointReversedDistanceMeters: round(reversedEndpointDistance, 1),
    directionIndependentEndpointDistanceMeters: round(
      directionIndependentEndpointDistance,
      1,
    ),
    endpointScore: round(endpointScore, 4),
    componentEndpointCoverage: round(componentEndpointCoverage, 4),
    routeAIsClosedLoop: isClosedGeometry(
      routeA.normalizedGeometry,
      thresholds.closedLoopEndpointToleranceMeters,
    ),
    routeBIsClosedLoop: isClosedGeometry(
      routeB.normalizedGeometry,
      thresholds.closedLoopEndpointToleranceMeters,
    ),
    coverageAByB: round(coverageAByB, 4),
    coverageBByA: round(coverageBByA, 4),
    symmetricCoverage: round(symmetricCoverage, 4),
    identityCoverageAByB: round(identityCoverageAByB, 4),
    identityCoverageBByA: round(identityCoverageBByA, 4),
    identitySymmetricCoverage: round(identitySymmetricCoverage, 4),
    boundingBoxAgreement: round(extentAgreement, 4),
    geometricIdentityScore: round(geometricIdentityScore, 4),
    strongGeometricIdentity,
    approximateShapeSimilarity: round(approximateShapeSimilarity, 4),
    sharedConfirmedSummitIds: intersection(
      routeA.summitEvidence.confirmedPeakIds,
      routeB.summitEvidence.confirmedPeakIds,
    ),
    sharedAssociatedSummitIds: intersection(
      routeA.summitEvidence.associatedPeakIds,
      routeB.summitEvidence.associatedPeakIds,
    ),
  };
}

function classifyMetrics(
  metrics: RouteSimilarityMetrics,
  thresholds: RouteSimilarityThresholds,
): { classification: RouteSimilarityClassification; confidence: number; reasons: string[] } {
  const reasons = [
    `Bidirectional coverage is ${(metrics.coverageAByB * 100).toFixed(1)}% A-by-B and ${(metrics.coverageBByA * 100).toFixed(1)}% B-by-A.`,
    `Length ratio is ${metrics.lengthRatio.toFixed(3)} and direction-independent endpoint score is ${metrics.endpointScore.toFixed(3)}.`,
  ];

  if (metrics.strongGeometricIdentity) {
    reasons.push(
      `Strong geometric identity passes: ${(metrics.identityCoverageAByB * 100).toFixed(1)}%/${(metrics.identityCoverageBByA * 100).toFixed(1)}% fine-grained coverage, ${metrics.lengthRatio.toFixed(3)} length ratio, and ${metrics.boundingBoxAgreement.toFixed(3)} bounding-box agreement.`,
    );
    if (metrics.endpointScore < thresholds.exactEndpointScore) {
      reasons.push(
        metrics.routeAIsClosedLoop && metrics.routeBIsClosedLoop
          ? "Endpoint disagreement is representational because equivalent closed loops can start at arbitrary positions."
          : "Endpoint disagreement is representational because identical component sets can be stored in a different order or segmentation.",
      );
    }
    return {
      classification: "EXACT_DUPLICATE",
      confidence: round(
        (metrics.identitySymmetricCoverage +
          metrics.lengthRatio +
          metrics.boundingBoxAgreement) /
          3,
        3,
      ),
      reasons,
    };
  }

  if (
    metrics.lengthRatio >= thresholds.exactLengthRatio &&
    metrics.symmetricCoverage >= thresholds.exactSymmetricCoverage &&
    metrics.endpointScore >= thresholds.exactEndpointScore
  ) {
    reasons.push("All exact-duplicate geometry, length, and endpoint thresholds pass.");
    return {
      classification: "EXACT_DUPLICATE",
      confidence: round(
        (metrics.lengthRatio + metrics.symmetricCoverage + metrics.endpointScore) /
          3,
        3,
      ),
      reasons,
    };
  }

  if (
    metrics.lengthRatio >= thresholds.nearLengthRatio &&
    metrics.symmetricCoverage >= thresholds.nearSymmetricCoverage &&
    metrics.endpointScore >= thresholds.nearEndpointScore
  ) {
    reasons.push("All near-duplicate geometry, length, and endpoint thresholds pass.");
    return {
      classification: "NEAR_DUPLICATE",
      confidence: round(
        (metrics.lengthRatio + metrics.symmetricCoverage + metrics.endpointScore) /
          3,
        3,
      ),
      reasons,
    };
  }

  const sharedEndpointCorridor =
    metrics.componentEndpointCoverage >=
    thresholds.sameVariantEndpointCoverage;
  const substantialContainedCorridor =
    Math.max(metrics.coverageAByB, metrics.coverageBByA) >= 0.95 &&
    metrics.lengthRatio >= 0.5;

  if (
    metrics.symmetricCoverage >= thresholds.sameVariantCoverage &&
    (sharedEndpointCorridor || substantialContainedCorridor)
  ) {
    reasons.push(
      substantialContainedCorridor && !sharedEndpointCorridor
        ? "Substantial bidirectional geometry plus a mostly contained corridor indicate the same broad variant, but the length difference prevents duplicate classification."
        : "Substantial bidirectional geometry and component-endpoint overlap indicate the same broad variant, but duplicate thresholds fail.",
    );
    return {
      classification: "SAME_VARIANT",
      confidence: round(metrics.approximateShapeSimilarity, 3),
      reasons,
    };
  }

  if (metrics.sharedConfirmedSummitIds.length > 0) {
    reasons.push(
      "Routes share a CONFIRMED summit but lack enough common geometry for the same variant.",
    );
    return {
      classification: "DIFFERENT_VARIANT",
      confidence: round(
        clamp(0.75 + (1 - metrics.symmetricCoverage) * 0.2, 0, 0.95),
        3,
      ),
      reasons,
    };
  }

  reasons.push(
    "Pair lacks duplicate-level bidirectional coverage and strong shared destination evidence.",
  );
  return {
    classification: "UNRELATED",
    confidence: round(
      clamp(1 - metrics.approximateShapeSimilarity, 0.5, 0.99),
      3,
    ),
    reasons,
  };
}

export function comparePreparedRoutes(
  routeA: PreparedComparableRoute,
  routeB: PreparedComparableRoute,
  thresholds: RouteSimilarityThresholds = DEFAULT_ROUTE_SIMILARITY_THRESHOLDS,
): RouteSimilarityResult {
  const metrics = calculateMetrics(routeA, routeB, thresholds);
  const decision = classifyMetrics(metrics, thresholds);

  return {
    routeA: { sourceId: routeA.sourceId, name: routeA.name },
    routeB: { sourceId: routeB.sourceId, name: routeB.name },
    metrics,
    ...decision,
  };
}

export function compareRoutes(
  routeA: ComparableRoute,
  routeB: ComparableRoute,
  thresholds: RouteSimilarityThresholds = DEFAULT_ROUTE_SIMILARITY_THRESHOLDS,
): RouteSimilarityResult {
  return comparePreparedRoutes(
    prepareRouteForSimilarity(routeA, thresholds),
    prepareRouteForSimilarity(routeB, thresholds),
    thresholds,
  );
}
