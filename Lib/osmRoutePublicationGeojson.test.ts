import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicationGeojsonResponse,
  geometryHash,
  publicationSelectionErrorResponse,
  selectSupportedActivePublication,
  type GeojsonPublication,
} from "./osmRoutePublicationGeojson.ts";

const geometry = {
  type: "LineString",
  coordinates: [
    [11.1, 46.1],
    [11.2, 46.2],
  ],
};

function publication(
  contract: string,
  mountainRouteId: number,
): GeojsonPublication {
  return {
    mountain_route_id: mountainRouteId,
    staging_route_id: `staging-${mountainRouteId}`,
    staging_payload_hash: `payload-${mountainRouteId}`,
    geometry_hash: geometryHash(geometry),
    topology: {
      classification: "SIMPLE",
      startCoordinate: [11.1, 46.1],
      endCoordinate: [11.2, 46.2],
      endpointSelectionAmbiguous: false,
      endpointSelectionWarning: null,
    },
    source_attribution: { provider: "openstreetmap" },
    publication_status: "ACTIVE",
    publication_contract_version: contract,
  };
}

function serve(
  candidate: GeojsonPublication,
  sourceId: string,
): Response {
  const selection = selectSupportedActivePublication([candidate]);
  const selectionError = publicationSelectionErrorResponse(selection);
  if (selectionError) return selectionError;
  assert.equal(selection.status, "FOUND");

  return createPublicationGeojsonResponse({
    requestPath: `/api/osm-route-publications/openstreetmap/relation/${sourceId}/geojson`,
    publication: selection.publication,
    route: {
      id: candidate.mountain_route_id,
      is_verified: true,
      geojson_url: `/api/osm-route-publications/openstreetmap/relation/${sourceId}/geojson`,
    },
    staging: {
      id: candidate.staging_route_id,
      payload_hash: candidate.staging_payload_hash,
      geometry_geojson: geometry,
    },
  });
}

test("ACTIVE v1 publication is served", async () => {
  const response = serve(
    publication("mountain-tracker-osm-publication/v1", 2),
    "196164",
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).features[0].geometry, geometry);
});

test("ACTIVE v2 hiking publication is served", () => {
  const response = serve(
    publication("mountain-tracker-osm-publication/v2", 8),
    "361148",
  );
  assert.equal(response.status, 200);
});

test("ACTIVE v2 via ferrata publication is served", () => {
  const response = serve(
    publication("mountain-tracker-osm-publication/v2", 9),
    "140270",
  );
  assert.equal(response.status, 200);
});

test("unsupported ACTIVE publication contract returns 404", () => {
  const selection = selectSupportedActivePublication([
    publication("mountain-tracker-osm-publication/v3", 10),
  ]);
  const response = publicationSelectionErrorResponse(selection);
  assert.equal(response?.status, 404);
});

test("duplicate ACTIVE v1 and v2 identity fails closed", () => {
  const selection = selectSupportedActivePublication([
    publication("mountain-tracker-osm-publication/v1", 2),
    publication("mountain-tracker-osm-publication/v2", 10),
  ]);
  const response = publicationSelectionErrorResponse(selection);
  assert.equal(response?.status, 409);
  assert.equal(selection.status, "CONFLICT");
});

test("geometry evidence mismatch preserves 409 behavior", () => {
  const candidate = publication("mountain-tracker-osm-publication/v2", 8);
  const response = createPublicationGeojsonResponse({
    requestPath: "/api/osm-route-publications/openstreetmap/relation/361148/geojson",
    publication: candidate,
    route: {
      id: 8,
      is_verified: true,
      geojson_url: "/api/osm-route-publications/openstreetmap/relation/361148/geojson",
    },
    staging: {
      id: candidate.staging_route_id,
      payload_hash: candidate.staging_payload_hash,
      geometry_geojson: { ...geometry, coordinates: [[0, 0], [1, 1]] },
    },
  });
  assert.equal(response.status, 409);
});
