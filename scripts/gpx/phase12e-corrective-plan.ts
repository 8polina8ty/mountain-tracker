import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { candidateSemanticNames, SEMANTIC_QUALIFIER_TAXONOMY_VERSION, STATUS_QUALIFIERS } from '../../Lib/gpxIngestion/nameNormalization.ts';
import { buildSemanticFeatureIndex, hasHistoricStatusEvidence, type SemanticFeatureIndex, type SemanticFeatureRecordSource } from '../../Lib/gpxIngestion/semanticFeatureIndex.ts';
import { extractSemanticEvidence } from '../../Lib/gpxIngestion/semanticEvidence.ts';
import { resolveSemanticEntity } from '../../Lib/gpxIngestion/semanticEntityResolution.ts';
import type { OsmAnchorResolution } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { OUTPUT, readJson, writeImmutable } from './phase12e-calibration.ts';
import type { ECorpus, EPlan, EPlanRecord, EMember } from './phase12e-evaluation-plan.ts';
import { versions } from './phase12e-run.ts';

export const ORIGINAL = `${OUTPUT}/revisions/e2-original`;
export const CORRECTION = 'E4-status-waypoint-v3';
export type CorrectionStage = 'train' | 'human' | 'extended' | 'active';
export const stageIncludes = (stage: CorrectionStage, m: EMember) => stage === 'train' ? m.group === 'TRAIN'
  : stage === 'human' ? m.humanApproved || m.negativeReasons.length > 0
    : stage === 'extended' ? m.machineGreen : m.group === 'FRESH_PUBLISHED_REFERENCE';

export interface CorrectiveRecord extends Omit<EPlanRecord, 'resolverMs'> {
  solverDependencyHash: string; previousSolverDependencyHash: string;
}
export function solverDependencyHash(record: Pick<EPlanRecord, 'evidence' | 'start' | 'summit' | 'vias' | 'bbox'>) {
  // Full compatible semantic inputs, not just the winning coordinate. No version-only blanket invalidation.
  return sha256Stable({ signal: record.evidence.signal, start: record.start, summit: record.summit, vias: record.vias, bbox: record.bbox });
}

