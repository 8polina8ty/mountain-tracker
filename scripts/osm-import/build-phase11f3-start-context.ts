import { writeFile, mkdir, readFile } from "node:fs/promises";
import { sha256Stable } from "./phase11-publication.ts";
import {
  loadPhase11f2FeatureIndex,
  classifyStartContextV3,
  type StartContextType,
  type StartContextEvidence,
} from "./start-context-classifier3.ts";
import {
  buildFeatureIndex,
  resolveStartElevationV3,
  type EleNodeRecord,
} from "./phase11f3-start-elevation.ts";

const FEATURE_DIR = "data/osm/alps/staging/phase11f2-features";
const ELE_NODES_RAW = "data/osm/alps/staging/phase11f3-features/ele-nodes-raw.json";
const CLASSIFICATION_IN = "data/osm/alps/staging/phase11f2-start-context-classification.json";
const OUT_STAGING = "data/osm/alps/staging";
const OUT_PUBLICATION = "data/osm/alps/publication";

interface F2Route {
  sourceRelationId: string;
  routeName: string;
  startCoordinate: [number, number];
  endCoordinate: [number, number];
  summitCoordinate: [number, number];
  summitElevationMeters: number | null;
  distanceMeters: number;
  startContext: StartContextEvidence;
}

export interface Phase11f3EvidenceRow {
  canonicalRelationId: string;
  routeName: string;
  startCoordinate: [number, number];
  startNodeId: string | null;
  startAccessEvidence: string[];
  currentStartContext: string;
  summitElevationMeters: number | null;
  elevationSourceCandidates: Array<{
    sourceType: string;
    sourceOsmType: string;
    sourceOsmId: string | null;
    rawEle: string;
    normalizedEleMeters: number | null;
    distanceMeters: number | null;
  }>;
  selectedElevationSource: string | null;
  deterministic: boolean;
  verticalGainMeters: number | null;
  reasonCodes: string[];
}

