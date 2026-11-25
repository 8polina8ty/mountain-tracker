import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { OUTPUT, readJson, writeImmutable, type Corpus, type Plan } from './phase12d-calibration.ts';
import { summarize, matrices, type EvaluationRecord } from './phase12d-run.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';

interface Report {
  identityHash: string; resultsHash: string; results: EvaluationRecord[];
  humanGold: ReturnType<typeof summarize>; training: ReturnType<typeof summarize>; holdout: ReturnType<typeof summarize>;
  extendedMachineGreen: ReturnType<typeof summarize>;
  negatives: ReturnType<typeof summarize> & { intrinsicFalseAcceptsBeforeFrozenVeto: number };
  determinism: { checked: number; passed: number }; performance: Record<string, unknown>;
}
interface Configuration { configuration: string; options: Record<string, number>; qualifierFallback?: boolean }

async function selectConfiguration() {
  const baseline = await readJson<Report>(`${OUTPUT}/phase12d-baseline.json`);
  const grid = await readJson<Configuration[]>(`${OUTPUT}/phase12d-experiment-grid.json`);
  const candidates: Array<Configuration & { training: ReturnType<typeof summarize> }> = [{ configuration: 'baseline-v1', options: {}, training: baseline.training }];
  for (const config of grid) {
    const report = await readJson<Report>(`${OUTPUT}/phase12d-experiment-${config.configuration}.json`);
    assert.equal(report.training.total, 30); assert.equal(report.holdout.total, 0);
    assert.equal(report.determinism.checked, report.determinism.passed);
    candidates.push({ ...config, training: report.training });
  }
  // Only training metrics participate. Ties retain the unchanged baseline/smaller bound.
  const best = [...candidates].sort((a, b) => b.training.acceptableMatch.count - a.training.acceptableMatch.count
    || b.training.autoCompatible.count - a.training.autoCompatible.count)[0];
  const selected = { configuration: best.configuration, options: best.options, ...(best.qualifierFallback ? { qualifierFallback: true } : {}) };
  await writeImmutable(`${OUTPUT}/phase12d-selected-configuration.json`, selected);
  await writeImmutable(`${OUTPUT}/phase12d-calibration-experiments.json`, {
    schemaVersion: 'phase12d/experiments/v1', baselineIdentityHash: baseline.identityHash,
    selectionRule: 'Maximize training acceptable matches, then safe-compatible matches; stable ties retain baseline/smaller bound. No holdout data used.',
    changedParameters: ['Exact start-name resolver fallback: remove trailing parenthetical/comma qualifier only after NOT_FOUND; no fallback after AMBIGUOUS. Adapter phase12d/exact-name-qualifier-fallback/v2.'],
    unchanged: ['hiking-cost/v1', 'graph-eligibility/v1', 'underlying exact anchor-resolution/v1 scoring', 'a-star/v1', 'similarity thresholds', 'start snap 75m', 'summit snap 30m'],
    candidates, selected, selectionHash: sha256Stable(selected), holdoutInspectedForSelection: false,
    hypothesis: '13 training starts are NOT_FOUND, including trailing parenthetical/comma descriptions; test exact lookup of the remaining name. No fuzzy matching, per-route names, coordinate hints or manufactured connectors.',
  });
  console.log(JSON.stringify({ selected, training: best.training }));
}

