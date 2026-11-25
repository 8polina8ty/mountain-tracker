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
  startContext: { type: string };
}

const alpineHuts = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/alpine-huts.json");
const wildernessHuts = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/wilderness-huts.json");
const classification = await json<{ routes: ClassifiedRoute[] }>(
  "data/osm/alps/staging/phase11f1-start-context-classification.json",
);

function nearestHut(start: [number, number]): { type: string; dist: number; osm: string; name: string | null } | null {
  let best: { type: string; dist: number; osm: string; name: string | null } | null = null;
  for (const [t, list] of [["alpine", alpineHuts], ["wilderness", wildernessHuts]] as const) {
    for (const h of list) {
      if (!h.coordinate) continue;
      const d = calculateCoordinateDistanceMeters(start, h.coordinate);
      if (!best || d < best.dist) best = { type: t, dist: d, osm: h.osmid, name: h.name };
    }
  }
  return best;
}

const high = classification.routes.filter((r) => r.startContext.type === "HIGH_MOUNTAIN_START");
let highWithHut200 = 0;
for (const r of high) {
  const h = nearestHut(r.startCoordinate);
  if (h && h.dist <= 200) {
    highWithHut200++;
    console.log("HIGH with HUT<=200m:", r.sourceRelationId, r.routeName, "hut:", h.type, h.name, Math.round(h.dist) + "m");
  }
}
console.log("\nTotal HIGH with hut <=200m:", highWithHut200, "of", high.length);
