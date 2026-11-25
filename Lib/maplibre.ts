import { Map, setWorkerUrl, type MapOptions } from "maplibre-gl";

let workerConfigured = false;

export function createMapLibreMap(options: MapOptions): Map {
  if (!workerConfigured) {
    setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
    workerConfigured = true;
  }

  return new Map(options);
}