async function close() {
  const corpus = await readJson<Corpus>(`${OUTPUT}/phase12d-corpus.json`);
  const baseline = await readJson<Report>(`${OUTPUT}/phase12d-baseline.json`);
  const final = await readJson<Report>(`${OUTPUT}/phase12d-final-evaluation.json`);
  const selected = await readJson<Configuration>(`${OUTPUT}/phase12d-selected-configuration.json`);
  const plan = await readJson<Plan>(`${OUTPUT}/phase12d-semantic-plan${selected.qualifierFallback ? '-v2' : ''}.json`);
  const trainingGain = final.training.acceptableMatch.count - baseline.training.acceptableMatch.count;
  const holdoutGain = final.holdout.acceptableMatch.count - baseline.holdout.acceptableMatch.count;
  const gates = {
    allGoldIncluded: final.humanGold.total === 44, fixedSplit: final.training.total === 30 && final.holdout.total === 14,
    extendedCoverage: final.extendedMachineGreen.total >= 120, all245Evaluated: final.extendedMachineGreen.total === 245,
    negativeFalseAutoAcceptZero: final.negatives.autoCompatible.count === 0 && final.negatives.intrinsicFalseAcceptsBeforeFrozenVeto === 0,
    determinism100Percent: final.determinism.checked === corpus.records.length && final.determinism.passed === corpus.records.length,
    noInternalErrors: !final.results.some(r => r.failure === 'INTERNAL_ERROR'),
    trainingImprovement: trainingGain >= 1, noMaterialHoldoutCollapse: holdoutGain >= -1,
    noSafetyRegression: !final.results.some(r => r.autoCompatible &&
      (r.roadSafety !== 'SAFE' || !['BASE_START', 'HUT_START'].includes(r.startContext ?? '') || r.safetyReasons.length > 0 || r.frozenVetoes.length > 0))
      && final.negatives.intrinsicFalseAcceptsBeforeFrozenVeto === 0,
  };
  const unsafe = !gates.negativeFalseAutoAcceptZero || !gates.determinism100Percent || !gates.noInternalErrors || !gates.noMaterialHoldoutCollapse || !gates.noSafetyRegression;
  const complete = gates.allGoldIncluded && gates.fixedSplit && gates.extendedCoverage;
  const outcome = unsafe || !complete ? 'CALIBRATION_BLOCKED' : gates.trainingImprovement ? 'CALIBRATION_PASS' : 'CALIBRATION_PARTIAL';
  const negativeProvenance = await readJson<{ records: { relationId: string; analysisStartContext: string }[] }>(`${OUTPUT}/phase12d-negative-label-provenance.json`);
  const membersById = new Map(corpus.records.map(m => {
    const provenance = negativeProvenance.records.find(r => r.relationId === m.relationId);
    return [m.relationId, provenance ? { ...m, labels: { ...m.labels, startContext: provenance.analysisStartContext } } : m];
  }));
  const anchorFailed = final.results.filter(r => r.signalCreated && !r.allAnchorsResolved);
  const divergent = final.results.filter(r => ['MATCH_DIFFERENT_VARIANT', 'MATCH_UNRELATED'].includes(r.failure));
  const excluded = final.results.filter(r => Object.values(r.excludedDirectTruthMembers ?? {}).some(n => n > 0));
  const limitationAnalysis = [
    { limitation: corpus.phase12cLimitations[0], measurement: 'Different/unrelated matches are a corridor-choice proxy, not proof of A* causation; direct relation-way exclusions are inspected only after solving.',
      divergentSolvedCount: divergent.length, solvedDenominator: final.results.filter(r => r.solved).length,
      solvedWithExcludedDirectTruthMembers: excluded.length,
      affectedStrata: matrices(divergent.map(r => membersById.get(r.relationId)!), divergent),
      mitigated: false, remains: 'Named-corridor intent and excluded via-ferrata remain architectural; name-resolution calibration does not change route costs or graph exclusions.' },
    { limitation: corpus.phase12cLimitations[1], measurement: 'Assigned frozen relation truth availability after reconstruction; corpus is conditioned on relation-backed truth, so it cannot measure unseen-route truth completeness.',
      comparedRoutes: final.results.filter(r => r.similarity).length, missingAssignedTruth: final.results.filter(r => r.safetyReasons.includes('MISSING_FROZEN_TRUTH')).length,
      zeroOverlapAssignedTruth: final.results.filter(r => r.similarity?.metrics.symmetricCoverage === 0).length,
      mitigated: false, remains: 'Original Jubiläumsgrat open-world missing-truth limitation remains deferred; zero missing assigned labels is not evidence of complete OSM truth coverage.' },
    { limitation: corpus.phase12cLimitations[2], measurement: 'Unresolved semantic start/summit anchors among usable signals; no oracle endpoints.',
      count: anchorFailed.length, usableSignalDenominator: final.results.filter(r => r.signalCreated).length,
      startNotFound: anchorFailed.filter(r => r.failure === 'ANCHOR_START_NOT_FOUND').length,
      startAmbiguous: anchorFailed.filter(r => r.failure === 'ANCHOR_START_AMBIGUOUS').length,
      affectedStrata: matrices(anchorFailed.map(r => membersById.get(r.relationId)!), anchorFailed),
      baselineCount: baseline.results.filter(r => r.signalCreated && !r.allAnchorsResolved).length,
      mitigated: anchorFailed.length < baseline.results.filter(r => r.signalCreated && !r.allAnchorsResolved).length,
      remains: 'Qualifier fallback can recover exact named objects; missing names, semantic descriptions and near-tied objects remain unresolved. No fuzzy guessing.' },
  ];
  const zeroWrites = { DBWrites: 0, StorageWrites: 0, PublicationWrites: 0, ACTIVEChanges: 0, externalRouteSourceNetworkRequests: 0,
    scope: 'Application/production writes. Local corpus, JSON checkpoints and disposable offline SQLite graph-cache writes are the only mutations.' };
  const decision = { schemaVersion: 'phase12d/closing-decision/v1', outcome, publishable: false, phase12eStarted: false,
    datasetSha256: corpus.datasetSha256, corpusCounts: corpus.counts, splitHash: corpus.splitHash,
    criteriaReference: 'phase12d-corpus.json#acceptanceCriteria (frozen before baseline)', gates, selected,
    baselineResultsHash: baseline.resultsHash, finalResultsHash: final.resultsHash,
    trainingGain, holdoutGain, generalizationDelta: { finalHoldoutMinusTrainingPercentagePoints:
      ((final.holdout.acceptableMatch.rate ?? 0) - (final.training.acceptableMatch.rate ?? 0)) * 100,
      holdoutGainMinusTrainingGainPercentagePoints: (holdoutGain / 14 - trainingGain / 30) * 100 },
    limitationAnalysis, limitations: ['Only original from/to or exact two-endpoint relation names create start hints; derived Phase11H start labels are deliberately excluded.',
      'Six topology-only negatives have no frozen start-context observation; corpus conservative AMBIGUOUS_START placeholders are annotated in phase12d-negative-label-provenance.json and reported as UNKNOWN for empirical limitation strata. Solver classification is independent.',
      'No frozen road-blocked relation found in inspected reports; five adversarial access/road graph controls plus existing Phase11 road-safety tests are separate from 19 frozen negative relations.',
      'Fixed relation-backed corpus does not quantify missing ground truth for independently discovered routes.',
      'Graph extraction requires a full PBF pass; evaluation retains per-route regional builds and double builds for determinism. Future 1000/10000/100000 runs need reusable spatial and graph indexes.',
      'Peak memory is a sampled RSS lower bound, not a system-wide maximum; preparation and graph cache I/O dominate small routing calls.'],
    oracleDiagnostics: { used: false, reason: 'No endpoint identities or geometry-derived semantic hints are supplied to routing.' },
    checkpointResume: 'Each route shard locks dataset, corpus, plan/catalog, graph/resolver/solver/cost, exact options and source/cache hashes. Atomic .partial -> .json; incompatible runs use distinct namespaces and cannot overwrite aggregate artifacts.',
    zeroWrites };
  await writeImmutable(`${OUTPUT}/phase12d-closing-decision.json`, decision);
  await writeFile(`${OUTPUT}/PHASE_12D_REPORT.md`, makeMarkdown(corpus, baseline, final, decision, plan));
  const files: Record<string, { sha256: string; bytes: number }> = {};
  async function walk(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === 'cache' || item.name === 'phase12d-artifact-hashes.json') continue;
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) await walk(path);
      else { const bytes = await readFile(path); files[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; }
    }
  }
  await walk(OUTPUT);
  await writeFile(`${OUTPUT}/phase12d-artifact-hashes.json`, JSON.stringify({ schemaVersion: 'phase12d/artifact-hashes/v1', files }, null, 2) + '\n');
  console.log(JSON.stringify({ outcome, gates, trainingGain, holdoutGain, generalizationDelta: decision.generalizationDelta }));
}

