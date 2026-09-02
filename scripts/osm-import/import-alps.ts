import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  BulkCheckpoint,
  fingerprintInput,
} from "./bulk-checkpoint.ts";
import {
  OSM_ATTRIBUTION,
  OSM_LICENSE,
  OSM_PROVENANCE_ID,
  reconstructBulkRoute,
  type BulkRouteRecord,
} from "./bulk-route-reconstruction.ts";
import { BulkSqliteStore } from "./bulk-sqlite-store.ts";
import {
  generatePeakCandidates,
  SpatialPeakIndex,
} from "./bulk-spatial-index.ts";
import { BulkSummaryCollector } from "./bulk-summary.ts";
import {
  createDedupRouteSignature,
  generateDedupCandidatesFromSignatures,
} from "./dedup-candidates.ts";
import {
  combineJsonlChunks,
  iterateJsonLines,
  readJsonLines,
  serializeJsonLine,
  writeJsonAtomically,
  writeJsonLines,
} from "./jsonl.ts";
import {
  assertOsmiumAvailable,
  runOsmium,
  runOsmiumGetId,
  validateOsmiumFile,
} from "./osmium-runner.ts";
import { parseOplLine } from "./opl-parser.ts";
import {
  matchPeaksToRoute,
  type MatchablePeak,
} from "./peak-matcher.ts";
import { buildDuplicateGroups } from "./route-groups.ts";
import {
  analyzeRoute,
  type RouteAnalysisResult,
} from "./route-analysis.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import {
  comparePreparedRoutes,
  prepareRouteForSimilarity,
  type ComparableRoute,
  type PreparedComparableRoute,
  type RouteSimilarityResult,
} from "./route-similarity.ts";

interface CliOptions {
  inputPath: string;
  outputDirectory: string;
  limitRoutes: number | null;
  skipDedup: boolean;
  confirmFull: boolean;
}

interface DiscoveryResult {
  hikingRelationsFound: number;
  footRelationsFound: number;
  selectedRelationIds: number[];
}

interface BulkPeak extends MatchablePeak {
  source: "openstreetmap";
  sourceType: "node";
  provenanceId: string;
  license: "ODbL-1.0";
  attribution: string;
  metadata: { tags: Record<string, string> };
}

interface StageTimings {
  pbfExtractionMilliseconds: number;
  routeReconstructionMilliseconds: number;
  peakIndexMilliseconds: number;
  peakMatchingMilliseconds: number;
  semanticAnalysisMilliseconds: number;
  dedupCandidateGenerationMilliseconds: number;
  similarityMilliseconds: number;
  groupingMilliseconds: number;
  totalRuntimeMilliseconds: number;
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_OUTPUT_DIRECTORY = resolve(REPOSITORY_ROOT, "data/osm/alps");
const RECONSTRUCTION_CHUNK_SIZE = 100;

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(arguments_: string[]): CliOptions {
  let inputPath: string | null = null;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  let limitRoutes: number | null = null;
  let skipDedup = false;
  let confirmFull = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--input") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--input requires a path");
      }
      inputPath = resolve(REPOSITORY_ROOT, value);
      index += 1;
    } else if (argument === "--output-dir") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output-dir requires a path");
      }
      outputDirectory = resolve(REPOSITORY_ROOT, value);
      index += 1;
    } else if (argument === "--limit-routes") {
      limitRoutes = parsePositiveInteger(
        arguments_[index + 1] ?? "",
        "--limit-routes",
      );
      index += 1;
    } else if (argument === "--skip-dedup") {
      skipDedup = true;
    } else if (argument === "--confirm-full") {
      confirmFull = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!inputPath) {
    throw new Error(
      "Missing --input path, for example --input data/osm/source/alps-latest.osm.pbf",
    );
  }
  if (limitRoutes === null && !confirmFull) {
    throw new Error(
      "Full Alps processing requires explicit --confirm-full. Start with --limit-routes 100.",
    );
  }
  return { inputPath, outputDirectory, limitRoutes, skipDedup, confirmFull };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function elapsed(start: number): number {
  return Number((performance.now() - start).toFixed(1));
}

