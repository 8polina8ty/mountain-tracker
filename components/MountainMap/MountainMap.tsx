"use client";

import { useRef, useState } from "react";
import { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AnimatePresence } from "motion/react";
import { createClient } from "@/Lib/supabase/client";
import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MIN_HEIGHT,
} from "./constants";
import SearchPanel from "./SearchPanel";
import HeightFilter from "./HeightFilter";
import PeakDetailsPanel from "./PeakDetailsPanel";
import {
  getPeakName,
  getWikipediaUrl,
} from "./peakUtils";
import { useMountainSearch } from "./useMountainSearch";
import { useMountainAscents } from "./useMountainAscents";
import { useVisibleMountains } from "./useVisibleMountains";
import { useMountainMap } from "./useMountainMap";


export default function MountainMap() {
  const [supabase] = useState(createClient);

  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const originalGeoJsonRef = useRef<PeakFeatureCollection | null>(null);


  const [selectedPeak, setSelectedPeak] = useState<SelectedPeak | null>(null);
  const [minimumHeight, setMinimumHeight] = useState(MIN_HEIGHT);

  const {
  climbedMountainIds,
  selectedPeakClimbed,
  ascentLoading,
  ascentMessage,
  setSelectedPeakClimbed,
  checkSelectedPeakAscent,
  loadClimbedMountains,
  handleAscent,
  clearAscentMessage,
} = useMountainAscents({
  supabase,
  selectedPeak,
});



  // searchInput — то, что пользователь сейчас печатает.
  // appliedSearch — поиск, применённый после кнопки «Найти».

  

  const [visiblePeakCount, setVisiblePeakCount] = useState(0);

  const [loadingMessage, setLoadingMessage] = useState("Загружаю вершины…");
  const [mountainDataVersion, setMountainDataVersion] = useState(0);

  const {
  searchInput,
  appliedSearch,
  searchMessage,
  setSearchInput,
  setSearchMessage,
  flyToSearchedPeak,
  clearSearch,
} = useMountainSearch({
  mapRef,
  originalGeoJsonRef,
  minimumHeight,

  onPeakSelect: (peak) => {
    setSelectedPeak(peak);
  },

  onCheckPeakAscent: (peakId) => {
    void checkSelectedPeakAscent(peakId);
  },

  onClearAscentMessage: clearAscentMessage,
});
  const minHeightRef = useRef<number>(MIN_HEIGHT);


    useVisibleMountains({
  mapRef,
  originalGeoJsonRef,
  minimumHeight,
  appliedSearch,
  climbedMountainIds,
  mountainDataVersion,
  setVisiblePeakCount,
  setSelectedPeak,
});

useMountainMap({
  mapContainerRef: mapContainer,
  mapRef,
  originalGeoJsonRef,
  minHeightRef,
  supabaseClient: supabase,
  setVisiblePeakCount,
  setMountainDataVersion,
  setLoadingMessage,
  setSelectedPeak,
  setSelectedPeakClimbed,
  loadClimbedMountains,
  checkSelectedPeakAscent,
});

  

  // Фильтрация выполняется на уровне источника.
  // Поэтому кластеры тоже пересчитываются правильно.
  
  function resetMap() {
    clearSearch();
    setMinimumHeight(MIN_HEIGHT);
    minHeightRef.current = MIN_HEIGHT;

    mapRef.current?.flyTo({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });
  }

 const wikipediaUrl = getWikipediaUrl(selectedPeak?.wikipedia);

  return (
    <div className="mountain-map-shell relative w-full overflow-hidden">
      <div ref={mapContainer} className="h-full w-full" />

      {loadingMessage && (
        <div
          className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-map-control)]"
          role="status"
          aria-live="polite"
        >
          <span
            className="h-2 w-2 rounded-full bg-[var(--color-glacier)]"
            aria-hidden="true"
          />
          {loadingMessage}
        </div>
      )}

      <section
        className="absolute left-3 top-3 z-10 max-h-[calc(100%-24px)] w-[calc(100%-24px)] overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-map-control)] sm:w-[336px]"
        aria-label="Инструменты карты"
      >
        <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
            Карта вершин
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
            Поиск и высотные параметры обзора
          </p>
        </div>

        <div className="px-4 py-4">
          <SearchPanel
            searchInput={searchInput}
            searchMessage={searchMessage}
            appliedSearch={appliedSearch}
            visiblePeakCount={visiblePeakCount}
            onSearchInputChange={(value) => {
              setSearchInput(value);
              setSearchMessage("");
            }}
            onSearch={flyToSearchedPeak}
            onClearSearch={clearSearch}
          />

          <HeightFilter
            minimumHeight={minimumHeight}
            onHeightChange={(newHeight) => {
              setMinimumHeight(newHeight);
              minHeightRef.current = newHeight;
            }}
            onReset={resetMap}
          />
        </div>
      </section>

      <AnimatePresence initial={false}>
        {selectedPeak && (
          <PeakDetailsPanel
            key="peak-details-panel"
            peak={selectedPeak}
            peakName={getPeakName(selectedPeak)}
            wikipediaUrl={wikipediaUrl}
            selectedPeakClimbed={selectedPeakClimbed}
            ascentLoading={ascentLoading}
            ascentMessage={ascentMessage}
            onClose={() => setSelectedPeak(null)}
            onAscent={handleAscent}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
