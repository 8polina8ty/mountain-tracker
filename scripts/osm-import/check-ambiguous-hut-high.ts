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
const alpineHuts = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/alpine-huts.json");
const wildernessHuts = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/wilderness-huts.json");
const saddles = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/saddles.json").catch(() => []);
const passes = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/mountain-passes.json").catch(() => []);
const ridges = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f2-features/ridges.json").catch(() => []);

const diagnostic = await json<{ rows: Array<{ relationId: string; nearestHut: { dist: number } | null }> }>(
  "data/osm/alps/staging/phase11f2-ambiguous-recovery-diagnostic.json",
);
const hutRows = diagnostic.rows.filter((r) => r.nearestHut && r.nearestHut.dist <= 200);
console.log("HUT candidate ambiguous routes:", hutRows.length);

// Load classification to get start coords
const classification = await json<{ routes: Array<{ sourceRelationId: string; startCoordinate: [number, number] }> }>(
  "data/osm/alps/staging/phase11f1-start-context-classification.json",
);
const startById = new Map(classification.routes.map((r) => [r.sourceRelationId, r.startCoordinate]));

// Also need mountain passes / saddles for HIGH detection - use f1 features (node) + check
const f1Saddles = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f1-features/saddles.json");
const f1Passes = await json<FeatureRecord[]>("data/osm/alps/staging/phase11f1-features/mountain-passes.json");

function nearestHigh(start: [number, number]): { ft: string; d: number } | null {
  let best: { ft: string; d: number } | null = null;
  for (const [t, list] of [["saddle", f1Saddles], ["mountain_pass", f1Passes]] as const) {
    for (const h of list) {
      if (!h.coordinate) continue;
      const d = calculateCoordinateDistanceMeters(start, h.coordinate);
      if (!best || d < best.d) best = { ft: t, d };
    }
  }
  return best;
}

let withHigh500 = 0;
for (const row of hutRows) {
  const start = startById.get(row.relationId);
  if (!start) { console.log("  no start coord:", row.relationId); continue; }
  const hn = nearestHigh(start);
  if (hn && hn.d <= 500) {
    withHigh500++;
    console.log("  HUT candidate ALSO has high<=500m:", row.relationId, Math.round(hn.d) + "m " + hn.ft);
  }
}
console.log("\nHUT candidates that ALSO have saddle/pass<=500m:", withHigh500, "of", hutRows.length);
