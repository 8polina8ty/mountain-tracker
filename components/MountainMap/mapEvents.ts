import type { GeoJSONSource, Map } from "maplibre-gl";

import type { PeakProperties, SelectedPeak } from "./types";

type RegisterMapEventsOptions = {
  map: Map;
  onPeakSelect: (peak: SelectedPeak) => void;
  onPeakAscentCheck: (peakId: number) => void;
};

export function registerMapEvents({
  map,
  onPeakSelect,
  onPeakAscentCheck,
}: RegisterMapEventsOptions) {
  map.on("click", "clusters", async (event) => {
    const feature = map.queryRenderedFeatures(event.point, {
      layers: ["clusters"],
    })[0];

    if (!feature || feature.geometry.type !== "Point") {
      return;
    }

    const clusterId = Number(feature.properties?.cluster_id);
    const source = map.getSource("peaks") as GeoJSONSource | undefined;

    if (!source || Number.isNaN(clusterId)) {
      return;
    }

    const zoom = await source.getClusterExpansionZoom(clusterId);

    map.easeTo({
      center: [
        feature.geometry.coordinates[0],
        feature.geometry.coordinates[1],
      ],
      zoom,
    });
  });

  map.on("click", "individual-peaks", (event) => {
    const feature = event.features?.[0];

    if (!feature || feature.geometry.type !== "Point") {
      return;
    }

    const properties = feature.properties as PeakProperties;
    const [longitude, latitude] = feature.geometry.coordinates;

    onPeakSelect({
      ...properties,
      longitude,
      latitude,
    });

    onPeakAscentCheck(Number(properties.id));
  });

  for (const layerId of ["clusters", "individual-peaks"]) {
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }
}