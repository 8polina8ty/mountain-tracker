// Minimal geographic utilities — WGS84, no external deps
// Coordinates are [longitude, latitude] per GeoJSON

export type Coordinate = [number, number];

/** Haversine distance in meters between two WGS84 points */
export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Point-to-segment geodesic distance (equirectangular local tangent, accurate <20km).
 * Handles segment interiors, endpoints, high latitude (cos scaling), longitude wraparound
 * via shortest arc, and invalid inputs (returns Infinity).
 * Numerical accuracy: <1% error for distances <20km at Alps latitudes; use haversine for endpoints fallback.
 */
export function pointToSegmentMeters(point: Coordinate, segA: Coordinate, segB: Coordinate): number {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(segA[0]) || !Number.isFinite(segA[1]) || !Number.isFinite(segB[0]) || !Number.isFinite(segB[1])) return Infinity;
  // Handle wraparound: choose shortest longitude delta
  const normalizeLon = (lon: number, ref: number) => {
    let d = lon - ref;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return ref + d;
  };
  const bLon = normalizeLon(segB[0], segA[0]);
  const pLon = normalizeLon(point[0], segA[0]);
  const lat0 = ((segA[1] + segB[1]) / 2) * Math.PI / 180;
  const R = 6371000;
  const cosLat0 = Math.max(0.1, Math.cos(lat0));
  const toX = (lon: number) => (lon * Math.PI / 180) * R * cosLat0;
  const toY = (lat: number) => (lat * Math.PI / 180) * R;
  const ax = toX(segA[0]), ay = toY(segA[1]);
  const bx = toX(bLon), by = toY(segB[1]);
  const px = toX(pLon), py = toY(point[1]);
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return haversineMeters(point, segA);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return haversineMeters(point, [bLon, segB[1]] as Coordinate);
  const t = c1 / c2;
  const proj: Coordinate = [segA[0] + t * (bLon - segA[0]), segA[1] + t * (segB[1] - segA[1])];
  // Wrap back into [-180,180]
  if (proj[0] > 180) proj[0] -= 360;
  if (proj[0] < -180) proj[0] += 360;
  return haversineMeters(point, proj);
}

/** Fast bbox pre-filter for spatial index */
export function bboxForPoint(center: Coordinate, radiusMeters: number): [number, number, number, number] {
  // approx: 1 deg lat ~ 111km, lon scales with cos(lat)
  const latDelta = radiusMeters / 111000;
  const lonDelta = radiusMeters / (111000 * Math.max(0.1, Math.cos((center[1] * Math.PI) / 180)));
  return [center[0] - lonDelta, center[1] - latDelta, center[0] + lonDelta, center[1] + latDelta];
}

export function bboxIntersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function segmentsIntersectLocally(
  a1: Coordinate,
  a2: Coordinate,
  b1: Coordinate,
  b2: Coordinate,
): boolean {
  const coordinates = [a1, a2, b1, b2];
  if (
    coordinates.some(
      ([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat),
    )
  ) {
    return false;
  }

  const referenceLon = a1[0];
  const normalizeLon = (lon: number): number => {
    let delta = lon - referenceLon;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return referenceLon + delta;
  };

  const meanLat =
    (a1[1] + a2[1] + b1[1] + b2[1]) / 4;
  const lat0 = (meanLat * Math.PI) / 180;
  const radius = 6371000;
  const cosLat0 = Math.max(0.1, Math.cos(lat0));
  const project = ([lon, lat]: Coordinate): [number, number] => [
    ((normalizeLon(lon) - referenceLon) * Math.PI / 180) *
      radius *
      cosLat0,
    ((lat - a1[1]) * Math.PI / 180) * radius,
  ];

  const pa1 = project(a1);
  const pa2 = project(a2);
  const pb1 = project(b1);
  const pb2 = project(b2);

  const cross = (
    p: [number, number],
    q: [number, number],
    r: [number, number],
  ): number =>
    (q[0] - p[0]) * (r[1] - p[1]) -
    (q[1] - p[1]) * (r[0] - p[0]);

  const onSegment = (
    p: [number, number],
    q: [number, number],
    r: [number, number],
  ): boolean => {
    const epsilon = 1e-6;
    return (
      Math.min(p[0], q[0]) - epsilon <= r[0] &&
      r[0] <= Math.max(p[0], q[0]) + epsilon &&
      Math.min(p[1], q[1]) - epsilon <= r[1] &&
      r[1] <= Math.max(p[1], q[1]) + epsilon
    );
  };

  const o1 = cross(pa1, pa2, pb1);
  const o2 = cross(pa1, pa2, pb2);
  const o3 = cross(pb1, pb2, pa1);
  const o4 = cross(pb1, pb2, pa2);
  const epsilon = 1e-6;

  if (
    ((o1 > epsilon && o2 < -epsilon) ||
      (o1 < -epsilon && o2 > epsilon)) &&
    ((o3 > epsilon && o4 < -epsilon) ||
      (o3 < -epsilon && o4 > epsilon))
  ) {
    return true;
  }

  return (
    (Math.abs(o1) <= epsilon && onSegment(pa1, pa2, pb1)) ||
    (Math.abs(o2) <= epsilon && onSegment(pa1, pa2, pb2)) ||
    (Math.abs(o3) <= epsilon && onSegment(pb1, pb2, pa1)) ||
    (Math.abs(o4) <= epsilon && onSegment(pb1, pb2, pa2))
  );
}

/**
 * Segment-to-segment distance.
 * Returns zero for crossing/touching segments before falling back to
 * endpoint-to-segment distances. The local projection uses longitude
 * wraparound so short dateline-crossing segments remain adjacent.
 */
export function segmentToSegmentMeters(
  a1: Coordinate,
  a2: Coordinate,
  b1: Coordinate,
  b2: Coordinate,
): number {
  if (segmentsIntersectLocally(a1, a2, b1, b2)) {
    return 0;
  }

  return Math.min(
    pointToSegmentMeters(a1, b1, b2),
    pointToSegmentMeters(a2, b1, b2),
    pointToSegmentMeters(b1, a1, a2),
    pointToSegmentMeters(b2, a1, a2),
  );
}

/** Simple grid spatial index for boundary segments / points */
export class GridIndex<T> {
  private cells = new Map<string, T[]>();
  private cellSize = 1.0; // degrees
  constructor(cellSize = 1.0) { this.cellSize = cellSize; }
  private key(lon: number, lat: number) {
    return `${Math.floor(lon / this.cellSize)}:${Math.floor(lat / this.cellSize)}`;
  }
  insert(bbox: [number, number, number, number], value: T) {
    const min = this.key(bbox[0], bbox[1]);
    const max = this.key(bbox[2], bbox[3]);
    const [minX, minY] = min.split(":").map(Number);
    const [maxX, maxY] = max.split(":").map(Number);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const k = `${x}:${y}`;
      const list = this.cells.get(k) ?? [];
      list.push(value);
      this.cells.set(k, list);
    }
  }
  query(bbox: [number, number, number, number]): T[] {
    const out: T[] = [];
    const seen = new Set<T>();
    const min = this.key(bbox[0], bbox[1]);
    const max = this.key(bbox[2], bbox[3]);
    const [minX, minY] = min.split(":").map(Number);
    const [maxX, maxY] = max.split(":").map(Number);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const k = `${x}:${y}`;
      for (const v of this.cells.get(k) ?? []) if (!seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  }
}