function memoryMegabytes(): number {
  return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
}

async function discoverRelations(
  inputPath: string,
  limitRoutes: number | null,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    hikingRelationsFound: 0,
    footRelationsFound: 0,
    selectedRelationIds: [],
  };
  await runOsmium(
    [
      "tags-filter",
      "-R",
      "-f",
      "opl,add_metadata=false",
      inputPath,
      "r/route=hiking,foot",
    ],
    (line) => {
      const object = parseOplLine(line);
      if (object.type !== "relation" || object.tags.type !== "route") {
        return;
      }
      if (object.tags.route === "foot") {
        result.footRelationsFound += 1;
      } else if (object.tags.route === "hiking") {
        result.hikingRelationsFound += 1;
        if (
          limitRoutes === null ||
          result.selectedRelationIds.length < limitRoutes
        ) {
          result.selectedRelationIds.push(object.id);
        }
      }
      if (result.hikingRelationsFound % 10_000 === 0) {
        console.log(
          `Relations discovered: ${result.hikingRelationsFound.toLocaleString()}`,
        );
      }
    },
  );
  return result;
}

function bulkPeakFromRelationNode(
  object: ReturnType<typeof parseOplLine>,
): BulkPeak | null {
  if (
    object.type !== "node" ||
    object.tags.natural !== "peak" ||
    !object.coordinate
  ) {
    return null;
  }
  const elevation = object.tags.ele
    ? Number.parseFloat(object.tags.ele)
    : Number.NaN;
  return {
    source: "openstreetmap",
    sourceType: "node",
    sourceId: String(object.id),
    sourceUrl: `https://www.openstreetmap.org/node/${object.id}`,
    provenanceId: OSM_PROVENANCE_ID,
    license: OSM_LICENSE,
    attribution: OSM_ATTRIBUTION,
    name: object.tags.name ?? null,
    coordinates: object.coordinate,
    elevationMeters: Number.isFinite(elevation) ? elevation : null,
    metadata: { tags: object.tags },
  };
}

async function loadOsmiumObjects(
  locatedPbfPath: string,
  store: BulkSqliteStore,
): Promise<{ ways: number; relations: number }> {
  let ways = 0;
  let relations = 0;
  let transactionObjects = 0;
  store.begin();
  try {
    await runOsmium(
      [
        "cat",
        "-f",
        "opl,add_metadata=false,locations_on_ways=true",
        locatedPbfPath,
      ],
      (line) => {
        const object = parseOplLine(line);
        if (object.type === "way") {
          store.putWay(object);
          ways += 1;
        } else if (object.type === "relation") {
          store.putRelation(object);
          relations += 1;
        }
        transactionObjects += 1;
        if (transactionObjects >= 5_000) {
          store.commit();
          store.begin();
          transactionObjects = 0;
        }
      },
    );
    store.commit();
  } catch (error) {
    store.rollback();
    throw error;
  }
  return { ways, relations };
}

async function extractPeaks(
  inputPath: string,
  peaksPath: string,
  store: BulkSqliteStore,
): Promise<number> {
  const temporaryPath = `${peaksPath}.tmp`;
  const handle = await open(temporaryPath, "w");
  let count = 0;
  store.begin();
  try {
    await runOsmium(
      [
        "tags-filter",
        "-R",
        "-f",
        "opl,add_metadata=false",
        inputPath,
        "n/natural=peak",
      ],
      async (line) => {
        const peak = bulkPeakFromRelationNode(parseOplLine(line));
        if (!peak) {
          return;
        }
        store.putPeak(peak);
        await handle.write(serializeJsonLine(peak));
        count += 1;
        if (count % 50_000 === 0) {
          store.commit();
          store.begin();
          console.log(`Peaks processed: ${count.toLocaleString()}`);
        }
      },
    );
    store.commit();
  } catch (error) {
    store.rollback();
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, peaksPath);
  return count;
}

