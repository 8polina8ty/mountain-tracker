import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  MountainRow,
  PeakFeature,
  PeakFeatureCollection,
} from "./types";

type LoadAllMountainsParams = {
  supabaseClient: SupabaseClient;
  onProgress?: (loadedCount: number) => void;
};

export async function loadAllMountains({
  supabaseClient,
  onProgress,
}: LoadAllMountainsParams): Promise<PeakFeatureCollection> {
  const pageSize = 1000;
  const allMountains: MountainRow[] = [];

  let from = 0;

  while (true) {
    const to = from + pageSize - 1;

    const { data, error } = await supabaseClient
      .from("mountains")
      .select(`
        id,
        osm_id,
        name,
        name_de,
        height,
        latitude,
        longitude,
        wikidata,
        wikipedia,
        region_source
      `)
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(error.message);
    }

    const page = (data ?? []) as MountainRow[];

    allMountains.push(...page);
    onProgress?.(allMountains.length);

    if (page.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  const features: PeakFeature[] = allMountains
    .filter((mountain) => {
      return (
        Number.isFinite(Number(mountain.latitude)) &&
        Number.isFinite(Number(mountain.longitude)) &&
        Number.isFinite(Number(mountain.height))
      );
    })
    .map((mountain) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [
          Number(mountain.longitude),
          Number(mountain.latitude),
        ],
      },
      properties: {
        id: Number(mountain.id),
        osm_id: Number(mountain.osm_id),
        name: mountain.name || undefined,
        name_de: mountain.name_de || undefined,
        height: Number(mountain.height),
        wikidata: mountain.wikidata || undefined,
        wikipedia: mountain.wikipedia || undefined,
        region_source: mountain.region_source || undefined,
      },
    }));

  return {
    type: "FeatureCollection",
    features,
  };
}