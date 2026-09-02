import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  buildPhase7Audit,
  inferExplicitCountryCode,
  renderFinalAuditMarkdown,
  validatePeakCoordinate,
  validateRouteGeometry,
  type AuditAnalysisInput,
  type AuditPeakInput,
  type AuditRouteInput,
  type IntegrityFailure,
  type Phase6SummaryInput,
} from "./alps-audit.ts";
import type { BulkRouteRecord } from "./bulk-route-reconstruction.ts";
import {
  iterateJsonLines,
  writeJsonAtomically,
  writeJsonLines,
} from "./jsonl.ts";
import type { Coordinate } from "./peak-matcher.ts";
import type { RouteAnalysisResult } from "./route-analysis.ts";
import type { DuplicateGroup } from "./route-groups.ts";

interface PeakJsonRecord {
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  elevationMeters: number | null;
  coordinates: Coordinate;
  provenanceId: string;
  license: string;
  attribution: string;
  metadata?: { tags?: Record<string, string> };
}

interface CliOptions {
  inputDirectory: string;
  outputDirectory: string;
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_INPUT_DIRECTORY = resolve(REPOSITORY_ROOT, "data/osm/alps");

function parseArguments(arguments_: string[]): CliOptions {
  let inputDirectory = DEFAULT_INPUT_DIRECTORY;
  let outputDirectory: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--input-directory") {
      if (!next || next.startsWith("--")) {
        throw new Error("--input-directory requires a path");
      }
      inputDirectory = resolve(next);
      index += 1;
    } else if (argument === "--output-directory") {
      if (!next || next.startsWith("--")) {
        throw new Error("--output-directory requires a path");
      }
      outputDirectory = resolve(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return {
    inputDirectory,
    outputDirectory: outputDirectory ?? resolve(inputDirectory, "audit"),
  };
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}

function rssMegabytes(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const totalStart = performance.now();
  let peakObservedRssMegabytes = rssMegabytes();
  const observeRss = (): void => {
    peakObservedRssMegabytes = Math.max(peakObservedRssMegabytes, rssMegabytes());
  };
  const inputLoadingStart = performance.now();
  const summary = JSON.parse(
    await readFile(resolve(options.inputDirectory, "summary.json"), "utf8"),
  ) as Phase6SummaryInput;
  if (summary.mode !== "confirmed-full") {
    throw new Error(
      `Phase 7 requires a confirmed-full Phase 6 summary; received mode ${summary.mode}.`,
    );
  }

  const duplicateGroups: DuplicateGroup[] = [];
  for await (const group of iterateJsonLines<DuplicateGroup>(
    resolve(options.inputDirectory, "route-groups.jsonl"),
  )) {
    duplicateGroups.push(group);
  }
  observeRss();
  console.log(`Duplicate groups loaded: ${duplicateGroups.length.toLocaleString()}`);

  const peaks: AuditPeakInput[] = [];
  let peakRows = 0;
  for await (const peak of iterateJsonLines<PeakJsonRecord>(
    resolve(options.inputDirectory, "peaks.jsonl"),
  )) {
    peaks.push({
      sourceId: peak.sourceId,
      sourceUrl: peak.sourceUrl,
      name: peak.name,
      elevationMeters: peak.elevationMeters,
      coordinates: peak.coordinates,
      coordinatesValid: validatePeakCoordinate(peak.coordinates),
      provenanceId: peak.provenanceId,
      license: peak.license,
      attribution: peak.attribution,
      explicitCountryCode: inferExplicitCountryCode(peak.metadata?.tags),
    });
    peakRows += 1;
  }
  observeRss();
  console.log(`Peaks loaded: ${peakRows.toLocaleString()}`);

  const routes: AuditRouteInput[] = [];
  let routeRows = 0;
  for await (const route of iterateJsonLines<BulkRouteRecord>(
    resolve(options.inputDirectory, "routes.jsonl"),
  )) {
    const geometryValidation = validateRouteGeometry(route.geometry);
    routes.push({
      sourceId: route.sourceId,
      sourceUrl: route.sourceUrl,
      name: route.name,
      geometryType: route.geometry.type,
      distanceMeters: route.stats.distanceMeters,
      componentCount: route.stats.componentCount,
      heavilyFragmented: route.flags.heavilyFragmented,
      ...geometryValidation,
      provenanceId: route.provenanceId,
      license: route.license,
      attribution: route.attribution,
      explicitCountryCode: inferExplicitCountryCode(route.metadata.tags),
    });
    routeRows += 1;
    if (routeRows % 20_000 === 0) {
      observeRss();
      console.log(`Routes loaded: ${routeRows.toLocaleString()}`);
    }
  }
  observeRss();
  console.log(`Routes loaded: ${routeRows.toLocaleString()}`);

  const analyses: AuditAnalysisInput[] = [];
  let analysisRows = 0;
  for await (const analysis of iterateJsonLines<RouteAnalysisResult>(
    resolve(options.inputDirectory, "route-analysis.jsonl"),
  )) {
    analyses.push({
      routeSourceId: analysis.routeSourceId,
      routeName: analysis.routeName,
      semanticType: analysis.semanticType,
      qualityScore: analysis.qualityScore,
      summitAssociations: analysis.summitAssociations.map((association) => ({
        ...association,
        reasons: [...association.reasons],
      })),
    });
    analysisRows += 1;
    if (analysisRows % 20_000 === 0) {
      observeRss();
      console.log(`Route analyses loaded: ${analysisRows.toLocaleString()}`);
    }
  }
  observeRss();
  console.log(`Route analyses loaded: ${analysisRows.toLocaleString()}`);
  const inputLoadingMilliseconds = performance.now() - inputLoadingStart;

  const loaderIntegrityFailures: IntegrityFailure[] = [];
  const build = buildPhase7Audit({
    summary,
    routes,
    peaks,
    analyses,
    duplicateGroups,
    loaderIntegrityFailures,
  });
  observeRss();

  const outputWritingStart = performance.now();
  await mkdir(options.outputDirectory, { recursive: true });
  const paths = {
    confirmedRoutes: resolve(options.outputDirectory, "confirmed-routes.jsonl"),
    coveredPeaks: resolve(options.outputDirectory, "covered-peaks.jsonl"),
    canonicalConfirmedRoutes: resolve(
      options.outputDirectory,
      "canonical-confirmed-routes.jsonl",
    ),
    peakCoverageRanking: resolve(
      options.outputDirectory,
      "peak-coverage-ranking.json",
    ),
    manualAuditSample: resolve(options.outputDirectory, "manual-audit-sample.json"),
    reviewOpportunities: resolve(options.outputDirectory, "review-opportunities.json"),
    importEligibility: resolve(options.outputDirectory, "import-eligibility.jsonl"),
    finalSummary: resolve(options.outputDirectory, "final-audit-summary.json"),
    finalMarkdown: resolve(options.outputDirectory, "FINAL_AUDIT.md"),
  };
  await Promise.all([
    writeJsonLines(paths.confirmedRoutes, build.artifacts.confirmedRoutes),
    writeJsonLines(paths.coveredPeaks, build.artifacts.coveredPeaks),
    writeJsonLines(
      paths.canonicalConfirmedRoutes,
      build.artifacts.canonicalConfirmedRoutes,
    ),
    writeJsonAtomically(
      paths.peakCoverageRanking,
      build.artifacts.peakCoverageRanking,
    ),
    writeJsonAtomically(paths.manualAuditSample, build.artifacts.manualAuditSample),
    writeJsonAtomically(paths.reviewOpportunities, build.artifacts.reviewOpportunities),
    writeJsonLines(paths.importEligibility, build.artifacts.importEligibility),
  ]);
  observeRss();
  const outputWritingMilliseconds = performance.now() - outputWritingStart;
  const performanceSummary = {
    inputLoadingMilliseconds: roundedMilliseconds(inputLoadingMilliseconds),
    aggregationMilliseconds: build.stageTimingsMilliseconds.aggregation,
    dedupCanonicalProcessingMilliseconds:
      build.stageTimingsMilliseconds.dedupCanonicalProcessing,
    auditGenerationMilliseconds: roundedMilliseconds(
      build.stageTimingsMilliseconds.auditGeneration + outputWritingMilliseconds,
    ),
    outputWritingMilliseconds: roundedMilliseconds(outputWritingMilliseconds),
    totalRuntimeMilliseconds: roundedMilliseconds(performance.now() - totalStart),
    peakObservedRssMegabytes,
    inputRows: {
      routes: routeRows,
      peaks: peakRows,
      analyses: analysisRows,
      duplicateGroups: duplicateGroups.length,
    },
    expensivePhase6WorkRepeated: false,
  };
  const finalSummary: Record<string, unknown> = {
    ...build.artifacts.finalSummary,
    performance: performanceSummary,
  };
  await writeJsonAtomically(paths.finalSummary, finalSummary);
  await writeTextAtomically(
    paths.finalMarkdown,
    renderFinalAuditMarkdown(
      finalSummary,
      build.artifacts.peakCoverageRanking,
      performanceSummary,
    ),
  );
  observeRss();

  const confirmed = finalSummary.confirmedRoutes as Record<string, number>;
  const peakCoverage = finalSummary.peakCoverage as Record<string, number>;
  const deduplication = finalSummary.deduplication as Record<string, number>;
  const eligibility = finalSummary.importEligibility as Record<string, number>;
  const integrity = finalSummary.integrity as Record<string, unknown>;
  console.log("Phase 7 Alps audit complete");
  console.log(
    `Confirmed: ${confirmed.totalConfirmedAssociations.toLocaleString()} associations across ${confirmed.uniqueRoutesWithConfirmedSummit.toLocaleString()} source routes`,
  );
  console.log(
    `Coverage: ${peakCoverage.uniqueConfirmedPeaks.toLocaleString()} unique peaks`,
  );
  console.log(
    `Canonical confirmed routes: ${deduplication.uniqueCanonicalConfirmedRoutesRemaining.toLocaleString()}`,
  );
  console.log(
    `Eligibility: ${eligibility.AUTO_IMPORT_READY.toLocaleString()} auto | ${eligibility.MANUAL_REVIEW_REQUIRED.toLocaleString()} manual | ${eligibility.EXCLUDE.toLocaleString()} exclude`,
  );
  console.log(
    `Integrity: ${String(integrity.status)} (${Number(integrity.criticalFailureCount).toLocaleString()} critical failures)`,
  );
  console.log(`Audit output: ${options.outputDirectory}`);
  console.log(`Runtime: ${performanceSummary.totalRuntimeMilliseconds} ms`);
  console.log(`Peak observed RSS: ${peakObservedRssMegabytes} MB`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