async function reconstructRoutes(
  relationIds: number[],
  store: BulkSqliteStore,
  checkpointDirectory: string,
  routesPath: string,
  rejectedPath: string,
): Promise<{ reconstructed: number; rejected: number }> {
  const chunksDirectory = resolve(checkpointDirectory, "route-chunks");
  await mkdir(chunksDirectory, { recursive: true });
  const routeChunks: string[] = [];
  const rejectedChunks: string[] = [];
  let reconstructed = 0;
  let rejected = 0;

  for (
    let startIndex = 0;
    startIndex < relationIds.length;
    startIndex += RECONSTRUCTION_CHUNK_SIZE
  ) {
    const chunkNumber = Math.floor(startIndex / RECONSTRUCTION_CHUNK_SIZE);
    const routeChunk = resolve(
      chunksDirectory,
      `${String(chunkNumber).padStart(6, "0")}-routes.jsonl`,
    );
    const rejectedChunk = resolve(
      chunksDirectory,
      `${String(chunkNumber).padStart(6, "0")}-rejected.jsonl`,
    );
    routeChunks.push(routeChunk);
    rejectedChunks.push(rejectedChunk);

    if ((await exists(routeChunk)) && (await exists(rejectedChunk))) {
      const existingRoutes = await readJsonLines<BulkRouteRecord>(routeChunk);
      existingRoutes.forEach((route) => store.putRoute(route));
      reconstructed += existingRoutes.length;
      rejected += (await readJsonLines(rejectedChunk)).length;
      continue;
    }

    const routeRecords: BulkRouteRecord[] = [];
    const rejectedRecords: unknown[] = [];
    for (const relationId of relationIds.slice(
      startIndex,
      startIndex + RECONSTRUCTION_CHUNK_SIZE,
    )) {
      const result = reconstructBulkRoute(relationId, store);
      if (result.route) {
        routeRecords.push(result.route);
        store.putRoute(result.route);
      } else if (result.rejected) {
        rejectedRecords.push(result.rejected);
      }
    }
    await Promise.all([
      writeJsonLines(routeChunk, routeRecords),
      writeJsonLines(rejectedChunk, rejectedRecords),
    ]);
    reconstructed += routeRecords.length;
    rejected += rejectedRecords.length;
    console.log(
      `Relations processed: ${Math.min(startIndex + RECONSTRUCTION_CHUNK_SIZE, relationIds.length).toLocaleString()} | routes ${reconstructed.toLocaleString()} | rejected ${rejected.toLocaleString()}`,
    );
  }

  await Promise.all([
    combineJsonlChunks(routeChunks, routesPath),
    combineJsonlChunks(rejectedChunks, rejectedPath),
  ]);
  return { reconstructed, rejected };
}

