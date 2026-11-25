/** Freeze one independent summit-only corpus before any route results exist. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  AdaptiveStartFeatureIndex,
  type AdaptiveStartFeatureKind,
} from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { OsmTrailDatasetIdentity } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';

const OUT = 'data/gpx/adaptive-start-pilot';
const FEATURE_DIRECTORY = 'data/osm/alps/staging/phase11f2-features';
const DATASET_PATH = 'data/osm/source/alps-latest.osm.pbf';
const SELECTION_VERSION = 'mountain-tracker/adaptive-start-pilot-selection/v1';
const EXPECTED_PBF_SHA256 = '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5';
const PRIMARY_BASE_KINDS = new Set<AdaptiveStartFeatureKind>([
  'TRAILHEAD', 'TRAILHEAD_INFO', 'PARKING', 'VILLAGE', 'HAMLET',
  'TRAIN_STATION', 'HALT', 'BUS_STOP',
]);
const FEATURE_FILES = [
  'alpine-huts', 'wilderness-huts', 'mountain-passes', 'saddles', 'ridges',
  'peaks', 'trailheads', 'trailhead-info', 'parking', 'villages', 'hamlets',
  'isolated-dwellings', 'farms', 'bus-stops', 'stations', 'halts', 'ele-nodes',
];

export interface AdaptivePilotMountain {
  mountainId: string;
  summit: {
    osmObjectType: 'node' | 'way' | 'relation';
    osmId: number;
    name: string;
    coordinate: [number, number];
    elevationMeters: number;
  };
  stratum: 'NORMAL' | 'SPARSE';
  primaryBaseFeaturesWithin10km: number;
  blockId: string;
}

export interface AdaptivePilotBlock {
  blockId: string;
  cell: [number, number];
  stratum: AdaptivePilotMountain['stratum'];
  bbox: [number, number, number, number];
  mountainIds: string[];
}

export interface AdaptivePilotCorpus {
  schemaVersion: string;
  selectionVersion: string;
  dataset: OsmTrailDatasetIdentity;
  datasetPath: string;
  datasetSizeBytes: number;
  featureSources: Array<{ path: string; sha256: string; sizeBytes: number }>;
  selection: Record<string, unknown>;
  blocks: AdaptivePilotBlock[];
  mountains: AdaptivePilotMountain[];
  corpusHash: string;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function seededOrder(identity: string): string {
  return sha256Stable({ selectionVersion: SELECTION_VERSION, identity });
}

function percentile(sorted: number[], proportion: number): number {
  return sorted[Math.floor((sorted.length - 1) * proportion)];
}

interface DensityPeak {
  mountainId: string;
  summit: AdaptivePilotMountain['summit'];
  density: number;
  cell: [number, number];
}

/** Full 52 km spherical search halo around the chosen summit extent. */
function blockBounds(peaks: DensityPeak[]): AdaptivePilotBlock['bbox'] {
  const angularRadius = 52_000 / 6_371_000;
  const latitudeMargin = angularRadius * 180 / Math.PI;
  const minLatitude = Math.min(...peaks.map(peak => peak.summit.coordinate[1]));
  const maxLatitude = Math.max(...peaks.map(peak => peak.summit.coordinate[1]));
  const longitudeMargin = Math.asin(Math.sin(angularRadius) /
    Math.cos(Math.max(Math.abs(minLatitude), Math.abs(maxLatitude)) * Math.PI / 180)) * 180 / Math.PI;
  const roundOut = (value: number, upper: boolean) =>
    (upper ? Math.ceil(value * 1e7) : Math.floor(value * 1e7)) / 1e7;
  return [
    roundOut(Math.min(...peaks.map(peak => peak.summit.coordinate[0])) - longitudeMargin, false),
    roundOut(minLatitude - latitudeMargin, false),
    roundOut(Math.max(...peaks.map(peak => peak.summit.coordinate[0])) + longitudeMargin, true),
    roundOut(maxLatitude + latitudeMargin, true),
  ];
}

