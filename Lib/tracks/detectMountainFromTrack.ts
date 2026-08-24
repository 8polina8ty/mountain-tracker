import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildRouteSegmentSpatialIndex,
  getRouteSegmentCandidateIndexes,
  type RouteSegmentSpatialIndex,
} from "./routeSegmentSpatialIndex.ts";

type TrackGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.LineString | GeoJSON.MultiLineString
>;

type MountainCandidateRow = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number | null;
  latitude: number | null;
  longitude: number | null;
};

export type MountainDetectionCandidate = {
  mountainId: number;
  mountainName: string;
  mountainHeight: number | null;
  distanceM: number;
  confidence: number;
};

export type DetectedMountain = MountainDetectionCandidate & {
  runnerUp: MountainDetectionCandidate | null;
  candidates: MountainDetectionCandidate[];
};

type DetectMountainOptions = {
  supabase: SupabaseClient;
  geojson: TrackGeoJson;

  searchRadiusM?: number;
  confirmationRadiusM?: number;
};

type TrackPoint = {
  longitude: number;
  latitude: number;
  elevation: number | null;
};

type TrackSegment = {
  start: TrackPoint;
  end: TrackPoint;
};

type ClosestTrackPosition = {
  distanceM: number;
  elevation: number | null;
};

const EARTH_RADIUS_M = 6_371_000;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(
  firstLongitude: number,
  firstLatitude: number,
  secondLongitude: number,
  secondLatitude: number,
): number {
  const firstLatitudeRadians =
    degreesToRadians(firstLatitude);

  const secondLatitudeRadians =
    degreesToRadians(secondLatitude);

  const latitudeDifference = degreesToRadians(
    secondLatitude - firstLatitude,
  );

  const longitudeDifference = degreesToRadians(
    secondLongitude - firstLongitude,
  );

  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitudeRadians) *
      Math.cos(secondLatitudeRadians) *
      Math.sin(longitudeDifference / 2) ** 2;

  const centralAngle =
    2 *
    Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine),
    );

  return EARTH_RADIUS_M * centralAngle;
}

function calculateProjectionOnSegment(
  point: TrackPoint,
  segmentStart: TrackPoint,
  segmentEnd: TrackPoint,
): { distanceM: number; fraction: number } {
  const averageLatitude = degreesToRadians(
    (point.latitude + segmentStart.latitude + segmentEnd.latitude) / 3,
  );
  const longitudeScale = Math.max(0.1, Math.cos(averageLatitude));
  const segmentX =
    degreesToRadians(segmentEnd.longitude - segmentStart.longitude) * longitudeScale;
  const segmentY = degreesToRadians(segmentEnd.latitude - segmentStart.latitude);
  const pointX =
    degreesToRadians(point.longitude - segmentStart.longitude) * longitudeScale;
  const pointY = degreesToRadians(point.latitude - segmentStart.latitude);
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
  const fraction = segmentLengthSquared === 0
    ? 0
    : Math.max(
        0,
        Math.min(1, (pointX * segmentX + pointY * segmentY) / segmentLengthSquared),
      );
  const projectedLongitude =
    segmentStart.longitude +
    (segmentEnd.longitude - segmentStart.longitude) * fraction;
  const projectedLatitude =
    segmentStart.latitude +
    (segmentEnd.latitude - segmentStart.latitude) * fraction;

  return {
    fraction,
    distanceM: calculateDistanceMeters(
      point.longitude,
      point.latitude,
      projectedLongitude,
      projectedLatitude,
    ),
  };
}

function getElevationAtProjection(
  segment: TrackSegment,
  fraction: number,
): number | null {
  const startElevation = segment.start.elevation;
  const endElevation = segment.end.elevation;

  if (startElevation !== null && endElevation !== null) {
    return startElevation + (endElevation - startElevation) * fraction;
  }

  return startElevation ?? endElevation;
}

function getTrackPoints(
  geojson: TrackGeoJson,
): TrackPoint[] {
  const points: TrackPoint[] = [];

  function addCoordinate(
    coordinate: GeoJSON.Position,
  ) {
    const longitude = Number(coordinate[0]);
    const latitude = Number(coordinate[1]);

    const elevation =
      coordinate.length >= 3 &&
      Number.isFinite(Number(coordinate[2]))
        ? Number(coordinate[2])
        : null;

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      return;
    }

    points.push({
      longitude,
      latitude,
      elevation,
    });
  }

  geojson.features.forEach((feature) => {
    if (feature.geometry.type === "LineString") {
      feature.geometry.coordinates.forEach(
        addCoordinate,
      );
    }

    if (
      feature.geometry.type ===
      "MultiLineString"
    ) {
      feature.geometry.coordinates.forEach(
        (line) => {
          line.forEach(addCoordinate);
        },
      );
    }
  });

  return points;
}

