import {
  createPublicationGeojsonResponse,
  publicationSelectionErrorResponse,
  selectSupportedActivePublication,
  type GeojsonPublication,
} from "@/Lib/osmRoutePublicationGeojson";
import { createAdminClient } from "@/Lib/supabase/admin";

export const dynamic = "force-dynamic";

type RouteParams = {
  provider: string;
  sourceType: string;
  sourceId: string;
};

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
  const { data: publications, error: publicationError } = await admin
    .from("osm_route_publication_provenance")
    .select(
      "mountain_route_id,staging_route_id,staging_payload_hash,geometry_hash,topology,source_attribution,publication_status,publication_contract_version",
    )
    .eq("provider", provider)
    .eq("canonical_relation_id", sourceId)
    .eq("publication_status", "ACTIVE");

  if (publicationError) {
    return new Response("Not found", { status: 404 });
  }
  const selection = selectSupportedActivePublication(
    (publications ?? []) as GeojsonPublication[],
  );
  const selectionErrorResponse = publicationSelectionErrorResponse(selection);
  if (selectionErrorResponse) return selectionErrorResponse;
  if (selection.status !== "FOUND") return new Response("Not found", { status: 404 });
  const publication = selection.publication;

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
  return createPublicationGeojsonResponse({
    requestPath: new URL(request.url).pathname,
    publication,
    route: routeResult.data,
    staging: stagingResult.data,
    evidenceReadFailed: Boolean(routeResult.error || stagingResult.error),
  });
}
