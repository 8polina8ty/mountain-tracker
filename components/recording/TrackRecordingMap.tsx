"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import GpsTrackRecorderPanel from "@/components/MountainMap/GpsTrackRecorderPanel";
import { createMountainMap } from "@/components/MountainMap/createMountainMap";
import { normalizeGpsPosition } from "@/components/MountainMap/useMountainMap";
import {
  USER_RECORDED_TRACK_LINE_LAYER_ID,
  USER_RECORDED_TRACK_SOURCE_ID,
  addTrackRecordingLayers,
  synchronizeTrackRecordingSources,
  updateUserLocation,
} from "@/components/MountainMap/trackRecordingLayers";
import { buildTrackLineGeoJson, getVisualPosition } from "@/components/MountainMap/trackRecording";
import { useGpsTrackRecorder } from "@/components/MountainMap/useGpsTrackRecorder";
import type { UserGpsPosition } from "@/components/MountainMap/types";

export default function TrackRecordingMap() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);

  const [gpsPosition, setGpsPosition] = useState<UserGpsPosition | null>(null);

  const gpsTrackRecorder = useGpsTrackRecorder();
  const acceptGpsPosition = gpsTrackRecorder.acceptGpsPosition;
  const acceptGpsError = gpsTrackRecorder.acceptGpsError;

  const recordedTrackGeoJson = useMemo(
    () => buildTrackLineGeoJson(gpsTrackRecorder.state.points),
    [gpsTrackRecorder.state.points],
  );

  const previewTrackGeoJson = useMemo(
    () => buildTrackLineGeoJson(gpsTrackRecorder.state.previewPoints),
    [gpsTrackRecorder.state.previewPoints],
  );
  const recordedTrackGeoJsonRef = useRef(recordedTrackGeoJson);
  const previewTrackGeoJsonRef = useRef(previewTrackGeoJson);

  useEffect(() => {
    recordedTrackGeoJsonRef.current = recordedTrackGeoJson;
    previewTrackGeoJsonRef.current = previewTrackGeoJson;
  }, [recordedTrackGeoJson, previewTrackGeoJson]);

  useEffect(() => {
    const container = mapContainer.current;

    if (!container || mapRef.current) {
      return;
    }

    const { map, geolocateControl } = createMountainMap(container, {
      showUserLocation: false,
    });

    const handleGeolocate = (event: unknown) => {
      const position = event as unknown as GeolocationPosition;
      const normalized = normalizeGpsPosition(position);

      setGpsPosition(normalized);
      acceptGpsPosition(normalized);
    };

    const handleGeolocateError = () => {
      acceptGpsError();
    };

    const handleMapError = () => {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[record-map] MapLibre error", {
          styleLoaded: map.isStyleLoaded(),
          sourceExists: Boolean(map.getSource(USER_RECORDED_TRACK_SOURCE_ID)),
          layerExists: Boolean(map.getLayer(USER_RECORDED_TRACK_LINE_LAYER_ID)),
        });
      }
    };

    const synchronizeSources = () => {
      synchronizeTrackRecordingSources(
        map,
        recordedTrackGeoJsonRef.current,
        previewTrackGeoJsonRef.current,
      );
    };

    geolocateControl.on("geolocate", handleGeolocate);
    geolocateControl.on("error", handleGeolocateError);
    map.on("load", synchronizeSources);
    map.on("style.load", synchronizeSources);
    map.on("error", handleMapError);

    mapRef.current = map;

    if (map.isStyleLoaded()) {
      synchronizeSources();
    }

    return () => {
      geolocateControl.off("geolocate", handleGeolocate);
      geolocateControl.off("error", handleGeolocateError);
      map.off("load", synchronizeSources);
      map.off("style.load", synchronizeSources);
      map.off("error", handleMapError);
      map.remove();
      mapRef.current = null;
    };
  }, [acceptGpsError, acceptGpsPosition]);

  // Update visual user-location dot based on movement state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    addTrackRecordingLayers(map);

    const visualPosition = getVisualPosition(
      gpsTrackRecorder.state,
      gpsPosition,
    );

    if (visualPosition !== null) {
      updateUserLocation(
        map,
        visualPosition.latitude,
        visualPosition.longitude,
        visualPosition.accuracyM,
      );
    }
  }, [gpsTrackRecorder.state, gpsPosition]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    synchronizeTrackRecordingSources(
      map,
      recordedTrackGeoJson,
      previewTrackGeoJson,
    );
  }, [recordedTrackGeoJson, previewTrackGeoJson]);

  return (
    <div className="mountain-map-shell relative w-full overflow-hidden">
      <div ref={mapContainer} className="h-full w-full" />

      <div className="absolute inset-x-0 bottom-0 z-20 pb-[env(safe-area-inset-bottom)] lg:inset-x-auto lg:bottom-auto lg:right-3 lg:top-[6.5rem] lg:w-[400px] lg:pb-0">
        <GpsTrackRecorderPanel
          recorder={gpsTrackRecorder}
          latestGpsPosition={gpsPosition}
        />
      </div>
    </div>
  );
}
