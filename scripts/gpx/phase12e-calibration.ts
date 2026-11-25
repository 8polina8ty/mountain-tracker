import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { OsmAnchorResolution } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import type { RouteDiscoverySignal } from '../../Lib/gpxIngestion/routeDiscovery.ts';
import {
  buildSemanticFeatureIndex,
  semanticFeatureIndexLayer,
  SEMANTIC_FEATURE_INDEX_VERSION,
  type SemanticFeatureIndex,
  type SemanticFeatureLayer,
  type SemanticFeatureRecordSource,
} from '../../Lib/gpxIngestion/semanticFeatureIndex.ts';
import { resolveSemanticEntity, SEMANTIC_ENTITY_RESOLUTION_VERSION } from '../../Lib/gpxIngestion/semanticEntityResolution.ts';
import { withoutWhitelistedTrailingQualifier } from '../../Lib/gpxIngestion/nameNormalization.ts';
import {
  ROUTABLE_ANCHOR_RESOLUTION_VERSION,
  ACCESS_CONNECTOR_POLICY_VERSION,
} from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';

export const OUTPUT = 'data/gpx/phase12e';
export const SEMANTIC_PLAN_VERSION = 'phase12e/semantic-plan/v1';
export type { SemanticFeatureIndex };

export interface CorpusMemberFacts {
  relationTags: Record<string, string | null>;
  summits: { id: string; name: string | null }[];
}

import { extractSignal, type Corpus } from './phase12d-calibration.ts';
export type { Corpus };

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeImmutable(path: string, value: unknown): Promise<void> {
  let existing: unknown;
  try { existing = await readJson(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (directory) await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  if (sha256Stable(existing) !== sha256Stable(value)) throw new Error(`INCOMPATIBLE_EXISTING_ARTIFACT:${path}`);
}

export interface Phase12EPlanRecord {
  relationId: string;
  start: OsmAnchorResolution | null;
  summit: OsmAnchorResolution | null;
  expectedRegion: [number, number, number, number] | null;
}

export interface Phase12EPlan {
  schemaVersion: typeof SEMANTIC_PLAN_VERSION;
  identity: {
    datasetSha256: string;
    featureIndexVersion: typeof SEMANTIC_FEATURE_INDEX_VERSION;
    entityResolutionVersion: typeof SEMANTIC_ENTITY_RESOLUTION_VERSION;
    routableVersion: typeof ROUTABLE_ANCHOR_RESOLUTION_VERSION;
    connectorPolicyVersion: typeof ACCESS_CONNECTOR_POLICY_VERSION;
  };
  records: Phase12EPlanRecord[];
  planHash: string;
}

export interface CorpusMemberFacts {
  relationTags: Record<string, string | null>;
  summits: { id: string; name: string | null }[];
}

export async function makeSemanticFeatureIndex(
  signals: readonly { relationId: string; signal: RouteDiscoverySignal | null }[],
): Promise<{ index: SemanticFeatureIndex }> {
  const wanted = new Set<string>();
  for (const entry of signals) {
    if (!entry.signal) continue;
    wanted.add(entry.signal.startHint.name);
    wanted.add(entry.signal.summitHint.name);
  }
  for (const name of [...wanted]) {
    const stripped = withoutWhitelistedTrailingQualifier(name).stripped;
    if (stripped && stripped !== name) wanted.add(stripped);
  }
  const sourceHashes: Record<string, string> = {};
  const collect: Array<{ layer: SemanticFeatureLayer; records: SemanticFeatureRecordSource[] }> = [];
  for (const layer of semanticFeatureIndexLayer()) {
    const buffer = await readFile(`data/osm/alps/staging/phase11f2-features/${layer}.json`);
    sourceHashes[layer] = createHash('sha256').update(buffer).digest('hex');
    collect.push({ layer, records: JSON.parse(buffer.toString('utf8')) as SemanticFeatureRecordSource[] });
  }
  const index = buildSemanticFeatureIndex({ sourceHashes, wantedNames: wanted, collect });
  return { index };
}

export async function makePlan(): Promise<void> {
  const corpus = await readJson<{
    schemaVersion: string; datasetSha256: string;
    records: { relationId: string; facts: CorpusMemberFacts }[];
  }>('data/gpx/phase12d/phase12d-corpus.json');
  const phase12dPlan = await readJson<{ records: { relationId: string; summit: OsmAnchorResolution | null }[] }>(
    'data/gpx/phase12d/phase12d-semantic-plan.json',
  );
  const summitById = new Map(phase12dPlan.records.map(record => [record.relationId, record.summit]));
  const signals = corpus.records.map(member => ({ relationId: member.relationId, ...extractSignal(member.relationId, member.facts) }));
  const signalIndex = new Map(signals.map(entry => [entry.relationId, entry.signal]));
  const { index } = await makeSemanticFeatureIndex(signals);
  const records: Phase12EPlanRecord[] = [];
  for (const member of corpus.records) {
    const signal = signalIndex.get(member.relationId) ?? null;
    const summit = summitById.get(member.relationId) ?? null;
    const start = signal
      ? resolveSemanticEntity(
          { name: signal.startHint.name, expectedTypes: [], regionName: null },
          index,
          { mountainCoordinate: summit?.status === 'RESOLVED' ? [summit.anchor.coordinate[0], summit.anchor.coordinate[1]] : null },
        )
      : null;
    let expectedRegion: Phase12EPlanRecord['expectedRegion'] = null;
    const startAnchor = start?.status === 'RESOLVED' ? start.anchor : null;
    const summitAnchor = summit?.status === 'RESOLVED' ? summit.anchor : null;
    if (startAnchor && summitAnchor) {
      const a = startAnchor.coordinate, b = summitAnchor.coordinate;
      expectedRegion = [Math.min(a[0], b[0]) - 0.025, Math.min(a[1], b[1]) - 0.025,
        Math.max(a[0], b[0]) + 0.025, Math.max(a[1], b[1]) + 0.025].map(x => Math.round(x * 1e7) / 1e7) as Phase12EPlanRecord['expectedRegion'];
    }
    records.push({ relationId: member.relationId, start, summit, expectedRegion });
  }
  const identity = {
    datasetSha256: corpus.datasetSha256,
    featureIndexVersion: SEMANTIC_FEATURE_INDEX_VERSION,
    entityResolutionVersion: SEMANTIC_ENTITY_RESOLUTION_VERSION,
    routableVersion: ROUTABLE_ANCHOR_RESOLUTION_VERSION,
    connectorPolicyVersion: ACCESS_CONNECTOR_POLICY_VERSION,
  };
  const planHash = sha256Stable({ identity, records });
  const plan: Phase12EPlan = { schemaVersion: SEMANTIC_PLAN_VERSION, identity, records, planHash };
  await mkdir(`${OUTPUT}/checkpoints`, { recursive: true });
  await writeImmutable(`${OUTPUT}/phase12e-semantic-plan.json`, plan);
  await writeImmutable(`${OUTPUT}/phase12e-feature-index.json`, {
    schemaVersion: SEMANTIC_FEATURE_INDEX_VERSION,
    indexHash: index.indexHash,
    wantedNameCount: index.wantedNameCount,
    entryCount: index.entries.length,
    sourceHashes: index.sourceHashes,
  });
  console.log(JSON.stringify({ planned: records.length, regions: records.filter(r => r.expectedRegion).length, planHash }));
}

export async function reconcileActiveManifest(): Promise<number> {
  const manifest = await readJson<{ activeRelationIds: string[] }>(`${OUTPUT}/phase12e-118-active.json`);
  return manifest.activeRelationIds.length;
}
