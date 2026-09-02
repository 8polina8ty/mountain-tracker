import { readFile } from "node:fs/promises";

import type { Coordinate, RouteGeometry } from "./peak-matcher.ts";

export const SUPPORTED_ALPS_COUNTRY_CODES = Object.freeze([
  "DE",
  "AT",
  "CH",
  "IT",
  "FR",
  "SI",
  "LI",
] as const);

export type AlpsCountryCode = (typeof SUPPORTED_ALPS_COUNTRY_CODES)[number];

export interface BoundaryProperties {
  countryCode: AlpsCountryCode;
  countryName: string;
  admin1Code: string;
  admin1Name: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  version: string;
}

interface PolygonGeometry {
  type: "Polygon";
  coordinates: Coordinate[][];
}

interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Coordinate[][][];
}

export interface AdminBoundaryFeature {
  type: "Feature";
  id: string;
  bbox: [number, number, number, number];
  properties: BoundaryProperties;
  geometry: PolygonGeometry | MultiPolygonGeometry;
}

export interface AdminBoundaryDataset {
  type: "FeatureCollection";
  metadata: {
    provider: string;
    dataset: string;
    source: string;
    license: string;
    version: string;
    sourceUrl: string;
    attribution: string;
  };
  features: AdminBoundaryFeature[];
}

export interface AdminAssignment {
  status: "ASSIGNED";
  countryCode: AlpsCountryCode;
  countryName: string;
  admin1Code: string;
  admin1Name: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  version: string;
  boundaryProvenance: AdminBoundaryDataset["metadata"];
}

export interface AdminBoundaryCandidate {
  countryCode: AlpsCountryCode;
  countryName: string;
  admin1Code: string;
  admin1Name: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  version: string;
}

export interface AmbiguousAdminAssignment {
  status: "AMBIGUOUS";
  candidates: AdminBoundaryCandidate[];
  reason: string;
  boundaryProvenance: AdminBoundaryDataset["metadata"];
}

export interface UnassignedAdminAssignment {
  status: "UNASSIGNED";
  reason: string;
  boundaryProvenance: AdminBoundaryDataset["metadata"] | null;
}

export type AdminBoundaryResolution =
  | AdminAssignment
  | AmbiguousAdminAssignment
  | UnassignedAdminAssignment;

function coordinateIsValid(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function pointTouchesSegment(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate,
): boolean {
  const cross =
    (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);
  const scale = Math.max(
    1,
    Math.abs(end[0] - start[0]),
    Math.abs(end[1] - start[1]),
  );
  if (Math.abs(cross) > 1e-10 * scale) return false;
  return (
    point[0] >= Math.min(start[0], end[0]) - 1e-10 &&
    point[0] <= Math.max(start[0], end[0]) + 1e-10 &&
    point[1] >= Math.min(start[1], end[1]) - 1e-10 &&
    point[1] <= Math.max(start[1], end[1]) + 1e-10
  );
}

function ringRelationship(
  point: Coordinate,
  ring: Coordinate[],
): "INSIDE" | "BOUNDARY" | "OUTSIDE" {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const currentPoint = ring[current];
    const previousPoint = ring[previous];
    if (pointTouchesSegment(point, previousPoint, currentPoint)) return "BOUNDARY";
    const intersects =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) *
          (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (intersects) inside = !inside;
  }
  return inside ? "INSIDE" : "OUTSIDE";
}

function polygonRelationship(
  point: Coordinate,
  polygon: Coordinate[][],
): "INSIDE" | "BOUNDARY" | "OUTSIDE" {
  const exterior = polygon[0];
  if (!exterior) return "OUTSIDE";
  const exteriorRelationship = ringRelationship(point, exterior);
  if (exteriorRelationship !== "INSIDE") return exteriorRelationship;
  for (const hole of polygon.slice(1)) {
    const holeRelationship = ringRelationship(point, hole);
    if (holeRelationship === "BOUNDARY") return "BOUNDARY";
    if (holeRelationship === "INSIDE") return "OUTSIDE";
  }
  return "INSIDE";
}

