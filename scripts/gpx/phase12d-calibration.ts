import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRouteDiscoverySignal, type RouteDiscoverySignal } from '../../Lib/gpxIngestion/routeDiscovery.ts';
import { resolveOsmAnchor, type OsmAnchorFeature, type OsmAnchorResolution } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';

export const OUTPUT = 'data/gpx/phase12d';
export const SIGNAL_VERSION = 'phase12d/semantic-extraction/v1';
export const REGION_VERSION = 'phase12d/anchor-envelope-0.025deg/v1';
export const QUALIFIER_RESOLVER_VERSION = 'phase12d/exact-name-qualifier-fallback/v2';
export function withoutTrailingQualifier(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').replace(/,\s*[^,]+$/, '').trim();
}
export const TAXONOMY = ['SIGNAL_INSUFFICIENT', 'ANCHOR_START_NOT_FOUND', 'ANCHOR_START_AMBIGUOUS',
  'ANCHOR_VIA_NOT_FOUND', 'ANCHOR_VIA_AMBIGUOUS', 'ANCHOR_SUMMIT_NOT_FOUND', 'ANCHOR_SUMMIT_AMBIGUOUS',
  'SNAP_FAILED', 'GRAPH_REGION_EMPTY', 'GRAPH_DISCONNECTED', 'NO_ROUTE', 'SEARCH_LIMIT_EXCEEDED',
  'HARD_ACCESS_BLOCKED', 'START_HIGH_MOUNTAIN', 'START_AMBIGUOUS', 'SUMMIT_TERMINATION_FAILED',
  'MATCH_EXACT', 'MATCH_NEAR', 'MATCH_SAME_VARIANT', 'MATCH_DIFFERENT_VARIANT', 'MATCH_UNRELATED', 'INTERNAL_ERROR'] as const;
export type Facts = { relationTags: Record<string, string | null>; summits: { id: string; name: string | null }[] };
export interface Member {
  relationId: string; machineGreen: boolean; humanApproved: boolean; split: 'TRAIN' | 'HOLDOUT' | null;
  negativeReasons: string[]; facts: Facts; factsHash: string;
  labels: { startContext: string; qualityScore: number | null; qualityBand: string; distanceM: number | null; verticalGainM: number | null };
  truthReference: string;
}
export interface Corpus {
  schemaVersion: string; datasetSha256: string; splitHash: string; sourceArtifacts: Record<string, string>;
  counts: { humanGold: number; extendedGreen: number; negative: number; unique: number };
  phase12cLimitations: string[]; records: Member[]; acceptanceCriteria: Record<string, number | string | boolean>;
}
export interface SignalInput {
  signal: RouteDiscoverySignal | null; contributedFields: string[]; reason: string | null;
}
export const normalizeName = (value: string) => value.normalize('NFKC').toLocaleLowerCase('und').replaceAll(/\s+/g, ' ').trim();

// This function cannot see labels, endpoint coordinates, member ways, or comparison truth.
export function extractSignal(relationId: string, facts: Facts): SignalInput {
  if (facts.summits.length !== 1 || !facts.summits[0].name) {
    return { signal: null, contributedFields: [], reason: 'SINGLE_NAMED_SUMMIT_REQUIRED' };
  }
  const summit = facts.summits[0].name;
  const tags = facts.relationTags;
  let start = tags.from?.trim() || null;
  const contributedFields = ['confirmedSummits.peakSourceId', 'confirmedSummits.peakName'];
  if (start) {
    contributedFields.push('relation.tags.from');
    if (normalizeName(start) === normalizeName(summit)) {
      start = tags.to?.trim() || null;
      contributedFields.push('relation.tags.to');
    }
  } else if (tags.name) {
    const parts = tags.name.split(/\s+(?:-|–|—|→)\s+/).map(x => x.trim());
    if (parts.length === 2) {
      if (normalizeName(parts[1]) === normalizeName(summit)) start = parts[0];
      else if (normalizeName(parts[0]) === normalizeName(summit)) start = parts[1];
      if (start) contributedFields.push('relation.tags.name (two named endpoints; exact summit)');
    }
  }
  if (!start || normalizeName(start) === normalizeName(summit)) {
    return { signal: null, contributedFields, reason: 'NO_NON_GEOMETRIC_START_NAME' };
  }
  if (tags.name) contributedFields.push('relation.tags.name (variant hint only)');
  if (tags.route) contributedFields.push('relation.tags.route');
  try { return { signal: createRouteDiscoverySignal({
    signalId: `phase12d:${relationId}`, sourceKey: 'openstreetmap', sourceReference: `osm:relation:${relationId}`,
    observedAt: '2026-08-24T21:21:08.000Z', mountainIdentity: { name: summit, regionName: null, countryCode: null },
    routeVariantName: tags.name || null, activityType: tags.route === 'foot' ? 'WALKING' : 'HIKING',
    startHint: { name: start, expectedTypes: [], regionName: null }, viaHints: [],
    summitHint: { name: summit, expectedTypes: ['SUMMIT'], regionName: null }, terminalHint: null,
    routeShapeHint: 'ONE_WAY', directionHint: 'ascent', sourcePolicyStatus: 'ALLOWED', signalConfidence: 0.8,
  }), contributedFields, reason: null }; } catch (error) {
    return { signal: null, contributedFields, reason: `SIGNAL_VALIDATION:${(error as Error).message}` };
  }
}