function getTrackSegments(
  geojson: TrackGeoJson,
): TrackSegment[] {
  const segments: TrackSegment[] = [];

  geojson.features.forEach((feature) => {
    if (feature.geometry.type === "LineString") {
      const coords = feature.geometry.coordinates;
      for (let i = 1; i < coords.length; i++) {
        const startCoord = coords[i - 1];
        const endCoord = coords[i];
        const startLon = Number(startCoord[0]);
        const startLat = Number(startCoord[1]);
        const endLon = Number(endCoord[0]);
        const endLat = Number(endCoord[1]);
        const startElevation =
          startCoord.length >= 3 && Number.isFinite(Number(startCoord[2]))
            ? Number(startCoord[2])
            : null;
        const endElevation =
          endCoord.length >= 3 && Number.isFinite(Number(endCoord[2]))
            ? Number(endCoord[2])
            : null;
        if (
          Number.isFinite(startLon) && Number.isFinite(startLat) &&
          Number.isFinite(endLon) && Number.isFinite(endLat)
        ) {
          segments.push({
            start: { longitude: startLon, latitude: startLat, elevation: startElevation },
            end: { longitude: endLon, latitude: endLat, elevation: endElevation },
          });
        }
      }
    }

    if (feature.geometry.type === "MultiLineString") {
      feature.geometry.coordinates.forEach((line) => {
        for (let i = 1; i < line.length; i++) {
          const startCoord = line[i - 1];
          const endCoord = line[i];
          const startLon = Number(startCoord[0]);
          const startLat = Number(startCoord[1]);
          const endLon = Number(endCoord[0]);
          const endLat = Number(endCoord[1]);
          const startElevation =
            startCoord.length >= 3 && Number.isFinite(Number(startCoord[2]))
              ? Number(startCoord[2])
              : null;
          const endElevation =
            endCoord.length >= 3 && Number.isFinite(Number(endCoord[2]))
              ? Number(endCoord[2])
              : null;
          if (
            Number.isFinite(startLon) && Number.isFinite(startLat) &&
            Number.isFinite(endLon) && Number.isFinite(endLat)
          ) {
            segments.push({
              start: { longitude: startLon, latitude: startLat, elevation: startElevation },
              end: { longitude: endLon, latitude: endLat, elevation: endElevation },
            });
          }
        }
      });
    }
  });

  return segments;
}

