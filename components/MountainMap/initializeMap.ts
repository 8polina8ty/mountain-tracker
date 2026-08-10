import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addMountainSource } from "./mapSources";
import { addMountainLayers } from "./mapLayers";
import { loadVisibleMountains } from "./mountainData";
import { registerMapEvents } from "./mapEvents";
import type {
  Map,
} from "maplibre-gl";

import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";

type InitializeMapParams = {
  map: Map;
  supabaseClient: SupabaseClient;
  minHeight: number;

  originalGeoJsonRef: MutableRefObject<
    PeakFeatureCollection | null
  >;

  setVisiblePeakCount: Dispatch<SetStateAction<number>>;
  setLoadingMessage: Dispatch<SetStateAction<string>>;

  loadClimbedMountains: () => Promise<void>;

  onPeakSelect: (peak: SelectedPeak) => void;
  onPeakAscentCheck: (peakId: number) => void;
};

function getLodResultLimit(mapZoom: number): number {
  if (mapZoom < 5) {
    return 1500;
  }

  if (mapZoom < 7) {
    return 3000;
  }

  if (mapZoom < 9) {
    return 7000;
  }

  if (mapZoom < 11) {
    return 15000;
  }

  return 30000;
}

export async function initializeMap({
  map,
  minHeight,
  supabaseClient,
  originalGeoJsonRef,
  setVisiblePeakCount,
  setLoadingMessage,
  loadClimbedMountains,
  onPeakSelect,
  onPeakAscentCheck,
}: InitializeMapParams) {
  addMountainSource(map);

  addMountainLayers(map);

  registerMapEvents({
    map,
    onPeakSelect,
    onPeakAscentCheck,
  });

  const mapBounds = map.getBounds();
  const mapZoom = map.getZoom();
  const abortController = new AbortController();
  const abortInitialLoad = () => abortController.abort();

  map.once("remove", abortInitialLoad);

  const visibleMountainsGeoJson = await (async () => {
    try {
      return await loadVisibleMountains({
        bounds: {
          west: mapBounds.getWest(),
          south: mapBounds.getSouth(),
          east: mapBounds.getEast(),
          north: mapBounds.getNorth(),
        },
        minHeight,
        mapZoom,
        resultLimit: getLodResultLimit(mapZoom),
        supabaseClient,
        signal: abortController.signal,
      });
    } finally {
      map.off("remove", abortInitialLoad);
    }
  })();

  if (visibleMountainsGeoJson) {
    originalGeoJsonRef.current =
      visibleMountainsGeoJson;

    setVisiblePeakCount(
      visibleMountainsGeoJson.features.length,
    );
  }

  await loadClimbedMountains();

  setLoadingMessage("");
}
 