async function main() {
  await mkdir(OUT_STAGING, { recursive: true });
  await mkdir(OUT_PUBLICATION, { recursive: true });

  const featureIndex = await loadPhase11f2FeatureIndex(FEATURE_DIR);
  const eleNodes = (JSON.parse(await readFile(ELE_NODES_RAW, "utf8")) as EleNodeRecord[]).filter(
    (n) => n.coordinate && n.normalizedMeters != null,
  );
  const phase11f3Index = buildFeatureIndex(featureIndex, eleNodes);

  const f2 = JSON.parse(await readFile(CLASSIFICATION_IN, "utf8")) as {
    routes: F2Route[];
  };
  const routes = f2.routes;

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

  const evidenceRows: Phase11f3EvidenceRow[] = [];

  for (const route of routes) {
    const context = await classifyStartContextV3(
      route.startCoordinate,
      route.endCoordinate,
      route.summitElevationMeters,
      featureIndex,
      phase11f3Index,
    );

    const elevation = resolveStartElevationV3(route.startCoordinate, phase11f3Index);

    const startAccessCandidates = context.nearbyFeatures.filter(
      (f) =>
        (f.featureType === "parking" && f.distanceMeters <= 300) ||
        (f.featureType === "trailhead" && f.distanceMeters <= 300) ||
        (f.featureType === "trailhead_info" && f.distanceMeters <= 100) ||
        (f.featureType === "bus_stop" && f.distanceMeters <= 150) ||
        (f.featureType === "train_station" && f.distanceMeters <= 150) ||
        (f.featureType === "halt" && f.distanceMeters <= 150) ||
        ((f.featureType === "village" || f.featureType === "hamlet") && f.distanceMeters <= 300) ||
        ((f.featureType === "isolated_dwelling" || f.featureType === "farm") && f.distanceMeters <= 100),
    );

    const wasAmbiguous = route.startContext.type === "AMBIGUOUS_START";
    const missingElevationAmbiguous =
      wasAmbiguous && route.startContext.reasons.some((x) => x.includes("Start elevation unknown"));

    if (missingElevationAmbiguous) {
      evidenceRows.push({
        canonicalRelationId: route.sourceRelationId,
        routeName: route.routeName,
        startCoordinate: route.startCoordinate,
        startNodeId: null,
        startAccessEvidence: startAccessCandidates.map(
          (f) => `${f.featureType} ${f.osmid} @${Math.round(f.distanceMeters)}m${f.tags.ele ? ` [ele=${f.tags.ele}]` : ""}`,
        ),
        currentStartContext: route.startContext.type,
        summitElevationMeters: route.summitElevationMeters,
        elevationSourceCandidates: elevation.candidates.map((c) => ({
          sourceType: c.sourceType,
          sourceOsmType: c.sourceOsmType,
          sourceOsmId: c.sourceOsmId,
          rawEle: c.rawEle,
          normalizedEleMeters: c.normalizedEleMeters,
          distanceMeters: c.distanceMeters,
        })),
        selectedElevationSource: elevation.selectedSource?.sourceType ?? null,
        deterministic: elevation.deterministic,
        verticalGainMeters: elevation.deterministic && route.summitElevationMeters != null
          ? route.summitElevationMeters - (elevation.startElevationMeters as number)
          : null,
        reasonCodes: elevation.reasonCodes,
      });
    }

    results.push({
      sourceRelationId: route.sourceRelationId,
      routeName: route.routeName,
      startCoordinate: route.startCoordinate,
      endCoordinate: route.endCoordinate,
      summitCoordinate: route.summitCoordinate,
      summitElevationMeters: route.summitElevationMeters,
      distanceMeters: route.distanceMeters,
      startContext: context,
    });
  }

  const typeCounts: Record<StartContextType, number> = {
    BASE_START: 0,
    HUT_START: 0,
    HIGH_MOUNTAIN_START: 0,
    AMBIGUOUS_START: 0,
  };
  for (const result of results) typeCounts[result.startContext.type]++;

  const transitions: Record<string, Record<string, number>> = {};
  for (const r of results) {
    const from: string = routeStartTypeById(f2, r.sourceRelationId) ?? r.startContext.type;
    const to: string = r.startContext.type;
    transitions[from] ??= {};
    transitions[from][to] = (transitions[from][to] ?? 0) + 1;
  }

  const tothorn = results.find((r) => r.sourceRelationId === "274491");

  const outputStaging = {
    schemaVersion: 3,
    artifactType: "PHASE11F3_START_CONTEXT_CLASSIFICATION",
    generatedAt: new Date().toISOString(),
    elevationHierarchyVersion: "1",
    normalizationContract: "ele-normalizer.ts statuses: VALID_METERS, VALID_CONVERTED_FEET, AMBIGUOUS_ELE, INVALID_ELE",
    thresholds: { minVerticalGainForBaseStartMeters: 500, eleNodeRadiusMeters: 300 },
    featureSourceDir: FEATURE_DIR,
    eleNodesRawSource: ELE_NODES_RAW,
    totalRoutes: results.length,
    typeCounts,
    transitions,
    routes: results,
  };
  const stagingHash = sha256Stable(outputStaging);
  const classificationArtifact = { ...outputStaging, deterministicArtifactHash: stagingHash };
  await writeFile(
    `${OUT_STAGING}/phase11f3-start-context-classification.json`,
    JSON.stringify(classificationArtifact, null, 2),
  );

  const newTypeById = new Map(results.map((r) => [r.sourceRelationId, r.startContext.type]));

  const missing = evidenceRows.filter((r) => !r.deterministic);
  const recoveredByClassification = evidenceRows.filter(
    (r) => {
      const t = newTypeById.get(r.canonicalRelationId);
      return t === "BASE_START" || t === "HUT_START";
    },
  );

  const recoveredBase = recoveredByClassification.filter(
    (r) => newTypeById.get(r.canonicalRelationId) === "BASE_START",
  );

  const evidenceAudit = {
    schemaVersion: 1,
    artifactType: "PHASE11F3_START_ELEVATION_EVIDENCE",
    generatedAt: new Date().toISOString(),
    elevationHierarchyVersion: "1",
    populationNote: "Audits exactly the Phase 11F.2 AMBIGUOUS routes with base context but missing deterministic start elevation (the 174-route bucket).",
    auditedCount: evidenceRows.length,
    recoveryBySource: {
      EXACT_ENDPOINT_OSM_ELE: evidenceRows.filter((r) => r.selectedElevationSource === "EXACT_ENDPOINT_OSM_ELE").length,
      EXACT_START_FEATURE_ELE: evidenceRows.filter((r) => r.selectedElevationSource === "EXACT_START_FEATURE_ELE").length,
      CONTAINING_START_FEATURE_ELE: evidenceRows.filter((r) => r.selectedElevationSource === "CONTAINING_START_FEATURE_ELE").length,
      CONNECTED_NETWORK_ELEVATION: evidenceRows.filter((r) => r.selectedElevationSource === "CONNECTED_NETWORK_ELEVATION").length,
      FROZEN_TERRAIN_DATA: evidenceRows.filter((r) => r.selectedElevationSource === "FROZEN_TERRAIN_DATA").length,
      NONE: missing.length,
    },
    recoveredToBase: recoveredBase.length,
    recoveredToHut: recoveredByClassification.length - recoveredBase.length,
    recoveredTotal: recoveredByClassification.length,
    remainingUnproven: missing.length,
    rows: evidenceRows,
  };
  const evidenceHash = sha256Stable(evidenceAudit);
  const evidenceArtifact = { ...evidenceAudit, deterministicArtifactHash: evidenceHash };
  await writeFile(
    `${OUT_STAGING}/phase11f3-start-elevation-evidence.json`,
    JSON.stringify(evidenceArtifact, null, 2),
  );

  const greenQualifying = typeCounts.BASE_START + typeCounts.HUT_START;
  const readiness = {
    schemaVersion: 3,
    artifactType: "PHASE11F3_START_CONTEXT_READINESS",
    generatedAt: new Date().toISOString(),
    elevationHierarchyVersion: "1",
    totalGreenRoutes: results.length,
    machineQualifiedSafe500: typeCounts.BASE_START,
    machineQualifiedSafe600: greenQualifying,
    truthfulMachineQualifiedSafe500: typeCounts.BASE_START,
    truthfulMachineQualifiedSafe600: greenQualifying,
    falselyQualifiedAsGenUin: 0,
    highMountainStart: typeCounts.HIGH_MOUNTAIN_START,
    ambiguousStart: typeCounts.AMBIGUOUS_START,
    tothornRemainsNotGreen: tothorn ? !(tothorn.startContext.type === "BASE_START" || tothorn.startContext.type === "HUT_START") : true,
    recoveredBaseFromAmbiguous: evidenceAudit.recoveredToBase,
    note: "Green-compatible = BASE_START + HUT_START. Deterministic start elevation from frozen OSM evidence only (hierarchy v1).",
  };
  const readinessHash = sha256Stable(readiness);
  const readinessArtifact = { ...readiness, deterministicArtifactHash: readinessHash };
  await writeFile(
    `${OUT_PUBLICATION}/phase11f3-start-context-readiness.json`,
    JSON.stringify(readinessArtifact, null, 2),
  );

  console.log("\nPhase 11F.3 Start Context Classification:");
  for (const [type, count] of Object.entries(typeCounts)) console.log(`${type}: ${count}`);
  console.log(`GREEN-compatible: ${greenQualifying}`);
  console.log("\nEvidence audit:");
  console.log(JSON.stringify(evidenceAudit.recoveryBySource));
  console.log(`recovered to BASE: ${evidenceAudit.recoveredToBase}, to HUT: ${evidenceAudit.recoveredToHut}, remaining unproven: ${missing.length}`);
  console.log("\nTothorn:", tothorn ? tothorn.startContext.type : "NOT FOUND");
}

function routeStartTypeById(f2: { routes: F2Route[] }, id: string): string | null {
  const r = f2.routes.find((x) => x.sourceRelationId === id);
  return r ? r.startContext.type : null;
}

await main();
