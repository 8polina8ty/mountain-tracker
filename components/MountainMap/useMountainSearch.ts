import { useState } from "react";
import type { Map } from "maplibre-gl";

import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import {
  getPeakName,
  normalizeText,
} from "./peakUtils";

type UseMountainSearchParams = {
  map: Map | null;
  originalGeoJson: PeakFeatureCollection | null;
  minimumHeight: number;
  onPeakSelect: (peak: SelectedPeak) => void;
  onCheckPeakAscent: (peakId: number) => void;
  onClearAscentMessage: () => void;
};

export function useMountainSearch({
  map,
  originalGeoJson,
  minimumHeight,
  onPeakSelect,
  onCheckPeakAscent,
  onClearAscentMessage,
}: UseMountainSearchParams) {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [searchMessage, setSearchMessage] = useState("");

  function flyToSearchedPeak() {
    const normalizedSearch = normalizeText(searchInput);

    if (!map || !originalGeoJson) {
      setSearchMessage("Карта ещё загружается.");
      return;
    }

    if (!normalizedSearch) {
      setSearchMessage("Введите название вершины.");
      return;
    }

    const matchingPeaks = originalGeoJson.features
      .filter((feature) => {
        const height = Number(feature.properties.height);
        const name = normalizeText(
          getPeakName(feature.properties),
        );

        return (
          height >= minimumHeight &&
          name.includes(normalizedSearch)
        );
      })
      .sort((first, second) => {
        const firstName = normalizeText(
          getPeakName(first.properties),
        );
        const secondName = normalizeText(
          getPeakName(second.properties),
        );

        const firstExact =
          firstName === normalizedSearch ? 1 : 0;
        const secondExact =
          secondName === normalizedSearch ? 1 : 0;

        if (firstExact !== secondExact) {
          return secondExact - firstExact;
        }

        return (
          Number(second.properties.height) -
          Number(first.properties.height)
        );
      });

    const peak = matchingPeaks[0];

    if (!peak) {
      setAppliedSearch("");
      setSearchMessage(
        `Вершина не найдена среди гор от ${minimumHeight} м.`,
      );
      return;
    }

    setAppliedSearch(searchInput);

    const [longitude, latitude] =
      peak.geometry.coordinates;

    onPeakSelect({
      ...peak.properties,
      longitude,
      latitude,
    });

    onClearAscentMessage();
    onCheckPeakAscent(peak.properties.id);

    setSearchMessage(
      matchingPeaks.length > 1
        ? `Найдено совпадений: ${matchingPeaks.length}. Показана наиболее подходящая вершина.`
        : "Вершина найдена.",
    );

    map.flyTo({
      center: [longitude, latitude],
      zoom: 13,
      essential: true,
    });
  }

  function clearSearch() {
    setSearchInput("");
    setAppliedSearch("");
    setSearchMessage("");
  }

  return {
    searchInput,
    appliedSearch,
    searchMessage,
    setSearchInput,
    setSearchMessage,
    flyToSearchedPeak,
    clearSearch,
  };
}