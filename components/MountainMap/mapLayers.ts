import type { Map } from "maplibre-gl";

import { PEAK_COLORS } from "./constants";

export function addMountainLayers(map: Map) {
  if (!map.getLayer("clusters")) {
    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "peaks",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": [
          "step",
          ["get", "maxHeight"],

          PEAK_COLORS.low,
1000,
PEAK_COLORS.mediumLow,
1300,
PEAK_COLORS.medium,
1600,
PEAK_COLORS.mediumHigh,
2000,
PEAK_COLORS.high,
4000,
PEAK_COLORS.veryHigh,
6000,
PEAK_COLORS.extreme,
        ],

        "circle-radius": [
          "step",
          ["get", "point_count"],
          22,
          10,
          28,
          50,
          34,
          100,
          40,
          500,
          46,
        ],

        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  if (!map.getLayer("cluster-count")) {
    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "peaks",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-size": 14,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });
  }

  if (!map.getLayer("individual-peaks")) {
    map.addLayer({
      id: "individual-peaks",
      type: "circle",
      source: "peaks",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": [
          "step",
          ["get", "height"],

          PEAK_COLORS.low,
1000,
PEAK_COLORS.mediumLow,
1300,
PEAK_COLORS.medium,
1600,
PEAK_COLORS.mediumHigh,
2000,
PEAK_COLORS.high,
4000,
PEAK_COLORS.veryHigh,
6000,
PEAK_COLORS.extreme,
        ],

        "circle-radius": 7,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }
}