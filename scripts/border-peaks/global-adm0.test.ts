import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdm0Segments,
  parseGlobalAdm0Dataset,
} from "./global-adm0.ts";
import { iso3ForCountry } from "./country-codes.ts";

function dataset() {
  return {
    type: "FeatureCollection",
    metadata: {
      provider: "test",
      dataset: "ADM0",
      source: "fixture",
      license: "test",
      version: "v1",
      sourceUrl: "https://example.com",
      attribution: "test",
      boundaryPrecisionMeters: 50,
    },
    features: [
      {
        type: "Feature",
        id: "AA:1",
        bbox: [0, 0, 1, 1],
        properties: {
          countryCode: "DE",
          countryName: "Germany",
          iso3: "DEU",
          boundaryId: "DEU-ADM0",
          boundaryYearRepresented: "2021",
          source: "fixture",
          sourceUrl: "https://example.com/de",
          license: "test",
          licenseUrl: null,
          attribution: "test",
          version: "v1",
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        },
      },
      {
        type: "Feature",
        id: "BB:1",
        bbox: [1, 0, 2, 1],
        properties: {
          countryCode: "AT",
          countryName: "Austria",
          iso3: "AUT",
          boundaryId: "AUT-ADM0",
          boundaryYearRepresented: "2021",
          source: "fixture",
          sourceUrl: "https://example.com/at",
          license: "test",
          licenseUrl: null,
          attribution: "test",
          version: "v1",
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]],
        },
      },
    ],
  };
}

test("global ADM0 parser accepts multi-country full-resolution fixture", () => {
  const parsed = parseGlobalAdm0Dataset(dataset());
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.metadata.boundaryPrecisionMeters, 50);
});

test("global ADM0 parser fails closed on one-country dataset", () => {
  const value = dataset();
  value.features = [value.features[0]];
  assert.throws(
    () => parseGlobalAdm0Dataset(value),
    /at least two countries/,
  );
});

test("ADM0 segment builder preserves country ownership", () => {
  const parsed = parseGlobalAdm0Dataset(dataset());
  const segments = buildAdm0Segments(parsed);
  assert.equal(segments.length, 8);
  assert.equal(
    segments.filter((segment) => segment.countryCode === "DE").length,
    4,
  );
  assert.equal(
    segments.filter((segment) => segment.countryCode === "AT").length,
    4,
  );
});

test("global ISO mapping includes ordinary and Mountain Tracker exception codes", () => {
  assert.equal(iso3ForCountry("DE"), "DEU");
  assert.equal(iso3ForCountry("AT"), "AUT");
  assert.equal(iso3ForCountry("XK"), "XKX");
  assert.equal(iso3ForCountry("ZZ"), null);
});