export async function correctivePlan(stage: CorrectionStage) {
  const corpus = await readJson<ECorpus>(`${ORIGINAL}/phase12e-corpus.json`);
  const oldPlan = await readJson<EPlan>(`${ORIGINAL}/phase12e-evaluation-plan.json`);
  const oldIndex = await readJson<SemanticFeatureIndex>(`${OUTPUT}/cache/semantic-index-v2.json`);
  const bytes = await readFile(`${OUTPUT}/phase12e-qualifier-diagnosis.json`);
  const diagnosis = JSON.parse(bytes.toString('utf8')) as { datasetSha256: string; trainNameMatches: Array<{ objectType: 'node' | 'way'; osmId: number; coordinate: [number, number] | null; tags: Record<string, string> }>; statusExamples: Array<{ objectType: 'node' | 'way'; osmId: number; coordinate: [number, number] | null; tags: Record<string, string> }> };
  assert.equal(diagnosis.datasetSha256, corpus.datasetSha256);
  const wanted = new Set(oldPlan.records.flatMap(r => r.evidence.signal ? [r.evidence.signal.startHint, ...r.evidence.signal.viaHints, r.evidence.signal.summitHint]
    .flatMap(h => candidateSemanticNames(h.name).map(v => v.name)) : []));
  const supplemental = [...new Map([...diagnosis.trainNameMatches, ...diagnosis.statusExamples].filter(r => r.coordinate && hasHistoricStatusEvidence(r.tags))
    .map(r => [`${r.objectType}:${r.osmId}`, r])).values()];
  const started = performance.now();
  const index = buildSemanticFeatureIndex({ sourceHashes: { ...oldIndex.sourceHashes, qualifierDiagnosis: createHash('sha256').update(bytes).digest('hex') },
    wantedNames: wanted, collect: [
      ...[...new Set(oldIndex.entries.map(e => e.layer))].map(layer => ({ layer, records: oldIndex.entries.filter(e => e.layer === layer)
        .map(e => ({ layer, objectType: e.objectType, osmid: String(e.osmId), coordinate: e.coordinate, tags: e.tags })) })),
      { layer: 'historic-status', records: supplemental.map(r => ({ layer: 'historic-status', objectType: r.objectType, osmid: String(r.osmId), coordinate: r.coordinate, tags: r.tags } as SemanticFeatureRecordSource)) },
    ] });
  const protocol = { version: 'phase12e/correction-protocol/v1', configuration: CORRECTION, parentConfiguration: 'E2-routable-projection-v2',
    versions, qualifierTaxonomyVersion: SEMANTIC_QUALIFIER_TAXONOMY_VERSION, statusDictionary: STATUS_QUALIFIERS,
    corpusHash: corpus.corpusHash, indexHash: index.indexHash,
    gates: { trainAcceptableMinimum: 7, trainSolvedMinimum: 8, hutAcceptableMinimum: 5, baseAcceptableMinimum: 7,
      negativeFalseAutoAccept: 0, extendedAcceptableMinimum: 39, exposedActiveAcceptableMinimum: 3, determinism: 1 },
    selection: 'One general corrective configuration defined from semantic contracts, TRAIN evidence and unit tests. No new parameter search.',
    exposure: 'Original fresh118 is now EXPOSED_ACTIVE_REFERENCE. Original14 remains EXPOSED_REGRESSION_SET. Neither selects the correction.',
    geometryPolicy: 'Only original source semantic facts and independently named OSM status features. No reference geometry/member sequence is semantic input.' };
  await writeImmutable(`${OUTPUT}/phase12e-corrective-protocol.json`, protocol);
  await writeImmutable(`${OUTPUT}/cache/semantic-index-v3.json`, index);
  const records: CorrectiveRecord[] = [], timings: number[] = [];
  for (const member of corpus.records.filter(m => stageIncludes(stage, m))) {
    const old = oldPlan.records.find(r => r.relationId === member.relationId)!;
    const startTime = performance.now();
    const evidence = extractSemanticEvidence(member.relationId, member.facts);
    const resolve = () => {
      const peaks = index.entries.filter(e => e.objectType === 'node' && e.osmId === Number(member.facts.summits[0]?.id));
      const summit = evidence.signal ? resolveSemanticEntity(evidence.signal.summitHint, { ...index, entries: peaks, byName: undefined }) : null;
      const context = { mountainCoordinate: summit?.anchor ? [...summit.anchor.coordinate] as [number, number] : null };
      const start = evidence.signal ? resolveSemanticEntity(evidence.signal.startHint, index, context) : null;
      const vias = evidence.signal?.viaHints.map(h => resolveSemanticEntity(h, index, context)) ?? [];
      return { start, summit, vias };
    };
    const resolved = resolve(); assert.deepEqual(resolve(), resolved, 'SEMANTIC_IDENTITY_DETERMINISM');
    const reversed = buildSemanticFeatureIndex({ sourceHashes: {}, wantedNames: wanted,
      collect: [...new Set(index.entries.map(e => e.layer))].reverse().map(layer => ({ layer, records: index.entries.filter(e => e.layer === layer).reverse()
        .map(e => ({ layer, objectType: e.objectType, osmid: String(e.osmId), coordinate: e.coordinate, tags: e.tags })) })) });
    if (evidence.signal) assert.deepEqual(resolveSemanticEntity(evidence.signal.startHint, reversed,
      { mountainCoordinate: resolved.summit?.anchor ? [...resolved.summit.anchor.coordinate] as [number, number] : null }), resolved.start, 'CANDIDATE_ORDER_DETERMINISM');
    const anchors: Array<OsmAnchorResolution | null> = [resolved.start, ...resolved.vias, resolved.summit];
    const coords = anchors.flatMap(a => a?.anchor ? [a.anchor.coordinate] : []);
    const bbox = anchors.every(a => a?.status === 'RESOLVED') ? [Math.min(...coords.map(c => c[0])) - .025, Math.min(...coords.map(c => c[1])) - .025,
      Math.max(...coords.map(c => c[0])) + .025, Math.max(...coords.map(c => c[1])) + .025].map(n => Math.round(n * 1e7) / 1e7) as EPlanRecord['bbox'] : null;
    const record = { ...old, evidence, ...resolved, bbox,
      maxCandidateCount: Math.max(0, ...anchors.map(a => a?.candidates.length ?? 0)) };
    records.push({ ...record, solverDependencyHash: solverDependencyHash(record), previousSolverDependencyHash: solverDependencyHash(old) });
    timings.push(performance.now() - startTime);
  }
  const content = { version: 'phase12e/corrective-plan/v1', stage, corpusHash: corpus.corpusHash, indexHash: index.indexHash, versions, records };
  await writeImmutable(`${OUTPUT}/phase12e-corrective-plan-${stage}.json`, { ...content, planHash: sha256Stable(content) });
  return { plan: { ...content, planHash: sha256Stable(content) }, corpus, protocol,
    diagnostics: { indexEntries: index.entries.length, supplementalEntries: index.entries.filter(e => e.layer === 'historic-status').length,
      supplementalAvailable: supplemental.length, indexAndPlanMs: performance.now() - started, resolverMs: timings,
      semanticInputsUnchanged: records.filter(r => r.solverDependencyHash === r.previousSolverDependencyHash).length,
      semanticInputsChanged: records.filter(r => r.solverDependencyHash !== r.previousSolverDependencyHash).map(r => r.relationId),
      newlyAmbiguous: records.filter(r => [r.start, ...r.vias, r.summit].some(a => a?.status === 'AMBIGUOUS') &&
        ![oldPlan.records.find(o => o.relationId === r.relationId)!.start, ...oldPlan.records.find(o => o.relationId === r.relationId)!.vias, oldPlan.records.find(o => o.relationId === r.relationId)!.summit].some(a => a?.status === 'AMBIGUOUS')).map(r => r.relationId) } };
}
