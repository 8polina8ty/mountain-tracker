"use client";

import { useRef, useState } from "react";
import { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import type {
  MountainMapFilters,
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import {
  MIN_HEIGHT,
} from "./constants";
import SearchPanel from "./SearchPanel";
import MapFilterBar from "./MapFilterBar";
import { DEFAULT_MAP_FILTERS } from "./mountainFilters";
import PeakDetailsPanel from "./PeakDetailsPanel";
import {
  getWikipediaUrl,
} from "./peakUtils";
import { useMountainSearch } from "./useMountainSearch";
import { useMountainAscents } from "./useMountainAscents";
import { useVisibleMountains } from "./useVisibleMountains";
import { useMountainMap } from "./useMountainMap";


export default function MountainMap() {
  const t = useTranslations("Map");
  const [supabase] = useState(createClient);

  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const originalGeoJsonRef = useRef<PeakFeatureCollection | null>(null);


  const [selectedPeak, setSelectedPeak] = useState<SelectedPeak | null>(null);
  const [filters, setFilters] = useState<MountainMapFilters>({ ...DEFAULT_MAP_FILTERS });

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
  messages: {
    loginRequired: t("PeakDetails.status.loginRequired"),
    ascentRemoved: t("PeakDetails.status.ascentRemoved"),
    alreadyClimbed: t("PeakDetails.status.alreadyClimbed"),
    ascentAdded: t("PeakDetails.status.ascentAdded"),
  },
});



  // searchInput — то, что пользователь сейчас печатает.
  // appliedSearch — поиск, применённый после кнопки «Найти».

  

  const [visiblePeakCount, setVisiblePeakCount] = useState(0);

  const [loadingMessage, setLoadingMessage] = useState(
    t("Status.loadingPeaks"),
  );
  const [mountainDataVersion, setMountainDataVersion] = useState(0);

  const {
  searchInput,
  appliedSearch,
  searchMessage,
  searching,
  countryCode,
  setSearchInput,
  setCountryCode,
  cancelSearch,
  flyToSearchedPeak,
  clearSearch,
} = useMountainSearch({
  mapRef,
  supabase,
  filters,
  climbedMountainIds,

  onPeakSelect: (peak) => {
    setSelectedPeak(peak);
    setSelectedPeakClimbed(Boolean(peak.climbed));
  },

  onCheckPeakAscent: (peakId) => {
    void checkSelectedPeakAscent(peakId);
  },

  onClearAscentMessage: clearAscentMessage,
  messages: {
    mapLoading: t("Search.status.mapLoading"),
    enterPeakName: t("Search.status.enterPeakName"),
    searching: t("Search.status.searching"),
    requestError: t("Search.status.requestError"),
    notFound: t("Filter.noSearchMatches"),
    peakFound: t("Search.status.peakFound"),
  },
});
  const minHeightRef = useRef<number>(MIN_HEIGHT);

  function applyFilters(nextFilters: MountainMapFilters) {
    cancelSearch();
    minHeightRef.current = nextFilters.minHeight;
    setFilters(nextFilters);
    setSelectedPeak((peak) => {
      if (peak?.selectionSource !== "search") return peak;
      const { ascentStatus, minHeight, maxHeight } = nextFilters;
      const statusMatches = ascentStatus === "all" || (ascentStatus === "climbed") === selectedPeakClimbed;
      return statusMatches && peak.height >= minHeight && peak.height <= maxHeight ? peak : null;
    });
  }


    useVisibleMountains({
  mapRef,
  originalGeoJsonRef,
  filters,
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
  minimumHeight: filters.minHeight,
  supabaseClient: supabase,
  setVisiblePeakCount,
  setMountainDataVersion,
  setLoadingMessage,
  setSelectedPeak,
  setSelectedPeakClimbed,
  loadClimbedMountains,
  checkSelectedPeakAscent,
  unknownErrorMessage: t("Status.unknownError"),
  formatLoadingError: (message) => t("Status.loadingError", { message }),
  onGpsPosition: () => {},
  onGpsError: () => {},
});

// Фильтрация выполняется на уровне источника.
  // Поэтому кластеры тоже пересчитываются правильно.
  
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
        className="absolute left-3 right-16 top-3 z-30 sm:right-auto sm:max-w-[calc(100%-80px)] lg:right-auto"
        aria-label={t("Controls.accessibleLabel")}
      >
          <div className="rounded-[22px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] sm:w-[380px]">
          <SearchPanel
            searchInput={searchInput}
            searchMessage={searchMessage}
            searching={searching}
            countryCode={countryCode}
            appliedSearch={appliedSearch}
            visiblePeakCount={visiblePeakCount}
            onSearchInputChange={setSearchInput}
            onCountryChange={setCountryCode}
            onSearch={flyToSearchedPeak}
            onClearSearch={clearSearch}
          />

        </div>
        <div className="lg:hidden">
          <MapFilterBar
            appliedFilters={filters}
            appliedSearch={appliedSearch}
            climbedMountainIds={climbedMountainIds}
            mapRef={mapRef}
            originalGeoJsonRef={originalGeoJsonRef}
            mountainDataVersion={mountainDataVersion}
            onApply={applyFilters}
          />
        </div>
      </section>

      <div className="hidden lg:flex absolute left-1/2 top-4 z-30 -translate-x-1/2 items-center justify-center">
        <MapFilterBar
          appliedFilters={filters}
          appliedSearch={appliedSearch}
          climbedMountainIds={climbedMountainIds}
          mapRef={mapRef}
          originalGeoJsonRef={originalGeoJsonRef}
          mountainDataVersion={mountainDataVersion}
          onApply={applyFilters}
        />
      </div>

      <AnimatePresence initial={false}>
        {selectedPeak && (
          <PeakDetailsPanel
            key="peak-details-panel"
            peak={selectedPeak}
            peakName={
              selectedPeak.name ||
              selectedPeak.name_de ||
              t("PeakDetails.unnamed")
            }
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
