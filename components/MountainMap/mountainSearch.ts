import { isAuthSessionMissingError, type SupabaseClient } from "@supabase/supabase-js";
import type { MountainMapFilters, MountainRow, SelectedPeak } from "./types";

export const MAX_MOUNTAIN_SEARCH_LENGTH = 100;

const SEARCH_COLUMNS = "id,osm_id,name,name_de,height,latitude,longitude,wikidata,wikipedia,region_source";

export async function searchMountains({
  supabase, query, filters, countryCode, climbedMountainIds, signal,
}: {
  supabase: SupabaseClient;
  query: string;
  filters: MountainMapFilters;
  countryCode: string;
  climbedMountainIds: ReadonlySet<number>;
  signal: AbortSignal;
}): Promise<SelectedPeak | null> {
  const name = query.trim().slice(0, MAX_MOUNTAIN_SEARCH_LENGTH);
  if (!name) return null;
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new Error("Invalid search country");

  signal.throwIfAborted();
  let viewerId: string | undefined;
  if (filters.ascentStatus !== "all") {
    const { data, error } = await supabase.auth.getUser();
    signal.throwIfAborted();
    if (error && !isAuthSessionMissingError(error)) throw error;
    viewerId = data.user?.id;
    if (!viewerId && filters.ascentStatus === "climbed") return null;
  }

  // Treat every user character literally, then quote the pattern for PostgREST's logic syntax.
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columns = SEARCH_COLUMNS + (countryCode ? ",search_country:mountain_countries()" : "")
    + (viewerId ? ",search_ascent:ascents()" : "");

  async function bestMatch(exact: boolean): Promise<MountainRow | null> {
    signal.throwIfAborted();
    const match = JSON.stringify(exact ? `^${pattern}$` : pattern);
    const request = supabase.from("mountains").select(columns)
      .gte("height", filters.minHeight).lte("height", filters.maxHeight)
      .or(`name.imatch.${match},name_de.imatch.${match}`);

    if (countryCode) {
      request.eq("search_country.country_code", countryCode)
        .or(`country_code.eq.${countryCode},search_country.not.is.null`);
    }
    if (viewerId) {
      request.eq("search_ascent.user_id", viewerId);
      if (filters.ascentStatus === "climbed") request.not("search_ascent", "is", null);
      else request.is("search_ascent", null);
    }

    const { data, error } = await request.order("height", { ascending: false })
      .order("id").limit(1).abortSignal(signal).overrideTypes<MountainRow[], { merge: false }>();
    signal.throwIfAborted();
    if (error) throw new Error(error.message, { cause: error });
    return data?.[0] ?? null;
  }

  const row = await bestMatch(true) ?? await bestMatch(false);
  if (!row) return null;

  return {
    id: row.id,
    osm_id: row.osm_id,
    name: row.name ?? undefined,
    name_de: row.name_de ?? undefined,
    height: row.height,
    longitude: row.longitude,
    latitude: row.latitude,
    wikidata: row.wikidata ?? undefined,
    wikipedia: row.wikipedia ?? undefined,
    region_source: row.region_source ?? undefined,
    climbed: filters.ascentStatus === "all" ? climbedMountainIds.has(Number(row.id)) : filters.ascentStatus === "climbed",
    selectionSource: "search",
  };
}
