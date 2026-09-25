import { readFileSync } from "node:fs";

import type { Coordinate } from "../osm-import/peak-matcher.ts";

export type GlobalAdm0Feature = {
  type: "Feature";
  id: string;
  bbox: [number, number, number, number];
  properties: {
    countryCode: string;
    countryName: string;
    iso3: string;
    boundaryId: string;
    boundaryYearRepresented: string | null;
    source: string;
    sourceUrl: string;
    license: string;
    licenseUrl: string | null;
    attribution: string;
    version: string;
  };
  geometry:
    | { type: "Polygon"; coordinates: Coordinate[][] }
    | { type: "MultiPolygon"; coordinates: Coordinate[][][] };
};

export type GlobalAdm0Dataset = {
  type: "FeatureCollection";
  metadata: {
    provider: string;
    dataset: string;
    source: string;
    license: string;
    version: string;
    sourceUrl: string;
    attribution: string;
    boundaryPrecisionMeters: number;
    coverageGaps?: string[];
  };
  features: GlobalAdm0Feature[];
};

export type Adm0Segment = {
  countryCode: string;
  featureId: string;
  a: Coordinate;
  b: Coordinate;
  bbox: [number, number, number, number];
};

function validCoordinate(value: unknown): value is Coordinate {
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

function validIso2(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

export function parseGlobalAdm0Dataset(value: unknown): GlobalAdm0Dataset {
  if (!value || typeof value !== "object") {
    throw new Error("global ADM0 dataset must be an object");
  }

  const candidate = value as Partial<GlobalAdm0Dataset>;
  if (candidate.type !== "FeatureCollection" || !Array.isArray(candidate.features)) {
    throw new Error("global ADM0 dataset must be a FeatureCollection");
  }

  const metadata = candidate.metadata;
  if (
    !metadata ||
    !metadata.provider ||
    !metadata.dataset ||
    !metadata.source ||
    !metadata.license ||
    !metadata.version ||
    !metadata.sourceUrl ||
    !metadata.attribution ||
    !Number.isFinite(metadata.boundaryPrecisionMeters) ||
    metadata.boundaryPrecisionMeters <= 0
  ) {
    throw new Error("global ADM0 provenance is incomplete");
  }

  const ids = new Set<string>();
  const countries = new Set<string>();
  for (const feature of candidate.features) {
    if (
      feature.type !== "Feature" ||
      !feature.id ||
      ids.has(feature.id) ||
      !Array.isArray(feature.bbox) ||
      feature.bbox.length !== 4 ||
      !feature.bbox.every(Number.isFinite) ||
      !validIso2(feature.properties?.countryCode) ||
      !feature.properties.countryName ||
      !feature.properties.iso3 ||
      !feature.properties.boundaryId ||
      !feature.properties.source ||
      !feature.properties.sourceUrl ||
      !feature.properties.license ||
      !feature.properties.attribution ||
      !feature.properties.version ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
    ) {
      throw new Error("global ADM0 feature is invalid or unsupported");
    }

    const coordinates =
      feature.geometry.type === "Polygon"
        ? feature.geometry.coordinates.flat()
        : feature.geometry.coordinates.flat(2);
    if (coordinates.length < 4 || !coordinates.every(validCoordinate)) {
      throw new Error(`global ADM0 geometry is invalid for ${feature.id}`);
    }

    ids.add(feature.id);
    countries.add(feature.properties.countryCode);
  }

  if (countries.size < 2) {
    throw new Error("global ADM0 dataset must contain at least two countries");
  }

  return candidate as GlobalAdm0Dataset;
}

export function loadGlobalAdm0Dataset(path: string): GlobalAdm0Dataset {
  return parseGlobalAdm0Dataset(JSON.parse(readFileSync(path, "utf8")));
}

export function buildAdm0Segments(dataset: GlobalAdm0Dataset): Adm0Segment[] {
  const segments: Adm0Segment[] = [];

  for (const feature of dataset.features) {
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;

    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index += 1) {
          const a = ring[index];
          const b = ring[index + 1];
          if (!validCoordinate(a) || !validCoordinate(b)) continue;
          const minLat = Math.min(a[1], b[1]);
          const maxLat = Math.max(a[1], b[1]);
          const base = {
            countryCode: feature.properties.countryCode,
            featureId: feature.id,
            a,
            b,
          };
          const candidateBboxes: Array<[number, number, number, number]> =
            Math.abs(a[0] - b[0]) > 180
              ? [
                  [Math.max(a[0], b[0]), minLat, 180, maxLat],
                  [-180, minLat, Math.min(a[0], b[0]), maxLat],
                ]
              : [[
                  Math.min(a[0], b[0]),
                  minLat,
                  Math.max(a[0], b[0]),
                  maxLat,
                ]];

          for (const bbox of candidateBboxes) {
            if (
              filterBboxes.length > 0 &&
              !filterBboxes.some(
                (filter) =>
                  !(bbox[2] < filter[0] ||
                    bbox[0] > filter[2] ||
                    bbox[3] < filter[1] ||
                    bbox[1] > filter[3]),
              )
            ) {
              continue;
            }
            segments.push({ ...base, bbox });
          }
        }
      }
    }
  }

  return segments;
}

