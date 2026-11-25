import { readFile } from "node:fs/promises";
import { calculateCoordinateDistanceMeters } from "./peak-matcher.ts";

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
interface FeatureRecord {
  objectType: string;
  osmid: string;
  name: string | null;
  tags: Record<string, string>;
  coordinate: [number, number] | null;
}
interface ClassifiedRoute {
  sourceRelationId: string;
  routeName: string;
  startCoordinate: [number, number];
  summitElevationMeters: number | null;
  startContext: {
    type: string;
    nearbyFeatures: Array<{ featureType: string; distanceMeters: number }>;
  };
}

const saddles = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f1-features/saddles.json");
const mountainPasses = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f1-features/mountain-passes.json");
const classification = await json<{ routes: ClassifiedRoute[] }>(
  "data/osm/alps/staging/phase11f1-start-context-classification.json",
);

function nearestHigh(start: [number, number]): { featureType: string; dist: number } | null {
  let best: { featureType: string; dist: number } | null = null;
  for (const [t, list] of [["saddle", saddles], ["mountain_pass", mountainPasses]] as const) {
    for (const h of list) {
      if (!h.coordinate) continue;
      const d = calculateCoordinateDistanceMeters(start, h.coordinate);
      if (!best || d < best.dist) best = { featureType: t, dist: d };
    }
  }
  return best;
}

const high = classification.routes.filter((r) => r.startContext.type === "HIGH_MOUNTAIN_START");
console.log("=== HIGH routes: nearest saddle/pass ===");
let allHighHaveHigh = true;
for (const r of high) {
  const hn = nearestHigh(r.startCoordinate);
  const within500 = hn && hn.dist <= 500;
  if (!within500) { allHighHaveHigh = false; console.log("  HIGH but no saddle/pass<=500m:", r.sourceRelationId, r.routeName, hn ? Math.round(hn.dist) + "m " + hn.featureType : "none"); }
}
console.log("All HIGH have saddle/pass<=500m:", allHighHaveHigh);
