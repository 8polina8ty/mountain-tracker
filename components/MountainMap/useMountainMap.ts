import { useEffect, useRef } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Map, GeoJSONSource } from "maplibre-gl";

import { createMountainMap } from "./createMountainMap";
import { initializeMap } from "./initializeMap";
import { loadVisibleMountains } from "./mountainData";

import type {
  PeakFeatureCollection,
  SelectedPeak,
} from "./types";



type MountainLoadBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type MountainTile = {
  key: string;
  x: number;
  y: number;
  zoom: number;
  bounds: MountainLoadBounds;
};
 
type UseMountainMapParams = {
  mapContainerRef: RefObject<HTMLDivElement | null>;
  mapRef: MutableRefObject<Map | null>;

  originalGeoJsonRef: MutableRefObject<
    PeakFeatureCollection | null
  >;

  minHeightRef: MutableRefObject<number>;
  supabaseClient: SupabaseClient;

  setVisiblePeakCount: Dispatch<SetStateAction<number>>;
  setMountainDataVersion: React.Dispatch<
  React.SetStateAction<number>
>;
  setLoadingMessage: Dispatch<SetStateAction<string>>;
  setSelectedPeak: Dispatch<
    SetStateAction<SelectedPeak | null>
  >;
  setSelectedPeakClimbed: Dispatch<
    SetStateAction<boolean>
  >;

  loadClimbedMountains: () => Promise<void>;
  checkSelectedPeakAscent: (
    mountainId: number,
  ) => Promise<void>;
};

function clampLatitude(
  latitude: number,
): number {
  return Math.max(
    -85.05112878,
    Math.min(85.05112878, latitude),
  );
}

function longitudeToTileX(
  longitude: number,
  zoom: number,
): number {
  const tileCount = 2 ** zoom;

  return Math.floor(
    ((longitude + 180) / 360) *
      tileCount,
  );
}

function latitudeToTileY(
  latitude: number,
  zoom: number,
): number {
  const safeLatitude =
    clampLatitude(latitude);

  const latitudeRadians =
    (safeLatitude * Math.PI) / 180;

  const tileCount = 2 ** zoom;

  return Math.floor(
    (
      1 -
      Math.log(
        Math.tan(latitudeRadians) +
          1 /
            Math.cos(
              latitudeRadians,
            ),
      ) /
        Math.PI
    ) /
      2 *
      tileCount,
  );
}

function tileYToLatitude(
  tileY: number,
  zoom: number,
): number {
  const tileCount = 2 ** zoom;

  const mercatorY =
    Math.PI *
    (1 - (2 * tileY) / tileCount);

  return (
    (Math.atan(
      Math.sinh(mercatorY),
    ) *
      180) /
    Math.PI
  );
}

function getMountainTileBounds(
  tileX: number,
  tileY: number,
  zoom: number,
):  MountainLoadBounds{
  const tileCount = 2 ** zoom;

  const west =
    (tileX / tileCount) * 360 - 180;

  const east =
    ((tileX + 1) / tileCount) * 360 -
    180;

  const north = tileYToLatitude(
    tileY,
    zoom,
  );

  const south = tileYToLatitude(
    tileY + 1,
    zoom,
  );

  return {
    west,
    south,
    east,
    north,
  };
}

