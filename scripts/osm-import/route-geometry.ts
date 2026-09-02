import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type RouteGeometry,
} from "./peak-matcher.ts";

export interface GeometryNormalizationOptions {
  resampleIntervalMeters: number;
  duplicatePointToleranceMeters: number;
}

export interface NormalizedRouteGeometry {
  components: Coordinate[][];
  lengthMeters: number;
  sampleCount: number;
  originalPointCount: number;
}

export const DEFAULT_GEOMETRY_NORMALIZATION_OPTIONS: Readonly<GeometryNormalizationOptions> = {
  resampleIntervalMeters: 25,
  duplicatePointToleranceMeters: 0.5,
};

function geometryComponents(geometry: RouteGeometry): Coordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

function interpolateCoordinate(
  start: Coordinate,
  end: Coordinate,
  fraction: number,
): Coordinate {
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function removeConsecutiveNearDuplicates(
  component: Coordinate[],
  toleranceMeters: number,
): Coordinate[] {
  if (component.length === 0) {
    return [];
  }

  const cleaned: Coordinate[] = [component[0]];
  for (let index = 1; index < component.length; index += 1) {
    const coordinate = component[index];
    if (
      calculateCoordinateDistanceMeters(cleaned[cleaned.length - 1], coordinate) >
      toleranceMeters
    ) {
      cleaned.push(coordinate);
    }
  }

  return cleaned;
}

function calculateComponentLength(component: Coordinate[]): number {
  let lengthMeters = 0;

  for (let index = 1; index < component.length; index += 1) {
    lengthMeters += calculateCoordinateDistanceMeters(
      component[index - 1],
      component[index],
    );
  }

  return lengthMeters;
}

function resampleComponent(
  component: Coordinate[],
  intervalMeters: number,
  duplicateToleranceMeters: number,
): Coordinate[] {
  if (component.length <= 1) {
    return [...component];
  }

  const resampled: Coordinate[] = [component[0]];
  let cumulativeDistance = 0;
  let nextSampleDistance = intervalMeters;

  for (let index = 1; index < component.length; index += 1) {
    const start = component[index - 1];
    const end = component[index];
    const segmentLength = calculateCoordinateDistanceMeters(start, end);

    if (segmentLength === 0) {
      continue;
    }

    while (cumulativeDistance + segmentLength >= nextSampleDistance) {
      const fraction =
        (nextSampleDistance - cumulativeDistance) / segmentLength;
      resampled.push(interpolateCoordinate(start, end, fraction));
      nextSampleDistance += intervalMeters;
    }

    cumulativeDistance += segmentLength;
  }

  const finalCoordinate = component[component.length - 1];
  const distanceToFinal = calculateCoordinateDistanceMeters(
    resampled[resampled.length - 1],
    finalCoordinate,
  );

  if (distanceToFinal <= duplicateToleranceMeters) {
    resampled[resampled.length - 1] = finalCoordinate;
  } else {
    resampled.push(finalCoordinate);
  }

  return resampled;
}

export function calculateGeometryLengthMeters(geometry: RouteGeometry): number {
  return geometryComponents(geometry).reduce(
    (total, component) => total + calculateComponentLength(component),
    0,
  );
}

export function normalizeRouteGeometry(
  geometry: RouteGeometry,
  options: GeometryNormalizationOptions = DEFAULT_GEOMETRY_NORMALIZATION_OPTIONS,
): NormalizedRouteGeometry {
  if (options.resampleIntervalMeters <= 0) {
    throw new Error("resampleIntervalMeters must be positive");
  }

  const originalComponents = geometryComponents(geometry);
  const cleanedComponents = originalComponents.map((component) =>
    removeConsecutiveNearDuplicates(
      component,
      options.duplicatePointToleranceMeters,
    ),
  );
  const components = cleanedComponents.map((component) =>
    resampleComponent(
      component,
      options.resampleIntervalMeters,
      options.duplicatePointToleranceMeters,
    ),
  );

  return {
    components,
    lengthMeters: cleanedComponents.reduce(
      (total, component) => total + calculateComponentLength(component),
      0,
    ),
    sampleCount: components.reduce(
      (total, component) => total + component.length,
      0,
    ),
    originalPointCount: originalComponents.reduce(
      (total, component) => total + component.length,
      0,
    ),
  };
}

export function reverseRouteGeometry(geometry: RouteGeometry): RouteGeometry {
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: [...geometry.coordinates].reverse() };
  }

  return {
    type: "MultiLineString",
    coordinates: [...geometry.coordinates]
      .reverse()
      .map((component) => [...component].reverse()),
  };
}
