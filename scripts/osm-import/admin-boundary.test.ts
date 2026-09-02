import assert from "node:assert/strict";
import test from "node:test";

import {
  assignPointToAdminBoundary,
  parseAdminBoundaryDataset,
  resolvePointAdminBoundary,
  type AdminBoundaryDataset,
  type AdminBoundaryFeature,
  type AlpsCountryCode,
} from "./admin-boundary.ts";
import {
  BOUNDARY_SOURCE_MANIFEST,
  normalizeAdminBoundarySources,
} from "./admin-boundary-normalizer.ts";
import {
  applyStagingPlan,
  createImportContract,
  createImportPlanRecord,
  type MountainCatalogRecord,
  type Phase7CanonicalRouteRecord,
  type Phase7EligibilityRecord,
  type StagingSourceRouteRecord,
  type StagingWriter,
} from "./phase8-staging.ts";

const ATTRIBUTION = "© OpenStreetMap contributors";
const PROVENANCE_ID = "openstreetmap-odbl-geofabrik-alps";

function square(
  id: string,
  countryCode: AlpsCountryCode,
  countryName: string,
  admin1Code: string,
  admin1Name: string,
  minimumLongitude: number,
  maximumLongitude: number,
): AdminBoundaryFeature {
  return {
    type: "Feature",
    id,
    bbox: [minimumLongitude, 0, maximumLongitude, 1],
    properties: {
      countryCode,
      countryName,
      admin1Code,
      admin1Name,
      source: "Test boundaries",
      sourceUrl: "https://example.test/source",
      license: "Test open license",
      licenseUrl: "https://example.test/license",
      attribution: "Test boundary attribution",
      version: "test-v1",
    },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [minimumLongitude, 0],
        [maximumLongitude, 0],
        [maximumLongitude, 1],
        [minimumLongitude, 1],
        [minimumLongitude, 0],
      ]],
    },
  };
}

function dataset(features: AdminBoundaryFeature[]): AdminBoundaryDataset {
  return parseAdminBoundaryDataset({
    type: "FeatureCollection",
    metadata: {
      provider: "Test provider",
      dataset: "Test ADM1",
      source: "Test boundaries",
      license: "Test open license",
      version: "test-v1",
      sourceUrl: "https://example.test/source",
      attribution: "Test boundary attribution",
    },
    features,
  });
}

const COUNTRY_FIXTURES: Array<[AlpsCountryCode, string, string]> = [
  ["DE", "Germany", "DE-1"],
  ["AT", "Austria", "AT-1"],
  ["CH", "Switzerland", "CH-1"],
  ["IT", "Italy", "IT-1"],
  ["FR", "France", "FR-1"],
  ["SI", "Slovenia", "SI-1"],
  ["LI", "Liechtenstein", "LI-1"],
];

test("DE/AT/CH/IT/FR/SI/LI points resolve to their country", () => {
  const boundaries = dataset(
    COUNTRY_FIXTURES.map(([code, name, admin1], index) =>
      square(code, code, name, admin1, `${name} Region`, index * 2, index * 2 + 1),
    ),
  );
  COUNTRY_FIXTURES.forEach(([code], index) => {
    assert.equal(
      assignPointToAdminBoundary([index * 2 + 0.5, 0.5], boundaries)?.countryCode,
      code,
    );
  });
});

test("assigned point preserves ADM1 code, name, and provenance", () => {
  const resolution = resolvePointAdminBoundary(
    [0.5, 0.5],
    dataset([square("DE", "DE", "Germany", "DE-BY", "Bayern", 0, 1)]),
  );
  assert.equal(resolution.status, "ASSIGNED");
  if (resolution.status !== "ASSIGNED") return;
  assert.equal(resolution.admin1Code, "DE-BY");
  assert.equal(resolution.admin1Name, "Bayern");
  assert.equal(resolution.boundaryProvenance.version, "test-v1");
});

test("point touching a shared border remains ambiguous", () => {
  const boundaries = dataset([
    square("DE:left", "DE", "Germany", "DE-L", "Left", 0, 1),
    square("DE:right", "DE", "Germany", "DE-R", "Right", 1, 2),
  ]);
  const resolution = resolvePointAdminBoundary([1, 0.5], boundaries);
  assert.equal(resolution.status, "AMBIGUOUS");
  if (resolution.status === "AMBIGUOUS") {
    assert.deepEqual(
      resolution.candidates.map((candidate) => candidate.admin1Code),
      ["DE-L", "DE-R"],
    );
  }
});

test("overlapping polygons remain ambiguous", () => {
  const boundaries = dataset([
    square("AT:first", "AT", "Austria", "AT-1", "First", 0, 2),
    square("AT:second", "AT", "Austria", "AT-2", "Second", 1, 3),
  ]);
  assert.equal(resolvePointAdminBoundary([1.5, 0.5], boundaries).status, "AMBIGUOUS");
});

test("MultiPolygon assignment checks every component", () => {
  const feature = square("CH:multi", "CH", "Switzerland", "CH-X", "Multi", 0, 1);
  feature.bbox = [0, 0, 4, 1];
  feature.geometry = {
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]],
    ],
  };
  assert.equal(
    resolvePointAdminBoundary([3.5, 0.5], dataset([feature])).status,
    "ASSIGNED",
  );
});

test("outside and invalid coordinates are unassigned", () => {
  const boundaries = dataset([
    square("FR", "FR", "France", "FR-1", "Region", 0, 1),
  ]);
  assert.equal(resolvePointAdminBoundary([10, 10], boundaries).status, "UNASSIGNED");
  assert.equal(resolvePointAdminBoundary([200, 95], boundaries).status, "UNASSIGNED");
  assert.match(
    resolvePointAdminBoundary([Number.NaN, 0], boundaries).status,
    /UNASSIGNED/,
  );
});

