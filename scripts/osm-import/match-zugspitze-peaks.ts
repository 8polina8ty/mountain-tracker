import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PEAK_MATCH_THRESHOLDS,
  matchPeaksToRoute,
  type MatchablePeak,
  type MatchableRoute,
  type PeakClassification,
  type PeakMatchCandidate,
} from "./peak-matcher.ts";

interface RouteInputFile {
  source: string;
  provenance?: unknown;
  routes: MatchableRoute[];
}

interface PeakInputFile {
  source: string;
  provenance?: unknown;
  peaks: MatchablePeak[];
}

interface RouteMatchResult {
  routeSourceId: string;
  routeSourceUrl: string;
  routeName: string;
  routeMetadata: {
    ref: string | null;
    network: string | null;
    operator: string | null;
    routeType: string;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
    geometryType: "LineString" | "MultiLineString";
    componentCount: number;
    distanceMeters: number;
  };
  candidates: PeakMatchCandidate[];
}

interface RouteMatchSummaryItem {
  routeSourceId: string;
  routeName: string;
  matchedPeakCount: number;
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DATA_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../../data/osm");
const ROUTES_PATH = resolve(DATA_DIRECTORY, "zugspitze-routes.json");
const PEAKS_PATH = resolve(DATA_DIRECTORY, "zugspitze-peaks.json");
const OUTPUT_PATH = resolve(
  DATA_DIRECTORY,
  "zugspitze-route-peak-matches.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRouteInput(value: unknown): RouteInputFile {
  if (!isRecord(value) || !Array.isArray(value.routes)) {
    throw new Error("zugspitze-routes.json does not contain a routes array");
  }

  return value as unknown as RouteInputFile;
}

function parsePeakInput(value: unknown): PeakInputFile {
  if (!isRecord(value) || !Array.isArray(value.peaks)) {
    throw new Error("zugspitze-peaks.json does not contain a peaks array");
  }

  return value as unknown as PeakInputFile;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function displayRouteName(route: MatchableRoute): string {
  return route.name ?? route.ref ?? `OSM relation ${route.sourceId}`;
}

function buildRouteMatchResult(
  route: MatchableRoute,
  peaks: MatchablePeak[],
): RouteMatchResult {
  return {
    routeSourceId: route.sourceId,
    routeSourceUrl: route.sourceUrl,
    routeName: displayRouteName(route),
    routeMetadata: {
      ref: route.ref,
      network: route.network,
      operator: route.operator,
      routeType: route.metadata.route,
      from: route.metadata.from,
      to: route.metadata.to,
      roundtrip: route.metadata.roundtrip,
      osmcSymbol: route.metadata.osmcSymbol,
      geometryType: route.geometry.type,
      componentCount: route.stats.componentCount,
      distanceMeters: route.stats.distanceMeters,
    },
    candidates: matchPeaksToRoute(route, peaks),
  };
}

function countClassification(
  results: RouteMatchResult[],
  classification: PeakClassification,
): number {
  return results.reduce(
    (total, result) =>
      total +
      result.candidates.filter(
        (candidate) => candidate.classification === classification,
      ).length,
    0,
  );
}

function summarizeRoutes(
  results: RouteMatchResult[],
): RouteMatchSummaryItem[] {
  return results.map((result) => ({
    routeSourceId: result.routeSourceId,
    routeName: result.routeName,
    matchedPeakCount: result.candidates.filter(
      (candidate) => candidate.classification === "MATCHED",
    ).length,
  }));
}

function printCandidateGroup(
  classification: "MATCHED" | "POSSIBLE",
  candidates: PeakMatchCandidate[],
): void {
  const matching = candidates.filter(
    (candidate) => candidate.classification === classification,
  );
  console.log(`  ${classification}:`);

  if (matching.length === 0) {
    console.log("    none");
    return;
  }

  matching.forEach((candidate) =>
    console.log(
      `    ${candidate.peakName ?? `OSM peak ${candidate.peakSourceId}`} — ${candidate.minDistanceMeters} m — confidence ${candidate.confidence.toFixed(3)}`,
    ),
  );
}

function printReport(
  results: RouteMatchResult[],
  peaksAnalyzed: number,
  routeSummaries: RouteMatchSummaryItem[],
): void {
  const totalCandidatePairs = results.reduce(
    (total, result) => total + result.candidates.length,
    0,
  );
  const zeroMatched = routeSummaries.filter(
    (route) => route.matchedPeakCount === 0,
  );
  const oneMatched = routeSummaries.filter(
    (route) => route.matchedPeakCount === 1,
  );
  const multipleMatched = routeSummaries.filter(
    (route) => route.matchedPeakCount > 1,
  );

  console.log("Zugspitze route-to-peak matcher report");
  console.log(`Routes analyzed: ${results.length}`);
  console.log(`Peaks analyzed: ${peaksAnalyzed}`);
  console.log(`Candidate pairs <= 500 m: ${totalCandidatePairs}`);
  console.log(`MATCHED: ${countClassification(results, "MATCHED")}`);
  console.log(`POSSIBLE: ${countClassification(results, "POSSIBLE")}`);
  console.log(`REJECTED: ${countClassification(results, "REJECTED")}`);
  console.log(`Routes with zero MATCHED peaks: ${zeroMatched.length}`);
  console.log(`Routes with one MATCHED peak: ${oneMatched.length}`);
  console.log(`Routes with multiple MATCHED peaks: ${multipleMatched.length}`);
  console.log("");
  console.log("Per-route summary");

  results.forEach((result) => {
    console.log(result.routeName);
    printCandidateGroup("MATCHED", result.candidates);
    printCandidateGroup("POSSIBLE", result.candidates);
    const rejectedCount = result.candidates.filter(
      (candidate) => candidate.classification === "REJECTED",
    ).length;
    console.log(`  REJECTED within candidate radius: ${rejectedCount}`);
  });
}

async function main(): Promise<void> {
  const [routeInput, peakInput] = await Promise.all([
    readJson(ROUTES_PATH).then(parseRouteInput),
    readJson(PEAKS_PATH).then(parsePeakInput),
  ]);
  const routeResults = routeInput.routes.map((route) =>
    buildRouteMatchResult(route, peakInput.peaks),
  );
  const routeSummaries = summarizeRoutes(routeResults);
  const routesWithZeroMatchedPeaks = routeSummaries.filter(
    (route) => route.matchedPeakCount === 0,
  );
  const routesWithOneMatchedPeak = routeSummaries.filter(
    (route) => route.matchedPeakCount === 1,
  );
  const routesWithMultipleMatchedPeaks = routeSummaries.filter(
    (route) => route.matchedPeakCount > 1,
  );
  const summary = {
    routesAnalyzed: routeResults.length,
    peaksAnalyzed: peakInput.peaks.length,
    totalCandidatePairs: routeResults.reduce(
      (total, result) => total + result.candidates.length,
      0,
    ),
    matchedCount: countClassification(routeResults, "MATCHED"),
    possibleCount: countClassification(routeResults, "POSSIBLE"),
    rejectedCount: countClassification(routeResults, "REJECTED"),
    routesWithZeroMatchedPeaks,
    routesWithOneMatchedPeak,
    routesWithMultipleMatchedPeaks,
  };
  const output = {
    generatedAt: new Date().toISOString(),
    source: "openstreetmap",
    inputs: {
      routes: "data/osm/zugspitze-routes.json",
      peaks: "data/osm/zugspitze-peaks.json",
    },
    thresholdsMeters: DEFAULT_PEAK_MATCH_THRESHOLDS,
    classificationRules: {
      matched: [
        "minimum route distance <= 30 m",
        "or minimum route distance <= 60 m and nearest route endpoint <= 100 m",
      ],
      possible:
        "minimum route distance > 30 m and <= 150 m unless already MATCHED",
      rejected:
        "minimum route distance > 150 m and <= the 500 m candidate radius",
    },
    caveat:
      "Geometric proximity is a screening signal and does not prove that a route reaches or ascends a summit.",
    summary,
    routes: routeResults,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  printReport(routeResults, peakInput.peaks.length, routeSummaries);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
