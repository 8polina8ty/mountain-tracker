import { useEffect } from "react";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { GeoJSONSource, Map } from "maplibre-gl";

import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import {
  getPeakName,
  normalizeText,
} from "./peakUtils";

type UseVisibleMountainsParams = {
  mapRef: MutableRefObject<Map | null>;
  originalGeoJsonRef: MutableRefObject<
    PeakFeatureCollection | null
  >;
  minimumHeight: number;
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
  minimumHeight,
  appliedSearch,
  climbedMountainIds,
  setVisiblePeakCount,
  setSelectedPeak,
  mountainDataVersion,
}: UseVisibleMountainsParams) {
  useEffect(() => {
    console.log("useVisibleMountains");
    console.log(originalGeoJsonRef.current);
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

    const normalizedSearch = normalizeText(appliedSearch);

    const filteredFeatures = originalGeoJson.features
      .filter((feature) => {

        const [
  longitude,
  latitude,
] = feature.geometry.coordinates;

const isInsideViewport =
  longitude >= west &&
  longitude <= east &&
  latitude >= south &&
  latitude <= north;

if (!isInsideViewport) {
  return false;
}

        const height = Number(feature.properties.height);
        const name = normalizeText(
          getPeakName(feature.properties),
        );

        const matchesHeight = height >= minimumHeight;

        const matchesSearch =
          normalizedSearch.length === 0 ||
          name.includes(normalizedSearch);

        return matchesHeight && matchesSearch;
      })
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          climbed: climbedMountainIds.has(
            Number(feature.properties.id),
          ),
        },
      }));

    const filteredGeoJson: PeakFeatureCollection = {
      type: "FeatureCollection",
      features: filteredFeatures,
    };

console.log(
  "setData features:",
  filteredGeoJson.features.length,
);

    source.setData(filteredGeoJson);
    setVisiblePeakCount(filteredFeatures.length);

    setSelectedPeak((currentPeak) => {
      if (!currentPeak) {
        return null;
      }

      const stillVisible = filteredFeatures.some(
        (feature) =>
          Number(feature.properties.osm_id) ===
          Number(currentPeak.osm_id),
      );

      return stillVisible ? currentPeak : null;
    });
  }, [
    minimumHeight,
    appliedSearch,
    climbedMountainIds,
    mapRef,
    originalGeoJsonRef,
    setVisiblePeakCount,
    setSelectedPeak,
    mountainDataVersion,
  ]);
}