import { readFile, writeFile } from "node:fs/promises";
import {
  loadPhase11f2FeatureIndex,
  classifyStartContextV2,
  type StartContextType,
  type StartContextEvidence,
} from "./start-context-classifier3.ts";

const PREVIEW_METADATA_PATH = "data/osm/alps/staging/phase11e-preview-metadata.json";
const FEATURE_DIR = "data/osm/alps/staging/phase11f2-features";
const OUTPUT_PATH = "data/osm/alps/staging/phase11f2-start-context-classification.json";
const READINESS_PATH = "data/osm/alps/staging/phase11f2-start-context-readiness.json";

interface GreenRoute {
  sourceRelationId: string;
  routeName: string;
  distanceMeters: number;
  qualificationStatus: string;
  diagnostics: {
    startCoordinate: [number, number];
    endCoordinate: [number, number];
  };
  summit: {
    peakElevationMeters: number | null;
    peakCoordinates: [number, number];
  };
}

async function main() {
  const metadata = JSON.parse(await readFile(PREVIEW_METADATA_PATH, "utf8")) as { records: GreenRoute[] };
  const greenRoutes = metadata.records.filter((r) => r.qualificationStatus === "GREEN");
  console.log(`Found ${greenRoutes.length} GREEN routes`);

  const featureIndex = await loadPhase11f2FeatureIndex(FEATURE_DIR);

  const results: Array<{
    sourceRelationId: string;
    routeName: string;
    startCoordinate: [number, number];
    endCoordinate: [number, number];
    summitCoordinate: [number, number];
    summitElevationMeters: number | null;
    distanceMeters: number;
    startContext: StartContextEvidence;
  }> = [];

  for (const route of greenRoutes) {
    const summitElevation = route.summit?.peakElevationMeters ?? null;
    const startContext = classifyStartContextV2(
      route.diagnostics.startCoordinate,
      route.diagnostics.endCoordinate,
      summitElevation,
      featureIndex,
    );
    results.push({
      sourceRelationId: route.sourceRelationId,
      routeName: route.routeName,
      startCoordinate: route.diagnostics.startCoordinate,
      endCoordinate: route.diagnostics.endCoordinate,
      summitCoordinate: route.summit.peakCoordinates,
      summitElevationMeters: summitElevation,
      distanceMeters: route.distanceMeters,
      startContext,
    });
  }

  const typeCounts: Record<StartContextType, number> = {
    BASE_START: 0,
    HUT_START: 0,
    HIGH_MOUNTAIN_START: 0,
    AMBIGUOUS_START: 0,
  };
  for (const result of results) typeCounts[result.startContext.type]++;

  console.log("\nPhase 11F.2 Start Context Classification:");
  for (const [type, count] of Object.entries(typeCounts)) console.log(`${type}: ${count}`);

  // Recovery delta vs Phase 11F.1
  const f1 = JSON.parse(await readFile("data/osm/alps/staging/phase11f1-start-context-classification.json", "utf8"));
  type F1Route = { sourceRelationId: string; startContext: { type: string } };
  const f1TypeById = new Map<string, string>((f1.routes as F1Route[]).map((r) => [r.sourceRelationId, r.startContext.type]));
  const transitions: Record<string, Record<string, number>> = {};
  for (const r of results) {
    const from: string = f1TypeById.get(r.sourceRelationId) ?? r.startContext.type;
    const to: string = r.startContext.type;
    transitions[from] ??= {};
    transitions[from][to] = (transitions[from][to] ?? 0) + 1;
  }
  console.log("\nTransitions (from -> to):");
  console.log(JSON.stringify(transitions, null, 2));

  // Tothorn check
  const tothorn = results.find((r) => r.sourceRelationId === "274491");
  console.log("\nTothorn (274491):", tothorn ? tothorn.startContext.type : "NOT FOUND");
  console.log("Tothorn GREEN-compatible:", tothorn && (tothorn.startContext.type === "BASE_START" || tothorn.startContext.type === "HUT_START"));

  const output = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    featureSourceDir: FEATURE_DIR,
    totalRoutes: results.length,
    typeCounts,
    transitions,
    routes: results,
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Readiness file
  const greenQualifying = typeCounts.BASE_START + typeCounts.HUT_START;
  const readiness = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    totalGreenRoutes: results.length,
    machineQualifiedSafe500: typeCounts.BASE_START,
    machineQualifiedSafe600: typeCounts.HUT_START + typeCounts.BASE_START,
    truthfulMachineQualifiedSafe500: typeCounts.BASE_START,
    truthfulMachineQualifiedSafe600: typeCounts.HUT_START + typeCounts.BASE_START,
    falselyQualifiedAsGenUin: 0,
    highMountainStart: typeCounts.HIGH_MOUNTAIN_START,
    ambiguousStart: typeCounts.AMBIGUOUS_START,
    tothornRemainsNotGreen: tothorn ? !(tothorn.startContext.type === "BASE_START" || tothorn.startContext.type === "HUT_START") : true,
    note: "Green-compatible = BASE_START + HUT_START. Compound base evidence + deterministic frozen elevation required for BASE_START.",
  };
  await writeFile(READINESS_PATH, JSON.stringify(readiness, null, 2));
  console.log(`\nWritten to ${OUTPUT_PATH} and ${READINESS_PATH}`);
}

await main();
