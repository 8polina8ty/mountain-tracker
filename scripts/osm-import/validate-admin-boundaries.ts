import { resolve } from "node:path";

import {
  loadAdminBoundaryDataset,
  resolvePointAdminBoundary,
  type AlpsCountryCode,
} from "./admin-boundary.ts";

const DEFAULT_BOUNDARY_PATH = resolve("data/osm/boundaries/alps-admin.geojson");

const KNOWN_POINTS: Array<{
  label: string;
  coordinate: [number, number];
  expectedCountryCode: AlpsCountryCode;
}> = [
  { label: "Munich", coordinate: [11.5761, 48.1372], expectedCountryCode: "DE" },
  { label: "Innsbruck", coordinate: [11.4041, 47.2692], expectedCountryCode: "AT" },
  { label: "Bern", coordinate: [7.4474, 46.948], expectedCountryCode: "CH" },
  { label: "Milan", coordinate: [9.19, 45.4642], expectedCountryCode: "IT" },
  { label: "Lyon", coordinate: [4.8357, 45.764], expectedCountryCode: "FR" },
  { label: "Ljubljana", coordinate: [14.5058, 46.0569], expectedCountryCode: "SI" },
  { label: "Vaduz", coordinate: [9.5209, 47.141], expectedCountryCode: "LI" },
];

async function main(): Promise<void> {
  const path = resolve(process.argv[2] ?? DEFAULT_BOUNDARY_PATH);
  const dataset = await loadAdminBoundaryDataset(path);
  const knownPointResults = KNOWN_POINTS.map((knownPoint) => {
    const resolution = resolvePointAdminBoundary(knownPoint.coordinate, dataset);
    if (
      resolution.status !== "ASSIGNED" ||
      resolution.countryCode !== knownPoint.expectedCountryCode ||
      !resolution.admin1Code ||
      !resolution.admin1Name
    ) {
      throw new Error(
        `${knownPoint.label} failed boundary validation: ${JSON.stringify(resolution)}`,
      );
    }
    return {
      ...knownPoint,
      countryCode: resolution.countryCode,
      countryName: resolution.countryName,
      admin1Code: resolution.admin1Code,
      admin1Name: resolution.admin1Name,
    };
  });
  const outside = resolvePointAdminBoundary([-30, 0], dataset);
  const invalid = resolvePointAdminBoundary([200, 95], dataset);
  if (outside.status !== "UNASSIGNED" || invalid.status !== "UNASSIGNED") {
    throw new Error("Outside/invalid coordinate safeguards failed");
  }
  const byCountry: Record<string, number> = {};
  let polygonFeatures = 0;
  let multiPolygonFeatures = 0;
  for (const feature of dataset.features) {
    byCountry[feature.properties.countryCode] =
      (byCountry[feature.properties.countryCode] ?? 0) + 1;
    if (feature.geometry.type === "Polygon") polygonFeatures += 1;
    else multiPolygonFeatures += 1;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "valid",
        path,
        version: dataset.metadata.version,
        featureCount: dataset.features.length,
        polygonFeatures,
        multiPolygonFeatures,
        byCountry,
        knownPointResults,
        outsideStatus: outside.status,
        invalidStatus: invalid.status,
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