function comparableFromBulk(
  route: BulkRouteRecord,
  analysis: RouteAnalysisResult,
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

function metadataRichness(route: BulkRouteRecord): number {
  return [
    route.name,
    route.ref,
    route.network,
    route.operator,
    route.metadata.from,
    route.metadata.to,
    route.metadata.roundtrip,
    route.metadata.osmcSymbol,
    route.metadata.website,
    route.metadata.description,
  ].filter(Boolean).length;
}

async function main(): Promise<void> {
  const totalStart = performance.now();
  const options = parseArguments(process.argv.slice(2));
  if (!(await exists(options.inputPath))) {
    throw new Error(`PBF input does not exist: ${options.inputPath}`);
  }
  const osmiumVersion = await assertOsmiumAvailable();
  await mkdir(options.outputDirectory, { recursive: true });
  const input = await fingerprintInput(options.inputPath);
  const runIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        input,
        limitRoutes: options.limitRoutes,
        includeFootCount: true,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const checkpointDirectory = resolve(
    options.outputDirectory,
    "checkpoints",
    runIdentity,
  );
  await mkdir(checkpointDirectory, { recursive: true });
  const checkpoint = await BulkCheckpoint.open(
    resolve(checkpointDirectory, "manifest.json"),
    {
      version: 1,
      input,
      options: { limitRoutes: options.limitRoutes, includeFootCount: true },
    },
  );
  const timings: StageTimings = {
    pbfExtractionMilliseconds: 0,
    routeReconstructionMilliseconds: 0,
    peakIndexMilliseconds: 0,
    peakMatchingMilliseconds: 0,
    semanticAnalysisMilliseconds: 0,
    dedupCandidateGenerationMilliseconds: 0,
    similarityMilliseconds: 0,
    groupingMilliseconds: 0,
    totalRuntimeMilliseconds: 0,
  };
  const discoveryPath = resolve(checkpointDirectory, "discovery.json");
  const selectedIdsPath = resolve(checkpointDirectory, "selected-relations.txt");
  let discovery: DiscoveryResult;
  const extractionStart = performance.now();
  if (checkpoint.isComplete("discovery") && (await exists(discoveryPath))) {
    discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as DiscoveryResult;
    if (!(await exists(selectedIdsPath))) {
      await writeFile(
        selectedIdsPath,
        `${discovery.selectedRelationIds.map((id) => `r${id}`).join("\n")}\n`,
        "utf8",
      );
    }
  } else {
    discovery = await discoverRelations(options.inputPath, options.limitRoutes);
    await Promise.all([
      writeJsonAtomically(discoveryPath, discovery),
      writeFile(
        selectedIdsPath,
        `${discovery.selectedRelationIds.map((id) => `r${id}`).join("\n")}\n`,
        "utf8",
      ),
    ]);
    await checkpoint.complete("discovery");
  }

  const selectedPbfPath = resolve(
    checkpointDirectory,
    "selected-routes.osm.pbf",
  );
  const referencedExtraction = await checkpoint.ensureArtifact({
    stage: "referenced-extraction",
    artifactPath: selectedPbfPath,
    sourcePath: options.inputPath,
    validate: validateOsmiumFile,
    generate: () =>
      runOsmiumGetId([
        "getid",
        "--verbose",
        "-r",
        "-t",
        "-i",
        selectedIdsPath,
        "-o",
        selectedPbfPath,
        "-O",
        options.inputPath,
      ]),
  });
  console.log(`Referenced extraction checkpoint: ${referencedExtraction}`);

  const locatedPbfPath = resolve(
    checkpointDirectory,
    "selected-routes-locations.osm.pbf",
  );
  const nodeLocationIndexPath = resolve(
    checkpointDirectory,
    "node-locations.idx",
  );
  const wayLocations = await checkpoint.ensureArtifact({
    stage: "way-locations",
    artifactPath: locatedPbfPath,
    sourcePath: selectedPbfPath,
    validate: validateOsmiumFile,
    generate: () =>
      runOsmium([
        "add-locations-to-ways",
        "-i",
        `sparse_file_array,${nodeLocationIndexPath}`,
        "-f",
        "pbf,locations_on_ways=true,add_metadata=false",
        "-o",
        locatedPbfPath,
        "-O",
        selectedPbfPath,
      ]),
  });
  console.log(`Way-location checkpoint: ${wayLocations}`);
  timings.pbfExtractionMilliseconds = elapsed(extractionStart);

  const storePath = resolve(checkpointDirectory, "bulk-store.sqlite");
  if (!checkpoint.isComplete("object-store")) {
    await Promise.all(
      [storePath, `${storePath}-wal`, `${storePath}-shm`].map((path) =>
        rm(path, { force: true }),
      ),
    );
  }
  const store = new BulkSqliteStore(storePath);
  try {
    if (!checkpoint.isComplete("object-store")) {
      await loadOsmiumObjects(locatedPbfPath, store);
      await checkpoint.complete("object-store");
    }

    const peaksPath = resolve(options.outputDirectory, "peaks.jsonl");
    if (!checkpoint.isComplete("peaks") || !(await exists(peaksPath))) {
      await extractPeaks(options.inputPath, peaksPath, store);
      await checkpoint.complete("peaks");
    }

    const routesPath = resolve(options.outputDirectory, "routes.jsonl");
    const rejectedPath = resolve(
      options.outputDirectory,
      "rejected-routes.jsonl",
    );
    const reconstructionStart = performance.now();
    const reconstruction = await reconstructRoutes(
      discovery.selectedRelationIds,
      store,
      checkpointDirectory,
      routesPath,
      rejectedPath,
    );
    timings.routeReconstructionMilliseconds = elapsed(reconstructionStart);
    await checkpoint.complete("routes");

    const rssBeforePeakLoadMegabytes = memoryMegabytes();
    const peaks = await readJsonLines<BulkPeak>(peaksPath);
    const peakIndexStart = performance.now();
    const peakIndex = new SpatialPeakIndex(peaks);
    timings.peakIndexMilliseconds = elapsed(peakIndexStart);
    const rssAfterPeakIndexMegabytes = memoryMegabytes();
    const associationsPath = resolve(
      options.outputDirectory,
      "route-peak-associations.jsonl",
    );
    const analysisPath = resolve(
      options.outputDirectory,
      "route-analysis.jsonl",
    );
    const associationsTemporary = `${associationsPath}.tmp`;
    const analysisTemporary = `${analysisPath}.tmp`;
    const associationHandle = await open(associationsTemporary, "w");
    const analysisHandle = await open(analysisTemporary, "w");
    const summaryCollector = new BulkSummaryCollector();
    let coarsePeakCandidatePairs = 0;
    let precisePeakMatcherEvaluations = 0;
    let retainedPeakPairs = 0;
    const semanticCounts: Record<string, number> = {
      summit_route: 0,
      long_distance_trail: 0,
      via_ferrata: 0,
      local_hike: 0,
      approach: 0,
      unknown: 0,
    };
    let qualityMinimum = Number.POSITIVE_INFINITY;
    let qualityMaximum = Number.NEGATIVE_INFINITY;
    let qualityTotal = 0;
    let qualityBelow50 = 0;
    let qualityFrom50To79 = 0;
    let qualityAtLeast80 = 0;
    let analyzedRouteCount = 0;
    try {
      for await (const route of iterateJsonLines<BulkRouteRecord>(routesPath)) {
        const matchingStart = performance.now();
        const candidatePeaks = generatePeakCandidates(route, peakIndex);
        coarsePeakCandidatePairs += candidatePeaks.length;
        precisePeakMatcherEvaluations += candidatePeaks.length;
        const candidates = matchPeaksToRoute(route, candidatePeaks);
        timings.peakMatchingMilliseconds += performance.now() - matchingStart;
        retainedPeakPairs += candidates.length;
        await associationHandle.write(
          serializeJsonLine({
            routeSourceId: route.sourceId,
            provenanceId: OSM_PROVENANCE_ID,
            coarseCandidateCount: candidatePeaks.length,
            candidates,
          }),
        );
        const semanticStart = performance.now();
        const analysis = analyzeRoute(
          route as ClassifiableRoute,
          [],
          candidates,
          (coordinate) => peakIndex.findNearest(coordinate),
        );
        timings.semanticAnalysisMilliseconds += performance.now() - semanticStart;
        store.putAnalysis(analysis);
        await analysisHandle.write(
          serializeJsonLine({
            ...analysis,
            provenanceId: OSM_PROVENANCE_ID,
          }),
        );
        summaryCollector.addRouteAnalysis(analysis);
        semanticCounts[analysis.semanticType] =
          (semanticCounts[analysis.semanticType] ?? 0) + 1;
        qualityMinimum = Math.min(qualityMinimum, analysis.qualityScore);
        qualityMaximum = Math.max(qualityMaximum, analysis.qualityScore);
        qualityTotal += analysis.qualityScore;
        if (analysis.qualityScore < 50) {
          qualityBelow50 += 1;
        } else if (analysis.qualityScore < 80) {
          qualityFrom50To79 += 1;
        } else {
          qualityAtLeast80 += 1;
        }
        analyzedRouteCount += 1;
        if (analyzedRouteCount % 1_000 === 0) {
          console.log(
            `Routes analyzed: ${analyzedRouteCount.toLocaleString()} | peak candidates ${coarsePeakCandidatePairs.toLocaleString()}`,
          );
        }
      }
    } finally {
      await Promise.all([associationHandle.close(), analysisHandle.close()]);
    }
    await Promise.all([
      rename(associationsTemporary, associationsPath),
      rename(analysisTemporary, analysisPath),
    ]);
    timings.peakMatchingMilliseconds = Number(
      timings.peakMatchingMilliseconds.toFixed(1),
    );
    timings.semanticAnalysisMilliseconds = Number(
      timings.semanticAnalysisMilliseconds.toFixed(1),
    );

    const dedupStart = performance.now();
    const signatures = [];
    const groupableRoutes = [];
    for await (const route of iterateJsonLines<BulkRouteRecord>(routesPath)) {
      const analysis = store.getAnalysis(route.sourceId);
      if (!analysis) {
        throw new Error(`Missing bulk analysis for route ${route.sourceId}`);
      }
      const comparable = comparableFromBulk(route, analysis);
      signatures.push(createDedupRouteSignature(comparable));
      groupableRoutes.push({
        sourceId: route.sourceId,
        name: analysis.routeName,
        qualityScore: analysis.qualityScore,
        metadataRichness: metadataRichness(route),
      });
    }
    const dedupCandidates = generateDedupCandidatesFromSignatures(signatures);
    timings.dedupCandidateGenerationMilliseconds = elapsed(dedupStart);
    const similarityPath = resolve(
      options.outputDirectory,
      "route-similarity.jsonl",
    );
    const similarityTemporary = `${similarityPath}.tmp`;
    const similarityHandle = await open(similarityTemporary, "w");
    const duplicateComparisons: RouteSimilarityResult[] = [];
    const preparedCache = new Map<string, PreparedComparableRoute>();
    const getPrepared = (sourceId: string): PreparedComparableRoute => {
      const cached = preparedCache.get(sourceId);
      if (cached) {
        preparedCache.delete(sourceId);
        preparedCache.set(sourceId, cached);
        return cached;
      }
      const route = store.getRoute(sourceId);
      const analysis = store.getAnalysis(sourceId);
      if (!route || !analysis) {
        throw new Error(`Missing route/analysis for similarity ${sourceId}`);
      }
      const prepared = prepareRouteForSimilarity(
        comparableFromBulk(route, analysis),
      );
      preparedCache.set(sourceId, prepared);
      if (preparedCache.size > 64) {
        const oldest = preparedCache.keys().next().value as string | undefined;
        if (oldest) {
          preparedCache.delete(oldest);
        }
      }
      return prepared;
    };
    const similarityStart = performance.now();
    let similarityCompared = 0;
    try {
      if (!options.skipDedup) {
        for (const pair of dedupCandidates.candidatePairs) {
          const comparison = comparePreparedRoutes(
            getPrepared(pair.routeAId),
            getPrepared(pair.routeBId),
          );
          await similarityHandle.write(serializeJsonLine(comparison));
          summaryCollector.addSimilarity(comparison);
          if (
            comparison.classification === "EXACT_DUPLICATE" ||
            comparison.classification === "NEAR_DUPLICATE"
          ) {
            duplicateComparisons.push(comparison);
          }
          similarityCompared += 1;
        }
      }
    } finally {
      await similarityHandle.close();
    }
    await rename(similarityTemporary, similarityPath);
    timings.similarityMilliseconds = elapsed(similarityStart);
    const groupingStart = performance.now();
    const groups = buildDuplicateGroups(
      groupableRoutes,
      duplicateComparisons,
    );
    const groupsPath = resolve(options.outputDirectory, "route-groups.jsonl");
    await writeJsonLines(groupsPath, groups.groups);
    timings.groupingMilliseconds = elapsed(groupingStart);
    timings.totalRuntimeMilliseconds = elapsed(totalStart);

    const qualityDistribution = {
      minimum: analyzedRouteCount ? qualityMinimum : 0,
      maximum: analyzedRouteCount ? qualityMaximum : 0,
      average: analyzedRouteCount
        ? Number((qualityTotal / analyzedRouteCount).toFixed(1))
        : 0,
      below50: qualityBelow50,
      from50To79: qualityFrom50To79,
      atLeast80: qualityAtLeast80,
    };
    const observability = summaryCollector.build();
    const summary = {
      generatedAt: new Date().toISOString(),
      mode: options.limitRoutes
        ? `limit-routes-${options.limitRoutes}`
        : "confirmed-full",
      input,
      tools: { osmium: osmiumVersion, node: process.version },
      provenance: {
        id: OSM_PROVENANCE_ID,
        source: "openstreetmap",
        extractProvider: "Geofabrik GmbH",
        license: OSM_LICENSE,
        attribution: OSM_ATTRIBUTION,
        sourcePage: "https://download.geofabrik.de/europe/alps.html",
      },
      counts: {
        hikingRelationsFound: discovery.hikingRelationsFound,
        footRelationsFound: discovery.footRelationsFound,
        selectedRelations: discovery.selectedRelationIds.length,
        reconstructedRoutes: reconstruction.reconstructed,
        rejectedRoutes: reconstruction.rejected,
        peaks: peaks.length,
        coarsePeakCandidatePairs,
        averageCoarsePeakCandidatesPerRoute:
          reconstruction.reconstructed === 0
            ? 0
            : Number(
                (
                  coarsePeakCandidatePairs / reconstruction.reconstructed
                ).toFixed(2),
              ),
        precisePeakMatcherEvaluations,
        retainedRoutePeakPairs: retainedPeakPairs,
        semanticTypes: semanticCounts,
        summitAssociations: observability.summitAssociations,
        routesBySummitAssociation:
          observability.routesBySummitAssociation,
        semanticAssociationCrossTab:
          observability.semanticAssociationCrossTab,
        qualityDistribution,
        theoreticalRoutePairs: dedupCandidates.theoreticalPairs,
        dedupCandidatePairs: dedupCandidates.candidatePairs.length,
        similarityComparedPairs: similarityCompared,
        similarityClassifications:
          observability.similarityClassifications,
        dedupReductionPercentage: dedupCandidates.reductionPercentage,
        duplicateGroups: groups.groups.length,
        ungroupedRoutes: groups.ungroupedSourceIds.length,
      },
      timingsMilliseconds: timings,
      peakMemoryUsage: {
        rssBeforeLoadMegabytes: rssBeforePeakLoadMegabytes,
        rssAfterIndexMegabytes: rssAfterPeakIndexMegabytes,
        approximateDeltaMegabytes: Number(
          Math.max(
            0,
            rssAfterPeakIndexMegabytes - rssBeforePeakLoadMegabytes,
          ).toFixed(1),
        ),
      },
      diagnostics: observability.diagnosticSamples,
      options: {
        limitRoutes: options.limitRoutes,
        skipDedup: options.skipDedup,
      },
    };
    await writeJsonAtomically(
      resolve(options.outputDirectory, "summary.json"),
      summary,
    );
    await checkpoint.complete("complete");
    console.log("Alps bulk ingestion summary");
    console.log(
      `Routes: ${reconstruction.reconstructed.toLocaleString()} reconstructed, ${reconstruction.rejected.toLocaleString()} rejected`,
    );
    console.log(`Peaks: ${peaks.length.toLocaleString()}`);
    console.log(
      `Peak candidates/evaluations: ${coarsePeakCandidatePairs.toLocaleString()}/${precisePeakMatcherEvaluations.toLocaleString()}`,
    );
    console.log(
      `Summit associations: ${observability.summitAssociations.CONFIRMED.toLocaleString()} confirmed, ${observability.summitAssociations.REVIEW.toLocaleString()} review, ${observability.summitAssociations.REJECTED.toLocaleString()} rejected`,
    );
    console.log(
      `Dedup: ${dedupCandidates.theoreticalPairs.toLocaleString()} theoretical -> ${dedupCandidates.candidatePairs.length.toLocaleString()} candidates -> ${similarityCompared.toLocaleString()} compared (${dedupCandidates.reductionPercentage}% reduction)`,
    );
    console.log(
      `Peak/index RSS delta estimate: ${summary.peakMemoryUsage.approximateDeltaMegabytes} MB`,
    );
    console.log(`Total runtime: ${timings.totalRuntimeMilliseconds} ms`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
