import maplibregl, { type Map } from "maplibre-gl";

import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
} from "./constants";

export function createMountainMap(
  container: HTMLDivElement,
): Map {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        opentopomap: {
          type: "raster",
          tiles: [
            "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
            "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
            "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          minzoom: 0,
          maxzoom: 17,
          attribution:
            "Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)",
        },
      },
      layers: [
        {
          id: "opentopomap",
          type: "raster",
          source: "opentopomap",
        },
      ],
    },
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
  });

  map.addControl(
    new maplibregl.NavigationControl(),
    "top-right",
  );

  return map;
}