function makeMarkdown(corpus: Corpus, baseline: Report, final: Report, decision: Record<string, unknown>, plan: Plan) {
  const rate = (v: { count: number; denominator: number; rate: number | null }) => `${v.count}/${v.denominator} (${v.rate === null ? 'n/a' : (v.rate * 100).toFixed(1) + '%'})`;
  const rows = (['training', 'holdout', 'humanGold', 'extendedMachineGreen', 'negatives'] as const).map(k =>
    `| ${k} | ${rate(final[k].usableSignal)} | ${rate(final[k].allAnchors)} | ${rate(final[k].solverSuccess)} | ${rate(baseline[k].acceptableMatch)} | ${rate(final[k].acceptableMatch)} |`).join('\n');
  const table = (members: Corpus['records'], key: (m: Corpus['records'][number]) => string) => {
    return [...new Set(members.map(key))].sort().map(k => {
      const ids = new Set(members.filter(m => key(m) === k).map(m => m.relationId));
      const s = summarize(final.results.filter(r => ids.has(r.relationId)));
      return `| ${k} | ${s.total} | ${s.usableSignal.count} | ${s.allAnchors.count} | ${s.solverSuccess.count} | ${s.acceptableMatch.count} |`;
    }).join('\n');
  };
  const gold = corpus.records.filter(m => m.humanApproved);
  return `# Phase 12D — frozen OSM calibration\n\nOutcome: **${decision.outcome}**. No Phase 12E work or publication.\n\n` +
    `Dataset SHA-256: \`${corpus.datasetSha256}\`. Corpus: 44 human-approved (23 BASE, 21 HUT), all 245 machine GREEN (124 + 121 disjoint), ${corpus.counts.negative} frozen negatives; ${corpus.counts.unique} unique relations. Unreviewed machine GREEN records are not human-approved.\n\n` +
    `Split: 30 training (16 BASE / 14 HUT), 14 holdout (7 BASE / 7 HUT), versioned SHA-256 ordering of canonical relation ID. Split hash: \`${corpus.splitHash}\`.\n\n` +
    `Inputs use original from/to tags, or two-part route names with an exact summit endpoint, plus a single confirmed named summit identity. Every contributing field is in phase12d-semantic-plan.json. Ref is retained as metadata and never becomes an anchor. No geometry-derived starts, vias or Phase11H generated display-name hints. ${plan.records.filter(r => r.signal).length} usable signals.\n\n` +
    `| Group | Usable signal / corpus | All anchors / signals | Solved / resolved | Baseline match / corpus | Final match / corpus |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `Acceptable = EXACT_DUPLICATE, NEAR_DUPLICATE, SAME_VARIANT, using unchanged Phase11 compareRoutes(). Detailed start/summit rates, DIFFERENT_VARIANT / UNRELATED counts, all similarity metrics, failure matrices and safety outcomes are in baseline/final JSON. Semantic similarity is separate from safe start eligibility.\n\n` +
    `Human-gold strata (small strata below five are descriptive):\n\n| Start | Total | Signals | Resolved | Solved | Acceptable |\n|---|---:|---:|---:|---:|---:|\n${table(gold, m => m.labels.startContext)}\n\n` +
    `| Quality | Total | Signals | Resolved | Solved | Acceptable |\n|---|---:|---:|---:|---:|---:|\n${table(gold, m => m.labels.qualityBand)}\n\n` +
    `| Name | Total | Signals | Resolved | Solved | Acceptable |\n|---|---:|---:|---:|---:|---:|\n${table(gold, m => m.facts.relationTags.name ? 'NAMED' : 'MISSING_NAME')}\n\n` +
    `Baseline training failure matrix: \`${JSON.stringify(baseline.training.failures)}\`.\n\n` +
    `Selected configuration: \`${JSON.stringify(decision.selected)}\`. Training gain ${decision.trainingGain} routes; holdout gain ${decision.holdoutGain} routes. Generalization: \`${JSON.stringify(decision.generalizationDelta)}\`. Selection used training only; final holdout was evaluated once after selection (with internal determinism replay). Oracle mode was not used.\n\n` +
    `Negative false accepts: ${final.negatives.autoCompatible.count}/${final.negatives.total}; intrinsic false accepts before frozen veto: ${final.negatives.intrinsicFalseAcceptsBeforeFrozenVeto}. Frozen road-blocked relation coverage is unavailable in inspected reports; separate adversarial controls must not be counted as real corpus observations.\n\n` +
    `Phase12C STRICT_NEGATIVE_ACCEPTED remains unchanged:\n\n${corpus.phase12cLimitations.map(x => '- ' + x).join('\n')}\n\n` +
    `The closing decision measures each limitation with denominators, affected strata and causal limits. Missing assigned relation truth is not the same as complete open-world route truth.\n\n` +
    `Determinism: ${final.determinism.passed}/${final.determinism.checked}. Performance: \`${JSON.stringify(final.performance)}\`. PBF extraction is separately recorded in phase12d-extraction.json; no inference of production throughput is made.\n\n` +
    `Checkpoint/resume and artifact integrity: ${decision.checkpointResume} All artifact file hashes are indexed in phase12d-artifact-hashes.json. Source hashes and exact options are in each run identity.\n\n` +
    `Validation results: phase12d-validation.json. Manual browser verification is not needed for this offline harness; no server was started and no browser/runtime app behavior is claimed.\n\n` +
    `DB writes = 0; Storage writes = 0; Publication writes = 0; ACTIVE changes = 0; external route-source network requests = 0. These refer to application/production systems; local artifact/cache writes are intentional.\n`;
}

if (process.argv[2] === 'select') await selectConfiguration();
else if (process.argv[2] === 'close') await close();
else throw new Error('Expected select or close');
