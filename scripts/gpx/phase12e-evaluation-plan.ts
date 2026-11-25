import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { extractSemanticEvidence } from '../../Lib/gpxIngestion/semanticEvidence.ts';
import { candidateSemanticNames } from '../../Lib/gpxIngestion/nameNormalization.ts';
import { buildSemanticFeatureIndex, semanticFeatureIndexLayer, SEMANTIC_FEATURE_INDEX_VERSION, type SemanticFeatureRecordSource, type SemanticFeatureIndex } from '../../Lib/gpxIngestion/semanticFeatureIndex.ts';
import { resolveSemanticEntity } from '../../Lib/gpxIngestion/semanticEntityResolution.ts';
import { resolveOsmAnchor, type OsmAnchorResolution } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { extractSignal, type Facts } from './phase12d-calibration.ts';
import { OUTPUT, readJson, writeImmutable } from './phase12e-calibration.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';

export interface EMember {
  relationId: string; group: string; humanApproved: boolean; machineGreen: boolean; negativeReasons: string[];
  facts: Facts; labels: { startContext: string; qualityBand: string };
}
export interface ECorpus { corpusHash: string; datasetSha256: string; phase12dSplitHash: string; records: EMember[]; acceptance: Record<string, unknown> }
export interface EPlanRecord {
  relationId: string; evidence: ReturnType<typeof extractSemanticEvidence>; baselineSignal: ReturnType<typeof extractSignal>['signal'];
  baselineStart: OsmAnchorResolution | null; baselineSummit: OsmAnchorResolution | null;
  start: OsmAnchorResolution | null; summit: OsmAnchorResolution | null; vias: OsmAnchorResolution[];
  bbox: [number, number, number, number] | null; baselineBbox: [number, number, number, number] | null;
  resolverMs: number; maxCandidateCount: number;
}
export interface EPlan { version: string; corpusHash: string; indexHash: string; records: Omit<EPlanRecord, 'resolverMs'>[]; planHash: string }

