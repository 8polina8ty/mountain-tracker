import { readFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvironment(await readFile(".env.local", "utf8"));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key || !publishableKey) {
  throw new Error("Missing read-only Supabase credentials.");
}

const response = await fetch(`${url}/rest/v1/`, {
  headers: { Accept: "application/openapi+json", apikey: key },
});
const openApi = (await response.json()) as {
  definitions?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
};
const schema =
  openApi.definitions?.mountain_routes ??
  openApi.components?.schemas?.mountain_routes ??
  null;
const paths = openApi as typeof openApi & {
  paths?: Record<string, Record<string, unknown>>;
};

const client = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymousClient = createClient(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const [
  count,
  sample,
  withGeometry,
  informationSchema,
  anonymousCount,
  storageBucket,
  phase11Publication,
  phase11Mountain,
] = await Promise.all([
  client.from("mountain_routes").select("*", { count: "exact", head: true }),
  client.from("mountain_routes").select("*").order("id").limit(5),
  client
    .from("mountain_routes")
    .select(
      "id,mountain_id,name,geojson_url,gpx_url,source_name,source_url,is_verified,created_by,created_at",
    )
    .not("geojson_url", "is", null)
    .order("id")
    .limit(5),
  client
    .schema("information_schema")
    .from("columns")
    .select("column_name,data_type,is_nullable,column_default")
    .eq("table_schema", "public")
    .eq("table_name", "mountain_routes")
    .order("ordinal_position"),
  anonymousClient
    .from("mountain_routes")
    .select("*", { count: "exact", head: true }),
  client.storage.getBucket("route-gpx"),
  client
    .from("osm_route_publication_provenance")
    .select("id,mountain_route_id,publication_idempotency_key", {
      count: "exact",
    })
    .eq("provider", "openstreetmap")
    .eq("canonical_relation_id", "196164"),
  client.from("mountains").select("id").eq("id", 13132).maybeSingle(),
]);

console.log(
  JSON.stringify(
    {
      openApi: {
        status: response.status,
        schema,
        methods: Object.keys(paths.paths?.["/mountain_routes"] ?? {}).sort(),
      },
      phase11Infrastructure: {
        provenanceDefinitionAvailable:
          openApi.definitions?.osm_route_publication_provenance !== undefined,
        publicationRpcAvailable:
          paths.paths?.["/rpc/publish_approved_osm_route"] !== undefined,
        rollbackRpcAvailable:
          paths.paths?.["/rpc/rollback_osm_route_publication"] !== undefined,
      },
      count: { value: count.count, error: count.error?.message ?? null },
      anonymousCount: {
        value: anonymousCount.count,
        error: anonymousCount.error?.message ?? null,
      },
      sample: { rows: sample.data, error: sample.error?.message ?? null },
      withGeometry: {
        rows: withGeometry.data,
        error: withGeometry.error?.message ?? null,
      },
      informationSchema: {
        rows: informationSchema.data,
        error: informationSchema.error?.message ?? null,
      },
      routeGpxBucket: {
        row: storageBucket.data
          ? {
              id: storageBucket.data.id,
              name: storageBucket.data.name,
              public: storageBucket.data.public,
              fileSizeLimit: storageBucket.data.file_size_limit,
              allowedMimeTypes: storageBucket.data.allowed_mime_types,
            }
          : null,
        error: storageBucket.error?.message ?? null,
      },
      lockedRoutePrewrite: {
        mountainExists: phase11Mountain.data?.id === 13132,
        mountainError: phase11Mountain.error?.message ?? null,
        existingPublicationCount: phase11Publication.count,
        existingPublicationRows: phase11Publication.data,
        existingPublicationError: phase11Publication.error?.message ?? null,
      },
    },
    null,
    2,
  ),
);
