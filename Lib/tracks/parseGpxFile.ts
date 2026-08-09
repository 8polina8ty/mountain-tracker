export type ParsedGpxTrack = {
  geojson: GeoJSON.FeatureCollection<
    GeoJSON.LineString
  >;

  pointCount: number;

  startedAt: string | null;
  finishedAt: string | null;

  durationSeconds: number | null;
  distanceM: number;

  elevationGainM: number;
  minimumElevationM: number | null;
  maximumElevationM: number | null;
};

type TrackPoint = {
  longitude: number;
  latitude: number;
  elevation: number | null;
  time: string | null;
};

const EARTH_RADIUS_M = 6_371_000;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(
  firstPoint: TrackPoint,
  secondPoint: TrackPoint,
): number {
  const firstLatitude =
    degreesToRadians(firstPoint.latitude);

  const secondLatitude =
    degreesToRadians(secondPoint.latitude);

  const latitudeDifference = degreesToRadians(
    secondPoint.latitude - firstPoint.latitude,
  );

  const longitudeDifference = degreesToRadians(
    secondPoint.longitude - firstPoint.longitude,
  );

  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;

  const centralAngle =
    2 *
    Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine),
    );

  return EARTH_RADIUS_M * centralAngle;
}

function parseOptionalNumber(
  value: string | null,
): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue)
    ? parsedValue
    : null;
}

function parseOptionalTime(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime())
    ? null
    : timestamp.toISOString();
}

function getTrackPoints(
  document: XMLDocument,
): TrackPoint[] {
  const trackPointElements = Array.from(
    document.querySelectorAll("trkpt"),
  );

  return trackPointElements.flatMap((element) => {
    const latitude = Number(
      element.getAttribute("lat"),
    );

    const longitude = Number(
      element.getAttribute("lon"),
    );

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return [];
    }

    const elevation = parseOptionalNumber(
      element.querySelector("ele")?.textContent ??
        null,
    );

    const time = parseOptionalTime(
      element.querySelector("time")?.textContent ??
        null,
    );

    return [
      {
        latitude,
        longitude,
        elevation,
        time,
      },
    ];
  });
}

export async function parseGpxFile(
  file: File,
): Promise<ParsedGpxTrack> {
  const xmlText = await file.text();

  const parser = new DOMParser();

  const document = parser.parseFromString(
    xmlText,
    "application/xml",
  );

  const parserError =
    document.querySelector("parsererror");

  if (parserError) {
    throw new Error(
      "GPX-файл содержит некорректный XML.",
    );
  }

  const points = getTrackPoints(document);

  if (points.length < 2) {
    throw new Error(
      "В GPX-файле недостаточно GPS-точек.",
    );
  }

  let distanceM = 0;
  let elevationGainM = 0;

  for (
    let pointIndex = 1;
    pointIndex < points.length;
    pointIndex += 1
  ) {
    const previousPoint = points[pointIndex - 1];
    const currentPoint = points[pointIndex];

    distanceM += calculateDistanceMeters(
      previousPoint,
      currentPoint,
    );

    if (
      previousPoint.elevation !== null &&
      currentPoint.elevation !== null
    ) {
      const elevationDifference =
        currentPoint.elevation -
        previousPoint.elevation;

      /*
       * Небольшие колебания GPS-высоты не считаем
       * реальным набором высоты.
       */
      if (elevationDifference >= 1) {
        elevationGainM += elevationDifference;
      }
    }
  }

  const elevations = points.flatMap((point) =>
    point.elevation === null
      ? []
      : [point.elevation],
  );

  const timedPoints = points.filter(
    (
      point,
    ): point is TrackPoint & {
      time: string;
    } => point.time !== null,
  );

  const startedAt =
    timedPoints[0]?.time ?? null;

  const finishedAt =
    timedPoints[timedPoints.length - 1]?.time ??
    null;

  let durationSeconds: number | null = null;

  if (startedAt && finishedAt) {
    const durationMilliseconds =
      new Date(finishedAt).getTime() -
      new Date(startedAt).getTime();

    if (durationMilliseconds >= 0) {
      durationSeconds = Math.round(
        durationMilliseconds / 1000,
      );
    }
  }

  const coordinates: GeoJSON.Position[] =
    points.map((point) => {
      if (point.elevation !== null) {
        return [
          point.longitude,
          point.latitude,
          point.elevation,
        ];
      }

      return [
        point.longitude,
        point.latitude,
      ];
    });

  const trackName =
    document.querySelector("trk > name")
      ?.textContent?.trim() ||
    file.name.replace(/\.[^.]+$/, "");

  const geojson: GeoJSON.FeatureCollection<
    GeoJSON.LineString
  > = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name: trackName,
          source: "gpx_upload",
          point_count: points.length,
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      },
    ],
  };

  return {
    geojson,
    pointCount: points.length,

    startedAt,
    finishedAt,
    durationSeconds,

    distanceM: Math.round(distanceM),
    elevationGainM: Math.round(
      elevationGainM,
    ),

    minimumElevationM:
      elevations.length > 0
        ? Math.min(...elevations)
        : null,

    maximumElevationM:
      elevations.length > 0
        ? Math.max(...elevations)
        : null,
  };
}