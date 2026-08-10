import type {
  MountainRow,
  PeakProperties,
} from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

type LoadVisibleMountainsResult = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  PeakProperties
>;

type LoadVisibleMountainsParams = {
  bounds: MountainLoadBounds;
  minHeight: number;
  mapZoom: number;
  resultLimit: number;
  supabaseClient: SupabaseClient;
  signal: AbortSignal;
}

type MountainBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};


const MOUNTAINS_PER_REQUEST = 1000;
const MAX_PARALLEL_REGION_REQUESTS = 4;

export type MountainLoadBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

function splitBoundsIntoFour(
  bounds: MountainBounds,
): MountainBounds[] {
  const middleLongitude =
    (bounds.west + bounds.east) / 2;

  const middleLatitude =
    (bounds.south + bounds.north) / 2;

  return [
    {
      west: bounds.west,
      south: middleLatitude,
      east: middleLongitude,
      north: bounds.north,
    },
    {
      west: middleLongitude,
      south: middleLatitude,
      east: bounds.east,
      north: bounds.north,
    },
    {
      west: bounds.west,
      south: bounds.south,
      east: middleLongitude,
      north: middleLatitude,
    },
    {
      west: middleLongitude,
      south: bounds.south,
      east: bounds.east,
      north: middleLatitude,
    },
  ];
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<MountainRow[] | null>,
): Promise<(MountainRow[] | null)[]> {
  const results: (MountainRow[] | null)[] =
    new Array(items.length);

  let nextIndex = 0;

  const workers = Array.from(
    {
      length: Math.min(
        concurrency,
        items.length,
      ),
    },
    async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] =
          await worker(items[currentIndex]);
      }
    },
  );

  await Promise.all(workers);

  return results;
}

async function loadMountainsForBounds(
  bounds: MountainBounds,
  minHeight: number,
  supabaseClient: SupabaseClient,
  maxDepth: number,
  signal: AbortSignal,
  depth = 0,
): Promise<MountainRow[] | null> {

   if (signal?.aborted) {
    return null;
  }

  const { data, error } =
  await supabaseClient
    .rpc(
      "get_mountains_in_bounds",
      {
        min_lat: bounds.south,
        max_lat: bounds.north,
        min_lng: bounds.west,
        max_lng: bounds.east,
        min_height: minHeight,
        result_limit: MOUNTAINS_PER_REQUEST,
        result_offset: 0,
      },
    )
    .abortSignal(signal);

  if (error) {
  if (signal?.aborted) {
    return null;
  }

  console.error(
    "Ошибка загрузки вершин:",
    error,
  );

  return null;
}

  const mountains =
    (data ?? []) as MountainRow[];

    if (
  mountains.length < MOUNTAINS_PER_REQUEST ||
  depth >= maxDepth
) {
  return mountains;
}
  /*
   * Если вернулось меньше лимита,
   * значит все вершины этой области получены.
   */
  if (
    mountains.length <
      MOUNTAINS_PER_REQUEST ||
    depth >= maxDepth
  ) {
    return mountains;
  }

  /*
   * Область слишком насыщенная.
   * Делим её на четыре части.
   */
  const childBounds =
    splitBoundsIntoFour(bounds);

  const childResults =
  await runWithConcurrency(
    childBounds,
    MAX_PARALLEL_REGION_REQUESTS,
    (child) =>
      loadMountainsForBounds(
        child,
        minHeight,
        supabaseClient,
        maxDepth,
        signal,
        depth + 1,
        

      ),
  );

  const mergedMountains: MountainRow[] = [];

  childResults.forEach((result) => {
    if (result) {
      mergedMountains.push(...result);
    }
  });

  return mergedMountains;
}


export async function loadVisibleMountains({
  bounds,
  minHeight,
   mapZoom,
   resultLimit,
   supabaseClient,
   signal,
}: LoadVisibleMountainsParams): Promise<
  LoadVisibleMountainsResult | null
> {

const maxDepth =
  mapZoom < 5
    ? 1
    : mapZoom < 7
      ? 2
      : mapZoom < 9
        ? 3
        : mapZoom < 11
          ? 4
          : 5;

const loadedMountains =
  await loadMountainsForBounds(
    bounds,
    minHeight,
    supabaseClient,
     maxDepth,
     signal,
  );

if (!loadedMountains) {
  return null;
}

/*
 * Одна вершина может попасть в соседние
 * области на границе. Убираем дубликаты.
 */
const mountainById =
  new globalThis.Map<
    string,
    MountainRow
  >();

loadedMountains.forEach((mountain) => {
  const mountainKey =
    mountain.id !== null &&
    mountain.id !== undefined
      ? String(mountain.id)
      : String(mountain.osm_id);

  mountainById.set(
    mountainKey,
    mountain,
  );
});

const mountains = Array.from(
  mountainById.values(),
);

const limitedMountains =
  mountains
    .sort(
      (firstMountain, secondMountain) =>
        Number(secondMountain.height ?? 0) -
        Number(firstMountain.height ?? 0),
    )
    .slice(0, resultLimit);

  const geoJson: LoadVisibleMountainsResult = {
    type: "FeatureCollection",
    features: limitedMountains.map((mountain) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [
          mountain.longitude,
          mountain.latitude,
        ],
      },
      properties: {
        id: mountain.id,
        osm_id: mountain.osm_id,
        name: mountain.name ?? undefined,
        name_de: mountain.name_de ?? undefined,
        height: mountain.height,
        wikidata: mountain.wikidata ?? undefined,
        wikipedia: mountain.wikipedia ?? undefined,
        region_source: mountain.region_source ?? undefined,
      },
    })),
  };

  return geoJson;
}

