import { createHash } from "node:crypto";

import { createAdminClient } from "@/Lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteParams = {
  provider: string;
  sourceType: string;
  sourceId: string;
};

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

function geometryHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  const { provider, sourceType, sourceId } = await params;
  if (
    provider !== "openstreetmap" ||
    sourceType !== "relation" ||
    !/^[1-9]\d*$/.test(sourceId)
  ) {
    return new Response("Not found", { status: 404 });
  }

  const admin = createAdminClient();
  const { data: publication, error: publicationError } = await admin
    .from("osm_route_publication_provenance")
    .select(
      "mountain_route_id,staging_route_id,staging_payload_hash,geometry_hash,topology,source_attribution,publication_status",
    )
    .eq("provider", provider)
    .eq("canonical_relation_id", sourceId)
    .eq("publication_contract_version", "mountain-tracker-osm-publication/v1")
    .eq("publication_status", "ACTIVE")
    .maybeSingle();

  if (publicationError || !publication) {
    return new Response("Not found", { status: 404 });
  }
  const [routeResult, stagingResult] = await Promise.all([
    admin
      .from("mountain_routes")
      .select("id,is_verified,geojson_url")
      .eq("id", publication.mountain_route_id)
      .maybeSingle(),
    admin
      .from("osm_route_import_staging")
      .select("id,payload_hash,geometry_geojson")
      .eq("id", publication.staging_route_id)
      .maybeSingle(),
  ]);
  const route = routeResult.data;
  const staging = stagingResult.data;
  if (
    routeResult.error ||
    stagingResult.error ||
    !route ||
    !staging ||
    route.is_verified !== true ||
    route.geojson_url !== new URL(request.url).pathname ||
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
