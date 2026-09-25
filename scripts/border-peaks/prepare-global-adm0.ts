#!/usr/bin/env ts-node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GLOBAL_ISO2_TO_ISO3 } from "./country-codes.ts";

const SNAPSHOT_REF = "9469f09";
const SNAPSHOT_VERSION = "geoBoundaries-gbOpen-9469f09-2023-12-12";
const ROOT = resolve("data/border-peaks/global-boundaries");
const SOURCE_DIR = resolve(ROOT, "source", SNAPSHOT_VERSION);
const SOURCE_MANIFEST_PATH = resolve(ROOT, "source-manifest.json");

const UNAVAILABLE_IN_PINNED_SNAPSHOT = Object.freeze({
  AX: "ALA",
  BV: "BVT",
  CC: "CCK",
  CX: "CXR",
  EH: "ESH",
  GS: "SGS",
  HK: "HKG",
  HM: "HMD",
  IO: "IOT",
  JE: "JEY",
  MF: "MAF",
  MO: "MAC",
  NF: "NFK",
  PM: "SPM",
  PR: "PRI",
  SJ: "SJM",
  SX: "SXM",
  TF: "ATF",
  UM: "UMI",
} as const);


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

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1000));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Boundary download failed after retries: ${url}`);
}

function coordinateBboxFromGeojsonText(
  content: string,
): [number, number, number, number] {
  const marker = '"coordinates"';
  const start = content.indexOf(marker);
  if (start < 0) throw new Error("GeoJSON coordinates are missing");

  let index = content.indexOf("[", start + marker.length);
  if (index < 0) throw new Error("GeoJSON coordinate array is missing");

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let coordinateDepth = 0;
  let pairDepth = -1;
  let first: number | null = null;

  const readNumber = (): number | null => {
    while (index < content.length && /[\s,\[\]]/.test(content[index])) index += 1;
    if (index >= content.length || !/[+\-0-9.]/.test(content[index])) return null;
    const numberStart = index;
    index += 1;
    while (index < content.length && /[0-9eE+\-.]/.test(content[index])) index += 1;
    const value = Number(content.slice(numberStart, index));
    return Number.isFinite(value) ? value : null;
  };

  for (; index < content.length; index += 1) {
    const char = content[index];
    if (char === "[") {
      coordinateDepth += 1;
      if (coordinateDepth >= 2) {
        let lookahead = index + 1;
        while (lookahead < content.length && /\s/.test(content[lookahead])) lookahead += 1;
        if (/[+\-0-9.]/.test(content[lookahead] ?? "")) {
          pairDepth = coordinateDepth;
          index = lookahead;
          first = readNumber();
          const second = readNumber();
          if (
            first != null &&
            second != null &&
            first >= -180 &&
            first <= 180 &&
            second >= -90 &&
            second <= 90
          ) {
            minLon = Math.min(minLon, first);
            minLat = Math.min(minLat, second);
            maxLon = Math.max(maxLon, first);
            maxLat = Math.max(maxLat, second);
          }
          first = null;
        }
      }
    } else if (char === "]") {
      if (coordinateDepth === 1) break;
      if (coordinateDepth === pairDepth) pairDepth = -1;
      coordinateDepth -= 1;
    }
  }

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    throw new Error("Could not derive GeoJSON coordinate bbox");
  }
  return [minLon, minLat, maxLon, maxLat];
}

function buildSourceManifest(
  countryCode: string,
  iso3: string,
  geojsonContent: string,
  metadataContent: string,
): Record<string, unknown> {
  if (!geojsonContent.includes('"FeatureCollection"') || !geojsonContent.includes('"ADM0"')) {
    throw new Error(`${iso3} ADM0 source does not look like the expected GeoJSON`);
  }

  const metadata = JSON.parse(metadataContent) as Record<string, unknown>;
  const optionalString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

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

  return {
    countryCode,
    bbox: coordinateBboxFromGeojsonText(geojsonContent),
    iso3,
    boundaryId,
    boundaryYearRepresented: boundaryYear,
    source: boundarySource,
    sourceUrl: sourceDataUrl,
    license: boundaryLicense,
    licenseUrl,
    geojsonUrl: geojsonUrl(iso3),
    metadataUrl: metadataUrl(iso3),
    localGeojsonPath: localGeojsonPath(iso3),
    localMetadataPath: localMetadataPath(iso3),
    geojsonBytes: Buffer.byteLength(geojsonContent),
    metadataBytes: Buffer.byteLength(metadataContent),
  };
}

async function main(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2));
  if ([...argumentsSet].some((argument) => argument !== "--download")) {
    throw new Error("Usage: prepare-global-adm0.ts [--download]");
  }
  const download = argumentsSet.has("--download");

  await mkdir(SOURCE_DIR, { recursive: true });

  const sourceManifest: Record<string, unknown>[] = [];
  const failures: Array<{ countryCode: string; iso3: string; error: string }> = [];

  for (const [countryCode, iso3] of Object.entries(GLOBAL_ISO2_TO_ISO3)) {
    if ((UNAVAILABLE_IN_PINNED_SNAPSHOT as Record<string, string>)[countryCode] === iso3) {
      continue;
    }
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
      const manifestEntry = buildSourceManifest(
        countryCode,
        iso3,
        geojsonContent,
        metadataContent,
      );
      sourceManifest.push(manifestEntry);
      process.stdout.write(
        `ADM0 ${countryCode}/${iso3}: ${Buffer.byteLength(geojsonContent)} bytes\n`,
      );
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

  await writeFile(
    SOURCE_MANIFEST_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        snapshotRef: SNAPSHOT_REF,
        snapshotVersion: SNAPSHOT_VERSION,
        generatedAt: new Date().toISOString(),
        countryCount: Object.keys(GLOBAL_ISO2_TO_ISO3).length - Object.keys(UNAVAILABLE_IN_PINNED_SNAPSHOT).length,
        requestedCountryCount: Object.keys(GLOBAL_ISO2_TO_ISO3).length,
        coverageGaps: UNAVAILABLE_IN_PINNED_SNAPSHOT,
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
        countries: Object.keys(GLOBAL_ISO2_TO_ISO3).length - Object.keys(UNAVAILABLE_IN_PINNED_SNAPSHOT).length,
        requestedCountries: Object.keys(GLOBAL_ISO2_TO_ISO3).length,
        coverageGaps: UNAVAILABLE_IN_PINNED_SNAPSHOT,
        sourceManifestPath: SOURCE_MANIFEST_PATH,
      },
      null,
      2,
    )}\n`,
  );
}


main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
