import type {
  Coordinate,
  MatchablePeak,
  MatchableRoute,
} from "./peak-matcher.ts";
import { normalizeRouteGeometry } from "./route-geometry.ts";

interface MetricPoint {
  x: number;
  y: number;
  z: number;
}

interface IndexedPeak {
  peak: MatchablePeak;
  point: MetricPoint;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
export const BULK_PEAK_CANDIDATE_RADIUS_METERS = 500;
export const BULK_ROUTE_CANDIDATE_SAMPLE_METERS = 250;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function metricPoint(coordinate: Coordinate): MetricPoint {
  const longitude = degreesToRadians(coordinate[0]);
  const latitude = degreesToRadians(coordinate[1]);
  const latitudeRadius = EARTH_RADIUS_METERS * Math.cos(latitude);
  return {
    x: latitudeRadius * Math.cos(longitude),
    y: latitudeRadius * Math.sin(longitude),
    z: EARTH_RADIUS_METERS * Math.sin(latitude),
  };
}

export class SpatialPeakIndex {
  readonly peaks: MatchablePeak[];
  readonly cellSizeMeters: number;
  private readonly cells = new Map<string, IndexedPeak[]>();

  constructor(peaks: MatchablePeak[], cellSizeMeters = 500) {
    this.peaks = peaks;
    this.cellSizeMeters = cellSizeMeters;
    for (const peak of peaks) {
      const point = metricPoint(peak.coordinates);
      const key = this.keyForPoint(point);
      const existing = this.cells.get(key);
      const indexed = { peak, point };
      if (existing) {
        existing.push(indexed);
      } else {
        this.cells.set(key, [indexed]);
      }
    }
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSizeMeters);
  }

  private key(x: number, y: number, z: number): string {
    return `${x}:${y}:${z}`;
  }

  private keyForPoint(point: MetricPoint): string {
    return this.key(this.cell(point.x), this.cell(point.y), this.cell(point.z));
  }

  queryRadius(coordinate: Coordinate, radiusMeters: number): MatchablePeak[] {
    const origin = metricPoint(coordinate);
    const center = [this.cell(origin.x), this.cell(origin.y), this.cell(origin.z)];
    const cellRadius = Math.ceil(radiusMeters / this.cellSizeMeters);
    const radiusSquared = radiusMeters ** 2;
    const found = new Map<string, MatchablePeak>();

    for (let x = -cellRadius; x <= cellRadius; x += 1) {
      for (let y = -cellRadius; y <= cellRadius; y += 1) {
        for (let z = -cellRadius; z <= cellRadius; z += 1) {
          const candidates = this.cells.get(
            this.key(center[0] + x, center[1] + y, center[2] + z),
          );
          candidates?.forEach((candidate) => {
            const distanceSquared =
              (candidate.point.x - origin.x) ** 2 +
              (candidate.point.y - origin.y) ** 2 +
              (candidate.point.z - origin.z) ** 2;
            if (distanceSquared <= radiusSquared) {
              found.set(candidate.peak.sourceId, candidate.peak);
            }
          });
        }
      }
    }

    return [...found.values()];
  }

  findNearest(coordinate: Coordinate): MatchablePeak | null {
    const origin = metricPoint(coordinate);
    const nearestFrom = (candidates: MatchablePeak[]): MatchablePeak | null =>
      candidates.reduce<MatchablePeak | null>((nearest, candidate) => {
        if (!nearest) {
          return candidate;
        }
        const nearestPoint = metricPoint(nearest.coordinates);
        const candidatePoint = metricPoint(candidate.coordinates);
        const nearestDistance =
          (nearestPoint.x - origin.x) ** 2 +
          (nearestPoint.y - origin.y) ** 2 +
          (nearestPoint.z - origin.z) ** 2;
        const candidateDistance =
          (candidatePoint.x - origin.x) ** 2 +
          (candidatePoint.y - origin.y) ** 2 +
          (candidatePoint.z - origin.z) ** 2;
        return candidateDistance < nearestDistance ? candidate : nearest;
      }, null);

    for (const radius of [1_000, 2_000, 5_000, 10_000, 25_000, 50_000, 100_000]) {
      const candidates = this.queryRadius(coordinate, radius);
      if (candidates.length > 0) {
        return nearestFrom(candidates);
      }
    }
    return nearestFrom(this.peaks);
  }
}

export function generatePeakCandidates(
  route: MatchableRoute,
  index: SpatialPeakIndex,
): MatchablePeak[] {
  const normalized = normalizeRouteGeometry(route.geometry, {
    resampleIntervalMeters: BULK_ROUTE_CANDIDATE_SAMPLE_METERS,
    duplicatePointToleranceMeters: 0.5,
  });
  const conservativeRadius =
    BULK_PEAK_CANDIDATE_RADIUS_METERS +
    BULK_ROUTE_CANDIDATE_SAMPLE_METERS / 2;
  const candidates = new Map<string, MatchablePeak>();

  normalized.components.flat().forEach((coordinate) =>
    index
      .queryRadius(coordinate, conservativeRadius)
      .forEach((peak) => candidates.set(peak.sourceId, peak)),
  );

  return [...candidates.values()];
}
