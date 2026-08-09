"use client";

import { useRef, useState } from "react";
import { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { createClient } from "@/Lib/supabase/client";
import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MAX_HEIGHT,
  MIN_HEIGHT,
} from "./constants";
import SearchPanel from "./SearchPanel";
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
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;

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
  map: mapRef.current,
  originalGeoJson: originalGeoJsonRef.current,
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

    mapRef.current?.flyTo({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      essential: true,
    });
  }

 const wikipediaUrl = getWikipediaUrl(selectedPeak?.wikipedia);

  return (
    <div className="relative h-[calc(100vh-80px)] w-full overflow-hidden">
      <div ref={mapContainer} className="h-full w-full" />

      {loadingMessage && (
        <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-xl bg-white px-4 py-2 text-sm font-medium shadow-lg">
          {loadingMessage}
        </div>
      )}

      <section className="absolute left-3 top-3 z-10 w-[min(320px,calc(100%-24px))] rounded-2xl border border-gray-200 bg-white p-4 shadow-xl">
        <div className="mb-5">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            🏔 Mountain Tracker
          </h1>

          <p className="mt-1 text-sm text-gray-500">
            Исследуйте вершины Германии и отмечайте покорённые.
          </p>
        </div>

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

        <label className="mt-4 block">
          <span className="mb-2 block text-sm font-medium text-gray-700">
            <div className="flex items-center justify-between">
              <span>Минимальная высота</span>

              <span className="rounded-lg bg-green-100 px-2 py-1 font-bold text-green-700">
                {minimumHeight} м
              </span>
            </div>
          </span>

          <input
            type="range"
            min={MIN_HEIGHT}
            max={MAX_HEIGHT}
            step="50"
            value={minimumHeight}
            onChange={(event) => {
              const newHeight = Number(event.target.value);

              setMinimumHeight(newHeight);
              minHeightRef.current = newHeight;
            }}
            className="w-full"
          />
        </label>

        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            700–999 м
            <span className="h-3 w-3 rounded-full bg-green-500" />

          </div>

          <div className="flex items-center gap-2">
            1000–1299 м
            <span className="h-3 w-3 rounded-full bg-lime-500" />

          </div>

          <div className="flex items-center gap-2">
            1300–1599 м
            <span className="h-3 w-3 rounded-full bg-yellow-400" />

          </div>

          <div className="flex items-center gap-2">
            1600–1999 м
            <span className="h-3 w-3 rounded-full bg-orange-500" />

          </div>

          <div className="flex items-center gap-2">
            2000–3999 м
            <span className="h-3 w-3 rounded-full bg-red-500" />

          </div>

          <div className="flex items-center gap-2">
            4000–5999 м
            <span className="h-3 w-3 rounded-full bg-purple-600" />
          </div>

          <div className="flex items-center gap-2">
            6000–8000 м
            <span className="h-3 w-3 rounded-full bg-blue-600" />
          </div>
        </div>

        <button
          type="button"
          onClick={resetMap}
          className="mt-4 w-full rounded-xl border border-gray-300 px-4 py-2 font-medium hover:bg-gray-50"
        >
          Сбросить фильтры
        </button>
      </section>

    
    {selectedPeak && (
  <PeakDetailsPanel
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
    </div>
  );
}