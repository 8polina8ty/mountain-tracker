import { useEffect, useRef, useState, type RefObject } from "react";
import type { Map } from "maplibre-gl";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  MountainMapFilters,
  SelectedPeak,
} from "./types";
import { searchMountains } from "./mountainSearch";

type SearchStatus = "idle" | "mapLoading" | "enterPeakName" | "searching" | "notFound" | "requestError" | "peakFound";

type UseMountainSearchParams = {
  mapRef: RefObject<Map | null>;
  supabase: SupabaseClient;
  filters: MountainMapFilters;
  climbedMountainIds: Set<number>;
  onPeakSelect: (peak: SelectedPeak) => void;
  onCheckPeakAscent: (peakId: number) => void;
  onClearAscentMessage: () => void;
  messages: Record<Exclude<SearchStatus, "idle">, string>;
};

export function useMountainSearch({
  mapRef,
  supabase,
  filters,
  climbedMountainIds,
  onPeakSelect,
  onCheckPeakAscent,
  onClearAscentMessage,
  messages,
}: UseMountainSearchParams) {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  function cancelSearch() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setStatus("idle");
  }

  async function flyToSearchedPeak() {
    cancelSearch();
    const query = searchInput.trim();
    const map = mapRef.current;
    if (!map) {
      setStatus("mapLoading");
      return;
    }
    if (!query) {
      setStatus("enterPeakName");
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus("searching");

    try {
      const peak = await searchMountains({
        supabase, query, filters, countryCode, climbedMountainIds, signal: controller.signal,
      });
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      if (!peak) {
        setAppliedSearch("");
        setStatus("notFound");
        return;
      }
      if (mapRef.current !== map) {
        setStatus("mapLoading");
        return;
      }

      setAppliedSearch(query);
      onPeakSelect(peak);
      onClearAscentMessage();
      onCheckPeakAscent(peak.id);
      setStatus("peakFound");
      map.flyTo({ center: [peak.longitude, peak.latitude], zoom: 13 });
    } catch {
      if (!controller.signal.aborted && activeRequest.current === controller) setStatus("requestError");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function clearSearch() {
    cancelSearch();
    setSearchInput("");
    setAppliedSearch("");
  }

  return {
    searchInput,
    appliedSearch,
    searchMessage: status === "idle" ? "" : messages[status],
    searching: status === "searching",
    countryCode,
    setSearchInput: (value: string) => { cancelSearch(); setSearchInput(value); },
    setCountryCode: (value: string) => { cancelSearch(); setCountryCode(value); },
    cancelSearch,
    flyToSearchedPeak,
    clearSearch,
  };
}
