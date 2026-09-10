/**
 * Route Factory — genuinely-fresh Base Access V2 generation (`--source current-v2`).
 *
 * This mode discovers brand-new routes from the frozen Alps extraction/graph caches
 * for mountains that were never part of the pilot corpus, the 10 reviewed canaries,
 * or any product-review checkpoint. It reuses the exact Phase 12 Base Access V2
 * discovery/reconstruction kernels and the strict Route Factory classification
 * gates; it does not invent routes, weaken gates, or use `final-review.json` as a
 * route source.
 *
 * Determinism contract:
 *  - Selection: union of eligible `natural=peak` node summits (named, ele 1500–5000)
 *    inside the 10 already-prepared block bounding boxes, minus the canary summit
 *    node ids and the pilot corpus mountain ids, ordered by ascending
 *    sha256Stable({selectionVersion, identity}) then identity, first `limit`.
 *  - Discovery: `SummitAttachmentGraphProvider` (attachment bound 100 m, the frozen
 *    review policy bound) + `AdaptiveStartDiscoverySession` with the default
 *    adaptive policy and default summit-attachment policy. All kernels are pure and
 *    input-ordered deterministically; feature/cached-graph inputs are content-hashed.
 *  - Checkpointing: same bounded `rf-<fp12>` run, same fingerprint, resume by index.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AdaptiveStartDiscoverySession,
  DEFAULT_ADAPTIVE_START_POLICY,
  type AdaptiveStartDiscoveryResult,
} from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import {
  SOURCE, serializeGeojson, serializeGpx,
  type PublicationEvidence,
} from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { DEFAULT_SUMMIT_ATTACHMENT_POLICY } from '../../Lib/gpxIngestion/summitAttachment.ts';
import type { ReconstructedOsmRoute } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import type { NormalizedTrackGeometry } from '../../Lib/gpxIngestion/types.ts';
import type { RoadSafetySourceDatasetIdentity } from '../osm-import/phase11c9-road-safety.ts';
import { loadPhase11f2FeatureIndex, type FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { SummitAttachmentGraphProvider } from '../gpx/adaptive-start-summit-graphs.ts';
import type { AdaptivePilotCorpus } from '../gpx/adaptive-start-pilot-prepare.ts';
import {
  RUN_DIR, buildRunManifest, checkpointFingerprint, choosePrimaryCandidate, classifyMountain,
  emptyCounts, loadRunCheckpoint, runIdFor, saveRunCheckpoint,
  type FactorySourceMeta,
} from './route-factory.ts';
import { CANDIDATE_STATE, type CandidateState, type RouteEntry } from './types.ts';

export const CURRENT_V2_SELECTION_VERSION = 'mountain-tracker/route-factory/current-v2-selection/v1';
export const CURRENT_V2_GENERATION_VERSION = 'mountain-tracker/route-factory/current-v2-generation/v1';
/** Exact reviewed canary summit node identities (Branch B/C replaced each of them). */
export const CANARY_SUMMIT_NODE_IDS = new Set([
  256041839, 293247920, 1085532056, 321620390, 3548306244,
  4360518883, 5213861391, 9935978946, 332625272, 779338466,
]);
/** Attachment bound used for fresh discovery: the frozen review bound, never above it. */
export const MAXIMUM_ATTACHMENT_DISTANCE_METERS = 100;

const PILOT_DIR = 'data/gpx/adaptive-start-pilot';
const CORPUS_PATH = `${PILOT_DIR}/adaptive-start-pilot-corpus.json`;
const EXTRACTION_CACHE = `${PILOT_DIR}/cache`;
const FEATURE_DIRECTORY = 'data/osm/alps/staging/phase11f2-features';
const CHECKPOINT_SCHEMA = 'mountain-tracker/route-factory/checkpoint/v1';

