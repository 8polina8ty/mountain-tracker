import type { GeoJSONSource, Map } from "maplibre-gl";

export const USER_RECORDED_TRACK_SOURCE_ID =
  "user-recorded-track";

export const USER_RECORDED_TRACK_CASING_LAYER_ID =
  "user-recorded-track-casing";

export const USER_RECORDED_TRACK_LINE_LAYER_ID =
  "user-recorded-track-line";

export const USER_RECORDED_PREVIEW_SOURCE_ID =
  "user-recorded-preview";

export const USER_RECORDED_PREVIEW_LINE_LAYER_ID =
  "user-recorded-preview-line";

export const USER_LOCATION_SOURCE_ID = "user-location";
export const USER_LOCATION_ACCURACY_SOURCE_ID = "user-location-accuracy";

export const USER_LOCATION_LAYER_ID = "user-location-point";
export const USER_LOCATION_ACCURACY_LAYER_ID = "user-location-accuracy-fill";
export const USER_LOCATION_ACCURACY_BOUNDARY_LAYER_ID = "user-location-accuracy-boundary";

const TRACK_CASING_COLOR = "#ffffff";
const TRACK_LINE_COLOR = "#e5481d";
const PREVIEW_LINE_COLOR = "#1565c0";
const PREVIEW_LINE_WIDTH = 3;
const PREVIEW_LINE_OPACITY = 0.5;
const USER_LOCATION_COLOR = "#1565c0";
const USER_LOCATION_ACCURACY_COLOR = "rgba(21, 101, 192, 0.15)";
const USER_LOCATION_ACCURACY_BOUNDARY_COLOR = "rgba(21, 101, 192, 0.3)";

type SynchronizationDiagnostics = {
  confirmedPointCount: number;
  setDataCallCount: number;
};

const synchronizationDiagnostics = new WeakMap<Map, SynchronizationDiagnostics>();

export function addTrackRecordingLayers(map: Map) {
  if (!map.getSource(USER_RECORDED_TRACK_SOURCE_ID)) {
    map.addSource(USER_RECORDED_TRACK_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getSource(USER_RECORDED_PREVIEW_SOURCE_ID)) {
    map.addSource(USER_RECORDED_PREVIEW_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getSource(USER_LOCATION_SOURCE_ID)) {
    map.addSource(USER_LOCATION_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getSource(USER_LOCATION_ACCURACY_SOURCE_ID)) {
    map.addSource(USER_LOCATION_ACCURACY_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getLayer(USER_LOCATION_ACCURACY_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_LOCATION_ACCURACY_LAYER_ID,
        type: "fill",
        source: USER_LOCATION_ACCURACY_SOURCE_ID,
        paint: {
          "fill-color": USER_LOCATION_ACCURACY_COLOR,
          "fill-opacity": 0.5,
        },
      },
    );
  }

  if (!map.getLayer(USER_LOCATION_ACCURACY_BOUNDARY_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_LOCATION_ACCURACY_BOUNDARY_LAYER_ID,
        type: "line",
        source: USER_LOCATION_ACCURACY_SOURCE_ID,
        paint: {
          "line-color": USER_LOCATION_ACCURACY_BOUNDARY_COLOR,
          "line-width": 1,
          "line-opacity": 0.5,
        },
      },
    );
  }

  if (!map.getLayer(USER_RECORDED_PREVIEW_LINE_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_RECORDED_PREVIEW_LINE_LAYER_ID,
        type: "line",
        source: USER_RECORDED_PREVIEW_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: "visible",
        },
        paint: {
          "line-color": PREVIEW_LINE_COLOR,
          "line-width": PREVIEW_LINE_WIDTH,
          "line-opacity": PREVIEW_LINE_OPACITY,
          "line-dasharray": [2, 2],
        },
      },
    );
  }

  if (!map.getLayer(USER_RECORDED_TRACK_CASING_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_RECORDED_TRACK_CASING_LAYER_ID,
        type: "line",
        source: USER_RECORDED_TRACK_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: "visible",
        },
        paint: {
          "line-color": TRACK_CASING_COLOR,
          "line-width": 10,
          "line-opacity": 0.95,
        },
      },
    );
  }

  if (!map.getLayer(USER_RECORDED_TRACK_LINE_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_RECORDED_TRACK_LINE_LAYER_ID,
        type: "line",
        source: USER_RECORDED_TRACK_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          visibility: "visible",
        },
        paint: {
          "line-color": TRACK_LINE_COLOR,
          "line-width": 6,
          "line-opacity": 1,
        },
      },
    );
  }

  if (!map.getLayer(USER_LOCATION_LAYER_ID)) {
    map.addLayer(
      {
        id: USER_LOCATION_LAYER_ID,
        type: "circle",
        source: USER_LOCATION_SOURCE_ID,
        paint: {
          "circle-radius": 8,
          "circle-color": USER_LOCATION_COLOR,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      },
    );
  }

  ensureTrackRecordingLayerOrder(map);
}

