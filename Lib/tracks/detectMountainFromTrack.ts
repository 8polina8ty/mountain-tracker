import type { SupabaseClient } from "@supabase/supabase-js";

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

export type DetectedMountain = {
  mountainId: number;
  mountainName: string;
  mountainHeight: number | null;

  distanceM: number;
  confidence: number;
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

function getRelevantTrackPoints(
  points: TrackPoint[],
): TrackPoint[] {
  if (points.length <= 300) {
    return points;
  }

  const result: TrackPoint[] = [];

  /*
   * Берём каждую N-ю точку, чтобы не выполнять
   * тысячи одинаковых сравнений.
   */
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

  /*
   * Обязательно добавляем начало и конец трека.
   */
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

  /*
   * Если есть высоты — добавляем самые высокие точки.
   */
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
  highestTrackElevation: number | null,
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
    highestTrackElevation !== null
  ) {
    const elevationDifference = Math.abs(
      mountainHeight -
        highestTrackElevation,
    );

    elevationScore = Math.max(
      0,
      1 - elevationDifference / 500,
    );
  }

  /*
   * Расстояние важнее высоты, потому что
   * GPS-высота часто неточная.
   */
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

export async function detectMountainFromTrack({
  supabase,
  geojson,
  searchRadiusM = 2_500,
  confirmationRadiusM = 300,
}: DetectMountainOptions): Promise<
  DetectedMountain | null
> {
  const allTrackPoints =
    getTrackPoints(geojson);

  if (allTrackPoints.length < 2) {
    throw new Error(
      "В GeoJSON недостаточно координат для определения вершины.",
    );
  }

  const relevantTrackPoints =
    getRelevantTrackPoints(allTrackPoints);

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
    return null;
  }

  const highestTrackElevation =
    allTrackPoints.reduce<number | null>(
      (highestElevation, point) => {
        if (point.elevation === null) {
          return highestElevation;
        }

        if (
          highestElevation === null ||
          point.elevation > highestElevation
        ) {
          return point.elevation;
        }

        return highestElevation;
      },
      null,
    );

  let bestMountain:
    | DetectedMountain
    | null = null;

  for (const mountain of mountains) {
   if (
  mountain.latitude === null ||
  mountain.longitude === null
) {
  continue;
}

    let minimumDistanceM =
      Number.POSITIVE_INFINITY;

    relevantTrackPoints.forEach(
      (trackPoint) => {
        const distanceM =
          calculateDistanceMeters(
            trackPoint.longitude,
            trackPoint.latitude,
            mountain.longitude as number,
            mountain.latitude as number,
          );

        if (
          distanceM < minimumDistanceM
        ) {
          minimumDistanceM = distanceM;
        }
      },
    );

  if (minimumDistanceM > searchRadiusM) {
  continue;
}

    const confidence =
      calculateConfidence(
        minimumDistanceM,
        confirmationRadiusM,
        mountain.height,
        highestTrackElevation,
      );

    const candidate: DetectedMountain = {
      mountainId: Number(mountain.id),
      mountainName:
        getMountainName(mountain),

      mountainHeight:
        mountain.height !== null
          ? Number(mountain.height)
          : null,

      distanceM: Math.round(
        minimumDistanceM,
      ),

      confidence,
    };

    if (
      !bestMountain ||
      candidate.confidence >
        bestMountain.confidence ||
      (
        candidate.confidence ===
          bestMountain.confidence &&
        candidate.distanceM <
          bestMountain.distanceM
      )
    ) {
      bestMountain = candidate;
    }
  }

  /*
   * Не сохраняем слишком далёкую вершину
   * как уверенно найденную.
   */
  if (
    !bestMountain ||
    bestMountain.distanceM >
      searchRadiusM
  ) {
    return null;
  }

  return bestMountain;
}