function featureRelationship(
  feature: AdminBoundaryFeature,
  point: Coordinate,
): "INSIDE" | "BOUNDARY" | "OUTSIDE" {
  const [minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude] =
    feature.bbox;
  if (
    point[0] < minimumLongitude ||
    point[0] > maximumLongitude ||
    point[1] < minimumLatitude ||
    point[1] > maximumLatitude
  ) {
    return "OUTSIDE";
  }
  const polygons =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  let inside = false;
  for (const polygon of polygons) {
    const relationship = polygonRelationship(point, polygon);
    if (relationship === "BOUNDARY") return "BOUNDARY";
    if (relationship === "INSIDE") inside = true;
  }
  return inside ? "INSIDE" : "OUTSIDE";
}

function isSupportedCountryCode(value: unknown): value is AlpsCountryCode {
  return (
    typeof value === "string" &&
    (SUPPORTED_ALPS_COUNTRY_CODES as readonly string[]).includes(value)
  );
}

export function parseAdminBoundaryDataset(value: unknown): AdminBoundaryDataset {
  if (!value || typeof value !== "object") {
    throw new Error("administrative boundary dataset must be an object");
  }
  const candidate = value as Partial<AdminBoundaryDataset>;
  if (candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) {
    throw new Error("administrative boundary dataset must be a FeatureCollection");
  }
  if (
    !candidate.metadata ||
    !candidate.metadata.provider ||
    !candidate.metadata.dataset ||
    !candidate.metadata.source ||
    !candidate.metadata.license ||
    !candidate.metadata.version ||
    !candidate.metadata.sourceUrl ||
    !candidate.metadata.attribution
  ) {
    throw new Error("administrative boundary provenance is incomplete");
  }
  for (const feature of candidate.features) {
    if (
      feature.type !== "Feature" ||
      !feature.id ||
      !Array.isArray(feature.bbox) ||
      feature.bbox.length !== 4 ||
      !feature.bbox.every(Number.isFinite) ||
      !isSupportedCountryCode(feature.properties?.countryCode) ||
      !feature.properties.countryName ||
      !feature.properties.admin1Code ||
      !feature.properties.admin1Name ||
      !feature.properties.source ||
      !feature.properties.sourceUrl ||
      !feature.properties.license ||
      !feature.properties.licenseUrl ||
      !feature.properties.attribution ||
      !feature.properties.version ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
    ) {
      throw new Error("administrative boundary feature is invalid or unsupported");
    }
    const coordinates =
      feature.geometry.type === "Polygon"
        ? feature.geometry.coordinates.flat()
        : feature.geometry.coordinates.flat(2);
    if (coordinates.length < 4 || !coordinates.every(coordinateIsValid)) {
      throw new Error("administrative boundary geometry is invalid");
    }
  }
  return candidate as AdminBoundaryDataset;
}

export async function loadAdminBoundaryDataset(
  path: string,
): Promise<AdminBoundaryDataset> {
  return parseAdminBoundaryDataset(JSON.parse(await readFile(path, "utf8")));
}

function candidateFromFeature(feature: AdminBoundaryFeature): AdminBoundaryCandidate {
  return { ...feature.properties };
}

function compareCandidates(
  left: AdminBoundaryCandidate,
  right: AdminBoundaryCandidate,
): number {
  return (
    left.countryCode.localeCompare(right.countryCode) ||
    left.admin1Code.localeCompare(right.admin1Code) ||
    left.admin1Name.localeCompare(right.admin1Name)
  );
}

