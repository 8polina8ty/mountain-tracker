import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  MatchablePeak,
  PeakMatchCandidate,
} from "./peak-matcher.ts";
import {
  analyzeRoute,
  type FinalAssociationResult,
  type FinalSummitAssociation,
  type RouteAnalysisResult,
} from "./route-analysis.ts";
import type {
  ClassifiableRoute,
  RouteSemanticType,
} from "./route-classifier.ts";

interface PhaseTwoRouteResult {
  routeSourceId: string;
  candidates: PeakMatchCandidate[];
}

interface AssociationWithRoute extends FinalAssociationResult {
  routeSourceId: string;
  routeName: string;
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../../data/osm");
const ROUTES_PATH = resolve(DATA_DIRECTORY, "zugspitze-routes.json");
const PEAKS_PATH = resolve(DATA_DIRECTORY, "zugspitze-peaks.json");
const MATCHES_PATH = resolve(
  DATA_DIRECTORY,
  "zugspitze-route-peak-matches.json",
);
const OUTPUT_PATH = resolve(DATA_DIRECTORY, "zugspitze-route-analysis.json");

const SEMANTIC_TYPES: RouteSemanticType[] = [
  "summit_route",
  "long_distance_trail",
  "via_ferrata",
  "local_hike",
  "approach",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArrayProperty<T>(
  value: unknown,
  property: string,
  filename: string,
): T[] {
  if (!isRecord(value) || !Array.isArray(value[property])) {
    throw new Error(`${filename} does not contain a ${property} array`);
  }

  return value[property] as T[];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function countSemanticTypes(
  routes: RouteAnalysisResult[],
): Record<RouteSemanticType, number> {
  return Object.fromEntries(
    SEMANTIC_TYPES.map((semanticType) => [
      semanticType,
      routes.filter((route) => route.semanticType === semanticType).length,
    ]),
  ) as Record<RouteSemanticType, number>;
}

function flattenAssociations(
  routes: RouteAnalysisResult[],
): AssociationWithRoute[] {
  return routes.flatMap((route) =>
    route.summitAssociations.map((association) => ({
      routeSourceId: route.routeSourceId,
      routeName: route.routeName,
      ...association,
    })),
  );
}

function countFinalAssociation(
  associations: AssociationWithRoute[],
  finalAssociation: FinalSummitAssociation,
): number {
  return associations.filter(
    (association) => association.finalAssociation === finalAssociation,
  ).length;
}

function printAssociationGroup(
  label: FinalSummitAssociation,
  associations: AssociationWithRoute[],
): void {
  const matching = associations.filter(
    (association) => association.finalAssociation === label,
  );
  console.log(`${label} associations: ${matching.length}`);

  if (matching.length === 0) {
    console.log("- none");
    return;
  }

  matching.forEach((association) =>
    console.log(
      `- ${association.routeName} -> ${association.peakName ?? `OSM peak ${association.peakSourceId}`}: ${association.minDistanceMeters} m, confidence ${association.finalConfidence.toFixed(3)}`,
    ),
  );
}

function printReport(
  routes: RouteAnalysisResult[],
  associations: AssociationWithRoute[],
  routesWithNoSummitAssociation: RouteAnalysisResult[],
): void {
  const semanticCounts = countSemanticTypes(routes);
  const averageQualityScore =
    routes.reduce((total, route) => total + route.qualityScore, 0) /
    routes.length;
  const lowestQualityRoutes = [...routes]
    .sort(
      (left, right) =>
        left.qualityScore - right.qualityScore ||
        left.routeName.localeCompare(right.routeName),
    )
    .slice(0, 5);

  console.log("Zugspitze Phase 3 route analysis");
  console.log("Routes by semantic type:");
  SEMANTIC_TYPES.forEach((semanticType) =>
    console.log(`- ${semanticType}: ${semanticCounts[semanticType]}`),
  );
  console.log(`Average quality score: ${averageQualityScore.toFixed(1)}`);
  console.log("Lowest-quality routes:");
  lowestQualityRoutes.forEach((route) =>
    console.log(
      `- ${route.routeName}: ${route.qualityScore}/100, ${route.routeMetadata.componentCount} components`,
    ),
  );
  console.log("");
  printAssociationGroup("CONFIRMED", associations);
  printAssociationGroup("REVIEW", associations);
  printAssociationGroup("REJECTED", associations);
  console.log("");
  console.log(
    `Routes with no CONFIRMED/REVIEW summit association: ${routesWithNoSummitAssociation.length}`,
  );
  routesWithNoSummitAssociation.forEach((route) =>
    console.log(`- ${route.routeName}`),
  );
  console.log("");
  console.log("Per-route semantics and association summary:");
  routes.forEach((route) => {
    const retained = route.summitAssociations.filter(
      (association) => association.finalAssociation !== "REJECTED",
    );
    const rejectedCount = route.summitAssociations.length - retained.length;
    console.log(
      `${route.routeName}: ${route.semanticType} (${route.semanticConfidence.toFixed(2)}), quality ${route.qualityScore}/100`,
    );
    if (retained.length === 0) {
      console.log("  summit association: none");
    } else {
      retained.forEach((association) =>
        console.log(
          `  ${association.finalAssociation}: ${association.peakName ?? association.peakSourceId} at ${association.minDistanceMeters} m`,
        ),
      );
    }
    console.log(`  rejected candidate pairs: ${rejectedCount}`);
  });
}

async function main(): Promise<void> {
  const [rawRoutes, rawPeaks, rawMatches] = await Promise.all([
    readJson(ROUTES_PATH),
    readJson(PEAKS_PATH),
    readJson(MATCHES_PATH),
  ]);
  const routes = requireArrayProperty<ClassifiableRoute>(
    rawRoutes,
    "routes",
    "zugspitze-routes.json",
  );
  const peaks = requireArrayProperty<MatchablePeak>(
    rawPeaks,
    "peaks",
    "zugspitze-peaks.json",
  );
  const phaseTwoRoutes = requireArrayProperty<PhaseTwoRouteResult>(
    rawMatches,
    "routes",
    "zugspitze-route-peak-matches.json",
  );
  const phaseTwoByRouteId = new Map(
    phaseTwoRoutes.map((route) => [route.routeSourceId, route]),
  );
  const routeAnalyses = routes.map((route) => {
    const phaseTwo = phaseTwoByRouteId.get(route.sourceId);
    if (!phaseTwo) {
      throw new Error(`Phase 2 output is missing route ${route.sourceId}`);
    }

    return analyzeRoute(route, peaks, phaseTwo.candidates);
  });
  const associations = flattenAssociations(routeAnalyses);
  const routesWithNoSummitAssociation = routeAnalyses.filter((route) =>
    route.summitAssociations.every(
      (association) => association.finalAssociation === "REJECTED",
    ),
  );
  const semanticTypeCounts = countSemanticTypes(routeAnalyses);
  const averageQualityScore = Number(
    (
      routeAnalyses.reduce((total, route) => total + route.qualityScore, 0) /
      routeAnalyses.length
    ).toFixed(1),
  );
  const lowestQualityRoutes = [...routeAnalyses]
    .sort(
      (left, right) =>
        left.qualityScore - right.qualityScore ||
        left.routeName.localeCompare(right.routeName),
    )
    .slice(0, 5)
    .map((route) => ({
      routeSourceId: route.routeSourceId,
      routeName: route.routeName,
      qualityScore: route.qualityScore,
      componentCount: route.routeMetadata.componentCount,
    }));
  const summary = {
    routesAnalyzed: routeAnalyses.length,
    peaksAnalyzed: peaks.length,
    candidatePairsAnalyzed: associations.length,
    semanticTypeCounts,
    averageQualityScore,
    lowestQualityRoutes,
    confirmedAssociationCount: countFinalAssociation(
      associations,
      "CONFIRMED",
    ),
    reviewAssociationCount: countFinalAssociation(associations, "REVIEW"),
    rejectedAssociationCount: countFinalAssociation(
      associations,
      "REJECTED",
    ),
    routesWithNoSummitAssociation: routesWithNoSummitAssociation.map(
      (route) => ({
        routeSourceId: route.routeSourceId,
        routeName: route.routeName,
      }),
    ),
  };
  const output = {
    generatedAt: new Date().toISOString(),
    source: "openstreetmap",
    inputs: {
      routes: "data/osm/zugspitze-routes.json",
      peaks: "data/osm/zugspitze-peaks.json",
      geometricMatches: "data/osm/zugspitze-route-peak-matches.json",
    },
    decisionPolicy: {
      confirmed:
        "Phase 2 MATCHED geometry, a component endpoint within 10 m, and semantics other than long_distance_trail.",
      review:
        "All Phase 2 POSSIBLE pairs, MATCHED pairs without an exact endpoint, and MATCHED long-distance trails.",
      rejected: "Phase 2 REJECTED geometry remains rejected.",
    },
    summary,
    routes: routeAnalyses,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  printReport(routeAnalyses, associations, routesWithNoSummitAssociation);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
