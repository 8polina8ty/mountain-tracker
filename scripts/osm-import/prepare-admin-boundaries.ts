import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BOUNDARY_SOURCE_MANIFEST,
  GEOBOUNDARIES_SNAPSHOT_VERSION,
  normalizeAdminBoundarySources,
  sha256BoundaryContent,
  type BoundarySourceInput,
} from "./admin-boundary-normalizer.ts";
import { writeJsonAtomically } from "./jsonl.ts";

const BOUNDARY_DIRECTORY = resolve("data/osm/boundaries");
const SOURCE_DIRECTORY = resolve(
  BOUNDARY_DIRECTORY,
  "source",
  GEOBOUNDARIES_SNAPSHOT_VERSION,
);
const NORMALIZED_PATH = resolve(BOUNDARY_DIRECTORY, "alps-admin.geojson");
const SOURCE_MANIFEST_PATH = resolve(SOURCE_DIRECTORY, "source-manifest.json");

function sourcePath(iso3: string): string {
  return resolve(SOURCE_DIRECTORY, `${iso3}-ADM1.geojson`);
}

async function downloadFile(url: string, destination: string): Promise<string> {
  if (!url.includes("/9469f09/")) {
    throw new Error(`Refusing unpinned boundary download URL: ${url}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Boundary download failed (${response.status}): ${url}`);
  }
  const content = await response.text();
  const temporaryPath = `${destination}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, destination);
  return content;
}

async function writeCompactJsonAtomically(
  destination: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${destination}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporaryPath, destination);
}

async function main(): Promise<void> {
  const argumentsSet = new Set(process.argv.slice(2));
  if ([...argumentsSet].some((argument) => argument !== "--download")) {
    throw new Error("Usage: prepare-admin-boundaries.ts [--download]");
  }
  const download = argumentsSet.has("--download");
  await mkdir(SOURCE_DIRECTORY, { recursive: true });
  const sources: BoundarySourceInput[] = [];
  const downloadedSources: Array<{
    countryCode: string;
    iso3: string;
    boundaryId: string;
    boundaryYearRepresented: string;
    downloadUrl: string;
    localPath: string;
    sha256: string;
    bytes: number;
    source: string;
    sourceUrl: string;
    license: string;
    licenseUrl: string;
    attribution: string;
  }> = [];

  for (const manifest of BOUNDARY_SOURCE_MANIFEST) {
    const path = sourcePath(manifest.iso3);
    const content = download
      ? await downloadFile(manifest.downloadUrl, path)
      : await readFile(path, "utf8");
    sources.push({ manifest, content });
    downloadedSources.push({
      countryCode: manifest.countryCode,
      iso3: manifest.iso3,
      boundaryId: manifest.boundaryId,
      boundaryYearRepresented: manifest.boundaryYearRepresented,
      downloadUrl: manifest.downloadUrl,
      localPath: path,
      sha256: sha256BoundaryContent(content),
      bytes: Buffer.byteLength(content),
      source: manifest.source,
      sourceUrl: manifest.sourceUrl,
      license: manifest.license,
      licenseUrl: manifest.licenseUrl,
      attribution: manifest.attribution,
    });
  }

  const normalized = normalizeAdminBoundarySources(sources);
  await Promise.all([
    writeJsonAtomically(SOURCE_MANIFEST_PATH, {
      schemaVersion: 1,
      snapshotVersion: GEOBOUNDARIES_SNAPSHOT_VERSION,
      provider: "William & Mary geoLab",
      dataset: "geoBoundaries gbOpen ADM1 high-precision single-country files",
      normalizedOutput: NORMALIZED_PATH,
      sources: downloadedSources,
    }),
    writeCompactJsonAtomically(NORMALIZED_PATH, normalized),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: download ? "download-and-normalize" : "normalize-local-sources",
        snapshotVersion: GEOBOUNDARIES_SNAPSHOT_VERSION,
        sourceFiles: sources.length,
        normalizedFeatures: normalized.features.length,
        countries: [
          ...new Set(
            normalized.features.map((feature) => feature.properties.countryCode),
          ),
        ],
        normalizedPath: NORMALIZED_PATH,
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
