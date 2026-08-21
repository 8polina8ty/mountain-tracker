import { useEffect, useRef } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Map } from "maplibre-gl";

import { createMountainMap } from "./createMountainMap";
import { initializeMap } from "./initializeMap";
import { loadVisibleMountains } from "./mountainData";
import type {
  PeakFeatureCollection,
  SelectedPeak,
  UserGpsPosition,
} from "./types";

type MountainLoadBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type UseMountainMapParams = {
  mapContainerRef: RefObject<HTMLDivElement | null>;
  mapRef: MutableRefObject<Map | null>;
  originalGeoJsonRef: MutableRefObject<PeakFeatureCollection | null>;
  minHeightRef: MutableRefObject<number>;
  supabaseClient: SupabaseClient;
  setVisiblePeakCount: Dispatch<SetStateAction<number>>;
  setMountainDataVersion: Dispatch<SetStateAction<number>>;
  setLoadingMessage: Dispatch<SetStateAction<string>>;
  setSelectedPeak: Dispatch<SetStateAction<SelectedPeak | null>>;
  setSelectedPeakClimbed: Dispatch<SetStateAction<boolean>>;
  loadClimbedMountains: () => Promise<void>;
  checkSelectedPeakAscent: (mountainId: number) => Promise<void>;
  unknownErrorMessage: string;
  formatLoadingError: (message: string) => string;
  onGpsPosition: (position: UserGpsPosition) => void;
  onGpsError: (error: { code: number; message: string }) => void;
};

export function normalizeGpsPosition(
  position: GeolocationPosition,
): UserGpsPosition {
  const coords = position.coords;
  const altitudeM =
    coords.altitude !== undefined && coords.altitude !== null
      ? coords.altitude
      : null;
  const altitudeAccuracyM =
    coords.altitudeAccuracy !== undefined && coords.altitudeAccuracy !== null
      ? coords.altitudeAccuracy
      : null;
  const speedMps =
    coords.speed !== undefined && coords.speed !== null && !Number.isNaN(coords.speed)
      ? coords.speed
      : null;

  let headingDeg = coords.heading;
  if (typeof headingDeg === "number") {
    headingDeg %= 360;
    if (headingDeg < 0) headingDeg += 360;
  }

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    altitudeM,
    accuracyM: coords.accuracy,
    altitudeAccuracyM,
    speedMps,
    headingDeg,
    timestamp: position.timestamp,
  };
}

function getLodResultLimit(mapZoom: number): number {
  if (mapZoom < 5) return 1500;
  if (mapZoom < 7) return 3000;
  if (mapZoom < 9) return 7000;
  if (mapZoom < 11) return 15000;
  return 30000;
}

function getLodMinimumHeight(
  mapZoom: number,
  userMinimumHeight: number,
): number {
  if (mapZoom < 5) return Math.max(userMinimumHeight, 2500);
  if (mapZoom < 7) return Math.max(userMinimumHeight, 1800);
  if (mapZoom < 9) return Math.max(userMinimumHeight, 1200);
  return userMinimumHeight;
}

function isCurrentViewInsideLoadedBounds(
  map: Map,
  loadedBounds: MountainLoadBounds | null,
): boolean {
  if (!loadedBounds) return false;
  const currentBounds = map.getBounds();
  return (
    currentBounds.getWest() >= loadedBounds.west &&
    currentBounds.getSouth() >= loadedBounds.south &&
    currentBounds.getEast() <= loadedBounds.east &&
    currentBounds.getNorth() <= loadedBounds.north
  );
}

