import { createHash } from "node:crypto";

export const SUPPORTED_PUBLICATION_CONTRACTS = [
  "mountain-tracker-osm-publication/v1",
  "mountain-tracker-osm-publication/v2",
] as const;

type SupportedPublicationContract =
  (typeof SUPPORTED_PUBLICATION_CONTRACTS)[number];

export type GeojsonPublication = {
  mountain_route_id: number;
  staging_route_id: string;
  staging_payload_hash: string;
  geometry_hash: string;
  topology: unknown;
  source_attribution: unknown;
  publication_status: string;
  publication_contract_version: string;
};

export type GeojsonMountainRoute = {
  id: number;
  is_verified: boolean;
  geojson_url: string | null;
};

export type GeojsonStagingRoute = {
  id: string;
  payload_hash: string;
  geometry_geojson: unknown;
};

export type PublicationSelection =
  | { status: "FOUND"; publication: GeojsonPublication }
  | { status: "NOT_FOUND" }
  | { status: "CONFLICT" };

function isSupportedContract(
  value: string,
): value is SupportedPublicationContract {
  return (SUPPORTED_PUBLICATION_CONTRACTS as readonly string[]).includes(value);
}

export function selectSupportedActivePublication(
  publications: GeojsonPublication[],
): PublicationSelection {
  const supported = publications.filter(
    (publication) =>
      publication.publication_status === "ACTIVE" &&
      isSupportedContract(publication.publication_contract_version),
  );

  if (supported.length === 0) return { status: "NOT_FOUND" };
  if (supported.length !== 1) return { status: "CONFLICT" };
  return { status: "FOUND", publication: supported[0] };
}

export function publicationSelectionErrorResponse(
  selection: PublicationSelection,
): Response | null {
  if (selection.status === "NOT_FOUND") {
    return new Response("Not found", { status: 404 });
  }
  if (selection.status === "CONFLICT") {
    return new Response("Publication identity conflict", { status: 409 });
  }
  return null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function geometryHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function createPublicationGeojsonResponse(input: {
  requestPath: string;
  publication: GeojsonPublication;
  route: GeojsonMountainRoute | null;
  staging: GeojsonStagingRoute | null;
  evidenceReadFailed?: boolean;
}): Response {
  const { publication, route, staging } = input;
  if (
    input.evidenceReadFailed === true ||
    !route ||
    !staging ||
    route.id !== publication.mountain_route_id ||
    staging.id !== publication.staging_route_id ||
    route.is_verified !== true ||
    route.geojson_url !== input.requestPath ||
    staging.payload_hash !== publication.staging_payload_hash ||
    geometryHash(staging.geometry_geojson) !== publication.geometry_hash
  ) {
    return new Response("Publication evidence mismatch", { status: 409 });
  }

  const topology = publication.topology as {
    classification?: string;
    startCoordinate?: [number, number] | null;
    endCoordinate?: [number, number] | null;
    endpointSelectionAmbiguous?: boolean;
    endpointSelectionWarning?: string | null;
  };
  const topologyEndpoints =
    topology.startCoordinate && topology.endCoordinate
      ? {
          startCoordinate: topology.startCoordinate,
          endCoordinate: topology.endCoordinate,
        }
      : null;
  const body = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          attribution: publication.source_attribution,
        },
        geometry: staging.geometry_geojson,
      },
    ],
    mountainTracker: {
      topologyClassification: topology.classification,
      topologyEndpoints,
      endpointSelectionAmbiguous: topology.endpointSelectionAmbiguous === true,
      endpointSelectionWarning: topology.endpointSelectionWarning ?? null,
    },
  };
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      ETag: `"${publication.geometry_hash}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