export function ensureTrackRecordingLayerOrder(map: Map): void {
  const orderedLayerIds = [
    USER_LOCATION_ACCURACY_LAYER_ID,
    USER_LOCATION_ACCURACY_BOUNDARY_LAYER_ID,
    USER_RECORDED_PREVIEW_LINE_LAYER_ID,
    USER_RECORDED_TRACK_CASING_LAYER_ID,
    USER_RECORDED_TRACK_LINE_LAYER_ID,
    USER_LOCATION_LAYER_ID,
  ];

  for (const layerId of orderedLayerIds) {
    if (map.getLayer(layerId)) {
      map.moveLayer(layerId);
    }
  }
}

export function synchronizeTrackRecordingSources(
  map: Map,
  confirmedTrack: GeoJSON.FeatureCollection,
  previewTrack: GeoJSON.FeatureCollection,
): boolean {
  if (!map.isStyleLoaded()) {
    return false;
  }

  addTrackRecordingLayers(map);

  const confirmedSource = map.getSource(USER_RECORDED_TRACK_SOURCE_ID);
  const previewSource = map.getSource(USER_RECORDED_PREVIEW_SOURCE_ID);

  if (
    !confirmedSource ||
    !("setData" in confirmedSource) ||
    typeof confirmedSource.setData !== "function" ||
    !previewSource ||
    !("setData" in previewSource) ||
    typeof previewSource.setData !== "function"
  ) {
    return false;
  }

  confirmedSource.setData(confirmedTrack);
  previewSource.setData(previewTrack);

  if (process.env.NODE_ENV !== "production") {
    const confirmedFeature = confirmedTrack.features[0];
    const confirmedPointCount =
      confirmedFeature?.geometry.type === "LineString"
        ? confirmedFeature.geometry.coordinates.length
        : 0;
    const previous = synchronizationDiagnostics.get(map);
    const next = {
      confirmedPointCount,
      setDataCallCount: (previous?.setDataCallCount ?? 0) + 1,
    };
    synchronizationDiagnostics.set(map, next);

    if (previous?.confirmedPointCount !== confirmedPointCount) {
      console.debug("[record-map] confirmed track synchronization", {
        confirmedPointCount,
        confirmedFeatureCount: confirmedTrack.features.length,
        sourceExists: true,
        layerExists: Boolean(map.getLayer(USER_RECORDED_TRACK_LINE_LAYER_ID)),
        setDataCallCount: next.setDataCallCount,
        styleLoaded: map.isStyleLoaded(),
      });
    }
  }

  return true;
}

export function updateUserLocation(
  map: Map,
  latitude: number,
  longitude: number,
  accuracyM: number | null,
): void {
  const pointSource = map.getSource(USER_LOCATION_SOURCE_ID) as
    | GeoJSONSource
    | undefined;

  const accuracySource = map.getSource(USER_LOCATION_ACCURACY_SOURCE_ID) as
    | GeoJSONSource
    | undefined;

  if (!pointSource || !accuracySource) {
    return;
  }

  // Single point feature for the user location dot
  pointSource.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [longitude, latitude],
        },
        properties: {},
      },
    ],
  });

  // Accuracy polygon as a separate feature for fill layer
  if (accuracyM !== null && accuracyM > 0 && isFinite(accuracyM)) {
    // Clamp absurdly large accuracy for visual safety (max 500m)
    const clampedAccuracyM = Math.min(accuracyM, 500);
    const radiusDeg = clampedAccuracyM / 111320; // approximate degrees per meter at equator
    const points = 32;
    const coords: number[][] = [];

    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * 2 * Math.PI;
      coords.push([
        longitude + radiusDeg * Math.cos(angle),
        latitude + radiusDeg * Math.sin(angle),
      ]);
    }

    accuracySource.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [coords],
          },
          properties: {},
        },
      ],
    });
  } else {
    // Clear accuracy when not available
    accuracySource.setData({
      type: "FeatureCollection",
      features: [],
    });
  }
}
