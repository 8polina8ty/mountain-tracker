#!/usr/bin/env ts-node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { MOUNTAIN_TRACKER_ISO2_TO_ISO3 } from "./country-codes.ts";
import { parseGlobalAdm0Dataset, type GlobalAdm0Dataset, type GlobalAdm0Feature } from "./global-adm0.ts";
import type { Coordinate } from "../osm-import/peak-matcher.ts";

const SNAPSHOT_REF = "9469f09";
const SNAPSHOT_VERSION = "geoBoundaries-gbOpen-9469f09-2023-12-12";
const ROOT = resolve("data/border-peaks/global-boundaries");
const SOURCE_DIR = resolve(ROOT, "source", SNAPSHOT_VERSION);
const NORMALIZED_PATH = resolve(ROOT, "global-adm0.geojson");
const SOURCE_MANIFEST_PATH = resolve(ROOT, "source-manifest.json");

type RawFeature = {
  type?: unknown;
  properties?: {
    shapeName?: unknown;
    shapeISO?: unknown;
    shapeID?: unknown;
    shapeGroup?: unknown;
    shapeType?: unknown;
  };
  geometry?: GlobalAdm0Feature["geometry"];
};

type RawCollection = {
  type?: unknown;
  features?: RawFeature[];
};

type RawMetadata = Record<string, unknown>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`geoBoundaries metadata is missing ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function geometryCoordinates(geometry: GlobalAdm0Feature["geometry"]): Coordinate[] {
  return geometry.type === "Polygon"
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2);
}

function featureBbox(
  geometry: GlobalAdm0Feature["geometry"],
): [number, number, number, number] {
  const coordinates = geometryCoordinates(geometry);
  if (coordinates.length === 0) throw new Error("ADM0 geometry is empty");
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of coordinates) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function sourceUrl(iso3: string, suffix: "geojson" | "metaData.json"): string {
  return `https://github.com/wmgeolab/geoBoundaries/raw/${SNAPSHOT_REF}/releaseData/gbOpen/${iso3}/ADM0/geoBoundaries-${iso3}-ADM0-${suffix === "geojson" ? "" : ""}`;
}

function geojsonUrl(iso3: string): string {
  return `https://github.com/wmgeolab/geoBoundaries/raw/${SNAPSHOT_REF}/releaseData/gbOpen/${iso3}/ADM0/geoBoundaries-${iso3}-ADM0.geojson`;
}

function metadataUrl(iso3: string): string {
  return `https://github.com/wmgeolab/geoBoundaries/raw/${SNAPSHOT_REF}/releaseData/gbOpen/${iso3}/ADM0/geoBoundaries-${iso3}-ADM0-metaData.json`;
}

function localGeojsonPath(iso3: string): string {
  return resolve(SOURCE_DIR, `${iso3}-ADM0.geojson`);
}

function localMetadataPath(iso3: string): string {
  return resolve(SOURCE_DIR, `${iso3}-ADM0-metaData.json`);
}

