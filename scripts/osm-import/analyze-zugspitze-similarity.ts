import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RouteGeometry } from "./peak-matcher.ts";
import {
  buildDuplicateGroups,
  type GroupableRoute,
} from "./route-groups.ts";
import { createHollentalsteigSimilarityFixtures } from "./route-similarity-fixtures.ts";
import {
  comparePreparedRoutes,
  DEFAULT_ROUTE_SIMILARITY_THRESHOLDS,
  prepareRouteForSimilarity,
  type ComparableRoute,
  type RouteSimilarityClassification,
  type RouteSimilarityResult,
} from "./route-similarity.ts";

interface SourceRoute {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  ref: string | null;
  network: string | null;
  operator: string | null;
  geometry: RouteGeometry;
  metadata: {
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
  };
}

interface PhaseThreeAssociation {
  peakSourceId: string;
  finalAssociation: "CONFIRMED" | "REVIEW" | "REJECTED";
}

interface PhaseThreeRoute {
  routeSourceId: string;
  routeName: string;
  qualityScore: number;
  summitAssociations: PhaseThreeAssociation[];
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../../data/osm");
const ROUTES_PATH = resolve(DATA_DIRECTORY, "zugspitze-routes.json");
const ANALYSIS_PATH = resolve(DATA_DIRECTORY, "zugspitze-route-analysis.json");
const SIMILARITY_OUTPUT_PATH = resolve(
  DATA_DIRECTORY,
  "zugspitze-route-similarity.json",
);
const GROUPS_OUTPUT_PATH = resolve(
  DATA_DIRECTORY,
  "zugspitze-route-groups.json",
);

const CLASSIFICATIONS: RouteSimilarityClassification[] = [
  "EXACT_DUPLICATE",
  "NEAR_DUPLICATE",
  "SAME_VARIANT",
  "DIFFERENT_VARIANT",
  "UNRELATED",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireArray<T>(
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

function metadataRichness(route: SourceRoute): number {
  return [
    route.name,
    route.ref,
    route.network,
    route.operator,
    route.metadata.from,
    route.metadata.to,
    route.metadata.roundtrip,
    route.metadata.osmcSymbol,
  ].filter(Boolean).length;
}

function sourceCoordinateCount(routes: SourceRoute[]): number {
  return routes.reduce((total, route) => {
    const components =
      route.geometry.type === "LineString"
        ? [route.geometry.coordinates]
        : route.geometry.coordinates;
    return (
      total +
      components.reduce(
        (routeTotal, component) => routeTotal + component.length,
        0,
      )
    );
  }, 0);
}

function toComparableRoute(
  route: SourceRoute,
  analysis: PhaseThreeRoute,
): ComparableRoute {
  return {
    sourceId: route.sourceId,
    name: analysis.routeName,
    geometry: route.geometry,
    summitEvidence: {
      confirmedPeakIds: analysis.summitAssociations
        .filter((association) => association.finalAssociation === "CONFIRMED")
        .map((association) => association.peakSourceId),
      associatedPeakIds: analysis.summitAssociations
        .filter((association) => association.finalAssociation !== "REJECTED")
        .map((association) => association.peakSourceId),
    },
  };
}

function classificationCounts(
  comparisons: RouteSimilarityResult[],
): Record<RouteSimilarityClassification, number> {
  return Object.fromEntries(
    CLASSIFICATIONS.map((classification) => [
      classification,
      comparisons.filter(
        (comparison) => comparison.classification === classification,
      ).length,
    ]),
  ) as Record<RouteSimilarityClassification, number>;
}

function compareAllPairs(routes: ComparableRoute[]): {
  comparisons: RouteSimilarityResult[];
  runtimeMilliseconds: number;
  normalizedSampleCount: number;
} {
  const start = performance.now();
  const prepared = routes.map((route) => prepareRouteForSimilarity(route));
  const comparisons: RouteSimilarityResult[] = [];

  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < prepared.length;
      rightIndex += 1
    ) {
      comparisons.push(
        comparePreparedRoutes(prepared[leftIndex], prepared[rightIndex]),
      );
    }
  }

  return {
    comparisons,
    runtimeMilliseconds: Number((performance.now() - start).toFixed(1)),
    normalizedSampleCount: prepared.reduce(
      (total, route) => total + route.normalizedGeometry.sampleCount,
      0,
    ),
  };
}

function printPair(comparison: RouteSimilarityResult): void {
  console.log(
    `- ${comparison.routeA.name} <> ${comparison.routeB.name}: ${comparison.classification}, shape ${comparison.metrics.approximateShapeSimilarity.toFixed(3)}, coverage ${comparison.metrics.coverageAByB.toFixed(3)}/${comparison.metrics.coverageBByA.toFixed(3)}, length ratio ${comparison.metrics.lengthRatio.toFixed(3)}`,
  );
}

async function main(): Promise<void> {
  const [rawRoutes, rawAnalysis] = await Promise.all([
    readJson(ROUTES_PATH),
    readJson(ANALYSIS_PATH),
  ]);
  const sourceRoutes = requireArray<SourceRoute>(
    rawRoutes,
    "routes",
    "zugspitze-routes.json",
  );
  const analyzedRoutes = requireArray<PhaseThreeRoute>(
    rawAnalysis,
    "routes",
    "zugspitze-route-analysis.json",
  );
  const analysisById = new Map(
    analyzedRoutes.map((route) => [route.routeSourceId, route]),
  );
  const comparableRoutes = sourceRoutes.map((route) => {
    const analysis = analysisById.get(route.sourceId);
    if (!analysis) {
      throw new Error(`Phase 3 output is missing route ${route.sourceId}`);
    }
    return toComparableRoute(route, analysis);
  });
  const pairwise = compareAllPairs(comparableRoutes);
  const expectedPairCount =
    (comparableRoutes.length * (comparableRoutes.length - 1)) / 2;
  if (pairwise.comparisons.length !== expectedPairCount) {
    throw new Error(
      `Expected ${expectedPairCount} pairs but calculated ${pairwise.comparisons.length}`,
    );
  }

  const groupableRoutes: GroupableRoute[] = sourceRoutes.map((route) => {
    const analysis = analysisById.get(route.sourceId);
    if (!analysis) {
      throw new Error(`Phase 3 output is missing route ${route.sourceId}`);
    }
    return {
      sourceId: route.sourceId,
      name: analysis.routeName,
      qualityScore: analysis.qualityScore,
      metadataRichness: metadataRichness(route),
    };
  });
  const duplicateGroups = buildDuplicateGroups(
    groupableRoutes,
    pairwise.comparisons,
  );
  const highestSimilarityPairs = [...pairwise.comparisons]
    .sort(
      (left, right) =>
        right.metrics.approximateShapeSimilarity -
          left.metrics.approximateShapeSimilarity ||
        left.routeA.sourceId.localeCompare(right.routeA.sourceId),
    )
    .slice(0, 10);
  const suspiciousNonDuplicates = pairwise.comparisons
    .filter(
      (comparison) =>
        comparison.classification !== "EXACT_DUPLICATE" &&
        comparison.classification !== "NEAR_DUPLICATE" &&
        (comparison.metrics.approximateShapeSimilarity >= 0.5 ||
          Math.max(
            comparison.metrics.coverageAByB,
            comparison.metrics.coverageBByA,
          ) >= 0.8),
    )
    .sort(
      (left, right) =>
        right.metrics.approximateShapeSimilarity -
        left.metrics.approximateShapeSimilarity,
    );
  const hollentalsteig = comparableRoutes.find(
    (route) => route.sourceId === "3201006",
  );
  if (!hollentalsteig) {
    throw new Error("Höllentalsteig route 3201006 is missing");
  }
  const fixtureResults = createHollentalsteigSimilarityFixtures(
    hollentalsteig,
  ).map((fixture) => {
    const comparison = comparePreparedRoutes(
      prepareRouteForSimilarity(hollentalsteig),
      prepareRouteForSimilarity(fixture.route),
    );
    return {
      fixtureId: fixture.fixtureId,
      description: fixture.description,
      acceptableClassifications: fixture.acceptableClassifications,
      actualClassification: comparison.classification,
      passed: fixture.acceptableClassifications.includes(
        comparison.classification,
      ),
      metrics: comparison.metrics,
    };
  });
  if (fixtureResults.some((fixture) => !fixture.passed)) {
    const failures = fixtureResults
      .filter((fixture) => !fixture.passed)
      .map(
        (fixture) =>
          `${fixture.fixtureId}: expected ${fixture.acceptableClassifications.join("/")}, got ${fixture.actualClassification}`,
      );
    throw new Error(`Synthetic similarity fixtures failed:\n${failures.join("\n")}`);
  }
  const counts = classificationCounts(pairwise.comparisons);
  const summary = {
    routesAnalyzed: comparableRoutes.length,
    uniquePairsAnalyzed: pairwise.comparisons.length,
    classificationCounts: counts,
    normalizedSampleCount: pairwise.normalizedSampleCount,
    originalCoordinateCount: sourceCoordinateCount(sourceRoutes),
    pairwiseRuntimeMilliseconds: pairwise.runtimeMilliseconds,
    duplicateGroupCount: duplicateGroups.groups.length,
    largestDuplicateGroupSize: Math.max(
      0,
      ...duplicateGroups.groups.map((group) => group.memberSourceIds.length),
    ),
    suspiciousHighSimilarityNonDuplicateCount: suspiciousNonDuplicates.length,
    syntheticFixturesPassed: fixtureResults.filter((fixture) => fixture.passed)
      .length,
    syntheticFixtureCount: fixtureResults.length,
  };
  const similarityOutput = {
    generatedAt: new Date().toISOString(),
    source: "openstreetmap",
    inputs: {
      routes: "data/osm/zugspitze-routes.json",
      routeAnalysis: "data/osm/zugspitze-route-analysis.json",
    },
    thresholds: DEFAULT_ROUTE_SIMILARITY_THRESHOLDS,
    summary,
    highestSimilarityPairs,
    suspiciousHighSimilarityNonDuplicates: suspiciousNonDuplicates,
    syntheticFixtureResults: fixtureResults,
    comparisons: pairwise.comparisons,
  };
  const groupsOutput = {
    generatedAt: similarityOutput.generatedAt,
    source: "openstreetmap",
    input: "data/osm/zugspitze-route-similarity.json",
    groupingPolicy:
      "Only EXACT_DUPLICATE and NEAR_DUPLICATE edges form groups; SAME_VARIANT is never merged.",
    canonicalPolicy: [
      "highest Phase 3 quality score",
      "richest metadata",
      "stable source ID tie-breaker",
    ],
    groupCount: duplicateGroups.groups.length,
    groups: duplicateGroups.groups,
    ungroupedSourceIds: duplicateGroups.ungroupedSourceIds,
  };

  await Promise.all([
    writeFile(
      SIMILARITY_OUTPUT_PATH,
      `${JSON.stringify(similarityOutput, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      GROUPS_OUTPUT_PATH,
      `${JSON.stringify(groupsOutput, null, 2)}\n`,
      "utf8",
    ),
  ]);

  console.log("Zugspitze Phase 4 route similarity analysis");
  console.log(`Routes analyzed: ${summary.routesAnalyzed}`);
  console.log(`Unique pairs analyzed: ${summary.uniquePairsAnalyzed}`);
  CLASSIFICATIONS.forEach((classification) =>
    console.log(`${classification}: ${counts[classification]}`),
  );
  console.log(`Duplicate groups: ${summary.duplicateGroupCount}`);
  console.log(`Largest duplicate group: ${summary.largestDuplicateGroupSize}`);
  console.log(
    `Normalized samples: ${summary.normalizedSampleCount} from ${summary.originalCoordinateCount} original coordinates`,
  );
  console.log(`Pairwise runtime: ${summary.pairwiseRuntimeMilliseconds} ms`);
  console.log("Highest-similarity pairs:");
  highestSimilarityPairs.slice(0, 10).forEach(printPair);
  console.log("Suspicious/high-similarity non-duplicates:");
  if (suspiciousNonDuplicates.length === 0) {
    console.log("- none");
  } else {
    suspiciousNonDuplicates.forEach(printPair);
  }
  console.log("Synthetic Höllentalsteig fixtures:");
  fixtureResults.forEach((fixture) =>
    console.log(
      `- ${fixture.fixtureId} ${fixture.description}: ${fixture.actualClassification} (${fixture.passed ? "pass" : "fail"})`,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