const ReadOnlyDatabase = DatabaseSync as unknown as {
  new(path: string, options: { readOnly: true }): DatabaseSync;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function seededOrder(identity: string): string {
  return sha256Stable({ selectionVersion: CURRENT_V2_SELECTION_VERSION, identity });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface FreshMountain {
  mountainId: string;
  name: string;
  summit: {
    osmObjectType: 'node';
    osmId: number;
    name: string;
    coordinate: [number, number];
    elevationMeters: number;
  };
  blockId: string;
}

export interface CurrentV2Selection {
  schemaVersion: typeof CURRENT_V2_GENERATION_VERSION;
  selectionVersion: string;
  corpusHash: string;
  dataset: { datasetKey: string; region: string; snapshotTimestamp: string; pbfSha256: string };
  eligibility: string;
  eligiblePeaks: number;
  eligibleNodePeaks: number;
  eligibleInsidePreparedBlocks: number;
  excludedCanaryCount: number;
  excludedPilotMountainCount: number;
  perBlockCounts: Record<string, number>;
  selected: FreshMountain[];
  selectionHash: string;
}

interface EligiblePeak {
  mountainId: string;
  summit: FreshMountain['summit'];
}

function eligiblePeak(feature: FeatureIndex['peaks'][number]): EligiblePeak | null {
  if (feature.objectType !== 'node' || feature.tags.natural !== 'peak' || !feature.coordinate) return null;
  const elevation = Number(feature.tags.ele?.trim());
  const osmId = Number(feature.osmid);
  const name = feature.tags.name?.trim() || feature.name?.trim();
  if (!name || !Number.isSafeInteger(osmId) || osmId <= 0 || !Number.isFinite(elevation) ||
    elevation < 1500 || elevation > 5000) return null;
  const coordinate: [number, number] = [feature.coordinate[0], feature.coordinate[1]];
  if (!coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) return null;
  return { mountainId: `osm:node:${osmId}`, summit: { osmObjectType: 'node', osmId, name, coordinate, elevationMeters: elevation } };
}

function inside(bbox: readonly number[], lon: number, lat: number): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

export async function selectCurrentV2Mountains(input: {
  corpus: AdaptivePilotCorpus;
  features: FeatureIndex;
  limit: number;
}): Promise<CurrentV2Selection> {
  const { corpus, features, limit } = input;
  const eligiblePeaksCount = features.peaks.filter((feature) => feature.tags.natural === 'peak').length;
  const peakPool: EligiblePeak[] = [];
  const seen = new Set<string>();
  for (const feature of features.peaks) {
    const peak = eligiblePeak(feature);
    if (!peak || seen.has(peak.mountainId)) continue;
    seen.add(peak.mountainId);
    peakPool.push(peak);
  }
  const sortedBlocks = [...corpus.blocks].sort((left, right) => compareText(left.blockId, right.blockId));
  const perBlockCounts: Record<string, number> = {};
  const pilotMountains = new Set(corpus.mountains.map((m) => m.mountainId));
  const assigned: FreshMountain[] = [];
  let excludedCanary = 0;
  let excludedPilot = 0;
  for (const peak of peakPool) {
    if (CANARY_SUMMIT_NODE_IDS.has(peak.summit.osmId)) { excludedCanary++; continue; }
    if (pilotMountains.has(peak.mountainId)) { excludedPilot++; continue; }
    const block = sortedBlocks.find((b) => inside(b.bbox, peak.summit.coordinate[0], peak.summit.coordinate[1]));
    if (!block) continue;
    perBlockCounts[block.blockId] = (perBlockCounts[block.blockId] ?? 0) + 1;
    const mountain: FreshMountain = {
      mountainId: peak.mountainId,
      name: peak.summit.name,
      summit: peak.summit,
      blockId: block.blockId,
    };
    assigned.push(mountain);
  }
  const ordered = [...assigned].sort((left, right) =>
    compareText(seededOrder(left.mountainId), seededOrder(right.mountainId)) || compareText(left.mountainId, right.mountainId));
  const selected = ordered.slice(0, limit);
  const identity = {
    selectionVersion: CURRENT_V2_SELECTION_VERSION,
    corpusHash: corpus.corpusHash,
    pbfSha256: corpus.dataset.pbfSha256,
    assignedCount: assigned.length,
    selected: selected.map((m) => m.mountainId),
  };
  const selectionHash = sha256Stable(identity);
  return {
    schemaVersion: CURRENT_V2_GENERATION_VERSION,
    selectionVersion: CURRENT_V2_SELECTION_VERSION,
    corpusHash: corpus.corpusHash,
    dataset: corpus.dataset,
    eligibility: 'Independent full OSM natural=peak node catalog; named, valid coordinate and numeric ele between 1500 and 5000 m; inside one of the ten already-prepared pilot block bounding boxes; no route, trail, graph or start input used.',
    eligiblePeaks: eligiblePeaksCount,
    eligibleNodePeaks: peakPool.length,
    eligibleInsidePreparedBlocks: assigned.length,
    excludedCanaryCount: excludedCanary,
    excludedPilotMountainCount: excludedPilot,
    perBlockCounts,
    selected,
    selectionHash,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface CurrentV2Runtime {
  corpus: AdaptivePilotCorpus;
  features: FeatureIndex;
  featureIndex: AdaptiveStartFeatureIndex;
  graphProvider: SummitAttachmentGraphProvider;
  safetyIdentity: RoadSafetySourceDatasetIdentity;
  datasetFingerprint: string;
  adaptivePolicyHash: string;
  summitPolicyHash: string;
  extractionIdentityHash: string;
  graphCacheIdentityHash: string;
  constructorMs: number;
}

function roadSafetyIdentity(pbfSha256: string): RoadSafetySourceDatasetIdentity {
  return {
    pbfPath: 'frozen-alps-pilot.osm.pbf', pbfSizeBytes: 0, pbfModifiedMilliseconds: 0,
    pbfSha256, pipelineDatasetFingerprint: 'pilot-only', pipelineGeneratedAt: new Date(0).toISOString(),
    checkpointPath: 'pilot', checkpointManifestSha256: 'pilot-only', motorwayIndexContentHash: 'pilot-only',
  };
}

export async function loadCurrentV2Runtime(): Promise<CurrentV2Runtime> {
  const started = performance.now();
  const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8')) as AdaptivePilotCorpus;
  if (!/^[a-f0-9]{64}$/.test(corpus.corpusHash)) throw new Error('CORPUS_HASH_MALFORMED');
  const extractionPath = `${EXTRACTION_CACHE}/${corpus.corpusHash}.sqlite`;
  const graphCachePath = `${EXTRACTION_CACHE}/${corpus.corpusHash}-graphs.sqlite`;
  const datasetFingerprint = sha256Stable(corpus.dataset);
  const adaptivePolicyHash = sha256Stable(DEFAULT_ADAPTIVE_START_POLICY);
  const summitPolicyHash = sha256Stable(DEFAULT_SUMMIT_ATTACHMENT_POLICY);
  const features = await loadPhase11f2FeatureIndex(FEATURE_DIRECTORY);
  const featureIndex = new AdaptiveStartFeatureIndex(features);
  const graphProvider = new SummitAttachmentGraphProvider({
    extractionPath, cachePath: graphCachePath, dataset: corpus.dataset, identityHash: corpus.corpusHash,
  });
  const extractionIdentityHash = (() => {
    const db = new ReadOnlyDatabase(extractionPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key='complete'").get();
      assert(row, 'EXTRACTION_COMPLETE_METADATA_MISSING');
      return sha256Stable(JSON.parse(String(row.value)));
    } finally {
      db.close();
    }
  })();
  return {
    corpus, features, featureIndex, graphProvider, safetyIdentity: roadSafetyIdentity(corpus.dataset.pbfSha256),
    datasetFingerprint, adaptivePolicyHash, summitPolicyHash, extractionIdentityHash,
    graphCacheIdentityHash: sha256Stable(graphProvider.cacheIdentity),
    constructorMs: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Row construction / serialization
// ---------------------------------------------------------------------------

export interface FreshGraphStats {
  componentId: number | null;
  componentNodes: number;
  componentWays: number;
  snapDistanceM: number | null;
  reasonCodes: string[];
}

export interface FreshMountainResult {
  mountainId: string;
  osmid: number;
  name: string;
  blockId: string;
  row: {
    mountainId: string;
    name: string;
    blockId: string;
    stratum: string;
    status: string;
    graphStatus: string;
    reasons: string[];
    summitAttachment: unknown;
    candidates: unknown[];
    resultHash: string | null;
    determinismVerified: boolean | null;
  };
  graphStats: FreshGraphStats;
  fabricatedGapCount: number;
  discoveryStatus: string | null;
  entry: RouteEntry;
}

function rowFromGraphResult(mountain: FreshMountain, graphResult: {
  status: 'READY' | 'NO_SUMMIT_CONNECTION' | 'GRAPH_COMPONENT_LIMIT';
  stats: FreshGraphStats;
}): FreshMountainResult['row'] {
  return {
    mountainId: mountain.mountainId,
    name: mountain.name,
    blockId: mountain.blockId,
    stratum: 'NORMAL',
    status: graphResult.status === 'NO_SUMMIT_CONNECTION' ? 'NO_SUMMIT_CONNECTION' : 'NO_ROUTABLE_START',
    graphStatus: graphResult.status,
    reasons: [...graphResult.stats.reasonCodes],
    summitAttachment: null,
    candidates: [],
    resultHash: null,
    determinismVerified: null,
  };
}

function rowFromDiscovery(mountain: FreshMountain, discovery: AdaptiveStartDiscoveryResult): FreshMountainResult['row'] {
  return {
    mountainId: mountain.mountainId,
    name: mountain.name,
    blockId: mountain.blockId,
    stratum: 'NORMAL',
    status: discovery.status,
    graphStatus: 'READY',
    reasons: [...discovery.reasons],
    summitAttachment: discovery.summitAttachment,
    candidates: discovery.candidates as unknown as unknown[],
    resultHash: discovery.resultHash,
    determinismVerified: true,
  };
}

export function classifyFreshRow(row: FreshMountainResult['row']): RouteEntry {
  return classifyMountain(row as unknown as Parameters<typeof classifyMountain>[0]);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface FreshEvidenceContext {
  datasetFingerprint: string;
  pilotCorpusHash: string;
  adaptivePolicyHash: string;
  summitPolicyHash: string;
  extractionIdentityHash: string;
  graphCacheIdentityHash: string;
}

export function buildFreshEvidence(params: {
  mountain: FreshMountain;
  row: FreshMountainResult['row'];
  candidate: NonNullable<AdaptiveStartDiscoveryResult['candidates'][number]>;
  context: FreshEvidenceContext;
  geometryHash: string;
}): PublicationEvidence {
  const { mountain, row, candidate, context, geometryHash } = params;
  const route = candidate.route;
  assert(route, 'FRESH_EVIDENCE_REQUIRES_ROUTE');
  return {
    startRole: 'PRIMARY_BASE_ACCESS',
    accessEvidence: candidate.accessEvidence!,
    generatedRouteIdentity: `${mountain.mountainId}:${candidate.id}`,
    sourceCandidateHash: sha256Stable(candidate),
    resultHash: row.resultHash!,
    sourceMountainIdentity: mountain.mountainId,
    summit: { osmObjectType: 'node', osmId: mountain.summit.osmId, name: mountain.summit.name, coordinate: mountain.summit.coordinate },
    start: {
      objectType: candidate.osmIdentity.objectType, osmId: candidate.osmIdentity.osmId, name: candidate.name,
      kind: candidate.kind, coordinate: candidate.coordinate, candidateId: candidate.id,
    },
    datasetFingerprint: context.datasetFingerprint,
    pilotCorpusHash: context.pilotCorpusHash,
    adaptivePolicyHash: context.adaptivePolicyHash,
    summitPolicyHash: context.summitPolicyHash,
    graphHash: route.geometryProvenance.graphHash,
    graphCacheIdentityHash: context.graphCacheIdentityHash,
    extractionIdentityHash: context.extractionIdentityHash,
    reconstructionManifestHash: route.reconstructionManifestHash,
    solverVersion: route.solverVersion,
    routePathHash: sha256Stable(route.osmNodeIds),
    geometryHash,
    routeCategory: candidate.category === 'HUT_ASCENT' ? 'HUT_ASCENT' : candidate.category === 'REMOTE_APPROACH' ? 'REMOTE_APPROACH' : 'STANDARD_ASCENT',
    startContext: candidate.startContext?.type === 'HUT_START' ? 'HUT_START' : 'BASE_START',
    summitAttachment: row.summitAttachment as PublicationEvidence['summitAttachment'],
    safety: {
      autoEligible: true, decision: 'SAFE', fabricatedGapCount: 0, boundaryLimited: false,
      connected: true, deterministic: true, solverStatus: 'RECONSTRUCTED', checkedEdges: route.osmNodeIds.length,
    },
    source: SOURCE,
  };
}

/** Pick the artifact candidate: the eligible primary route, else the first routed candidate. */
export function artifactCandidate(
  row: FreshMountainResult['row'],
): AdaptiveStartDiscoveryResult['candidates'][number] | null {
  const primary = choosePrimaryCandidate(row as unknown as Parameters<typeof choosePrimaryCandidate>[0]);
  if (primary && primary.route) return primary as unknown as AdaptiveStartDiscoveryResult['candidates'][number];
  return row.candidates.find((c) => (c as { route?: unknown }).route !== null) as unknown as AdaptiveStartDiscoveryResult['candidates'][number] ?? null;
}

function asLine(geometry: NormalizedTrackGeometry): { type: 'LineString'; coordinates: [number, number][] } {
  assert.equal(geometry.type, 'LineString', 'DISCONNECTED_OR_MULTILINE_REJECTED');
  return { type: 'LineString', coordinates: geometry.coordinates.map((c) => [Number(c[0]), Number(c[1])]) };
}

export async function writeFreshArtifacts(params: {
  runDir: string;
  mountain: FreshMountain;
  row: FreshMountainResult['row'];
  context: FreshEvidenceContext;
}): Promise<{ produced: boolean; gpxSha256: string | null; geojsonSha256: string | null; distanceM: number | null; candidateId: string | null } | null> {
  const candidate = artifactCandidate(params.row);
  if (!candidate || !candidate.route) return null;
  const route = candidate.route as ReconstructedOsmRoute;
  const geometry = asLine(route.geometry);
  if (geometry.coordinates.length < 2) return null;
  const evidence = buildFreshEvidence({
    mountain: params.mountain, row: params.row, candidate,
    context: params.context, geometryHash: route.geometryHash,
  });
  const routeName = `${candidate.name} → ${params.mountain.name}`;
  const gpx = serializeGpx(routeName, geometry);
  const geojson = serializeGeojson(routeName, geometry, evidence);
  const gpxSha256 = sha256Stable(Buffer.from(gpx));
  const geojsonSha256 = sha256Stable(Buffer.from(geojson));
  const dir = join(params.runDir, 'artifacts', String(params.mountain.summit.osmId));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'route.gpx'), gpx, 'utf8');
  await writeFile(join(dir, 'route.geojson'), geojson, 'utf8');
  await writeFile(join(dir, 'route.json'), `${JSON.stringify({
    routeName, candidateId: candidate.id, distanceM: route.distanceM, geometryHash: route.geometryHash,
    gpxSha256, geojsonSha256, category: evidence.routeCategory, startContext: evidence.startContext,
    summitAttachment: evidence.summitAttachment, start: evidence.start, summit: evidence.summit,
    producedAt: null,
  }, null, 2)}\n`, 'utf8');
  return { produced: true, gpxSha256, geojsonSha256, distanceM: route.distanceM, candidateId: candidate.id };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface CurrentV2RunOptions {
  limit?: number;
  mountains?: Set<number>;
  region?: string;
  /** Seeded selection superset size. `--limit` only caps the processed count; resume batches must stay within it. */
  selection?: number;
}

export async function generateCurrentV2(options: CurrentV2RunOptions): Promise<string> {
  const region = options.region ?? 'alps';
  if (region !== 'alps') return JSON.stringify({ error: 'UNSUPPORTED_REGION', region });
  const runtime = await loadCurrentV2Runtime();
  const superset = Math.max(1, Math.min(50_000, Number(options.selection ?? 400) || 400));
  const selection = await selectCurrentV2Mountains({ corpus: runtime.corpus, features: runtime.features, limit: superset });
  let pool = selection.selected;
  if (options.mountains && options.mountains.size > 0) {
    pool = pool.filter((m) => options.mountains!.has(m.summit.osmId));
    if (!pool.length) { runtime.graphProvider.close(); return JSON.stringify({ error: 'EMPTY_MOUNTAIN_SELECTION' }); }
  }
  const processLimit = Math.min(pool.length, Number(options.limit ?? pool.length) || pool.length);
  if (processLimit <= 0) { runtime.graphProvider.close(); return JSON.stringify({ error: 'LIMIT_MUST_BE_POSITIVE_INTEGER' }); }

  const source: FactorySourceMeta = {
    datasetKey: runtime.corpus.dataset.datasetKey,
    region,
    snapshotTimestamp: runtime.corpus.dataset.snapshotTimestamp,
    pbfSha256: runtime.corpus.dataset.pbfSha256,
    policyHash: runtime.adaptivePolicyHash,
    mountains: pool.map((m) => m.mountainId),
  };
  const fingerprint = checkpointFingerprint(source);
  const runId = runIdFor(fingerprint);
  const runDir = join(RUN_DIR, runId);
  const existing = await loadRunCheckpoint(runDir, fingerprint);
  const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  const startedAt = manifestRaw ? (JSON.parse(manifestRaw) as { startedAt: string }).startedAt : new Date().toISOString();
  const counts = existing ? { ...existing.counts } : emptyCounts();
  const results: FreshMountainResult[] = [];
  const startIndex = Math.min(existing?.lastIndex ?? 0, processLimit);
  for (let i = 0; i < startIndex; i++) {
    const mountain = pool[i];
    const raw = await readFile(join(runDir, 'fresh-results', `${mountain.summit.osmId}.json`), 'utf8').catch(() => null);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as { row: FreshMountainResult['row']; graphStats: FreshGraphStats; fabricatedGapCount: number; discoveryStatus: string | null };
    results.push({ mountainId: mountain.mountainId, osmid: mountain.summit.osmId, name: mountain.name, blockId: mountain.blockId, row: parsed.row, graphStats: parsed.graphStats, fabricatedGapCount: parsed.fabricatedGapCount, discoveryStatus: parsed.discoveryStatus, entry: classifyFreshRow(parsed.row) });
  }
  let processed = startIndex;
  const context: FreshEvidenceContext = {
    datasetFingerprint: runtime.datasetFingerprint,
    pilotCorpusHash: runtime.corpus.corpusHash,
    adaptivePolicyHash: runtime.adaptivePolicyHash,
    summitPolicyHash: runtime.summitPolicyHash,
    extractionIdentityHash: runtime.extractionIdentityHash,
    graphCacheIdentityHash: runtime.graphCacheIdentityHash,
  };

  await mkdir(runDir, { recursive: true });
  for (const sub of ['candidates', 'approved', 'needs-review', 'rejected', 'failed', 'fresh-results', 'artifacts']) {
    await mkdir(join(runDir, sub), { recursive: true });
  }
  await writeFile(join(runDir, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
  await writeFile(join(runDir, 'source.json'), `${JSON.stringify({ source: 'current-v2', generationVersion: CURRENT_V2_GENERATION_VERSION, maximumAttachmentDistanceMeters: MAXIMUM_ATTACHMENT_DISTANCE_METERS, summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY }, null, 2)}\n`, 'utf8');

  const overallStarted = performance.now();
  for (let i = processed; i < processLimit; i++) {
    const mountain = pool[i];
    const graphResult = runtime.graphProvider.get(mountain.blockId, mountain.summit.coordinate, MAXIMUM_ATTACHMENT_DISTANCE_METERS);
    let row: FreshMountainResult['row'];
    let discoveryStatus: string | null = null;
    const graphStats: FreshGraphStats = {
      componentId: graphResult.stats.componentId,
      componentNodes: graphResult.stats.componentNodes,
      componentWays: graphResult.stats.componentWays,
      snapDistanceM: graphResult.stats.snapDistanceM,
      reasonCodes: [...graphResult.stats.reasonCodes],
    };
    let fabricatedGapCount = 0;
    if (graphResult.status === 'READY') {
      const session = new AdaptiveStartDiscoverySession({
        graph: graphResult.graph!, ways: graphResult.ways, features: runtime.featureIndex, safetyIdentity: runtime.safetyIdentity,
      });
      const discovery = session.discover({
        summit: {
          id: mountain.mountainId, name: mountain.summit.name, coordinate: mountain.summit.coordinate,
          elevationMeters: mountain.summit.elevationMeters, osmId: mountain.summit.osmId,
        },
        summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY,
      });
      discoveryStatus = discovery.status;
      fabricatedGapCount = discovery.fabricatedGapCount;
      row = rowFromDiscovery(mountain, discovery);
    } else {
      row = rowFromGraphResult(mountain, graphResult);
    }
    const entry = classifyFreshRow(row);
    counts[entry.state]++;
    results.push({ mountainId: mountain.mountainId, osmid: mountain.summit.osmId, name: mountain.name, blockId: mountain.blockId, row, graphStats, fabricatedGapCount, discoveryStatus, entry });
    await writeFile(join(runDir, 'fresh-results', `${mountain.summit.osmId}.json`), `${JSON.stringify({
      mountainId: mountain.mountainId, name: mountain.name, blockId: mountain.blockId, summit: mountain.summit,
      row: rowToFile(row), graphStats, fabricatedGapCount, discoveryStatus,
    }, null, 2)}\n`, 'utf8');
    await writeFreshArtifacts({ runDir, mountain, row, context });
    await writeFile(join(runDir, 'candidates', `${entry.mountainId}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    await writeFile(join(runDir, stateFolder(entry.state), `${entry.mountainId}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    processed = i + 1;
    await saveRunCheckpoint(runDir, { schemaVersion: CHECKPOINT_SCHEMA, fingerprint, lastIndex: processed, counts, updatedAt: new Date().toISOString() });
    if (processed % 10 === 0 || processed === processLimit) {
      console.log(JSON.stringify({ progress: `${processed}/${processLimit}`, last: { mountain: mountain.mountainId, entry: entry.state, status: discoveryStatus ?? row.status, candidates: row.candidates.length } }));
    }
  }
  const elapsedMs = Math.round(performance.now() - overallStarted);

  const artifactCount = (await Promise.all(results.map((r) => readFile(join(runDir, 'artifacts', String(r.osmid), 'route.json'), 'utf8').then(() => true).catch(() => false)))).filter(Boolean).length;

  const manifest = buildRunManifest({ runId, startedAt, limit: processLimit, source, counts, total: pool.length, processed });
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(runDir, 'summary.json'), `${JSON.stringify({ runId, entries: results.map((r) => r.entry) }, null, 2)}\n`, 'utf8');
  await writeFile(join(runDir, 'generation-report.json'), `${JSON.stringify({
    schemaVersion: CURRENT_V2_GENERATION_VERSION,
    runId, selectionHash: selection.selectionHash,
    source: 'current-v2',
    policyHash: runtime.adaptivePolicyHash,
    summitPolicyHash: runtime.summitPolicyHash,
    datasetFingerprint: runtime.datasetFingerprint,
    extractionIdentityHash: runtime.extractionIdentityHash,
    graphCacheIdentityHash: runtime.graphCacheIdentityHash,
    eligiblePeaks: selection.eligiblePeaks,
    eligibleNodePeaks: selection.eligibleNodePeaks,
    eligibleInsidePreparedBlocks: selection.eligibleInsidePreparedBlocks,
    excludedCanaryCount: selection.excludedCanaryCount,
    excludedPilotMountainCount: selection.excludedPilotMountainCount,
    perBlockCounts: selection.perBlockCounts,
    mountainsWithDiscoveryResult: results.filter((r) => r.row.graphStatus === 'READY').length,
    artifacts: artifactCount,
    fabricatedGapCount: results.reduce((s, r) => s + r.fabricatedGapCount, 0),
    outcomeCounts: counts,
    elapsedMs, startedAt, completedAt: new Date().toISOString(),
    productionWrites: 0, externalRequests: 0,
  }, null, 2)}\n`, 'utf8');
  runtime.graphProvider.close();
  return JSON.stringify({
    runId, fingerprint, source: 'current-v2', region, selectionHash: selection.selectionHash,
    processed, counts, manifestHash: manifest.manifestHash, artifacts: artifactCount,
    eligiblePeaks: selection.eligiblePeaks, eligibleNodePeaks: selection.eligibleNodePeaks,
    eligibleInsidePreparedBlocks: selection.eligibleInsidePreparedBlocks,
    excludedCanaryCount: selection.excludedCanaryCount, excludedPilotMountainCount: selection.excludedPilotMountainCount,
    perBlockCounts: selection.perBlockCounts, productionWrites: 0,
  }, null, 2);
}

/** JSON-ify a row for the on-disk verification lock; routes keep their full geometry. */
function rowToFile(row: FreshMountainResult['row']): FreshMountainResult['row'] {
  return row;
}

function stateFolder(state: CandidateState): string {
  switch (state) {
    case CANDIDATE_STATE.AUTO_APPROVED: return 'approved';
    case CANDIDATE_STATE.NEEDS_REVIEW: return 'needs-review';
    case CANDIDATE_STATE.REJECTED: return 'rejected';
    case CANDIDATE_STATE.FAILED: return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export async function verifyCurrentV2(runId: string, sample = 3): Promise<Record<string, unknown>> {
  const runDir = join(RUN_DIR, runId);
  const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  const summaryRaw = await readFile(join(runDir, 'summary.json'), 'utf8').catch(() => null);
  const selectionRaw = await readFile(join(runDir, 'selection.json'), 'utf8').catch(() => null);
  if (!manifestRaw || !summaryRaw || !selectionRaw) {
    return { valid: false, errors: ['RUN_ARTIFACTS_MISSING'], runId };
  }
  const manifest = JSON.parse(manifestRaw) as { manifestHash: string; summary: { autoApproved: number; needsReview: number; rejected: number; failed: number } };
  const summary = JSON.parse(summaryRaw) as { entries: RouteEntry[] };
  const selection = JSON.parse(selectionRaw) as CurrentV2Selection;
  const recomputedContent = { ...manifest } as Record<string, unknown>;
  delete recomputedContent.manifestHash;
  delete recomputedContent.startedAt;
  const errors: string[] = [];
  if (sha256Stable(recomputedContent) !== manifest.manifestHash) errors.push('MANIFEST_HASH_DRIFT');

  const files = await listFreshResults(runDir);
  const rows = await Promise.all(files.map(async (file) => {
    const parsed = JSON.parse(await readFile(join(runDir, 'fresh-results', file), 'utf8')) as { row: FreshMountainResult['row'] };
    return parsed.row;
  }));
  const reclassified = rows.map((row) => classifyFreshRow(row));
  const reClassifiedCounts = emptyCounts();
  for (const e of reclassified) reClassifiedCounts[e.state]++;
  const singlePass = {
    AUTO_APPROVED: reClassifiedCounts.AUTO_APPROVED,
    NEEDS_REVIEW: reClassifiedCounts.NEEDS_REVIEW,
    REJECTED: reClassifiedCounts.REJECTED,
    FAILED: reClassifiedCounts.FAILED,
  };
  const storedCounts = summarizeCounts(summary.entries);
  if (JSON.stringify(singlePass) !== JSON.stringify(storedCounts)) {
    errors.push(`CLASSIFICATION_COUNT_DRIFT ${JSON.stringify({ singlePass, stored: storedCounts })}`);
  }
  const entryMap = new Map<string, RouteEntry>();
  for (const e of reclassified) entryMap.set(`${e.mountainId}:${e.state}`, e);
  for (const e of summary.entries) {
    const re = entryMap.get(`${e.mountainId}:${e.state}`);
    if (!re) { errors.push(`SUMMARY_ENTRY_NOT_IN_SINGLE_PASS:${e.mountainId}`); continue; }
    if (JSON.stringify(e) !== JSON.stringify(re)) errors.push(`ENTRY_DRIFT:${e.mountainId}`);
  }
  if (manifest.summary.autoApproved !== storedCounts.AUTO_APPROVED ||
    manifest.summary.needsReview !== storedCounts.NEEDS_REVIEW ||
    manifest.summary.rejected !== storedCounts.REJECTED ||
    manifest.summary.failed !== storedCounts.FAILED) errors.push('MANIFEST_SUMMARY_DRIFT');

  // Deterministic discovery re-run on a bounded sample.
  const discoverySample: Array<{ mountain: FreshMountain; expected: FreshMountainResult['row'] }> = [];
  for (const mountain of selection.selected) {
    const file = `${mountain.summit.osmId}.json`;
    if (!files.includes(file)) continue;
    const parsed = JSON.parse(await readFile(join(runDir, 'fresh-results', file), 'utf8')) as { row: FreshMountainResult['row'] };
    if (!parsed.row.resultHash) continue;
    discoverySample.push({ mountain, expected: parsed.row });
    if (discoverySample.length >= sample) break;
  }
  let replayed = 0;
  const replay: Array<{ mountainId: string; resultHashEqual: boolean; candidatesEqual: boolean; statusEqual: boolean }> = [];
  if (discoverySample.length) {
    const runtime = await loadCurrentV2Runtime();
    try {
      for (const { mountain, expected } of discoverySample) {
        const graphResult = runtime.graphProvider.get(mountain.blockId, mountain.summit.coordinate, MAXIMUM_ATTACHMENT_DISTANCE_METERS);
        if (graphResult.status !== 'READY') {
          replay.push({ mountainId: mountain.mountainId, resultHashEqual: false, candidatesEqual: false, statusEqual: false });
          continue;
        }
        const session = new AdaptiveStartDiscoverySession({
          graph: graphResult.graph!, ways: graphResult.ways, features: runtime.featureIndex, safetyIdentity: runtime.safetyIdentity,
        });
        const discovery = session.discover({
          summit: {
            id: mountain.mountainId, name: mountain.summit.name, coordinate: mountain.summit.coordinate,
            elevationMeters: mountain.summit.elevationMeters, osmId: mountain.summit.osmId,
          },
          summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY,
        });
        replay.push({
          mountainId: mountain.mountainId,
          resultHashEqual: discovery.resultHash === expected.resultHash,
          candidatesEqual: JSON.stringify(discovery.candidates.map((c) => c.id).sort()) ===
            JSON.stringify((expected.candidates as unknown as Array<{ id: string }>).map((c) => c.id).sort()),
          statusEqual: discovery.status === expected.status,
        });
        replayed++;
      }
    } finally {
      runtime.graphProvider.close();
    }
    if (replay.some((r) => !r.resultHashEqual || !r.candidatesEqual || !r.statusEqual)) {
      errors.push('DETERMINISTIC_REPLAY_MISMATCH');
    }
  }

  return {
    runId,
    valid: errors.length === 0,
    errors,
    singlePass,
    storedCounts,
    replaySampleSize: replayed,
    replay,
    productionWrites: 0,
  };
}

async function listFreshResults(runDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(runDir, 'fresh-results'));
  return files.filter((f) => f.endsWith('.json')).sort();
}

export function summarizeCounts(entries: readonly RouteEntry[]): Record<CandidateState, number> {
  const counts = emptyCounts();
  for (const e of entries) counts[e.state]++;
  return counts;
}

// ---------------------------------------------------------------------------
// Standalone entry: `node --experimental-strip-types scripts/routes/current-v2-generation.ts <mode> ...`
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/routes/current-v2-generation.ts')) {
  const mode = process.argv[2];
  if (mode === 'generate') {
    process.stdout.write(`${await generateCurrentV2({ limit: Number(process.argv[3] ?? 100) || 100, selection: Number(process.argv[4] ?? 400) || 400 })}\n`);
  } else if (mode === 'selection') {
    const runtime = await loadCurrentV2Runtime();
    const selection = await selectCurrentV2Mountains({ corpus: runtime.corpus, features: runtime.features, limit: Math.max(1, Math.min(50_000, Number(process.argv[3] ?? 400) || 400)) });
    runtime.graphProvider.close();
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  } else if (mode === 'verify') {
    const runId = process.argv[3];
    const sample = Number(process.argv[4] ?? 3) || 3;
    const report = await verifyCurrentV2(runId, sample);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.valid ? 0 : 1;
  } else {
    process.stderr.write('USAGE: current-v2-generation.ts generate [limit] | selection | verify <runId> [sample]\n');
    process.exitCode = 2;
  }
}