function getMountainTilesForBounds(
  bounds: MountainLoadBounds,
  minimumHeight: number,
  zoom: number,
): MountainTile[] {

  const minimumTileX =
    longitudeToTileX(
      bounds.west,
      zoom,
    );

  const maximumTileX =
    longitudeToTileX(
      bounds.east,
      zoom,
    );

  const minimumTileY =
    latitudeToTileY(
      bounds.north,
      zoom,
    );

  const maximumTileY =
    latitudeToTileY(
      bounds.south,
      zoom,
    );

  const tiles: MountainTile[] = [];

  for (
    let tileX = minimumTileX;
    tileX <= maximumTileX;
    tileX += 1
  ) {
    for (
      let tileY = minimumTileY;
      tileY <= maximumTileY;
      tileY += 1
    ) {
      tiles.push({
        key: [
          minimumHeight,
          zoom,
          tileX,
          tileY,
        ].join(":"),

        x: tileX,
        y: tileY,
        zoom,

        bounds: getMountainTileBounds(
          tileX,
          tileY,
          zoom,
        ),
      });
    }
  }

  return tiles;
}
function getLodResultLimit(
  mapZoom: number,
): number {
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


function getLodMinimumHeight(
  mapZoom: number,
  userMinimumHeight: number,
): number {
  if (mapZoom < 5) {
    return Math.max(
      userMinimumHeight,
      2500,
    );
  }

  if (mapZoom < 7) {
    return Math.max(
      userMinimumHeight,
      1800,
    );
  }

  if (mapZoom < 9) {
    return Math.max(
      userMinimumHeight,
      1200,
    );
  }

  return userMinimumHeight;
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
}: UseMountainMapParams) {
const loadedBoundsRef =
  useRef< MountainLoadBounds| null>(null);

const loadedMinHeightRef =
  useRef<number | null>(null);

const loadedResultLimitRef =
  useRef<number | null>(null);

function isCurrentViewInsideLoadedBounds(
  map: Map,
): boolean {
  const loadedBounds =
    loadedBoundsRef.current;

  if (!loadedBounds) {
    return false;
  }

  const currentBounds =
    map.getBounds();

  return (
    currentBounds.getWest() >= loadedBounds.west &&
    currentBounds.getSouth() >= loadedBounds.south &&
    currentBounds.getEast() <= loadedBounds.east &&
    currentBounds.getNorth() <= loadedBounds.north
  );
}

const mountainLoadVersionRef =
  useRef(0);

  const mountainAbortControllerRef =
  useRef<AbortController | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = createMountainMap(
      mapContainerRef.current,
    );

    let loadTimeout: ReturnType<
      typeof setTimeout
    > | null = null;



const refreshVisibleMountains = async () => {
  

  const loadVersion =
    ++mountainLoadVersionRef.current;

  const currentBounds =
    map.getBounds();

 const longitudeSpan =
  currentBounds.getEast() -
  currentBounds.getWest();

const latitudeSpan =
  currentBounds.getNorth() -
  currentBounds.getSouth();

const longitudeBuffer =
  longitudeSpan * 0.25;

const latitudeBuffer =
  latitudeSpan * 0.25;

const requestedBounds: MountainLoadBounds = {
  west:
    currentBounds.getWest() -
    longitudeBuffer,
  south:
    currentBounds.getSouth() -
    latitudeBuffer,
  east:
    currentBounds.getEast() +
    longitudeBuffer,
  north:
    currentBounds.getNorth() +
    latitudeBuffer,
};

  const mapZoom =
    map.getZoom();

  const effectiveMinimumHeight =
  getLodMinimumHeight(
    mapZoom,
    minHeightRef.current,
  );

  const resultLimit =
  getLodResultLimit(mapZoom);

  const canReuseLoadedData =
  isCurrentViewInsideLoadedBounds(map) &&
  loadedMinHeightRef.current ===
    effectiveMinimumHeight &&
  loadedResultLimitRef.current ===
    resultLimit;

if (canReuseLoadedData) {
 

  setMountainDataVersion(
    (currentVersion: number) =>
      currentVersion + 1,
  );

  return;
}

mountainAbortControllerRef.current?.abort();

const abortController =
  new AbortController();

mountainAbortControllerRef.current =
  abortController;

  const geoJson =
    await loadVisibleMountains({
      bounds: requestedBounds,
      minHeight: effectiveMinimumHeight,
      mapZoom,
      resultLimit,
      supabaseClient,
      signal: abortController.signal,
    });

    if (
  loadVersion !==
  mountainLoadVersionRef.current
) {
  return;
}

if (!geoJson) {
  return;
}

loadedBoundsRef.current =
  requestedBounds;

  loadedMinHeightRef.current =
  effectiveMinimumHeight;

loadedResultLimitRef.current =
  resultLimit;

originalGeoJsonRef.current =
  geoJson;

setMountainDataVersion(
  (currentVersion: number) =>
    currentVersion + 1,
);

setVisiblePeakCount(
  geoJson.features.length,
);
};

    const reloadVisibleMountains = () => {
      if (loadTimeout) {
        clearTimeout(loadTimeout);
      }

      loadTimeout = setTimeout(() => {
       void refreshVisibleMountains();
      }, 300);
    };

    map.on("load", async () => {
      try {
        await initializeMap({
          map,
          minHeight: minHeightRef.current,
          supabaseClient,
          originalGeoJsonRef,
          setVisiblePeakCount,
          setLoadingMessage,
          loadClimbedMountains,

          onPeakSelect: (peak) => {
            setSelectedPeak(peak);
            setSelectedPeakClimbed(false);
          },

          onPeakAscentCheck: (peakId) => {
            void checkSelectedPeakAscent(peakId);
          },
        });

        map.on(
          "moveend",
          reloadVisibleMountains,
        );

        map.on(
          "zoomend",
          reloadVisibleMountains,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Неизвестная ошибка";

        console.error(error);
        setLoadingMessage(`Ошибка: ${message}`);
      }
    });

    mapRef.current = map;

    return () => {
      map.off(
        "moveend",
        reloadVisibleMountains,
      );

      map.off(
        "zoomend",
        reloadVisibleMountains,
      );

      if (loadTimeout) {
        clearTimeout(loadTimeout);
      }
  map.remove();
  mapRef.current = null;
};
}, []);
}