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

const visibleMountainsGeoJson =
  await loadVisibleMountains({
    bounds: {
      west: mapBounds.getWest(),
      south: mapBounds.getSouth(),
      east: mapBounds.getEast(),
      north: mapBounds.getNorth(),
    },
    minHeight,
    supabaseClient,
  });

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
 