export function resolvePointAdminBoundary(
  point: Coordinate,
  dataset: AdminBoundaryDataset | null,
): AdminBoundaryResolution {
  if (!dataset) {
    return {
      status: "UNASSIGNED",
      reason: "Administrative boundary dataset is unavailable.",
      boundaryProvenance: null,
    };
  }
  if (!coordinateIsValid(point)) {
    return {
      status: "UNASSIGNED",
      reason: "Coordinate is invalid or outside longitude/latitude ranges.",
      boundaryProvenance: { ...dataset.metadata },
    };
  }
  const matches = dataset.features.filter(
    (feature) => featureRelationship(feature, point) !== "OUTSIDE",
  );
  if (matches.length === 0) {
    return {
      status: "UNASSIGNED",
      reason: "Coordinate is outside all supported boundary polygons.",
      boundaryProvenance: { ...dataset.metadata },
    };
  }
  const candidates = matches.map(candidateFromFeature).sort(compareCandidates);
  if (candidates.length > 1) {
    return {
      status: "AMBIGUOUS",
      candidates,
      reason:
        "Coordinate is contained by or touches multiple administrative polygons; no arbitrary assignment was made.",
      boundaryProvenance: { ...dataset.metadata },
    };
  }
  return {
    status: "ASSIGNED",
    ...candidates[0],
    boundaryProvenance: { ...dataset.metadata },
  };
}

export function assignPointToAdminBoundary(
  point: Coordinate,
  dataset: AdminBoundaryDataset | null,
): AdminAssignment | null {
  const resolution = resolvePointAdminBoundary(point, dataset);
  return resolution.status === "ASSIGNED" ? resolution : null;
}

function geometryCoordinates(geometry: RouteGeometry): Coordinate[] {
  return geometry.type === "LineString"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

export function assignRouteToAdminBoundary(
  geometry: RouteGeometry,
  dataset: AdminBoundaryDataset | null,
): AdminAssignment | null {
  const resolution = resolveRouteAdminBoundary(geometry, dataset);
  return resolution.status === "ASSIGNED" ? resolution : null;
}

export function combineAdminBoundaryResolutions(
  resolutions: AdminBoundaryResolution[],
  dataset: AdminBoundaryDataset | null,
): AdminBoundaryResolution {
  const provenance = dataset ? { ...dataset.metadata } : null;
  if (resolutions.length === 0) {
    return {
      status: "UNASSIGNED",
      reason: "No coordinates were available for administrative enrichment.",
      boundaryProvenance: provenance,
    };
  }
  const ambiguousCandidates = resolutions.flatMap((resolution) =>
    resolution.status === "AMBIGUOUS" ? resolution.candidates : [],
  );
  const assigned = resolutions.filter(
    (resolution): resolution is AdminAssignment => resolution.status === "ASSIGNED",
  );
  const candidates = [...ambiguousCandidates, ...assigned]
    .filter(
      (candidate, index, values) =>
        values.findIndex(
          (value) =>
            value.countryCode === candidate.countryCode &&
            value.admin1Code === candidate.admin1Code,
        ) === index,
    )
    .sort(compareCandidates);
  if (
    ambiguousCandidates.length > 0 ||
    candidates.length > 1
  ) {
    if (!dataset) {
      return {
        status: "UNASSIGNED",
        reason: "Administrative boundary dataset is unavailable.",
        boundaryProvenance: null,
      };
    }
    return {
      status: "AMBIGUOUS",
      candidates,
      reason:
        "Route coordinates resolve to multiple administrative polygons; no arbitrary assignment was made.",
      boundaryProvenance: { ...dataset.metadata },
    };
  }
  if (
    candidates.length === 1 &&
    resolutions.every((resolution) => resolution.status === "ASSIGNED")
  ) {
    return {
      status: "ASSIGNED",
      ...candidates[0],
      boundaryProvenance: { ...(dataset as AdminBoundaryDataset).metadata },
    };
  }
  return {
    status: "UNASSIGNED",
    reason: "At least one route coordinate could not be assigned reliably.",
    boundaryProvenance: provenance,
  };
}

export function resolveRouteAdminBoundary(
  geometry: RouteGeometry,
  dataset: AdminBoundaryDataset | null,
): AdminBoundaryResolution {
  return combineAdminBoundaryResolutions(
    geometryCoordinates(geometry).map((coordinate) =>
      resolvePointAdminBoundary(coordinate, dataset),
    ),
    dataset,
  );
}
