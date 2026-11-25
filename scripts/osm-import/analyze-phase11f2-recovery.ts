import { readFile, writeFile } from "node:fs/promises";
import { calculateCoordinateDistanceMeters } from "./peak-matcher.ts";
import { loadLocatedRoutePbf } from "./phase11f2-route-locations.ts";
import type { FeatureRecord } from "./build-phase11f2-feature-index.ts";

interface ClassifiedRoute {
  sourceRelationId: string;
  routeName: string;
  startCoordinate: [number, number];
  summitCoordinate: [number, number];
  summitElevationMeters: number | null;
  distanceMeters: number;
  startContext: {
    type: string;
    reasons: string[];
    nearbyFeatures: Array<{ featureType: string; osmid: string; name: string | null; coordinate: [number, number]; distanceMeters: number; tags: Record<string, string> }>;
  };
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadFeatures(path: string): Promise<FeatureRecord[]> {
  try {
    return await json<FeatureRecord[]>(path);
  } catch {
    return [];
  }
}

async function main() {
  const classification = await json<{ routes: ClassifiedRoute[] }>(
    "data/osm/alps/staging/phase11f1-start-context-classification.json",
  );
  const { nodes } = await loadLocatedRoutePbf();

  const alpineHuts = await loadFeatures("data/osm/alps/staging/phase11f2-features/alpine-huts.json");
  const wildernessHuts = await loadFeatures("data/osm/alps/staging/phase11f2-features/wilderness-huts.json");
  const parking = await loadFeatures("data/osm/alps/staging/phase11f2-features/parking.json");
  const villages = await loadFeatures("data/osm/alps/staging/phase11f2-features/villages.json");
  const hamlets = await loadFeatures("data/osm/alps/staging/phase11f2-features/hamlets.json");

  const ambiguous = classification.routes.filter((r) => r.startContext.type === "AMBIGUOUS_START");
  console.log("AMBIGUOUS:", ambiguous.length);

  // For each ambiguous route, find recoverable signals
  interface Row {
    relationId: string;
    routeName: string;
    nearestHut: { type: string; dist: number; osm: string; name: string | null } | null;
    nearestParking: { dist: number; osm: string; name: string | null } | null;
    endpointNodeEle: number | null;
    verticalGain: number | null;
    nearestSettlement: { dist: number; name: string | null } | null;
  }
  const rows: Row[] = [];
  for (const r of ambiguous) {
    const start = r.startCoordinate;
    // nearest hut (node or way)
    let nearestHut: Row["nearestHut"] = null;
    for (const hutList of [
      { type: "alpine", list: alpineHuts },
      { type: "wilderness", list: wildernessHuts },
    ]) {
      for (const h of hutList.list) {
        if (!h.coordinate) continue;
        const d = calculateCoordinateDistanceMeters(start, h.coordinate);
        if (!nearestHut || d < nearestHut.dist) {
          nearestHut = { type: hutList.type, dist: d, osm: h.osmid, name: h.name };
        }
      }
    }
    // nearest parking
    let nearestParking: Row["nearestParking"] = null;
    for (const p of parking) {
      if (!p.coordinate) continue;
      const d = calculateCoordinateDistanceMeters(start, p.coordinate);
      if (!nearestParking || d < nearestParking.dist) {
        nearestParking = { dist: d, osm: p.osmid, name: p.name };
      }
    }
    // nearest settlement
    let nearestSettlement: Row["nearestSettlement"] = null;
    for (const list of [villages, hamlets]) {
      for (const s of list) {
        if (!s.coordinate) continue;
        const d = calculateCoordinateDistanceMeters(start, s.coordinate);
        if (!nearestSettlement || d < nearestSettlement.dist) {
          nearestSettlement = { dist: d, name: s.name };
        }
      }
    }
    // endpoint node ele - find nearest node with ele to start coordinate
    let endpointNodeEle: number | null = null;
    let bestNodeDist = Infinity;
    for (const node of nodes.values()) {
      if (node.ele === null) continue;
      const d = calculateCoordinateDistanceMeters(start, node.coordinate);
      if (d < bestNodeDist) {
        bestNodeDist = d;
        endpointNodeEle = node.ele;
      }
    }
    const verticalGain =
      endpointNodeEle !== null && r.summitElevationMeters !== null
        ? r.summitElevationMeters - endpointNodeEle
        : null;

    rows.push({
      relationId: r.sourceRelationId,
      routeName: r.routeName,
      nearestHut,
      nearestParking,
      endpointNodeEle,
      verticalGain,
      nearestSettlement,
    });
  }

  const output = {
    ambiguousCount: ambiguous.length,
    rows,
  };
  await writeFile(
    "data/osm/alps/staging/phase11f2-ambiguous-recovery-diagnostic.json",
    JSON.stringify(output, null, 2),
  );

  // Summaries
  const hutNear = rows.filter((r) => r.nearestHut && r.nearestHut.dist <= 200).length;
  const elevationFound = rows.filter((r) => r.endpointNodeEle !== null).length;
  const parkingNear = rows.filter((r) => r.nearestParking && r.nearestParking.dist <= 300).length;
  const settlementNear = rows.filter((r) => r.nearestSettlement && r.nearestSettlement.dist <= 500).length;
  console.log("HUT within 200m (node or way):", hutNear);
  console.log("Endpoint node ele found:", elevationFound);
  console.log("Parking within 300m:", parkingNear);
  console.log("Settlement within 500m:", settlementNear);
  console.log(`\nWritten to data/osm/alps/staging/phase11f2-ambiguous-recovery-diagnostic.json`);
}

await main();