export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export async function writeImmutable(path: string, value: unknown): Promise<void> {
  let existing: unknown;
  try { existing = await readJson(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  if (sha256Stable(existing) !== sha256Stable(value)) throw new Error(`INCOMPATIBLE_EXISTING_ARTIFACT:${path}`);
}

interface FeatureRecord { objectType: 'node' | 'way' | 'relation'; osmid: string; coordinate: [number, number] | null; tags: Record<string, string> }
export interface PlanRecord extends SignalInput {
  relationId: string; start: OsmAnchorResolution | null; summit: OsmAnchorResolution | null;
  bbox: [number, number, number, number] | null;
}
export interface Plan { identity: Record<string, string>; records: PlanRecord[]; planHash: string }

export async function makePlan(qualifierFallback = false): Promise<void> {
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  const signals = corpus.records.map(m => ({ relationId: m.relationId, ...extractSignal(m.relationId, m.facts) }));
  const wanted = new Set(signals.flatMap(s => s.signal ? [normalizeName(s.signal.startHint.name), normalizeName(s.signal.summitHint.name)] : []));
  if (qualifierFallback) for (const s of signals) {
    if (s.signal) wanted.add(normalizeName(withoutTrailingQualifier(s.signal.startHint.name)));
  }
  const features: OsmAnchorFeature[] = [];
  const sourceHashes: Record<string, string> = {};
  const files = ['alpine-huts', 'wilderness-huts', 'parking', 'stations', 'halts', 'bus-stops', 'trailheads',
    'villages', 'hamlets', 'isolated-dwellings', 'farms', 'saddles', 'mountain-passes', 'ridges', 'peaks', 'trailhead-info'];
  const seen = new Set<string>();
  for (const file of files) {
    const buffer = await readFile(`data/osm/alps/staging/phase11f2-features/${file}.json`);
    sourceHashes[file] = createHash('sha256').update(buffer).digest('hex');
    for (const item of JSON.parse(buffer.toString('utf8')) as FeatureRecord[]) {
      const names = [item.tags.name, item.tags.official_name, item.tags.short_name, ...(item.tags.alt_name || '').split(';')].filter(Boolean);
      if (!item.coordinate || !names.some(n => wanted.has(normalizeName(n)))) continue;
      const key = `${item.objectType}:${item.osmid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ sourceKey: 'openstreetmap', osmObjectType: item.objectType, osmId: Number(item.osmid.replace(/^[nwr]/, '')),
        coordinate: item.coordinate, tags: item.tags });
    }
  }
  const records: PlanRecord[] = signals.map((entry, i) => {
    if (!entry.signal) return { ...entry, start: null, summit: null, bbox: null };
    const signal = entry.signal;
    const summitId = Number(corpus.records[i].facts.summits[0].id);
    const summitFeatures = features.filter(f => f.osmObjectType === 'node' && f.osmId === summitId);
    const summit = resolveOsmAnchor(signal.summitHint, summitFeatures);
    const resolveStart = (name: string) => resolveOsmAnchor({ ...signal.startHint, name },
      features.filter(f => [f.tags.name, f.tags.official_name, f.tags.short_name, ...(f.tags.alt_name || '').split(';')]
        .filter(Boolean).some(n => normalizeName(n) === normalizeName(name))),
      { mountainCoordinate: summit.anchor?.coordinate });
    let start = resolveStart(signal.startHint.name);
    const alternative = withoutTrailingQualifier(signal.startHint.name);
    if (qualifierFallback && start.status === 'NOT_FOUND' && alternative && alternative !== signal.startHint.name) {
      start = resolveStart(alternative);
      for (const candidate of start.candidates) candidate.resolutionEvidence.push(QUALIFIER_RESOLVER_VERSION);
    }
    let bbox: PlanRecord['bbox'] = null;
    if (start.status === 'RESOLVED' && summit.status === 'RESOLVED') {
      const a = start.anchor.coordinate, b = summit.anchor.coordinate;
      bbox = [Math.min(a[0], b[0]) - 0.025, Math.min(a[1], b[1]) - 0.025,
        Math.max(a[0], b[0]) + 0.025, Math.max(a[1], b[1]) + 0.025].map(x => Math.round(x * 1e7) / 1e7) as PlanRecord['bbox'];
    }
    return { ...entry, start, summit, bbox };
  });
  const identity = { datasetSha256: corpus.datasetSha256, corpusHash: sha256Stable(corpus), signalVersion: SIGNAL_VERSION,
    regionVersion: REGION_VERSION, featureCatalogHash: sha256Stable(sourceHashes),
    ...(qualifierFallback ? { resolverAdapterVersion: QUALIFIER_RESOLVER_VERSION } : {}) };
  await mkdir(`${OUTPUT}/checkpoints`, { recursive: true });
  await writeImmutable(`${OUTPUT}/phase12d-semantic-plan${qualifierFallback ? '-v2' : ''}.json`, { identity, records, planHash: sha256Stable({ identity, records }) });
  console.log(JSON.stringify({ planned: records.length, regions: records.filter(r => r.bbox).length }));
}
