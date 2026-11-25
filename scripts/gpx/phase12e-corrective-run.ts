import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { correctivePlan, CORRECTION, ORIGINAL, type CorrectionStage } from './phase12e-corrective-plan.ts';
import { evaluateCorrection } from './phase12e-evaluate-correction.ts';
import { OUTPUT, readJson, writeImmutable } from './phase12e-calibration.ts';
import { contextFeatures, metrics, versions, type EResult } from './phase12e-run.ts';
import type { EPlan } from './phase12e-evaluation-plan.ts';
import type { OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import type { analyzeRouteRoadSafety } from '../osm-import/phase11c9-road-safety.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';

async function fileHash(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
interface CorrectionShard { identityHash: string; dependencyHash: string; resultHash: string; result: EResult; reusedFromOriginal: boolean; graphBuilds: number; totalMs: number }
const stage = process.argv[2] as CorrectionStage;
assert(['train', 'human', 'extended', 'active'].includes(stage), 'Expected train/human/extended/active');
const prerequisite = stage === 'human' ? 'train' : stage === 'extended' ? 'human' : stage === 'active' ? 'extended' : null;
if (prerequisite) {
  const report = await readJson<{ gatePassed: boolean }>(`${OUTPUT}/phase12e-corrective-${prerequisite}.json`);
  assert(report.gatePassed, `PREREQUISITE_GATE_FAILED:${prerequisite}`);
}
const prepared = await correctivePlan(stage);
const { plan, corpus, protocol } = prepared;
const previous = await readJson<{ results: EResult[]; identity: { sourceHashes: Record<string, string>; cacheHashes: Record<string, string> }; configuration: { id: string } }>(`${ORIGINAL}/phase12e-final-evaluation.json`);
const previousResults = previous.results.filter(r => r.configuration === previous.configuration.id);
const dependencyFiles = ['Lib/gpxIngestion/osmTrailGraph.ts', 'Lib/gpxIngestion/osmRouteReconstruction.ts',
  'Lib/gpxIngestion/routableAnchorResolution.ts', 'Lib/gpxIngestion/semanticRouteAccess.ts',
  'Lib/gpxIngestion/routeDiscovery.ts', 'Lib/gpxIngestion/gpxNormalization.ts', 'Lib/gpxIngestion/hashing.ts',
  'scripts/osm-import/route-geometry.ts', 'scripts/osm-import/route-similarity.ts',
  'scripts/osm-import/phase11c9-road-safety.ts', 'scripts/osm-import/start-context-classifier3.ts'];
const sourceFiles = [...dependencyFiles, 'Lib/gpxIngestion/nameNormalization.ts', 'Lib/gpxIngestion/semanticFeatureIndex.ts',
  'Lib/gpxIngestion/semanticEntityResolution.ts', 'Lib/gpxIngestion/semanticEvidence.ts',
  'scripts/gpx/phase12e-corrective-plan.ts', 'scripts/gpx/phase12e-corrective-run.ts',
  'scripts/gpx/phase12e-evaluate-correction.ts', 'scripts/gpx/phase12e-run.ts'];
const sourceHashes: Record<string, string> = {};
for (const file of sourceFiles) sourceHashes[file] = await fileHash(file);
for (const file of dependencyFiles) assert.equal(sourceHashes[file], previous.identity.sourceHashes[file], `UNCHANGED_ROUTER_DEPENDENCY_DRIFT:${file}`);
for (const [file, expected] of Object.entries(previous.identity.cacheHashes)) assert.equal(await fileHash(file), expected, `FROZEN_CACHE_DRIFT:${file}`);
const identity = { version: 'phase12e/corrective-evaluation/v1', configuration: CORRECTION, versions,
  datasetSha256: corpus.datasetSha256, corpusHash: corpus.corpusHash, splitHash: corpus.phase12dSplitHash,
  indexHash: plan.indexHash, protocolHash: sha256Stable(protocol), sourceHashes, cacheHashes: previous.identity.cacheHashes };
const identityHash = sha256Stable(identity);
const directory = `${OUTPUT}/checkpoints/corrective-${identityHash.slice(0, 20)}`;
await mkdir(directory, { recursive: true }); await writeImmutable(`${directory}/identity.json`, identity);
const extraction = await readJson<{ identity: { locations: Record<string, { cache: string; region: string }> } }>(`${ORIGINAL}/phase12e-extraction.json`);
const oldPlan = await readJson<EPlan>(`${ORIGINAL}/phase12e-evaluation-plan.json`);
const changed = plan.records.filter(r => r.solverDependencyHash !== r.previousSolverDependencyHash);
const features = changed.some(r => r.bbox) ? await contextFeatures({ ...oldPlan, records: changed }) : null;
const ReadOnlyDatabase = DatabaseSync as unknown as { new(path: string, options: { readOnly: true }): DatabaseSync };
const truth = new ReadOnlyDatabase('data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite', { readOnly: true });
const sourceDatasetIdentity = (await readJson<{ sourceDatasetIdentity: Parameters<typeof analyzeRouteRoadSafety>[0]['sourceDatasetIdentity'] }>(
  'data/osm/alps/publication/phase11c9-road-safety-eligible-pool-103.json')).sourceDatasetIdentity;
const shards: CorrectionShard[] = [];
let checkpointHits = 0, originalResultReuse = 0, actualGraphBuilds = 0;
for (const record of plan.records) {
  const checkpoint = `${directory}/${record.relationId}.json`;
  try {
    const shard = await readJson<CorrectionShard>(checkpoint);
    assert.equal(shard.identityHash, identityHash); assert.equal(shard.dependencyHash, record.solverDependencyHash);
    assert.equal(shard.resultHash, sha256Stable(shard.result)); shards.push(shard); checkpointHits++; continue;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const old = previousResults.find(r => r.relationId === record.relationId)!;
  let result: EResult, graphBuilds = 0, totalMs = 0;
  const reuse = record.solverDependencyHash === record.previousSolverDependencyHash;
  if (reuse) {
    originalResultReuse++;
    result = { ...old, configuration: CORRECTION, evidenceHash: record.evidence.hash,
      manifestHash: old.manifestHash ? sha256Stable({ reusedPhysicalManifest: old.manifestHash, newEvidenceHash: record.evidence.hash, versions, configuration: CORRECTION }) : null };
  } else {
    let ways: OsmTrailWayInput[] = [];
    if (record.bbox) {
      const regionRecord = oldPlan.records.flatMap(r => [
        { key: `semantic:${r.relationId}`, bbox: r.bbox }, { key: `baseline:${r.relationId}`, bbox: r.baselineBbox },
      ]).find(r => r.bbox && sha256Stable(r.bbox) === sha256Stable(record.bbox));
      assert(regionRecord, 'NO_COMPATIBLE_FROZEN_SEMANTIC_ENVELOPE_NO_AUTOMATIC_EXTRACTION');
      const location = extraction.identity.locations[regionRecord.key]; assert(location);
      const cache = new ReadOnlyDatabase(location.cache, { readOnly: true });
      ways = (cache.prepare('SELECT w.payload FROM ways w JOIN region_ways r ON w.id=r.way WHERE r.region=? ORDER BY w.id').all(location.region) as { payload: string }[])
        .map(r => JSON.parse(r.payload) as OsmTrailWayInput); cache.close();
    }
    const evaluated = evaluateCorrection({ member: corpus.records.find(m => m.relationId === record.relationId)!, record,
      ways, datasetSha256: corpus.datasetSha256, truth, features: features?.index ?? {} as NonNullable<typeof features>['index'], sourceDatasetIdentity });
    result = evaluated.result; graphBuilds = evaluated.graphBuilds; totalMs = evaluated.totalMs; actualGraphBuilds += graphBuilds;
  }
  const shard: CorrectionShard = { identityHash, dependencyHash: record.solverDependencyHash,
    resultHash: sha256Stable(result), result, reusedFromOriginal: reuse, graphBuilds, totalMs };
  await writeFile(`${checkpoint}.partial`, JSON.stringify(shard, null, 2) + '\n'); await rename(`${checkpoint}.partial`, checkpoint);
  shards.push(shard);
}
truth.close();
const results = shards.map(s => s.result);
const select = (predicate: (id: string) => boolean) => results.filter(r => predicate(r.relationId));
const hut = metrics(select(id => corpus.records.some(m => m.relationId === id && m.humanApproved && m.labels.startContext === 'HUT_START')));
const base = metrics(select(id => corpus.records.some(m => m.relationId === id && m.humanApproved && m.labels.startContext === 'BASE_START')));
const negative = metrics(select(id => corpus.records.some(m => m.relationId === id && m.negativeReasons.length > 0)));
const aggregate = metrics(results);
const safetyPassed = aggregate.falseAutoAccept === 0 && aggregate.intrinsicNegativeFalseAccept === 0 && results.every(r => r.determinismVerified);
const gatePassed = safetyPassed && (stage === 'train' ? aggregate.acceptableMatch >= protocol.gates.trainAcceptableMinimum && aggregate.solverSolved >= protocol.gates.trainSolvedMinimum
  : stage === 'human' ? hut.acceptableMatch >= protocol.gates.hutAcceptableMinimum && base.acceptableMatch >= protocol.gates.baseAcceptableMinimum && negative.autoCompatible === 0
    : stage === 'extended' ? aggregate.acceptableMatch >= protocol.gates.extendedAcceptableMinimum : aggregate.acceptableMatch >= protocol.gates.exposedActiveAcceptableMinimum);
const report = { stage: stage === 'active' ? 'EXPOSED_ACTIVE_REFERENCE' : stage, configuration: CORRECTION, identity, identityHash,
  planHash: plan.planHash, gatePassed, aggregate, hut, base, negative, diagnostics: prepared.diagnostics,
  reuse: { originalResultReuse, checkpointHits, actualGraphBuilds, unchangedExtractionReused: true,
    policy: 'Old result reused only when full semantic solver dependencies are identical and frozen graph/solver/cost/safety/comparison source hashes and cache bytes match. New provenance manifest wraps reused physical result.' },
  determinism: { checked: results.length, passed: results.filter(r => r.determinismVerified).length,
    semanticOutputsChecked: plan.records.length, executedSolverAndGraphReplays: actualGraphBuilds, reusedVerifiedResults: originalResultReuse + checkpointHits },
  resultsHash: sha256Stable(results), results };
const reportPath = `${OUTPUT}/phase12e-corrective-${stage}.json`;
try {
  const old = await readJson<typeof report>(reportPath); assert.equal(old.identityHash, report.identityHash); assert.equal(old.resultsHash, report.resultsHash);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeImmutable(reportPath, report); }
if (stage === 'train' && gatePassed) {
  const frozen = { configuration: CORRECTION, identity, trainingMetrics: aggregate, protocol, selectedUsing: 'TRAIN_ONLY',
    exposedActiveUsedForSelection: false, reason: 'Single contract-driven correction passed the predefined TRAIN non-regression gate. Human/safety/extended/exposed validation is still required.' };
  await writeImmutable(`${OUTPUT}/phase12e-corrective-selected-configuration.json`, { ...frozen, freezeHash: sha256Stable(frozen) });
}
if (stage !== 'train') {
  const frozen = await readJson<{ identity: unknown }>(`${OUTPUT}/phase12e-corrective-selected-configuration.json`);
  assert.deepEqual(identity, frozen.identity, 'CORRECTIVE_FREEZE_DRIFT');
}
console.log(JSON.stringify({ stage, gatePassed, aggregate, hut, base, negative, diagnostics: prepared.diagnostics, reuse: report.reuse }));