export async function prepareAdaptiveStartPilot(): Promise<void> {
  const started = performance.now();
  const datasetSizeBytes = (await stat(DATASET_PATH)).size;
  const pbfSha256 = await fileHash(DATASET_PATH);
  if (pbfSha256 !== EXPECTED_PBF_SHA256) throw new Error('Frozen Alps PBF differs from the recovered Phase 12E snapshot.');
  const featureSources: AdaptivePilotCorpus['featureSources'] = [];
  // Validate every file explicitly: the legacy loader otherwise treats absent files as empty.
  for (const file of FEATURE_FILES) {
    const path = `${FEATURE_DIRECTORY}/${file}.json`;
    featureSources.push({ path, sha256: await fileHash(path), sizeBytes: (await stat(path)).size });
  }
  const features = await loadPhase11f2FeatureIndex(FEATURE_DIRECTORY);
  const index = new AdaptiveStartFeatureIndex(features);
  const peaks: DensityPeak[] = [];
  const seenPeaks = new Set<string>();
  for (const feature of features.peaks) {
    const elevation = Number(feature.tags.ele?.trim());
    const osmId = Number(feature.osmid);
    const name = feature.tags.name?.trim() || feature.name?.trim();
    if (feature.tags.natural !== 'peak' || !feature.coordinate || !name ||
      !Number.isSafeInteger(osmId) || osmId <= 0 || !Number.isFinite(elevation) ||
      elevation < 1500 || elevation > 5000) continue;
    const mountainId = `osm:${feature.objectType}:${osmId}`;
    if (seenPeaks.has(mountainId)) continue;
    seenPeaks.add(mountainId);
    const coordinate: [number, number] = [feature.coordinate[0], feature.coordinate[1]];
    if (!coordinate.every(Number.isFinite) || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) continue;
    peaks.push({
      mountainId,
      summit: { osmObjectType: feature.objectType, osmId, name, coordinate, elevationMeters: elevation },
      density: index.queryStarts(coordinate, 10_000).filter(candidate => PRIMARY_BASE_KINDS.has(candidate.kind)).length,
      cell: [Math.floor(coordinate[0] * 10), Math.floor(coordinate[1] * 10)],
    });
    if (peaks.length % 5000 === 0) console.log(JSON.stringify({ eligiblePeakDensities: peaks.length }));
  }
  const densities = peaks.map(peak => peak.density).sort((left, right) => left - right);
  const sparseThreshold = percentile(densities, 0.25);
  const normalThreshold = percentile(densities, 0.5);
  if (!(sparseThreshold < normalThreshold)) throw new Error('Independent density strata do not separate.');
  const blocks: AdaptivePilotBlock[] = [];
  const mountains: AdaptivePilotMountain[] = [];
  const usedCells = new Set<string>();
  const blockPoolCounts: Record<string, number> = {};
  for (const [stratum, blockCount] of [['NORMAL', 7], ['SPARSE', 3]] as const) {
    const grouped = new Map<string, DensityPeak[]>();
    for (const peak of peaks) {
      if (stratum === 'NORMAL' ? peak.density < normalThreshold : peak.density > sparseThreshold) continue;
      const key = peak.cell.join(':');
      const group = grouped.get(key) ?? [];
      group.push(peak);
      grouped.set(key, group);
    }
    const eligibleBlocks = [...grouped.entries()]
      .filter(([key, group]) => group.length >= 10 && !usedCells.has(key))
      .sort(([, left], [, right]) => left[0].cell[0] - right[0].cell[0] || left[0].cell[1] - right[0].cell[1]);
    blockPoolCounts[stratum] = eligibleBlocks.length;
    if (eligibleBlocks.length < blockCount) throw new Error(`Insufficient independent ${stratum} blocks.`);
    for (let bin = 0; bin < blockCount; bin++) {
      const longitudeBin = eligibleBlocks.slice(
        Math.floor(bin * eligibleBlocks.length / blockCount),
        Math.floor((bin + 1) * eligibleBlocks.length / blockCount),
      );
      longitudeBin.sort(([left], [right]) => compareText(
        seededOrder(`${stratum}:block:${left}`), seededOrder(`${stratum}:block:${right}`),
      ) || compareText(left, right));
      const [cellKey, available] = longitudeBin[0];
      usedCells.add(cellKey);
      const selected = [...available].sort((left, right) =>
        compareText(seededOrder(left.mountainId), seededOrder(right.mountainId)) || compareText(left.mountainId, right.mountainId),
      ).slice(0, 10);
      const blockId = `${stratum.toLowerCase()}-${bin + 1}-${cellKey.replace(':', '-')}`;
      blocks.push({ blockId, cell: selected[0].cell, stratum, bbox: blockBounds(selected), mountainIds: selected.map(peak => peak.mountainId) });
      mountains.push(...selected.map(peak => ({
        mountainId: peak.mountainId,
        summit: peak.summit,
        stratum,
        primaryBaseFeaturesWithin10km: peak.density,
        blockId,
      })));
    }
  }
  if (mountains.length !== 100 || new Set(mountains.map(mountain => mountain.mountainId)).size !== 100) {
    throw new Error('Pilot must contain exactly 100 unique summits.');
  }
  const manifest = {
    schemaVersion: 'mountain-tracker/adaptive-start-pilot-corpus/v1',
    selectionVersion: SELECTION_VERSION,
    dataset: {
      datasetKey: 'openstreetmap-odbl-geofabrik-alps',
      region: 'alps',
      snapshotTimestamp: '2026-08-24T21:21:08.000Z',
      pbfSha256,
    },
    datasetPath: DATASET_PATH,
    datasetSizeBytes,
    featureSources,
    selection: {
      summitEligibility: 'Independent full OSM natural=peak catalog; named, valid coordinate and numeric ele between 1500 and 5000 m; no route, trail, graph or start input used.',
      eligibleSummitCount: peaks.length,
      density: 'Count unique true primary BASE feature identities within exact 10000 m haversine radius; public-access or route reachability are not selection inputs.',
      primaryBaseKinds: [...PRIMARY_BASE_KINDS],
      densityQuantiles: Object.fromEntries([0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(q => [String(q), percentile(densities, q)])),
      normal: { count: 70, minimumDensity: normalThreshold, definition: 'At or above global eligible-summit median primary BASE density.' },
      sparse: { count: 30, maximumDensity: sparseThreshold, definition: 'At or below global eligible-summit lower quartile primary BASE density; relative sparsity does not assert absent POIs within20 km.' },
      geographicSampling: '0.1-degree cells with >=10 peaks in the relevant density stratum. Sort cells by longitude then latitude, divide into 7 NORMAL /3 SPARSE equal-count geographic bins, select minimum seeded SHA256 cell per bin; select10 minimum seeded SHA256 summit identities per cell. SPARSE excludes previously used NORMAL cells.',
      eligibleBlockCounts: blockPoolCounts,
      seedContract: 'sha256Stable({selectionVersion,identity}); ascending lexical SHA256, then identity.',
      blockCellDegrees: 0.1,
      extractionHaloMeters: 52_000,
      extractionBounds: 'Selected summit extent plus conservative52 km spherical halo; full selected highway ways retained. Bounded regional graph, not an exhaustive100 km route-coverage claim.',
      featureIndexVersion: index.schemaVersion,
      routeTruthInputs: 0,
      manualStartInputs: 0,
    },
    blocks,
    mountains,
  };
  const corpus: AdaptivePilotCorpus = { ...manifest, corpusHash: sha256Stable(manifest) };
  await mkdir(OUT, { recursive: true });
  const corpusPath = `${OUT}/adaptive-start-pilot-corpus.json`;
  try {
    await writeFile(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = JSON.parse(await readFile(corpusPath, 'utf8')) as AdaptivePilotCorpus;
    if (sha256Stable(existing) !== sha256Stable(corpus)) throw new Error('Existing corpus differs. Do not change a frozen pilot corpus.');
  }
  const report = {
    corpusHash: corpus.corpusHash,
    mountains: mountains.length,
    normal: mountains.filter(mountain => mountain.stratum === 'NORMAL').length,
    sparse: mountains.filter(mountain => mountain.stratum === 'SPARSE').length,
    blocks: blocks.length,
    densityQuantiles: manifest.selection.densityQuantiles,
    eligibleBlockCounts: blockPoolCounts,
    featureIndex: index.stats,
    elapsedSeconds: Math.round((performance.now() - started) / 1000 * 1000) / 1000,
    corpusFrozenBeforeRouteEvaluation: true,
    externalRequests: 0,
    productionWrites: 0,
  };
  await writeFile(`${OUT}/adaptive-start-pilot-preparation.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/adaptive-start-pilot-prepare.ts')) {
  await prepareAdaptiveStartPilot();
}