function getRelevantTrackPoints(
  points: TrackPoint[],
): TrackPoint[] {
  if (points.length <= 300) {
    return points;
  }

  const result: TrackPoint[] = [];

  const samplingStep = Math.max(
    1,
    Math.floor(points.length / 250),
  );

  for (
    let index = 0;
    index < points.length;
    index += samplingStep
  ) {
    result.push(points[index]);
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  if (result[0] !== firstPoint) {
    result.unshift(firstPoint);
  }

  if (
    result[result.length - 1] !== lastPoint
  ) {
    result.push(lastPoint);
  }

  const highestPoints = [...points]
    .filter(
      (
        point,
      ): point is TrackPoint & {
        elevation: number;
      } => point.elevation !== null,
    )
    .sort(
      (firstPoint, secondPoint) =>
        secondPoint.elevation -
        firstPoint.elevation,
    )
    .slice(0, 25);

  result.push(...highestPoints);

  return result;
}

function getTrackBoundingBox(
  points: TrackPoint[],
  searchRadiusM: number,
) {
  const longitudes = points.map(
    (point) => point.longitude,
  );

  const latitudes = points.map(
    (point) => point.latitude,
  );

  const minimumLatitude = Math.min(
    ...latitudes,
  );

  const maximumLatitude = Math.max(
    ...latitudes,
  );

  const averageLatitude =
    (minimumLatitude + maximumLatitude) / 2;

  const latitudePadding =
    searchRadiusM / 111_320;

  const longitudePadding =
    searchRadiusM /
    (
      111_320 *
      Math.max(
        0.1,
        Math.cos(
          degreesToRadians(averageLatitude),
        ),
      )
    );

  return {
    minimumLongitude:
      Math.min(...longitudes) -
      longitudePadding,

    maximumLongitude:
      Math.max(...longitudes) +
      longitudePadding,

    minimumLatitude:
      minimumLatitude -
      latitudePadding,

    maximumLatitude:
      maximumLatitude +
      latitudePadding,
  };
}

function getMountainName(
  mountain: MountainCandidateRow,
): string {
  return (
    mountain.name_de ??
    mountain.name ??
    `Вершина №${mountain.id}`
  );
}

function calculateConfidence(
  distanceM: number,
  confirmationRadiusM: number,
  mountainHeight: number | null,
  localRouteElevation: number | null,
): number {
  const distanceScore = Math.max(
    0,
    1 -
      distanceM /
        Math.max(confirmationRadiusM, 1),
  );

  let elevationScore = 0.5;

  if (
    mountainHeight !== null &&
    localRouteElevation !== null
  ) {
    const elevationDifference = Math.abs(
      mountainHeight -
        localRouteElevation,
    );

    elevationScore = Math.max(
      0,
      1 - elevationDifference / 500,
    );
  }

  const confidence =
    distanceScore * 0.8 +
    elevationScore * 0.2;

  return Number(
    Math.max(
      0,
      Math.min(1, confidence),
    ).toFixed(3),
  );
}

function calculateClosestTrackPosition(
  mountainLon: number,
  mountainLat: number,
  allTrackPoints: TrackPoint[],
  trackSegments: TrackSegment[],
  trackSegmentIndex: RouteSegmentSpatialIndex,
): ClosestTrackPosition {
  let closestPosition: ClosestTrackPosition = {
    distanceM: Number.POSITIVE_INFINITY,
    elevation: null,
  };

  const mountainPoint: TrackPoint = { longitude: mountainLon, latitude: mountainLat, elevation: null };

  const candidateSegmentIndexes = getRouteSegmentCandidateIndexes(
    trackSegmentIndex,
    mountainLon,
    mountainLat,
  );

  for (const segmentIndex of candidateSegmentIndexes) {
    const segment = trackSegments[segmentIndex];
    const projection = calculateProjectionOnSegment(
      mountainPoint,
      segment.start,
      segment.end,
    );
    if (projection.distanceM < closestPosition.distanceM) {
      closestPosition = {
        distanceM: projection.distanceM,
        elevation: getElevationAtProjection(segment, projection.fraction),
      };
    }
  }

  if (closestPosition.distanceM === Number.POSITIVE_INFINITY && allTrackPoints.length > 0) {
    for (const trackPoint of allTrackPoints) {
      const distanceM = calculateDistanceMeters(
        trackPoint.longitude,
        trackPoint.latitude,
        mountainLon,
        mountainLat,
      );
      if (distanceM < closestPosition.distanceM) {
        closestPosition = {
          distanceM,
          elevation: trackPoint.elevation,
        };
      }
    }
  }

  return closestPosition;
}

export async function evaluateMountainCandidatesForTrack({
  supabase,
  geojson,
  searchRadiusM = 2_500,
  confirmationRadiusM = 300,
}: DetectMountainOptions): Promise<MountainDetectionCandidate[]> {
  const allTrackPoints = getTrackPoints(geojson);
  const trackSegments = getTrackSegments(geojson);
  const trackSegmentIndex = buildRouteSegmentSpatialIndex(
    trackSegments.map((segment) => ({
      startLongitude: segment.start.longitude,
      startLatitude: segment.start.latitude,
      endLongitude: segment.end.longitude,
      endLatitude: segment.end.latitude,
    })),
    searchRadiusM,
  );

  if (allTrackPoints.length < 2) {
    throw new Error(
      "В GeoJSON недостаточно координат для определения вершины.",
    );
  }

  const relevantTrackPoints = getRelevantTrackPoints(allTrackPoints);

  const boundingBox = getTrackBoundingBox(
    relevantTrackPoints,
    searchRadiusM,
  );

  const {
    data: mountainRows,
    error: mountainsError,
  } = await supabase
    .from("mountains")
    .select(`
      id,
      name,
      name_de,
      height,
      latitude,
      longitude
    `)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .gte(
      "latitude",
      boundingBox.minimumLatitude,
    )
    .lte(
      "latitude",
      boundingBox.maximumLatitude,
    )
    .gte(
      "longitude",
      boundingBox.minimumLongitude,
    )
    .lte(
      "longitude",
      boundingBox.maximumLongitude,
    )
    .limit(500);

  if (mountainsError) {
    throw mountainsError;
  }

  const mountains =
    (mountainRows ??
      []) as MountainCandidateRow[];

  if (mountains.length === 0) {
    return [];
  }

  const candidates: MountainDetectionCandidate[] = [];

  for (const mountain of mountains) {
    if (
      mountain.latitude === null ||
      mountain.longitude === null
    ) {
      continue;
    }

    const closestTrackPosition = calculateClosestTrackPosition(
      mountain.longitude as number,
      mountain.latitude as number,
      allTrackPoints,
      trackSegments,
      trackSegmentIndex,
    );

    if (closestTrackPosition.distanceM > searchRadiusM) {
      continue;
    }

    const confidence =
      calculateConfidence(
        closestTrackPosition.distanceM,
        confirmationRadiusM,
        mountain.height,
        closestTrackPosition.elevation,
      );

    const candidate: MountainDetectionCandidate = {
      mountainId: Number(mountain.id),
      mountainName:
        getMountainName(mountain),

      mountainHeight:
        mountain.height !== null
          ? Number(mountain.height)
          : null,

      distanceM: Math.round(
        closestTrackPosition.distanceM,
      ),

      confidence,
    };

    candidates.push(candidate);
  }

  candidates.sort((first, second) =>
    second.confidence - first.confidence || first.distanceM - second.distanceM,
  );

  return candidates;
}

export async function detectMountainFromTrack({
  supabase,
  geojson,
  searchRadiusM = 2_500,
  confirmationRadiusM = 300,
}: DetectMountainOptions): Promise<
  DetectedMountain | null
> {
  const candidates = await evaluateMountainCandidatesForTrack({
    supabase,
    geojson,
    searchRadiusM,
    confirmationRadiusM,
  });

  const bestMountain = candidates[0] ?? null;

  if (
    !bestMountain ||
    bestMountain.distanceM >
      searchRadiusM
  ) {
    return null;
  }

  return {
    ...bestMountain,
    runnerUp: candidates[1] ?? null,
    candidates,
  };
}
