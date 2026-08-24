export type RouteSegmentSpatialInput = {
  startLongitude: number;
  startLatitude: number;
  endLongitude: number;
  endLatitude: number;
};

export type RouteSegmentSpatialIndex = {
  buckets: Map<string, number[]>;
  fallbackSegmentIndexes: number[];
  segmentCount: number;
};

const GRID_CELL_DEGREES = 0.05;
const MAX_CELLS_PER_SEGMENT = 256;
const CONSERVATIVE_METERS_PER_DEGREE = 100_000;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function cellIndex(value: number): number {
  return Math.floor(value / GRID_CELL_DEGREES);
}

function cellKey(latitudeIndex: number, longitudeIndex: number): string {
  return `${latitudeIndex}:${longitudeIndex}`;
}

function isGeographicCoordinate(longitude: number, latitude: number): boolean {
  return Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90;
}

export function buildRouteSegmentSpatialIndex(
  segments: readonly RouteSegmentSpatialInput[],
  searchRadiusM: number,
): RouteSegmentSpatialIndex {
  const buckets = new Map<string, number[]>();
  const fallbackSegmentIndexes: number[] = [];
  const latitudePadding = Math.max(0, searchRadiusM) / CONSERVATIVE_METERS_PER_DEGREE;

  segments.forEach((segment, segmentIndex) => {
    if (
      !isGeographicCoordinate(segment.startLongitude, segment.startLatitude) ||
      !isGeographicCoordinate(segment.endLongitude, segment.endLatitude)
    ) {
      fallbackSegmentIndexes.push(segmentIndex);
      return;
    }

    const minimumLatitude = Math.min(segment.startLatitude, segment.endLatitude) - latitudePadding;
    const maximumLatitude = Math.max(segment.startLatitude, segment.endLatitude) + latitudePadding;
    const maximumAbsoluteLatitude = Math.max(Math.abs(minimumLatitude), Math.abs(maximumLatitude));

    if (minimumLatitude < -90 || maximumLatitude > 90 || maximumAbsoluteLatitude >= 89.9) {
      fallbackSegmentIndexes.push(segmentIndex);
      return;
    }

    const longitudePadding = Math.max(0, searchRadiusM) /
      (
        CONSERVATIVE_METERS_PER_DEGREE *
        Math.cos(degreesToRadians(maximumAbsoluteLatitude))
      );
    const minimumLongitude = Math.min(segment.startLongitude, segment.endLongitude) - longitudePadding;
    const maximumLongitude = Math.max(segment.startLongitude, segment.endLongitude) + longitudePadding;

    if (minimumLongitude < -180 || maximumLongitude > 180) {
      fallbackSegmentIndexes.push(segmentIndex);
      return;
    }

    const minimumLatitudeCell = cellIndex(minimumLatitude);
    const maximumLatitudeCell = cellIndex(maximumLatitude);
    const minimumLongitudeCell = cellIndex(minimumLongitude);
    const maximumLongitudeCell = cellIndex(maximumLongitude);
    const cellCount =
      (maximumLatitudeCell - minimumLatitudeCell + 1) *
      (maximumLongitudeCell - minimumLongitudeCell + 1);

    if (!Number.isSafeInteger(cellCount) || cellCount > MAX_CELLS_PER_SEGMENT) {
      fallbackSegmentIndexes.push(segmentIndex);
      return;
    }

    for (
      let latitudeIndex = minimumLatitudeCell;
      latitudeIndex <= maximumLatitudeCell;
      latitudeIndex += 1
    ) {
      for (
        let longitudeIndex = minimumLongitudeCell;
        longitudeIndex <= maximumLongitudeCell;
        longitudeIndex += 1
      ) {
        const key = cellKey(latitudeIndex, longitudeIndex);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(segmentIndex);
        } else {
          buckets.set(key, [segmentIndex]);
        }
      }
    }
  });

  return {
    buckets,
    fallbackSegmentIndexes,
    segmentCount: segments.length,
  };
}

export function getRouteSegmentCandidateIndexes(
  index: RouteSegmentSpatialIndex,
  longitude: number,
  latitude: number,
): number[] {
  if (!isGeographicCoordinate(longitude, latitude)) {
    return Array.from({ length: index.segmentCount }, (_, segmentIndex) => segmentIndex);
  }

  const bucket = index.buckets.get(cellKey(cellIndex(latitude), cellIndex(longitude))) ?? [];

  return [...bucket, ...index.fallbackSegmentIndexes].sort(
    (firstIndex, secondIndex) => firstIndex - secondIndex,
  );
}
