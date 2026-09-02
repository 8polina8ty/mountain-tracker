import { createHash } from "node:crypto";

import {
  SUPPORTED_ALPS_COUNTRY_CODES,
  parseAdminBoundaryDataset,
  type AdminBoundaryDataset,
  type AdminBoundaryFeature,
  type AlpsCountryCode,
} from "./admin-boundary.ts";
import type { Coordinate } from "./peak-matcher.ts";

export const GEOBOUNDARIES_SNAPSHOT_VERSION =
  "geoBoundaries-gbOpen-9469f09-2023-12-12";

export interface BoundarySourceManifestEntry {
  countryCode: AlpsCountryCode;
  countryName: string;
  iso3: string;
  boundaryId: string;
  boundaryYearRepresented: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  downloadUrl: string;
}

export const BOUNDARY_SOURCE_MANIFEST: readonly BoundarySourceManifestEntry[] = [
  {
    countryCode: "DE",
    countryName: "Germany",
    iso3: "DEU",
    boundaryId: "DEU-ADM1-10402087",
    boundaryYearRepresented: "2021",
    source: "Federal Agency for Cartography and Geodesy via geoBoundaries",
    sourceUrl:
      "https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/verwaltungsgebiete-nuts-gebiete-1-250-000.html",
    license: "Data licence Germany – attribution – Version 2.0",
    licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
    attribution:
      "Federal Agency for Cartography and Geodesy; Data licence Germany – attribution – Version 2.0; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/DEU/ADM1/geoBoundaries-DEU-ADM1.geojson",
  },
  {
    countryCode: "AT",
    countryName: "Austria",
    iso3: "AUT",
    boundaryId: "AUT-ADM1-97560089",
    boundaryYearRepresented: "2017",
    source:
      "Federal Office for Metrology and Survey, Austria via geoBoundaries",
    sourceUrl: "https://www.bev.gv.at/",
    license: "Creative Commons Attribution-ShareAlike 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    attribution:
      "Federal Office for Metrology and Survey, Austria and geoBoundaries; CC BY-SA 2.0; geometry normalized for Mountain Tracker.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/AUT/ADM1/geoBoundaries-AUT-ADM1.geojson",
  },
  {
    countryCode: "CH",
    countryName: "Switzerland",
    iso3: "CHE",
    boundaryId: "CHE-ADM1-70761945",
    boundaryYearRepresented: "2022",
    source: "Federal Office of Topography swisstopo via geoBoundaries",
    sourceUrl: "https://www.swisstopo.admin.ch/en/administrative-units-switzerland",
    license: "Federal Office of Topography swisstopo OGD terms",
    licenseUrl:
      "https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices",
    attribution:
      "Federal Office of Topography swisstopo; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/CHE/ADM1/geoBoundaries-CHE-ADM1.geojson",
  },
  {
    countryCode: "IT",
    countryName: "Italy",
    iso3: "ITA",
    boundaryId: "ITA-ADM1-72843720",
    boundaryYearRepresented: "2023",
    source: "ISTAT, National Institute of Statistics via geoBoundaries",
    sourceUrl: "https://www.istat.it/it/archivio/222527",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    attribution:
      "ISTAT, National Institute of Statistics; CC BY 3.0; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/ITA/ADM1/geoBoundaries-ITA-ADM1.geojson",
  },
  {
    countryCode: "FR",
    countryName: "France",
    iso3: "FRA",
    boundaryId: "FRA-ADM1-19338628",
    boundaryYearRepresented: "2022",
    source:
      "Institut national de l'information géographique et forestière via geoBoundaries",
    sourceUrl: "https://geoservices.ign.fr/adminexpress",
    license: "Etalab Open License 2.0",
    licenseUrl:
      "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
    attribution:
      "IGN-F; Etalab Open License 2.0; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/FRA/ADM1/geoBoundaries-FRA-ADM1.geojson",
  },
  {
    countryCode: "SI",
    countryName: "Slovenia",
    iso3: "SVN",
    boundaryId: "SVN-ADM1-3739544",
    boundaryYearRepresented: "2021",
    source: "Eurostat, European Commission via geoBoundaries",
    sourceUrl:
      "https://ec.europa.eu/eurostat/web/gisco/geodata/statistical-units/territorial-units-statistics",
    license: "Creative Commons Attribution 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution:
      "Eurostat, European Commission; CC BY 4.0; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/SVN/ADM1/geoBoundaries-SVN-ADM1.geojson",
  },
  {
    countryCode: "LI",
    countryName: "Liechtenstein",
    iso3: "LIE",
    boundaryId: "LIE-ADM1-41692755",
    boundaryYearRepresented: "2017",
    source: "OpenStreetMap and Wambacher via geoBoundaries",
    sourceUrl: "https://wambachers-osm.website/boundaries/",
    license: "Open Data Commons Open Database License 1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution:
      "© OpenStreetMap contributors and Wambacher; ODbL 1.0; geometry normalized via geoBoundaries.",
    downloadUrl:
      "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/LIE/ADM1/geoBoundaries-LIE-ADM1.geojson",
  },
] as const;

interface RawBoundaryProperties {
  shapeName?: unknown;
  shapeISO?: unknown;
  shapeID?: unknown;
  shapeGroup?: unknown;
  shapeType?: unknown;
}