export async function completeEvaluationPlan() {
  const corpus = await readJson<ECorpus>(`${OUTPUT}/phase12e-corpus.json`);
  try {
    const existing = await readJson<EPlan>(`${OUTPUT}/phase12e-evaluation-plan.json`);
    const { planHash, ...content } = existing;
    if (existing.corpusHash !== corpus.corpusHash || sha256Stable(content) !== planHash) throw new Error('INCOMPATIBLE_EVALUATION_PLAN');
    const index = await readJson<SemanticFeatureIndex>(`${OUTPUT}/cache/semantic-index-v2.json`);
    if (index.indexHash !== existing.indexHash) throw new Error('INCOMPATIBLE_SEMANTIC_INDEX');
    for (const [layer, expected] of Object.entries(index.sourceHashes)) {
      const bytes = await readFile(`data/osm/alps/staging/phase11f2-features/${layer}.json`);
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('SEMANTIC_SOURCE_DRIFT');
    }
    console.log(JSON.stringify({ reusedPlan: planHash, planned: existing.records.length, indexEntries: index.entries.length }));
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const prepared = corpus.records.map(m => ({ member: m, evidence: extractSemanticEvidence(m.relationId, m.facts), baseline: extractSignal(m.relationId, m.facts).signal }));
  const wanted = new Set(prepared.flatMap(p => [p.evidence.signal, p.baseline].flatMap(s => s ? [s.startHint, s.summitHint, ...s.viaHints].flatMap(h => candidateSemanticNames(h.name).map(n => n.name)) : [])));
  const started = performance.now();
  const sourceHashes: Record<string, string> = {}, entries: SemanticFeatureIndex['entries'] = [];
  for (const layer of semanticFeatureIndexLayer()) {
    const bytes = await readFile(`data/osm/alps/staging/phase11f2-features/${layer}.json`);
    sourceHashes[layer] = createHash('sha256').update(bytes).digest('hex');
    const block = buildSemanticFeatureIndex({ sourceHashes: {}, wantedNames: wanted,
      collect: [{ layer, records: JSON.parse(bytes.toString('utf8')) as SemanticFeatureRecordSource[] }] });
    entries.push(...block.entries);
  }
  const unique = new Map(entries.map(e => [`${e.objectType}:${e.osmId}`, e]));
  const index: SemanticFeatureIndex = { schemaVersion: SEMANTIC_FEATURE_INDEX_VERSION,
    entries: [...unique.values()].sort((a, b) => a.osmId - b.osmId || a.objectType.localeCompare(b.objectType)),
    sourceHashes, wantedNameCount: wanted.size, indexHash: '' };
  index.indexHash = sha256Stable({ ...index, indexHash: undefined });
  const indexBuildMs = performance.now() - started;
  // Shared in-memory name lookup, one build for every route.
  const { attachSemanticNameLookup } = await import('../../Lib/gpxIngestion/semanticFeatureIndex.ts');
  attachSemanticNameLookup(index);
  const records: EPlanRecord[] = [];
  for (const p of prepared) {
    const startTime = performance.now();
    const peakId = Number(p.member.facts.summits[0]?.id);
    const peak = index.entries.filter(e => e.objectType === 'node' && e.osmId === peakId);
    const asFeatures = (values: SemanticFeatureIndex['entries']) => values.map(e => ({ sourceKey: 'openstreetmap' as const,
      osmObjectType: e.objectType, osmId: e.osmId, coordinate: e.coordinate, tags: e.tags }));
    const baselineSummit = p.baseline ? resolveOsmAnchor(p.baseline.summitHint, asFeatures(peak)) : null;
    const baselineStart = p.baseline ? resolveOsmAnchor(p.baseline.startHint, asFeatures(index.entries), { mountainCoordinate: baselineSummit?.anchor?.coordinate }) : null;
    const summit = p.evidence.signal ? resolveSemanticEntity(p.evidence.signal.summitHint, { ...index, entries: peak, byName: undefined }) : null;
    const context = { mountainCoordinate: summit?.anchor ? [summit.anchor.coordinate[0], summit.anchor.coordinate[1]] as [number, number] : null };
    const start = p.evidence.signal ? resolveSemanticEntity(p.evidence.signal.startHint, index, context) : null;
    const vias = p.evidence.signal?.viaHints.map(h => resolveSemanticEntity(h, index, context)) ?? [];
    const envelope = (resolutions: Array<OsmAnchorResolution | null>): EPlanRecord['bbox'] => {
      if (resolutions.some(r => r?.status !== 'RESOLVED')) return null;
      const coordinates = resolutions.map(r => r!.anchor!.coordinate);
      return [Math.min(...coordinates.map(c => c[0])) - .025, Math.min(...coordinates.map(c => c[1])) - .025,
        Math.max(...coordinates.map(c => c[0])) + .025, Math.max(...coordinates.map(c => c[1])) + .025].map(n => Math.round(n * 1e7) / 1e7) as EPlanRecord['bbox'];
    };
    records.push({ relationId: p.member.relationId, evidence: p.evidence, baselineSignal: p.baseline,
      baselineStart, baselineSummit, start, summit, vias, bbox: envelope([start, ...vias, summit]), baselineBbox: envelope([baselineStart, baselineSummit]),
      resolverMs: performance.now() - startTime, maxCandidateCount: Math.max(start?.candidates.length ?? 0, summit?.candidates.length ?? 0, ...vias.map(v => v.candidates.length)) });
  }
  const content = { version: 'phase12e/evaluation-plan/v2', corpusHash: corpus.corpusHash, indexHash: index.indexHash,
    records: records.map(({ resolverMs: duration, ...record }) => { void duration; return record; }) };
  await mkdir(`${OUTPUT}/cache`, { recursive: true });
  await writeImmutable(`${OUTPUT}/cache/semantic-index-v2.json`, index);
  await writeImmutable(`${OUTPUT}/phase12e-evaluation-plan.json`, { ...content, planHash: sha256Stable(content) });
  await writeImmutable(`${OUTPUT}/phase12e-index-build.json`, { indexHash: index.indexHash, indexedFeatureCount: index.entries.length,
    wantedNames: wanted.size, sourceHashes, indexBuildMs, resolverTimings: records.map(r => ({ relationId: r.relationId, ms: r.resolverMs, candidates: r.maxCandidateCount })) });
  console.log(JSON.stringify({ planned: records.length, indexEntries: index.entries.length, planHash: sha256Stable(content) }));
}