function rawSource(
  manifest: (typeof BOUNDARY_SOURCE_MANIFEST)[number],
  index: number,
) {
  return {
    manifest,
    content: JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            shapeName: `${manifest.countryName} Region`,
            shapeISO: `${manifest.countryCode}-${index}`,
            shapeID: `${manifest.boundaryId}-${index}`,
            shapeGroup: manifest.iso3,
            shapeType: "ADM1",
          },
          geometry: {
            type: index % 2 === 0 ? "Polygon" : "MultiPolygon",
            coordinates:
              index % 2 === 0
                ? [[[index, 0], [index + 0.5, 0], [index + 0.5, 1], [index, 1], [index, 0]]]
                : [[[[index, 0], [index + 0.5, 0], [index + 0.5, 1], [index, 1], [index, 0]]]],
          },
        },
      ],
    }),
  };
}

test("normalization is deterministic across source order", () => {
  const sources = BOUNDARY_SOURCE_MANIFEST.map(rawSource);
  assert.equal(
    JSON.stringify(normalizeAdminBoundarySources(sources)),
    JSON.stringify(normalizeAdminBoundarySources([...sources].reverse())),
  );
});

test("spatial join is deterministic across feature order", () => {
  const features = [
    square("IT:left", "IT", "Italy", "IT-1", "Left", 0, 2),
    square("IT:right", "IT", "Italy", "IT-2", "Right", 1, 3),
  ];
  assert.deepEqual(
    resolvePointAdminBoundary([1.5, 0.5], dataset(features)),
    resolvePointAdminBoundary([1.5, 0.5], dataset([...features].reverse())),
  );
});

function importInputs(adminBoundaries: AdminBoundaryDataset | null) {
  const eligibility: Phase7EligibilityRecord = {
    canonicalRouteSourceId: "1001",
    routeName: "Route",
    eligibility: "AUTO_IMPORT_READY",
    reasons: [],
    auditFlags: [],
    qualityScore: 100,
    confirmedPeakIds: ["9001"],
    sourceRouteIds: ["1001"],
  };
  const canonical: Phase7CanonicalRouteRecord = {
    canonicalRouteSourceId: "1001",
    routeName: "Route",
    semanticType: "summit_route",
    qualityScore: 100,
    geometryType: "LineString",
    distanceMeters: 1_000,
    componentCount: 1,
    sourceRouteIds: ["1001"],
    removedDuplicateRepresentationIds: [],
    confirmedSummits: [{
      peakSourceId: "9001",
      peakName: "Peak",
      peakElevationMeters: 2_000,
      peakCoordinates: [0.5, 0.5],
      minimumGeometryDistanceMeters: 0,
      endpointDistanceMeters: 0,
      finalConfidence: 1,
      reasons: ["confirmed"],
      provenanceId: PROVENANCE_ID,
      sourceRouteIds: ["1001"],
      sourceAssociations: [{
        routeSourceId: "1001",
        routeSourceUrl: "https://www.openstreetmap.org/relation/1001",
        routeProvenanceId: PROVENANCE_ID,
        finalConfidence: 1,
        minimumGeometryDistanceMeters: 0,
        endpointDistanceMeters: 0,
        reasons: ["confirmed"],
      }],
    }],
    auditFlags: [],
    sourceProvenance: [{
      routeSourceId: "1001",
      sourceUrl: "https://www.openstreetmap.org/relation/1001",
      provenanceId: PROVENANCE_ID,
      license: "ODbL-1.0",
      attribution: ATTRIBUTION,
    }],
    duplicateGroupId: null,
  };
  const sourceRoute: StagingSourceRouteRecord = {
    source: "openstreetmap",
    sourceType: "relation",
    sourceId: "1001",
    sourceUrl: "https://www.openstreetmap.org/relation/1001",
    provenanceId: PROVENANCE_ID,
    license: "ODbL-1.0",
    attribution: ATTRIBUTION,
    name: "Route",
    geometry: { type: "LineString", coordinates: [[0, 0], [0.5, 0.5]] },
    stats: { distanceMeters: 1_000, coordinatePoints: 2, componentCount: 1 },
  };
  const mountains: MountainCatalogRecord[] = [{
    id: 1,
    osmId: "9001",
    name: "Peak",
    nameDe: null,
    heightMeters: 2_000,
    coordinates: [0.5, 0.5],
    countryCode: null,
    source: "openstreetmap",
  }];
  return createImportContract({
    eligibility,
    canonical,
    sourceRoute,
    mountains,
    datasetVersion: "test",
    phase7AuditHash: "hash",
    adminBoundaries,
  });
}

test("administrative enrichment does not alter mountain matching", () => {
  const withoutBoundaries = importInputs(null);
  const withBoundaries = importInputs(
    dataset([square("LI", "LI", "Liechtenstein", "LI-1", "Region", 0, 1)]),
  );
  assert.deepEqual(
    withBoundaries.confirmedSummits.map((summit) => summit.mountainMatch),
    withoutBoundaries.confirmedSummits.map((summit) => summit.mountainMatch),
  );
});

test("enriched dry-run still performs zero database writes", async () => {
  let calls = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      calls += 1;
      return null;
    },
    async upsertRouteWithSummits() {
      calls += 1;
      return { id: "not-used" };
    },
  };
  const plan = createImportPlanRecord(
    importInputs(dataset([square("DE", "DE", "Germany", "DE-BY", "Bayern", 0, 1)])),
  );
  const result = await applyStagingPlan([plan], {
    mode: "dry-run",
    limit: null,
    confirmAll: false,
  }, writer);
  assert.equal(calls, 0);
  assert.equal(result.databaseWrites, 0);
});
