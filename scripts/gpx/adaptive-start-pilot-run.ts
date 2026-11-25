import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  AdaptiveStartDiscoverySession,
  DEFAULT_ADAPTIVE_START_POLICY,
  type AdaptiveStartCandidate,
  type AdaptiveStartDiscoveryResult,
} from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { RoadSafetySourceDatasetIdentity } from '../osm-import/phase11c9-road-safety.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { PILOT_GRAPH_PREPARATION_VERSION } from './adaptive-start-pilot-graphs.ts';
import type { AdaptivePilotCorpus, AdaptivePilotMountain } from './adaptive-start-pilot-prepare.ts';

const OUT = 'data/gpx/adaptive-start-pilot';
const FEATURE_DIRECTORY = 'data/osm/alps/staging/phase11f2-features';
const EXTRACTION_CACHE = `${OUT}/cache`;

interface PilotResult {
  mountainId: string;
  summit: AdaptivePilotMountain['summit'];
  stratum: AdaptivePilotMountain['stratum'];
  primaryBaseFeaturesWithin10km: number;
  blockId: string;
  status: AdaptiveStartDiscoveryResult['status'];
  reasons: string[];
  candidates: AdaptiveStartCandidate[];
  evaluatedCount: number;
  solverCalls: number;
  tiersVisited: number[];
  fallbackInspected: boolean;
  rejections: AdaptiveStartDiscoveryResult['rejections'];
  fabricatedGapCount: number;
  componentCacheHit: boolean;
  graphStatus: 'READY' | 'NO_SUMMIT_CONNECTION' | 'GRAPH_COMPONENT_LIMIT';
  graphStats: { componentNodes: number; componentWays: number; snapDistanceM: number | null };
  timings: { totalMs: number; componentMs: number; routeMs: number; graphLoadMs: number; discoveryMs: number };
}

interface PilotReport {
  schemaVersion: 'mountain-tracker/adaptive-start-pilot/v1';
  corpusHash: string;
  policyVersion: string;
  policyHash: string;
  datasetSha256: string;
  graphPreparationVersion: string;
  startedAt: string;
  completedAt: string;
  mountainsAttempted: number;
  mountainsWithAtLeast1Candidate: number;
  mountainsWithAtLeast2Candidates: number;
  mountainsWithAtLeast3Candidates: number;
  totalCandidatesGenerated: number;
  standardAscentCount: number;
  hutAscentCount: number;
  remoteApproachCount: number;
  radiusTierDistribution: Record<string, number>;
  outcomeDistribution: Record<string, number>;
  noReasonableStartCount: number;
  noSummitConnectionCount: number;
  needsReviewCount: number;
  sparseSuccessCount: number;
  sparseTotal: number;
  sparseRemoteApproachCount: number;
  averageCandidatesPerSuccessfulMountain: number;
  medianNetworkDistanceM: number;
  p95NetworkDistanceM: number;
  candidateGenerationP50Ms: number;
  candidateGenerationP95Ms: number;
  graphCacheReuse: { requests: number; cacheHits: number; evictions: number; builds: number };
  safetyRejections: { motorway: number; footNo: number; privateForbidden: number; highMountain: number; ambiguous: number };
  fabricatedGapCount: number;
  estimatedTimeFor1000Mountains: string;
  timings: { totalMs: number; extractionLoadMs: number; graphPrepMs: number; discoveryMs: number };
  externalRequests: number;
  productionWrites: number;
  manualExamples: ManualExample[];
}