interface RawBoundaryFeature {
  type?: unknown;
  properties?: RawBoundaryProperties;
  geometry?: AdminBoundaryFeature["geometry"];
}

interface RawBoundaryCollection {
  type?: unknown;
  features?: RawBoundaryFeature[];
}

export interface BoundarySourceInput {
  manifest: BoundarySourceManifestEntry;
  content: string;
}

export function sha256BoundaryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function geometryCoordinates(
  geometry: AdminBoundaryFeature["geometry"],
): Coordinate[] {
  return geometry.type === "Polygon"
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2);
}

function featureBbox(
  geometry: AdminBoundaryFeature["geometry"],
): [number, number, number, number] {
  const coordinates = geometryCoordinates(geometry);
  if (coordinates.length === 0) throw new Error("Boundary geometry is empty");
  let minimumLongitude = Number.POSITIVE_INFINITY;
  let minimumLatitude = Number.POSITIVE_INFINITY;
  let maximumLongitude = Number.NEGATIVE_INFINITY;
  let maximumLatitude = Number.NEGATIVE_INFINITY;
  for (const coordinate of coordinates) {
    minimumLongitude = Math.min(minimumLongitude, coordinate[0]);
    minimumLatitude = Math.min(minimumLatitude, coordinate[1]);
    maximumLongitude = Math.max(maximumLongitude, coordinate[0]);
    maximumLatitude = Math.max(maximumLatitude, coordinate[1]);
  }
  return [minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`geoBoundaries feature is missing ${field}`);
  }
  return value.trim();
}

function normalizeFeature(
  raw: RawBoundaryFeature,
  manifest: BoundarySourceManifestEntry,
): AdminBoundaryFeature {
  if (
    raw.type !== "Feature" ||
    !raw.properties ||
    !raw.geometry ||
    !["Polygon", "MultiPolygon"].includes(raw.geometry.type)
  ) {
    throw new Error(`${manifest.iso3} contains an invalid boundary feature`);
  }
  const shapeName = requiredString(raw.properties.shapeName, "shapeName");
  const shapeId = requiredString(raw.properties.shapeID, "shapeID");
  if (raw.properties.shapeGroup !== manifest.iso3) {
    throw new Error(`${shapeId} has an unexpected shapeGroup`);
  }
  if (raw.properties.shapeType !== "ADM1") {
    throw new Error(`${shapeId} is not ADM1`);
  }
  const sourceAdmin1Code =
    typeof raw.properties.shapeISO === "string"
      ? raw.properties.shapeISO.trim()
      : "";
  const admin1Code = sourceAdmin1Code || `${manifest.countryCode}-${shapeId}`;
  return {
    type: "Feature",
    id: `${manifest.countryCode}:${admin1Code}:${shapeId}`,
    bbox: featureBbox(raw.geometry),
    properties: {
      countryCode: manifest.countryCode,
      countryName: manifest.countryName,
      admin1Code,
      admin1Name: shapeName,
      source: manifest.source,
      sourceUrl: manifest.sourceUrl,
      license: manifest.license,
      licenseUrl: manifest.licenseUrl,
      attribution: manifest.attribution,
      version: `${GEOBOUNDARIES_SNAPSHOT_VERSION}:${manifest.boundaryId}:${manifest.boundaryYearRepresented}`,
    },
    geometry: raw.geometry,
  };
}

export function normalizeAdminBoundarySources(
  sources: BoundarySourceInput[],
): AdminBoundaryDataset {
  const inputCountryCodes = new Set(sources.map((source) => source.manifest.countryCode));
  if (
    inputCountryCodes.size !== SUPPORTED_ALPS_COUNTRY_CODES.length ||
    SUPPORTED_ALPS_COUNTRY_CODES.some((code) => !inputCountryCodes.has(code))
  ) {
    throw new Error("Boundary sources must contain exactly the seven supported countries");
  }
  const features = sources.flatMap(({ manifest, content }) => {
    const raw = JSON.parse(content) as RawBoundaryCollection;
    if (raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
      throw new Error(`${manifest.iso3} source is not a GeoJSON FeatureCollection`);
    }
    return raw.features.map((feature) => normalizeFeature(feature, manifest));
  });
  features.sort(
    (left, right) =>
      left.properties.countryCode.localeCompare(right.properties.countryCode) ||
      left.properties.admin1Code.localeCompare(right.properties.admin1Code) ||
      left.properties.admin1Name.localeCompare(right.properties.admin1Name) ||
      left.id.localeCompare(right.id),
  );
  if (new Set(features.map((feature) => feature.id)).size !== features.length) {
    throw new Error("Normalized boundary feature IDs are not unique");
  }
  return parseAdminBoundaryDataset({
    type: "FeatureCollection",
    metadata: {
      provider: "William & Mary geoLab",
      dataset: "geoBoundaries gbOpen ADM1 high-precision single-country files",
      source: "geoBoundaries and the per-feature government/open-data sources",
      license:
        "Mixed commercial-compatible open licenses; see each feature's license, licenseUrl, and attribution fields.",
      version: GEOBOUNDARIES_SNAPSHOT_VERSION,
      sourceUrl: "https://www.geoboundaries.org/",
      attribution:
        "Boundary data normalized from geoBoundaries gbOpen; per-feature attribution and license terms apply. Geometry was reformatted and combined for offline point-in-polygon use.",
    },
    features,
  });
}