async function downloadText(url: string, destination: string): Promise<string> {
  if (!url.includes(`/${SNAPSHOT_REF}/`)) {
    throw new Error(`Refusing unpinned boundary URL: ${url}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) {
    throw new Error(`Boundary download failed (${response.status}): ${url}`);
  }
  const content = await response.text();
  if (content.startsWith("version https://git-lfs.github.com/spec/v1")) {
    throw new Error(
      `Git LFS pointer returned instead of boundary content for ${url}; use the GitHub /raw/ URL that follows LFS media redirects.`,
    );
  }
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, destination);
  return content;
}

function normalizeCountry(
  countryCode: string,
  iso3: string,
  geojsonContent: string,
  metadataContent: string,
): { features: GlobalAdm0Feature[]; manifest: Record<string, unknown> } {
  const raw = JSON.parse(geojsonContent) as RawCollection;
  const metadata = JSON.parse(metadataContent) as RawMetadata;
  if (raw.type !== "FeatureCollection" || !Array.isArray(raw.features) || raw.features.length === 0) {
    throw new Error(`${iso3} ADM0 source is not a non-empty FeatureCollection`);
  }

  const boundaryId =
    optionalString(metadata.boundaryID) ??
    optionalString(metadata.boundaryId) ??
    `${iso3}-ADM0`;
  const boundaryYear =
    optionalString(metadata.boundaryYearRepresented) ??
    optionalString(metadata.boundaryYear) ??
    null;
  const boundarySource =
    optionalString(metadata.boundarySource) ??
    optionalString(metadata.source) ??
    "geoBoundaries gbOpen source";
  const boundaryLicense =
    optionalString(metadata.boundaryLicense) ??
    optionalString(metadata.license) ??
    "See pinned geoBoundaries metadata";
  const licenseUrl =
    optionalString(metadata.licenseSource) ??
    optionalString(metadata.licenseURL) ??
    null;
  const sourceDataUrl =
    optionalString(metadata.boundarySourceURL) ??
    optionalString(metadata.sourceDataURL) ??
    "https://www.geoboundaries.org/";

  const features = raw.features.map((feature, index): GlobalAdm0Feature => {
    if (
      feature.type !== "Feature" ||
      !feature.properties ||
      !feature.geometry ||
      !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
    ) {
      throw new Error(`${iso3} contains an invalid ADM0 feature`);
    }
    if (feature.properties.shapeGroup !== iso3) {
      throw new Error(`${iso3} feature has unexpected shapeGroup`);
    }
    if (feature.properties.shapeType !== "ADM0") {
      throw new Error(`${iso3} feature is not ADM0`);
    }

    const shapeId = requiredString(feature.properties.shapeID, "shapeID");
    const countryName = requiredString(feature.properties.shapeName, "shapeName");
    return {
      type: "Feature",
      id: `${countryCode}:${shapeId}:${index}`,
      bbox: featureBbox(feature.geometry),
      properties: {
        countryCode,
        countryName,
        iso3,
        boundaryId,
        boundaryYearRepresented: boundaryYear,
        source: boundarySource,
        sourceUrl: sourceDataUrl,
        license: boundaryLicense,
        licenseUrl,
        attribution: `${countryName}: ${boundarySource}; ${boundaryLicense}; normalized from geoBoundaries gbOpen.`,
        version: `${SNAPSHOT_VERSION}:${boundaryId}`,
      },
      geometry: feature.geometry,
    };
  });

  return {
    features,
    manifest: {
      countryCode,
      iso3,
      boundaryId,
      boundaryYearRepresented: boundaryYear,
      source: boundarySource,
      sourceUrl: sourceDataUrl,
      license: boundaryLicense,
      licenseUrl,
      geojsonUrl: geojsonUrl(iso3),
      metadataUrl: metadataUrl(iso3),
      geojsonBytes: Buffer.byteLength(geojsonContent),
      metadataBytes: Buffer.byteLength(metadataContent),
    },
  };
}

async function main(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2));
  if ([...argumentsSet].some((argument) => argument !== "--download")) {
    throw new Error("Usage: prepare-global-adm0.ts [--download]");
  }
  const download = argumentsSet.has("--download");

  await mkdir(SOURCE_DIR, { recursive: true });

  const allFeatures: GlobalAdm0Feature[] = [];
  const sourceManifest: Record<string, unknown>[] = [];
  const failures: Array<{ countryCode: string; iso3: string; error: string }> = [];

  for (const [countryCode, iso3] of Object.entries(MOUNTAIN_TRACKER_ISO2_TO_ISO3)) {
    try {
      const geoPath = localGeojsonPath(iso3);
      const metaPath = localMetadataPath(iso3);
      const [geojsonContent, metadataContent] = download
        ? await Promise.all([
            downloadText(geojsonUrl(iso3), geoPath),
            downloadText(metadataUrl(iso3), metaPath),
          ])
        : await Promise.all([
            readFile(geoPath, "utf8"),
            readFile(metaPath, "utf8"),
          ]);
      const normalized = normalizeCountry(
        countryCode,
        iso3,
        geojsonContent,
        metadataContent,
      );
      allFeatures.push(...normalized.features);
      sourceManifest.push(normalized.manifest);
      process.stdout.write(`ADM0 ${countryCode}/${iso3}: ${normalized.features.length} feature(s)\n`);
    } catch (error) {
      failures.push({
        countryCode,
        iso3,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Global ADM0 preparation failed closed; ${failures.length} required country source(s) unavailable:\n${JSON.stringify(failures, null, 2)}`,
    );
  }

  allFeatures.sort(
    (left, right) =>
      left.properties.countryCode.localeCompare(right.properties.countryCode) ||
      left.id.localeCompare(right.id),
  );

  const dataset: GlobalAdm0Dataset = parseGlobalAdm0Dataset({
    type: "FeatureCollection",
    metadata: {
      provider: "William & Mary geoLab",
      dataset: "geoBoundaries gbOpen ADM0 full-resolution single-country files",
      source: "geoBoundaries and per-country source metadata",
      license: "Mixed open licenses; preserve per-feature attribution/license metadata.",
      version: SNAPSHOT_VERSION,
      sourceUrl: "https://www.geoboundaries.org/",
      attribution: "geoBoundaries gbOpen; per-country attribution and license metadata apply.",
      boundaryPrecisionMeters: 100,
    },
    features: allFeatures,
  });

  const temporaryOutput = `${NORMALIZED_PATH}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(dataset)}\n`, "utf8");
  await rename(temporaryOutput, NORMALIZED_PATH);
  await writeFile(
    SOURCE_MANIFEST_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        snapshotRef: SNAPSHOT_REF,
        snapshotVersion: SNAPSHOT_VERSION,
        generatedAt: new Date().toISOString(),
        normalizedOutput: NORMALIZED_PATH,
        countryCount: Object.keys(MOUNTAIN_TRACKER_ISO2_TO_ISO3).length,
        features: dataset.features.length,
        sources: sourceManifest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: download ? "download-and-normalize" : "normalize-local-sources",
        snapshotVersion: SNAPSHOT_VERSION,
        countries: Object.keys(MOUNTAIN_TRACKER_ISO2_TO_ISO3).length,
        features: dataset.features.length,
        normalizedPath: NORMALIZED_PATH,
        sourceManifestPath: SOURCE_MANIFEST_PATH,
      },
      null,
      2,
    )}\n`,
  );
}

void sourceUrl;

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