export type GlobalAdm0SourceManifestEntry = {
  countryCode: string;
  iso3: string;
  bbox: [number, number, number, number];
  localGeojsonPath: string;
  boundaryId: string;
  boundaryYearRepresented: string | null;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string | null;
};

export type GlobalAdm0SourceManifest = {
  schemaVersion: 2;
  snapshotRef: string;
  snapshotVersion: string;
  generatedAt: string;
  countryCount: number;
  requestedCountryCount: number;
  coverageGaps: Record<string, string>;
  features: number;
  sources: GlobalAdm0SourceManifestEntry[];
};

export function loadGlobalAdm0SourceManifest(path: string): GlobalAdm0SourceManifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GlobalAdm0SourceManifest>;
  if (
    value.schemaVersion !== 2 ||
    !value.snapshotRef ||
    !value.snapshotVersion ||
    !Array.isArray(value.sources) ||
    !value.coverageGaps
  ) {
    throw new Error("global ADM0 source manifest is invalid");
  }
  for (const source of value.sources) {
    if (
      !validIso2(source.countryCode) ||
      !source.iso3 ||
      !Array.isArray(source.bbox) ||
      source.bbox.length !== 4 ||
      !source.bbox.every(Number.isFinite) ||
      !source.localGeojsonPath ||
      !source.boundaryId ||
      !source.source ||
      !source.sourceUrl ||
      !source.license
    ) {
      throw new Error("global ADM0 source manifest entry is invalid");
    }
  }
  return value as GlobalAdm0SourceManifest;
}

type RawAdm0Collection = {
  type?: unknown;
  features?: Array<{
    type?: unknown;
    properties?: { shapeID?: unknown; shapeGroup?: unknown; shapeType?: unknown };
    geometry?: GlobalAdm0Feature["geometry"];
  }>;
};

export function buildAdm0SegmentsFromSource(
  content: string,
  source: GlobalAdm0SourceManifestEntry,
  filterBboxes: Array<[number, number, number, number]> = [],
): Adm0Segment[] {
  const raw = JSON.parse(content) as RawAdm0Collection;
  if (raw.type !== "FeatureCollection" || !Array.isArray(raw.features) || raw.features.length === 0) {
    throw new Error(`${source.iso3} ADM0 source is not a non-empty FeatureCollection`);
  }

  const segments: Adm0Segment[] = [];
  raw.features.forEach((feature, featureIndex) => {
    if (
      feature.type !== "Feature" ||
      !feature.properties ||
      feature.properties.shapeGroup !== source.iso3 ||
      feature.properties.shapeType !== "ADM0" ||
      !feature.geometry ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
    ) {
      throw new Error(`${source.iso3} contains an invalid ADM0 feature`);
    }
    const shapeId =
      typeof feature.properties.shapeID === "string" && feature.properties.shapeID.trim()
        ? feature.properties.shapeID.trim()
        : String(featureIndex);
    const featureId = `${source.countryCode}:${shapeId}:${featureIndex}`;
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;

    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index += 1) {
          const a = ring[index];
          const b = ring[index + 1];
          if (!validCoordinate(a) || !validCoordinate(b)) continue;
          const minLat = Math.min(a[1], b[1]);
          const maxLat = Math.max(a[1], b[1]);
          const base = { countryCode: source.countryCode, featureId, a, b };
          if (Math.abs(a[0] - b[0]) > 180) {
            const east = Math.max(a[0], b[0]);
            const west = Math.min(a[0], b[0]);
            segments.push(
              { ...base, bbox: [east, minLat, 180, maxLat] },
              { ...base, bbox: [-180, minLat, west, maxLat] },
            );
          } else {
            segments.push({
              ...base,
              bbox: [
                Math.min(a[0], b[0]),
                minLat,
                Math.max(a[0], b[0]),
                maxLat,
              ],
            });
          }
        }
      }
    }
  });
  return segments;
}
