export type ParsedGpxTrack = {
  geojson: GeoJSON.FeatureCollection<GeoJSON.LineString>;
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
export const GPX_MAX_TRACK_POINTS = 250_000;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(firstPoint: TrackPoint, secondPoint: TrackPoint): number {
  const firstLatitude = degreesToRadians(firstPoint.latitude);
  const secondLatitude = degreesToRadians(secondPoint.latitude);
  const latitudeDifference = degreesToRadians(secondPoint.latitude - firstPoint.latitude);
  const longitudeDifference = degreesToRadians(secondPoint.longitude - firstPoint.longitude);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return EARTH_RADIUS_M * centralAngle;
}

function parseOptionalNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseOptionalTime(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export function isValidGpxCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
}

function getTrackPoints(document: XMLDocument): TrackPoint[] {
  const trackPointElements = document.querySelectorAll("trkpt");
  if (trackPointElements.length > GPX_MAX_TRACK_POINTS) {
    throw new Error("GPX-файл содержит слишком много GPS-точек.");
  }

  const points: TrackPoint[] = [];
  for (const element of trackPointElements) {
    const latitudeAttribute = element.getAttribute("lat");
    const longitudeAttribute = element.getAttribute("lon");
    if (latitudeAttribute === null || longitudeAttribute === null) {
      throw new Error("GPX-файл содержит GPS-точку без координат.");
    }

    const latitude = Number(latitudeAttribute);
    const longitude = Number(longitudeAttribute);
    if (!isValidGpxCoordinate(latitude, longitude)) {
      throw new Error("GPX-файл содержит GPS-точку с некорректными координатами.");
    }

    points.push({
      latitude,
      longitude,
      elevation: parseOptionalNumber(element.querySelector("ele")?.textContent ?? null),
      time: parseOptionalTime(element.querySelector("time")?.textContent ?? null),
    });
  }
  return points;
}

export async function parseGpxFile(file: File): Promise<ParsedGpxTrack> {
  const xmlText = await file.text();
  const parser = new DOMParser();
  const document = parser.parseFromString(xmlText, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) throw new Error("GPX-файл содержит некорректный XML.");

  const points = getTrackPoints(document);
  if (points.length < 2) throw new Error("В GPX-файле недостаточно GPS-точек.");

  let distanceM = 0;
  let elevationGainM = 0;
  let minimumElevationM: number | null = null;
  let maximumElevationM: number | null = null;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const currentPoint = points[pointIndex];
    if (currentPoint.elevation !== null) {
      minimumElevationM = minimumElevationM === null ? currentPoint.elevation : Math.min(minimumElevationM, currentPoint.elevation);
      maximumElevationM = maximumElevationM === null ? currentPoint.elevation : Math.max(maximumElevationM, currentPoint.elevation);
    }
    if (currentPoint.time !== null) {
      startedAt ??= currentPoint.time;
      finishedAt = currentPoint.time;
    }
    if (pointIndex === 0) continue;

    const previousPoint = points[pointIndex - 1];
    distanceM += calculateDistanceMeters(previousPoint, currentPoint);
    if (previousPoint.elevation !== null && currentPoint.elevation !== null) {
      const elevationDifference = currentPoint.elevation - previousPoint.elevation;
      if (elevationDifference >= 1) elevationGainM += elevationDifference;
    }
  }

  let durationSeconds: number | null = null;
  if (startedAt && finishedAt) {
    const durationMilliseconds = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    if (durationMilliseconds >= 0) durationSeconds = Math.round(durationMilliseconds / 1000);
  }

  const coordinates: GeoJSON.Position[] = points.map((point) =>
    point.elevation !== null
      ? [point.longitude, point.latitude, point.elevation]
      : [point.longitude, point.latitude],
  );

  const trackName = document.querySelector("trk > name")?.textContent?.trim() || file.name.replace(/\.[^.]+$/, "");
  const geojson: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: trackName, source: "gpx_upload", point_count: points.length },
      geometry: { type: "LineString", coordinates },
    }],
  };

  return {
    geojson,
    pointCount: points.length,
    startedAt,
    finishedAt,
    durationSeconds,
    distanceM: Math.round(distanceM),
    elevationGainM: Math.round(elevationGainM),
    minimumElevationM,
    maximumElevationM,
  };
}
