import type { Map } from "maplibre-gl";

export function addMountainSource(map: Map) {
  if (map.getSource("peaks")) {
    return;
  }

  map.addSource("peaks", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [],
    },
    cluster: true,
    clusterMaxZoom: 10,
    clusterRadius: 45,
    clusterProperties: {
      maxHeight: ["max", ["get", "height"]],
    },
  });
}