export function useMountainMap({
  mapContainerRef,
  mapRef,
  originalGeoJsonRef,
  minHeightRef,
  supabaseClient,
  setVisiblePeakCount,
  setLoadingMessage,
  setSelectedPeak,
  setSelectedPeakClimbed,
  loadClimbedMountains,
  checkSelectedPeakAscent,
  setMountainDataVersion,
  unknownErrorMessage,
  formatLoadingError,
  onGpsPosition,
  onGpsError,
}: UseMountainMapParams) {
  const loadedBoundsRef = useRef<MountainLoadBounds | null>(null);
  const loadedMinHeightRef = useRef<number | null>(null);
  const loadedResultLimitRef = useRef<number | null>(null);
  const mountainLoadVersionRef = useRef(0);
  const mountainAbortControllerRef = useRef<AbortController | null>(null);

  const loadingErrorMessagesRef = useRef({
    unknownErrorMessage,
    formatLoadingError,
  });
  useEffect(() => {
    loadingErrorMessagesRef.current = {
      unknownErrorMessage,
      formatLoadingError,
    };
  }, [formatLoadingError, unknownErrorMessage]);

  const gpsCallbacksRef = useRef({ onGpsPosition, onGpsError });
  useEffect(() => {
    gpsCallbacksRef.current = { onGpsPosition, onGpsError };
  }, [onGpsError, onGpsPosition]);

  const runtimeRef = useRef({
    supabaseClient,
    setVisiblePeakCount,
    setMountainDataVersion,
    setLoadingMessage,
    setSelectedPeak,
    setSelectedPeakClimbed,
    loadClimbedMountains,
    checkSelectedPeakAscent,
  });
  useEffect(() => {
    runtimeRef.current = {
      supabaseClient,
      setVisiblePeakCount,
      setMountainDataVersion,
      setLoadingMessage,
      setSelectedPeak,
      setSelectedPeakClimbed,
      loadClimbedMountains,
      checkSelectedPeakAscent,
    };
  }, [
    checkSelectedPeakAscent,
    loadClimbedMountains,
    setLoadingMessage,
    setMountainDataVersion,
    setSelectedPeak,
    setSelectedPeakClimbed,
    setVisiblePeakCount,
    supabaseClient,
  ]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const { map, geolocateControl } = createMountainMap(mapContainerRef.current);

    const handleGeolocate = (event: unknown) => {
      const position = event as unknown as GeolocationPosition;
      gpsCallbacksRef.current.onGpsPosition(normalizeGpsPosition(position));
    };

    const handleGeolocateError = (event: unknown) => {
      const error = event as unknown as GeolocationPositionError;
      gpsCallbacksRef.current.onGpsError({
        code: error.code,
        message: error.message,
      });
    };

    geolocateControl.on("geolocate", handleGeolocate);
    geolocateControl.on("error", handleGeolocateError);

    let loadTimeout: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const refreshVisibleMountains = async () => {
      if (disposed) return;

      const loadVersion = ++mountainLoadVersionRef.current;
      const currentBounds = map.getBounds();
      const longitudeSpan = currentBounds.getEast() - currentBounds.getWest();
      const latitudeSpan = currentBounds.getNorth() - currentBounds.getSouth();
      const longitudeBuffer = longitudeSpan * 0.25;
      const latitudeBuffer = latitudeSpan * 0.25;
      const requestedBounds: MountainLoadBounds = {
        west: currentBounds.getWest() - longitudeBuffer,
        south: currentBounds.getSouth() - latitudeBuffer,
        east: currentBounds.getEast() + longitudeBuffer,
        north: currentBounds.getNorth() + latitudeBuffer,
      };

      const mapZoom = map.getZoom();
      const effectiveMinimumHeight = getLodMinimumHeight(
        mapZoom,
        minHeightRef.current,
      );
      const resultLimit = getLodResultLimit(mapZoom);
      const canReuseLoadedData =
        isCurrentViewInsideLoadedBounds(map, loadedBoundsRef.current) &&
        loadedMinHeightRef.current === effectiveMinimumHeight &&
        loadedResultLimitRef.current === resultLimit;

      if (canReuseLoadedData) {
        runtimeRef.current.setMountainDataVersion((currentVersion) => currentVersion + 1);
        return;
      }

      mountainAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      mountainAbortControllerRef.current = abortController;
      const runtime = runtimeRef.current;
      const geoJson = await loadVisibleMountains({
        bounds: requestedBounds,
        minHeight: effectiveMinimumHeight,
        mapZoom,
        resultLimit,
        supabaseClient: runtime.supabaseClient,
        signal: abortController.signal,
      });

      if (
        disposed ||
        abortController.signal.aborted ||
        loadVersion !== mountainLoadVersionRef.current
      ) {
        return;
      }
      if (!geoJson) return;

      loadedBoundsRef.current = requestedBounds;
      loadedMinHeightRef.current = effectiveMinimumHeight;
      loadedResultLimitRef.current = resultLimit;
      originalGeoJsonRef.current = geoJson;
      runtimeRef.current.setMountainDataVersion((currentVersion) => currentVersion + 1);
      runtimeRef.current.setVisiblePeakCount(geoJson.features.length);
    };

    const reloadVisibleMountains = () => {
      if (loadTimeout) clearTimeout(loadTimeout);
      loadTimeout = setTimeout(() => {
        void refreshVisibleMountains();
      }, 300);
    };

    const handleLoad = async () => {
      try {
        const runtime = runtimeRef.current;
        await initializeMap({
          map,
          minHeight: minHeightRef.current,
          supabaseClient: runtime.supabaseClient,
          originalGeoJsonRef,
          setVisiblePeakCount: runtime.setVisiblePeakCount,
          setLoadingMessage: runtime.setLoadingMessage,
          loadClimbedMountains: () => runtimeRef.current.loadClimbedMountains(),
          onPeakSelect: (peak) => {
            runtimeRef.current.setSelectedPeak(peak);
            runtimeRef.current.setSelectedPeakClimbed(false);
          },
          onPeakAscentCheck: (peakId) => {
            void runtimeRef.current.checkSelectedPeakAscent(peakId);
          },
        });

        if (disposed) return;
        map.on("moveend", reloadVisibleMountains);
        map.on("zoomend", reloadVisibleMountains);
      } catch (error) {
        const loadingErrorMessages = loadingErrorMessagesRef.current;
        const message =
          error instanceof Error ? error.message : loadingErrorMessages.unknownErrorMessage;
        console.error(error);
        if (!disposed) {
          runtimeRef.current.setLoadingMessage(
            loadingErrorMessages.formatLoadingError(message),
          );
        }
      }
    };

    map.on("load", handleLoad);
    mapRef.current = map;

    return () => {
      disposed = true;
      mountainAbortControllerRef.current?.abort();
      mountainAbortControllerRef.current = null;
      geolocateControl.off("geolocate", handleGeolocate);
      geolocateControl.off("error", handleGeolocateError);
      map.off("load", handleLoad);
      map.off("moveend", reloadVisibleMountains);
      map.off("zoomend", reloadVisibleMountains);
      if (loadTimeout) clearTimeout(loadTimeout);
      map.remove();
      mapRef.current = null;
    };
  }, [mapContainerRef, mapRef, minHeightRef, originalGeoJsonRef]);
}
