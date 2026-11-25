import { useEffect } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { GeoJSONSource, Map } from "maplibre-gl";

import type {
  MountainMapFilters,
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import { filterMountainsInView, retainVisiblePeak } from "./mountainFilters";

type UseVisibleMountainsParams = {
  mapRef: MutableRefObject<Map | null>;
  originalGeoJsonRef: MutableRefObject<
    PeakFeatureCollection | null
  >;
  filters: MountainMapFilters;
  appliedSearch: string;
  climbedMountainIds: Set<number>;
  mountainDataVersion: number;
  setVisiblePeakCount: Dispatch<SetStateAction<number>>;
  setSelectedPeak: Dispatch<
    SetStateAction<SelectedPeak | null>
  >;
};

export function useVisibleMountains({
  mapRef,
  originalGeoJsonRef,
  filters,
  appliedSearch,
  climbedMountainIds,
  setVisiblePeakCount,
  setSelectedPeak,
  mountainDataVersion,
}: UseVisibleMountainsParams) {
  useEffect(() => {
    const map = mapRef.current;
    const originalGeoJson = originalGeoJsonRef.current;

    if (!map || !originalGeoJson) {
      return;
    }

    const currentBounds =
  map.getBounds();

const west =
  currentBounds.getWest();

const south =
  currentBounds.getSouth();

const east =
  currentBounds.getEast();

const north =
  currentBounds.getNorth();

    const source = map.getSource("peaks") as
      | GeoJSONSource
      | undefined;

    if (!source) {
      return;
    }

    const filteredGeoJson = filterMountainsInView(
      originalGeoJson,
      { west, south, east, north },
      filters,
      climbedMountainIds,
      appliedSearch,
    );

    source.setData(filteredGeoJson);
    setVisiblePeakCount(filteredGeoJson.features.length);
    setSelectedPeak((currentPeak) => retainVisiblePeak(currentPeak, filteredGeoJson));
  }, [
    filters,
    appliedSearch,
    climbedMountainIds,
    mapRef,
    originalGeoJsonRef,
    setVisiblePeakCount,
    setSelectedPeak,
    mountainDataVersion,
  ]);
}