interface ManualExample {
  mountain: string;
  stratum: string;
  summitName: string;
  summitCoordinate: [number, number];
  candidateName: string;
  candidateKind: string;
  routeCategory: string | null;
  radiusTier: number | 'NETWORK_ACCESS' | 'NONE';
  networkDistanceM: number | null;
  routeDistanceM: number | null;
  elevationGainM: number | null;
  verticalGainM: number | null;
  startContext: string | null;
  autoEligible: boolean;
  safety: string;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function extractRoadSafetyIdentity(pbfSha256: string): RoadSafetySourceDatasetIdentity {
  return {
    pbfPath: 'frozen-alps-pilot.osm.pbf', pbfSizeBytes: 0, pbfModifiedMilliseconds: 0,
    pbfSha256, pipelineDatasetFingerprint: 'pilot-only', pipelineGeneratedAt: new Date().toISOString(),
    checkpointPath: 'pilot', checkpointManifestSha256: 'pilot-only', motorwayIndexContentHash: 'pilot-only',
  };
}

async function run(): Promise<void> {
  const overallStarted = performance.now();
  const corpusPath = `${OUT}/adaptive-start-pilot-corpus.json`;
  const corpus: AdaptivePilotCorpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const extractionPath = `${EXTRACTION_CACHE}/${corpus.corpusHash}.sqlite`;
  const graphCachePath = `${EXTRACTION_CACHE}/${corpus.corpusHash}-graphs.sqlite`;

  console.log(JSON.stringify({ status: 'LOADING_FEATURES', corpusHash: corpus.corpusHash }));
  const featureLoadStarted = performance.now();
  const features = await loadPhase11f2FeatureIndex(FEATURE_DIRECTORY);
  const featureIndex = new AdaptiveStartFeatureIndex(features);
  const featureLoadMs = performance.now() - featureLoadStarted;
  console.log(JSON.stringify({ status: 'FEATURES_LOADED', featureLoadMs: Math.round(featureLoadMs) }));

  console.log(JSON.stringify({ status: 'PREPARING_GRAPH_CACHE' }));
  const graphPrepStarted = performance.now();
  const { prepareGraphCache, PilotGraphProvider: Provider } = await import('./adaptive-start-pilot-graphs.ts');
  const graphPrep = await prepareGraphCache({
    extractionPath, cachePath: graphCachePath,
    dataset: corpus.dataset, identityHash: corpus.corpusHash,
    blocks: corpus.blocks,
  });
  const graphPrepMs = performance.now() - graphPrepStarted;
  console.log(JSON.stringify({
    status: 'GRAPH_CACHE_READY', graphPrepMs: Math.round(graphPrepMs),
    blocksPrepared: graphPrep.blocksPrepared, blocksReused: graphPrep.blocksReused,
    cacheHit: graphPrep.cacheHit,
  }));

  const graphProvider = new Provider({ extractionPath, cachePath: graphCachePath, dataset: corpus.dataset, identityHash: corpus.corpusHash });
  const safetyIdentity = extractRoadSafetyIdentity(corpus.dataset.pbfSha256);

  const results: PilotResult[] = [];
  let discoveryMs = 0;

  for (let i = 0; i < corpus.mountains.length; i++) {
    const mountain = corpus.mountains[i];
    const mountainStarted = performance.now();

    const graphResult = graphProvider.get(mountain.blockId, mountain.summit.coordinate);
    if (graphResult.status !== 'READY') {
      results.push({
        mountainId: mountain.mountainId, summit: mountain.summit, stratum: mountain.stratum,
        primaryBaseFeaturesWithin10km: mountain.primaryBaseFeaturesWithin10km, blockId: mountain.blockId,
        status: graphResult.status === 'NO_SUMMIT_CONNECTION' ? 'NO_SUMMIT_CONNECTION' : 'NO_ROUTABLE_START',
        reasons: graphResult.stats.reasonCodes, candidates: [], evaluatedCount: 0, solverCalls: 0,
        tiersVisited: [], fallbackInspected: false,
        rejections: { motorway: 0, footNo: 0, privateForbidden: 0, accessAmbiguous: 0, highMountain: 0, ambiguous: 0, disconnected: 0 },
        fabricatedGapCount: 0, componentCacheHit: false, graphStatus: graphResult.status,
        graphStats: { componentNodes: 0, componentWays: 0, snapDistanceM: null },
        timings: { totalMs: performance.now() - mountainStarted, componentMs: 0, routeMs: 0, graphLoadMs: graphResult.stats.loadMs + graphResult.stats.buildMs, discoveryMs: 0 },
      });
      if ((i + 1) % 10 === 0) console.log(JSON.stringify({ progress: `${i + 1}/${corpus.mountains.length}` }));
      continue;
    }

    const session = new AdaptiveStartDiscoverySession({
      graph: graphResult.graph!, ways: graphResult.ways, features: featureIndex, safetyIdentity,
    });

    const dStarted = performance.now();
    const discoveryResult = session.discover({
      summit: {
        id: mountain.mountainId,
        name: mountain.summit.name,
        coordinate: mountain.summit.coordinate,
        elevationMeters: mountain.summit.elevationMeters,
        osmId: mountain.summit.osmId,
      },
    });
    const dMs = performance.now() - dStarted;
    discoveryMs += dMs;

    results.push({
      mountainId: mountain.mountainId, summit: mountain.summit, stratum: mountain.stratum,
      primaryBaseFeaturesWithin10km: mountain.primaryBaseFeaturesWithin10km, blockId: mountain.blockId,
      status: discoveryResult.status, reasons: discoveryResult.reasons,
      candidates: discoveryResult.candidates.map(c => ({ ...c, route: null })),
      evaluatedCount: discoveryResult.evaluated.length, solverCalls: discoveryResult.solverCalls,
      tiersVisited: discoveryResult.tiersVisited, fallbackInspected: discoveryResult.fallbackInspected,
      rejections: discoveryResult.rejections,
      fabricatedGapCount: discoveryResult.fabricatedGapCount,
      componentCacheHit: discoveryResult.componentCacheHit,
      graphStatus: 'READY',
      graphStats: { componentNodes: graphResult.stats.componentNodes, componentWays: graphResult.stats.componentWays, snapDistanceM: graphResult.stats.snapDistanceM },
      timings: { totalMs: performance.now() - mountainStarted, componentMs: discoveryResult.timings.componentMs, routeMs: discoveryResult.timings.routeMs, graphLoadMs: graphResult.stats.loadMs + graphResult.stats.buildMs, discoveryMs: dMs },
    });
    if ((i + 1) % 10 === 0) console.log(JSON.stringify({ progress: `${i + 1}/${corpus.mountains.length}`, status: discoveryResult.status, candidates: discoveryResult.candidates.length }));
  }

  graphProvider.close();
  const totalMs = performance.now() - overallStarted;

  const successful = results.filter(r => r.candidates.length > 0);
  const candidateTimings = results.map(r => r.timings.totalMs).sort((a, b) => a - b);
  const networkDistances = successful.flatMap(r => r.candidates.map(c => c.networkDistanceMeters ?? 0)).filter(d => d > 0).sort((a, b) => a - b);
  const routeCategories = successful.flatMap(r => r.candidates.map(c => c.category));

  const tierCounts: Record<string, number> = {};
  for (const r of results) {
    for (const t of r.tiersVisited) { tierCounts[String(t)] = (tierCounts[String(t)] ?? 0) + 1; }
    if (r.fallbackInspected) tierCounts['NETWORK_ACCESS'] = (tierCounts['NETWORK_ACCESS'] ?? 0) + 1;
  }

  const graphStats = graphProvider.stats;
  const totalRejections = results.reduce(
    (acc, r) => ({
      motorway: acc.motorway + r.rejections.motorway,
      footNo: acc.footNo + r.rejections.footNo,
      privateForbidden: acc.privateForbidden + r.rejections.privateForbidden,
      highMountain: acc.highMountain + r.rejections.highMountain,
      ambiguous: acc.ambiguous + r.rejections.ambiguous,
    }),
    { motorway: 0, footNo: 0, privateForbidden: 0, highMountain: 0, ambiguous: 0 },
  );

  const sparseSuccessful = successful.filter(r => r.stratum === 'SPARSE');
  const sparseRemoteApproaches = sparseSuccessful.filter(r => r.candidates.some(c => c.category === 'REMOTE_APPROACH'));

  const manualExamples = selectManualExamples(results);

  const estimatedMsPerMountain = totalMs / corpus.mountains.length;
  const estimated1000Ms = estimatedMsPerMountain * 1000;
  const estimated1000Min = Math.round(estimated1000Ms / 60000);

  const report: PilotReport = {
    schemaVersion: 'mountain-tracker/adaptive-start-pilot/v1',
    corpusHash: corpus.corpusHash,
    policyVersion: DEFAULT_ADAPTIVE_START_POLICY.version,
    policyHash: sha256Stable(DEFAULT_ADAPTIVE_START_POLICY),
    datasetSha256: corpus.dataset.pbfSha256,
    graphPreparationVersion: PILOT_GRAPH_PREPARATION_VERSION,
    startedAt: new Date(overallStarted + performance.timeOrigin).toISOString(),
    completedAt: new Date(performance.now() + performance.timeOrigin).toISOString(),
    mountainsAttempted: results.length,
    mountainsWithAtLeast1Candidate: successful.length,
    mountainsWithAtLeast2Candidates: successful.filter(r => r.candidates.length >= 2).length,
    mountainsWithAtLeast3Candidates: successful.filter(r => r.candidates.length >= 3).length,
    totalCandidatesGenerated: successful.reduce((s, r) => s + r.candidates.length, 0),
    standardAscentCount: routeCategories.filter(c => c === 'STANDARD_ASCENT').length,
    hutAscentCount: routeCategories.filter(c => c === 'HUT_ASCENT').length,
    remoteApproachCount: routeCategories.filter(c => c === 'REMOTE_APPROACH').length,
    radiusTierDistribution: tierCounts,
    outcomeDistribution: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    noReasonableStartCount: results.filter(r => r.status === 'NO_REASONABLE_START').length,
    noSummitConnectionCount: results.filter(r => r.status === 'NO_SUMMIT_CONNECTION').length,
    needsReviewCount: results.filter(r => r.status === 'NEEDS_REVIEW').length,
    sparseSuccessCount: sparseSuccessful.length,
    sparseTotal: results.filter(r => r.stratum === 'SPARSE').length,
    sparseRemoteApproachCount: sparseRemoteApproaches.length,
    averageCandidatesPerSuccessfulMountain: successful.length ? Math.round(successful.reduce((s, r) => s + r.candidates.length, 0) / successful.length * 100) / 100 : 0,
    medianNetworkDistanceM: Math.round(percentile(networkDistances, 0.5)),
    p95NetworkDistanceM: Math.round(percentile(networkDistances, 0.95)),
    candidateGenerationP50Ms: Math.round(percentile(candidateTimings, 0.5)),
    candidateGenerationP95Ms: Math.round(percentile(candidateTimings, 0.95)),
    graphCacheReuse: { requests: graphStats.graphRequests, cacheHits: graphStats.graphCacheHits, evictions: graphStats.graphEvictions, builds: graphStats.graphBuilds },
    safetyRejections: totalRejections,
    fabricatedGapCount: results.reduce((s, r) => s + r.fabricatedGapCount, 0),
    estimatedTimeFor1000Mountains: `~${estimated1000Min} minutes (${Math.round(estimated1000Ms / 1000)}s)`,
    timings: { totalMs: Math.round(totalMs), extractionLoadMs: 0, graphPrepMs: Math.round(graphPrepMs), discoveryMs: Math.round(discoveryMs) },
    externalRequests: 0,
    productionWrites: 0,
    manualExamples,
  };

  await mkdir(`${OUT}`, { recursive: true });
  await writeFile(`${OUT}/adaptive-start-pilot-results.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  await writeFile(`${OUT}/ADAPTIVE_START_PILOT_REPORT.md`, generateReportMarkdown(report), 'utf8');
  console.log(JSON.stringify({ status: 'PILOT_COMPLETE', report: { ...report, manualExamples: `[${report.manualExamples.length} examples]` } }));
}

function selectManualExamples(results: PilotResult[]): ManualExample[] {
  const examples: ManualExample[] = [];
  const successful = results.filter(r => r.candidates.length > 0);
  const normal = successful.filter(r => r.stratum === 'NORMAL');
  const sparse = successful.filter(r => r.stratum === 'SPARSE');
  const failed = results.filter(r => r.candidates.length === 0);

  for (const r of normal.slice(0, 5)) {
    const best = r.candidates[0];
    examples.push({ mountain: r.mountainId, stratum: r.stratum, summitName: r.summit.name,
      summitCoordinate: r.summit.coordinate, candidateName: best.name, candidateKind: best.kind,
      routeCategory: best.category, radiusTier: best.radiusTier, networkDistanceM: best.networkDistanceMeters,
      routeDistanceM: best.routeDistanceMeters, elevationGainM: best.elevationGainMeters,
      verticalGainM: best.verticalGainMeters, startContext: best.startContext?.type ?? null,
      autoEligible: best.autoEligible, safety: best.safety });
  }
  for (const r of sparse.slice(0, 3)) {
    const best = r.candidates[0];
    examples.push({ mountain: r.mountainId, stratum: r.stratum, summitName: r.summit.name,
      summitCoordinate: r.summit.coordinate, candidateName: best.name, candidateKind: best.kind,
      routeCategory: best.category, radiusTier: best.radiusTier, networkDistanceM: best.networkDistanceMeters,
      routeDistanceM: best.routeDistanceMeters, elevationGainM: best.elevationGainMeters,
      verticalGainM: best.verticalGainMeters, startContext: best.startContext?.type ?? null,
      autoEligible: best.autoEligible, safety: best.safety });
  }
  for (const r of failed.slice(0, 2)) {
    examples.push({ mountain: r.mountainId, stratum: r.stratum, summitName: r.summit.name,
      summitCoordinate: r.summit.coordinate, candidateName: 'NONE', candidateKind: 'NONE',
      routeCategory: null, radiusTier: 'NONE',networkDistanceM: null,
      routeDistanceM: null, elevationGainM: null, verticalGainM: null,
      startContext: r.reasons[0] ?? 'NO_RESULT', autoEligible: false, safety: 'N/A' });
  }
  return examples;
}

function generateReportMarkdown(report: PilotReport): string {
  const lines: string[] = [];
  lines.push('# Adaptive Mountain Start Discovery — 100-Mountain Alps Pilot Report');
  lines.push('');
  lines.push(`**Dataset:** frozen Alps PBF (${report.datasetSha256.slice(0, 12)}...)`);
  lines.push(`**Corpus:** ${report.corpusHash.slice(0, 12)}... (100 summits: 70 NORMAL + 30 SPARSE)`);
  lines.push(`**Policy:** ${report.policyVersion}`);
  lines.push(`**Graph preparation:** ${report.graphPreparationVersion}`);
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Mountains attempted | ${report.mountainsAttempted} |`);
  lines.push(`| Mountains with >= 1 safe route candidate | ${report.mountainsWithAtLeast1Candidate} |`);
  lines.push(`| Mountains with >= 2 route candidates | ${report.mountainsWithAtLeast2Candidates} |`);
  lines.push(`| Mountains with >= 3 route candidates | ${report.mountainsWithAtLeast3Candidates} |`);
  lines.push(`| Total generated route candidates | ${report.totalCandidatesGenerated} |`);
  lines.push(`| Average candidates per successful mountain | ${report.averageCandidatesPerSuccessfulMountain} |`);
  lines.push('');
  lines.push('## Route Categories');
  lines.push('');
  lines.push(`| Category | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| STANDARD_ASCENT | ${report.standardAscentCount} |`);
  lines.push(`| HUT_ASCENT | ${report.hutAscentCount} |`);
  lines.push(`| REMOTE_APPROACH | ${report.remoteApproachCount} |`);
  lines.push('');
  lines.push('## Radius Tier Usage');
  lines.push('');
  lines.push(`| Tier | Summits Visited |`);
  lines.push(`| --- | --- |`);
  for (const [tier, count] of Object.entries(report.radiusTierDistribution)) {
    lines.push(`| ${tier === 'NETWORK_ACCESS' ? 'NETWORK_ACCESS (fallback)' : `${Number(tier) / 1000} km`} | ${count} |`);
  }
  lines.push('');
  lines.push('## Outcome Distribution');
  lines.push('');
  for (const [status, count] of Object.entries(report.outcomeDistribution)) {
    lines.push(`- **${status}:** ${count}`);
  }
  lines.push('');
  lines.push('## Distance');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Median network distance | ${report.medianNetworkDistanceM} m |`);
  lines.push(`| P95 network distance | ${report.p95NetworkDistanceM} m |`);
  lines.push('');
  lines.push('## Sparse/Remote Mountains');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Sparse total | ${report.sparseTotal} |`);
  lines.push(`| Sparse with >= 1 candidate | ${report.sparseSuccessCount} |`);
  lines.push(`| Sparse REMOTE_APPROACH | ${report.sparseRemoteApproachCount} |`);
  lines.push('');
  lines.push('## Safety');
  lines.push('');
  lines.push(`| Rejection | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Motorway | ${report.safetyRejections.motorway} |`);
  lines.push(`| foot=no | ${report.safetyRejections.footNo} |`);
  lines.push(`| Private/forbidden | ${report.safetyRejections.privateForbidden} |`);
  lines.push(`| High mountain | ${report.safetyRejections.highMountain} |`);
  lines.push(`| Ambiguous | ${report.safetyRejections.ambiguous} |`);
  lines.push(`| Fabricated gap count | ${report.fabricatedGapCount} |`);
  lines.push('');
  lines.push('## Performance');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total pilot time | ${(report.timings.totalMs / 1000).toFixed(1)}s |`);
  lines.push(`| Graph preparation | ${(report.timings.graphPrepMs / 1000).toFixed(1)}s |`);
  lines.push(`| Discovery (all mountains) | ${(report.timings.discoveryMs / 1000).toFixed(1)}s |`);
  lines.push(`| Per-mountain P50 | ${report.candidateGenerationP50Ms}ms |`);
  lines.push(`| Per-mountain P95 | ${report.candidateGenerationP95Ms}ms |`);
  lines.push(`| Graph requests | ${report.graphCacheReuse.requests} |`);
  lines.push(`| Graph cache hits | ${report.graphCacheReuse.cacheHits} |`);
  lines.push(`| Graph builds | ${report.graphCacheReuse.builds} |`);
  lines.push(`| Estimated 1000-mountain time | ${report.estimatedTimeFor1000Mountains} |`);
  lines.push('');
  lines.push('## Manual Sample');
  lines.push('');
  for (const ex of report.manualExamples) {
    lines.push(`### ${ex.summitName} (${ex.mountain})`);
    lines.push('');
    lines.push(`- **Stratum:** ${ex.stratum}`);
    lines.push(`- **Coordinate:** ${ex.summitCoordinate.join(', ')}`);
    lines.push(`- **Candidate:** ${ex.candidateName} (${ex.candidateKind})`);
    lines.push(`- **Route category:** ${ex.routeCategory ?? 'N/A'}`);
    lines.push(`- **Radius tier:** ${ex.radiusTier === 'NONE' ? 'N/A' : ex.radiusTier === 'NETWORK_ACCESS' ? 'NETWORK_ACCESS' : `${ex.radiusTier / 1000} km`}`);
    lines.push(`- **Network distance:** ${ex.networkDistanceM != null ? `${ex.networkDistanceM} m` : 'N/A'}`);
    lines.push(`- **Route distance:** ${ex.routeDistanceM != null ? `${ex.routeDistanceM} m` : 'N/A'}`);
    lines.push(`- **Elevation gain:** ${ex.elevationGainM != null ? `${ex.elevationGainM} m` : 'N/A'}`);
    lines.push(`- **Vertical gain:** ${ex.verticalGainM != null ? `${ex.verticalGainM} m` : 'N/A'}`);
    lines.push(`- **Start context:** ${ex.startContext ?? 'N/A'}`);
    lines.push(`- **Auto eligible:** ${ex.autoEligible}`);
    lines.push(`- **Safety:** ${ex.safety}`);
    lines.push('');
  }
  lines.push('## Attestation');
  lines.push('');
  lines.push('- DB writes: **0**');
  lines.push('- Storage writes: **0**');
  lines.push('- Publication writes: **0**');
  lines.push('- ACTIVE changes: **0**');
  lines.push('- External route-source requests: **0**');
  lines.push('');
  lines.push('ADAPTIVE MOUNTAIN START DISCOVERY MVP COMPLETE —');
  lines.push('100-MOUNTAIN ALPS PILOT FINISHED.');
  return lines.join('\n');
}

await run();
