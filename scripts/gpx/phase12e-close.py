"""Close the frozen offline experiment; never selects or changes a configuration."""
import hashlib
import json
import pathlib
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12e'
ACCEPTABLE = {'EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'SAME_VARIANT'}


def load(path):
    return json.loads(path.read_text(encoding='utf8'))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def immutable(path, content):
    text = json.dumps(content, ensure_ascii=False, indent=2) + '\n'
    if path.exists():
        assert load(path) == content, f'IMMUTABLE_ARTIFACT_DRIFT:{path.name}'
    else:
        path.write_text(text, encoding='utf8')


def stats(values):
    values = sorted(values)
    import math
    return {'count': len(values), 'p50': values[max(0, math.ceil(len(values) * .5) - 1)] if values else None,
            'p95': values[max(0, math.ceil(len(values) * .95) - 1)] if values else None,
            'max': max(values) if values else None}


def main():
    corpus = load(OUT / 'phase12e-corpus.json')
    selected = load(OUT / 'phase12e-selected-configuration.json')
    final = load(OUT / 'phase12e-final-evaluation.json')
    baseline = load(OUT / 'phase12e-semantic-evidence-baseline.json')
    experiments = load(OUT / 'phase12e-experiments.json')
    index = load(OUT / 'phase12e-index-build.json')
    extraction = load(OUT / 'phase12e-extraction.json')
    plan = load(OUT / 'phase12e-evaluation-plan.json')
    validation = load(OUT / 'phase12e-validation.json')
    d = load(ROOT / 'data/gpx/phase12d/phase12d-final-evaluation.json')
    dc = load(ROOT / 'data/gpx/phase12d/phase12d-corpus.json')
    members = {m['relationId']: m for m in corpus['records']}
    fresh_ids = {key for key, m in members.items() if m['group'] == 'FRESH_PUBLISHED_REFERENCE'}
    green_ids = {key for key, m in members.items() if m['machineGreen']}
    train_ids = {key for key, m in members.items() if m['group'] == 'TRAIN'}
    assert len(fresh_ids) == 118 and len(green_ids) == 245 and not fresh_ids & green_ids
    assert {r['relationId'] for r in experiments['results']} == train_ids and len(train_ids) == 30
    assert selected['freshResultsOpened'] is False and final['freezeHash'] == selected['freezeHash']
    assert final['identity'] == selected['identity'] == experiments['identity']
    for path, expected in selected['identity']['sourceHashes'].items():
        assert sha(ROOT / path) == expected, f'FROZEN_SOURCE_DRIFT:{path}'
    results = [r for r in final['results'] if r['configuration'] == selected['configuration']['id']]
    assert {r['relationId'] for r in results} == set(members)
    assert len(results) == len(members) == 382

    def old_summary(predicate):
        rows = [r for r in d['results'] if predicate(members[r['relationId']])]
        return {'total': len(rows), 'semanticEvidenceAvailable': sum(r['signalCreated'] for r in rows),
                'entityResolved': sum(r['allAnchorsResolved'] for r in rows),
                'solverSolved': sum(r['solved'] for r in rows),
                'acceptableMatch': sum(bool(r['similarity']) and r['similarity']['classification'] in ACCEPTABLE for r in rows),
                'classifications': dict(Counter(r['similarity']['classification'] for r in rows if r['similarity'])),
                'failures': dict(Counter(r['failure'] for r in rows))}

    comparisons = {
        'TRAIN30': {'baseline': baseline['metrics'], 'selected': final['train']},
        'EXPOSED_REGRESSION_SET14': {'baseline': old_summary(lambda m: m['group'] == 'EXPOSED_REGRESSION_SET'), 'selected': final['exposedRegressionSet']},
        'HUMAN_GOLD44': {'baseline': old_summary(lambda m: m['humanApproved']), 'selected': final['humanGold44']},
        'BASE23': {'baseline': old_summary(lambda m: m['humanApproved'] and m['labels']['startContext'] == 'BASE_START'), 'selected': final['base23']},
        'HUT21': {'baseline': old_summary(lambda m: m['humanApproved'] and m['labels']['startContext'] == 'HUT_START'), 'selected': final['hut21']},
        'MACHINE_GREEN245': {'baseline': old_summary(lambda m: m['machineGreen']), 'selected': final['machineGreen245']},
        'FRESH_PUBLISHED_REFERENCE118': final['fresh'],
    }
    gains = {name: {key: pair['selected'][key] - pair['baseline'][key] for key in
             ['semanticEvidenceAvailable', 'entityResolved', 'solverSolved', 'acceptableMatch']} for name, pair in comparisons.items()}
    tothorn = next(r for r in results if r['relationId'] == '274491')
    baseline_train = baseline['metrics']
    improved = any(final['train'][key] > baseline_train[key] for key in ['acceptableMatch', 'solverSolved', 'routableAnchorResolved'])
    gates = {
        'trainOnlySelection': True, 'freshDisjointAndFrozenBeforeResults': True,
        'negativeFalseAutoAcceptZero': final['negative19']['falseAutoAccept'] == 0 and final['negative19']['autoCompatible'] == 0,
        'intrinsicNegativeFalseAcceptZero': final['negative19']['intrinsicNegativeFalseAccept'] == 0,
        'tothornNonAutoCompatible': not tothorn['autoCompatible'],
        'determinism100Percent': final['determinism']['checked'] == final['determinism']['passed'],
        'noUnsafeAutoCompatibleResult': all(not r['autoCompatible'] or (r['roadSafety'] == 'SAFE' and not r['safetyReasons'] and r['startContext'] in ['BASE_START', 'HUT_START']) for r in results),
        'noHutMatchOrSolverRegression': gains['HUT21']['acceptableMatch'] >= 0 and gains['HUT21']['solverSolved'] >= 0,
        'noMaterialFreshMatchRegression': gains['FRESH_PUBLISHED_REFERENCE118']['acceptableMatch'] >= -corpus['acceptance']['freshMatchDropAllowed'],
        'realTrainRoutableSolverOrMatchImprovement': improved,
        'finiteValidationPassed': all(c['exitCode'] == 0 for c in validation['checks']),
    }
    safety_ok = all(value for key, value in gates.items() if key != 'realTrainRoutableSolverOrMatchImprovement')
    outcome = 'SEMANTIC_ANCHOR_PASSED' if safety_ok and improved else 'SEMANTIC_ANCHOR_PARTIAL' if safety_ok else 'SEMANTIC_ANCHOR_BLOCKED'
    fresh_plan = [r for r in plan['records'] if r['relationId'] in fresh_ids]
    fresh_evaluability = {'enrolled': len(fresh_ids), 'excluded': corpus['freshExclusions'],
        'freshIdsJsonSha256': hashlib.sha256(json.dumps(sorted(fresh_ids), separators=(',', ':')).encode()).hexdigest(),
        'legitimateSemanticSignals': sum(bool(r['evidence']['signal']) for r in fresh_plan),
        'missingSignalReasons': dict(Counter(r['evidence']['reason'] for r in fresh_plan if not r['evidence']['signal'])),
        'unresolvedEntityReasons': dict(Counter(r['failure'] for r in results if r['relationId'] in fresh_ids and not r['entityResolved'])),
        'rule': 'All 118 remain evaluable as upstream outcomes; reconstructable subset is reported separately. ACTIVE is published reference, not new human gold.'}
    transitions = []
    stage_failure_details = []
    plan_by_id = {r['relationId']: r for r in plan['records']}
    for result in results:
        if result['signalCreated'] and not result['entityResolved']:
            record = plan_by_id[result['relationId']]
            roles = [('START', record['start']), *[(f'VIA_{i + 1}', v) for i, v in enumerate(record['vias'])], ('SUMMIT', record['summit'])]
            stage_failure_details.append({'relationId': result['relationId'], 'unresolvedRoles':
                [f"ENTITY_{role}_{anchor['status'] if anchor else 'NOT_FOUND'}" for role, anchor in roles if not anchor or anchor['status'] != 'RESOLVED']})
    old_by_id = {r['relationId']: r for r in d['results']}
    for result in results:
        old = old_by_id.get(result['relationId'])
        if old and (old['routeHash'] != result['routeHash'] or old['allAnchorsResolved'] != result['entityResolved']):
            transitions.append({'relationId': result['relationId'], 'group': members[result['relationId']]['group'],
                'baselineFailure': old['failure'], 'selectedFailure': result['failure'],
                'baselineClassification': old['similarity']['classification'] if old['similarity'] else None,
                'selectedClassification': result['similarity']['classification'] if result['similarity'] else None,
                'entityResolved': result['entityResolved'], 'routableAnchorResolved': result['routableAnchorResolved'],
                'methods': [p['method'] for p in result['projections']], 'safetyReasons': result['safetyReasons']})
    performance = {'semanticIndexBuildMs': index['indexBuildMs'], 'indexedFeatureCount': index['indexedFeatureCount'],
        'wantedNameCount': index['wantedNames'], 'entityResolverMs': stats([r['ms'] for r in index['resolverTimings']]),
        'largestSemanticCandidateSet': max(r['candidates'] for r in index['resolverTimings']),
        'training': experiments['performance'], 'final': final['performance'],
        'extraction': {k: v for k, v in extraction.items() if k != 'identity'}}
    attestations = {'productionDbWrites': 0, 'storageWrites': 0, 'publicationWrites': 0, 'activeChanges': 0,
        'productionSql': 0, 'externalRouteSourceRequests': 0, 'wikiloc': 0, 'komoot': 0, 'hikr': 0,
        'osmPublicGpx': 0, 'overpass': 0, 'liveOsmApi': 0, 'onlineGeocoder': 0, 'commits': 0, 'pushes': 0,
        'persistentProcessesStarted': 0, 'localCacheAndArtifactWrites': 'performed as authorized'}
    limitations = [
        'Independent semantic start evidence remains absent for many routes; no geometry-derived start or Phase11H display name was substituted.',
        'Named frozen feature catalogs lack explicit entrance/member topology. Entrance projection is deferred where unproven; no entrance is guessed from reference geometry.',
        'Feature-specific projection selects an existing eligible graph node and emits no straight-line geometry; physical access across the short off-graph snap remains an unrepresented access offset.',
        'Connectors require explicit pedestrian permission and actual shared OSM nodes. They are local bounded access paths only; no general road classes enter the default mountain graph.',
        'Via tags are independent evidence. No gold-derived corridor/via anchors or per-route exceptions were added. Via access supports bounded trail projection, not inferred connector detours.',
        'Fresh published references are not human-reviewed gold. Semantic inputs may be absent even when a published geometry exists.',
        'Phase12D negative topology controls retain their original frozen vetoes; unknown diagnostic start labels are not converted to observed facts.',
        'Legacy resolveRoutableAnchor is only a nearby-candidate helper; the new topology-aware projection and route-access wrapper provide routability evidence.',
        *dc['phase12cLimitations'],
    ]
    closing = {'schemaVersion': 'phase12e/closing-decision/v1', 'outcome': outcome, 'publishable': False,
        'phase12fStarted': False, 'configuration': selected['configuration'], 'freezeHash': selected['freezeHash'],
        'corpusHash': corpus['corpusHash'], 'datasetSha256': corpus['datasetSha256'], 'splitHash': corpus['phase12dSplitHash'],
        'gates': gates, 'comparisons': comparisons, 'gains': gains, 'freshEvaluability': fresh_evaluability,
        'negative19': final['negative19'], 'tothorn': tothorn, 'determinism': final['determinism'],
        'performance': performance, 'transitionAnalysis': transitions, 'limitations': limitations,
        'stageFailureDetails': stage_failure_details,
        'attestations': attestations, 'resultsHash': final['resultsHash']}
    immutable(OUT / 'phase12e-closing-decision.json', closing)
    rows = '\n'.join(f"| {name} | {v['baseline']['entityResolved']} → {v['selected']['entityResolved']} | "
        f"{v['baseline']['solverSolved']} → {v['selected']['solverSolved']} | {v['baseline']['acceptableMatch']} → {v['selected']['acceptableMatch']} / {v['selected']['total']} |"
        for name, v in comparisons.items())
    experiment_rows = '\n'.join(f"| {e['configuration']['id']} | {e['metrics']['semanticEvidenceAvailable']} | {e['metrics']['entityResolved']} | {e['metrics']['routableAnchorResolved']} | {e['metrics']['graphConnected']} | {e['metrics']['solverSolved']} | {e['metrics']['acceptableMatch']} |"
        for e in experiments['experiments'])
    bounds_rows = '\n'.join(f"| {name} | {b['snapM']} | {b['radiusM']} | {b['pathM']} | {b['roadM']} |" for name, b in selected['parameters']['featureBounds'].items())
    report = f"""# Phase 12E — semantic evidence and routable anchor resolution

Outcome: **{outcome}**. Selected: **{selected['configuration']['id']}**. Phase 12F not started; no publication authorized.

## Recovered continuation state

Local HEAD was `dd8066c6e0400cbcef42793fe2db94c1e6403173`, the old Phase 11 baseline.
Phase 12A/B/C/D/E files were local untracked work; package.json/package-lock.json already had GPX scripts and sax changes.
Preserved unrelated WIP and all completed Phase 12D artifacts. Existing Phase 12E had name normalization,
feature indexing, entity resolution, preliminary snap/connector helpers, graph connector scaffolding,
calibration/plan scripts and 19 tests; ACTIVE118 and a 264-record semantic plan existed.
There was no E corpus freeze, completed experiment, selection or final evaluation. Recovered TypeScript
failures were the missing RouteDiscoverySignal type and readonly summit-coordinate adapter; these were fixed first.
Existing 19 tests passed before continuation hardening. No completed E outcome was discarded or search restarted.

Already modified files recovered: `Lib/gpxIngestion/nameNormalization.ts`, `semanticFeatureIndex.ts`,
`semanticEntityResolution.ts`, `routableAnchorResolution.ts`, `osmTrailGraph.ts`, plus
`scripts/gpx/phase12e-calibration.ts`, `phase12e-plan.ts`, `phase12e-calibration.test.ts`, package scripts,
and existing `data/gpx/phase12e/phase12e-118-active.json`, `phase12e-semantic-plan.json`, `phase12e-feature-index.json`.
Those legacy v1 planning artifacts remain historical; `phase12e-evaluation-plan.json` is the complete frozen 382-record plan.

## Verified Phase 12D baseline and results

D selected baseline-v1: TRAIN30 signals22/entities8/solved6/acceptable5; exposed14 signals9/entities4/solved2/acceptable2.
Human44: signals31/entities12/solved8/acceptable7; BASE23 acceptable2, HUT21 acceptable5.
GREEN245: signals162/entities57/solved34/acceptable28 (12 exact, 9 near, 7 same variant), 6 different, 0 unrelated.
The often quoted 169 signals uses all264 including negatives; it is not the GREEN245 denominator.
E0 replay checked all30 TRAIN route hashes and comparison classes against immutable D outcomes.

| Corpus | Semantic entities D/E0 → selected | Solved D/E0 → selected | Acceptable D/E0 → selected |
| --- | ---: | ---: | ---: |
{rows}

Acceptable = EXACT_DUPLICATE + NEAR_DUPLICATE + SAME_VARIANT. Counts use full enrolled denominators.
Upstream stages are separate counts; entity resolution alone is not physical route success.
Exact/near/same/different/unrelated distributions and failure taxonomy for every corpus are in the closing JSON.
The frozen runner's coarse ENTITY_RESOLVED failure means the start resolved but a required via did not;
it is not a successful all-anchor outcome. `stageFailureDetails` gives the exact unresolved role for every case.
HUT regression: relation19370185 (Martin-Busch-Hütte → Kreuzspitze) explicitly names
`via=Brizzihütte (verf.)`, absent from the eligible independent name index. Baseline ignored this via;
E preserves it and fails closed. No reference-derived fallback or post-freeze tuning removes this failure.

## Leakage controls and fresh corpus

Input allowlist: relation from/to/via/name/official_name/local_name/alt_name/human-meaningful ref,
route/roundtrip/is_in, and independently confirmed summit ID/name. Summit catalog coordinates are independent OSM evidence.
No reference start/end, relation member sequence, geometry-derived via/corridor or Phase11H derived name is input.
SQLite opens read-only. Preparation projects relation tags and reference ID existence only.
Reference route geometry is first read strictly after independent solving, solely for unchanged compareRoutes evaluation.
Graph highways come from the frozen Alps PBF inside semantic entity envelopes (±0.025 degrees), never relation-selected ways.

Fresh118 was frozen before any E outcome. It is disjoint from GREEN245 (intersection **0**) and was not used for tuning.
All118 have frozen reference identity and one named confirmed summit; missing starts remain upstream failures rather than exclusions.
Fresh eligibility and insufficient-input details: `{json.dumps(fresh_evaluability, ensure_ascii=False)}`.
ACTIVE means published reference, not fresh human gold. Old14 is **EXPOSED_REGRESSION_SET**, never a fresh holdout.

Dataset SHA-256: `{corpus['datasetSha256']}`.
Corpus content hash: `{corpus['corpusHash']}`.
TRAIN/exposed split hash: `{corpus['phase12dSplitHash']}`.
Selection freeze hash: `{selected['freezeHash']}`.

## Evidence, normalization and resolution

The versioned evidence contract preserves START/VIA/SUMMIT/TERMINAL/VARIANT/REGION/TYPE/ELEVATION/SHAPE concepts,
source field, original and normalized text, provenance, confidence and semanticOnly=true; no geometry fields.
It rejects unsafe or >160-character values and >8 via hints; absence is explicit.
Unicode NFKC, case and whitespace normalization plus conservative apostrophe/hyphen normalization are deterministic.
Only whitelisted trailing structural qualifiers are stripped. Elevation qualifiers retain original text; >100m
conflicting feature elevation excludes a candidate. Missing elevation remains explicitly unproven.
No fuzzy rewriting or online geocoder. Index aliases include name, official/local/alt/short/old names and name:*.
{index['indexedFeatureCount']} selected named objects for {index['wantedNames']} wanted forms are indexed once with a name lookup;
all16 frozen source catalog hashes are persisted. No whole-Alps scan per signal.
Exact/type/region/elevation/independent summit proximity resolve entities; ties remain AMBIGUOUS, missing stays NOT_FOUND.
Candidate overflow fails closed. Plan records retain candidate order, winner, runner-up, confidence and reasons.

## Routable anchor and access policy

Entity identity remains separate from graph node identity. Exact eligible entity node is preferred, then bounded
projection to a safe node that can reach the independent summit. Source dataset, method and snap distance persist.
The wrapper adapts the projection for the existing baseline-v1 solver; it never inserts a straight-line segment.
Explicit entrance topology is not available in these frozen named catalogs and is not invented.

| Family | Trail snap m | Connector radius m | Total access path m | Road portion m |
| --- | ---: | ---: | ---: | ---: |
{bounds_rows}

Initial road snap ≤75m; ≤2000 trail candidates/local edges, ≤64 road starts, ≤10000 visited nodes, ≤20000 queued states.
Pedestrian/residential/living_street/service/unclassified connectors need explicit pedestrian permission.
Only actual consecutive OSM edges in the bounded chosen access path enter the local graph, with a 1.15 connector cost.
They must share a real node with a summit-reachable mountain trail. Nearby but disconnected road geometry cannot bridge gaps.
Default mountain path/footway/steps/track eligibility, hiking-cost/v1, A*/v1 and Phase11 similarity thresholds are unchanged.
Motorways/links, disallowed road classes, foot=no, forbidden/private without foot override, ambiguous access,
impassable or incomplete geometry fail closed. Direction is respected. HIGH/AMBIGUOUS starts remain non-auto-compatible.
Start context is classified at the semantic entity, not the projected trail node; road safety checks traversed edges
and frozen nearby motorway grade evidence. No kilometre-scale general road routing is admitted.

## Four finite TRAIN-only experiments and freeze

| Config | Signals | Entities | Routable | Connected | Solved | Acceptable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
{experiment_rows}

Selection priority was persisted before evaluation: false auto accept0, maximize TRAIN acceptable, solved, routable,
minimize ambiguous, retain simpler/older on tie. Synthetic hard controls gate implementation; real19 negatives are
final validation, not a selection/tuning set. Winner/ranking/reason, all versions and parameters, source/cache hashes,
corpus/split identities and training metrics are immutable in selected-configuration.json.
Only after that freeze were exposed14, full44, GREEN245, negative19 and fresh baseline/selected outcomes evaluated.
No parameters were changed after observing them. Total configurations:4, below the hard maximum12.
The selected E2 configuration has connectors disabled. E3's bounded connector implementation passed synthetic
topology/access tests but added no TRAIN physical matches and was not selected.

## Safety, determinism and acceptance

Gates: `{json.dumps(gates)}`.
Negative19: `{json.dumps(final['negative19'])}`.
Tothorn274491: failure={tothorn['failure']}, autoCompatible={tothorn['autoCompatible']}, frozen vetoes={tothorn['frozenVetoes']}.
Determinism: {final['determinism']['passed']}/{final['determinism']['checked']} outcomes.
Executed solvers are repeated; base graphs rebuilt in reverse way order; projections/local graph hashes checked similarly.
Pre-solver outcomes use deterministic frozen evidence. This is offline reconstruction validation, not browser/runtime testing.
PASS requires actual TRAIN routable/solver/match gain, no HUT match/solver drop, fresh match drop at most1,
zero negative false auto accepts and all safety/determinism gates. Name-only gains cannot force PASS.

## Performance and reuse

Index build {index['indexBuildMs']:.1f}ms; entity resolver p50/p95 `{performance['entityResolverMs']}`.
Largest semantic candidate set {performance['largestSemanticCandidateSet']}.
Extraction reused118 exact D envelopes, scanned22 new envelopes once, collected17861 unique highway ways in826.682s.
Final performance: `{json.dumps(final['performance'])}`.
TRAIN performance: `{json.dumps(experiments['performance'])}`.
Graph cache keys include immutable extraction cache and region; a bounded four-region memory cache avoids repeated builds.
Atomic per-route checkpoints include dataset/corpus/split, all semantic/anchor/connector/graph/solver/cost versions,
configuration/parameters, index/plan and source/cache/feature hashes. Incompatible shards fail closed.
Baseline D reference results and PBF extraction are reused; final replay reuses compatible TRAIN shards.
Large semantic indexes and SQLite caches are gitignored. No expensive PBF rescan is needed for compatible resume.

## Changes, validation and remaining limits

Continuation patched the recovered normalization/index/resolver/access/graph/calibration files and added
semanticEvidence.ts, semanticRouteAccess.ts, phase12e-prepare.py, phase12e-evaluation-plan.ts,
phase12e-complete-plan.ts, phase12e-extract.py, phase12e-run.ts and this closing script.
osmRouteReconstruction.ts only widens the graph-version type; A* is unchanged. PHASE_12_PLAN.md and its
contract assertion now stop before unauthorized12F. Package dependencies were not changed by this continuation.

Executed checks: `{json.dumps(validation['checks'])}`.
No application UI/server change requires a persistent runtime check for this offline task; browser/mobile runtime was not tested.

""" + '\n'.join(f'- {item}' for item in limitations) + f"""

Attestations: `{json.dumps(attestations)}`.

Artifacts: corpus, semantic-evidence-baseline, experiment-grid, experiments, selected-configuration,
final-evaluation, closing-decision, validation and artifact-hashes JSON, plus this report.
`phase12e-artifact-hashes.json` contains file SHA-256 values; embedded corpus/freeze hashes identify canonical content.
Final result content hash: `{final['resultsHash']}`.
"""
    report_path = OUT / 'PHASE_12E_REPORT.md'
    if report_path.exists():
        assert report_path.read_text(encoding='utf8') == report
    else:
        report_path.write_text(report, encoding='utf8')
    artifact_paths = sorted(p for p in OUT.iterdir() if p.is_file() and p.name != 'phase12e-artifact-hashes.json')
    immutable(OUT / 'phase12e-artifact-hashes.json', {'algorithm': 'SHA-256 file bytes',
        'artifacts': {p.name: sha(p) for p in artifact_paths}, 'selectedSourceHashes': selected['identity']['sourceHashes'],
        'additionalDeliverableSourceHashes': {p: sha(ROOT / p) for p in ['scripts/gpx/phase12e-close.py',
            'scripts/gpx/phase12e-calibration.test.ts', 'scripts/gpx/phase12e-complete-plan.ts', 'PHASE_12_PLAN.md']}})
    print(json.dumps({'outcome': outcome, 'gates': gates, 'gains': gains, 'freezeHash': selected['freezeHash'], 'reportSha256': sha(report_path)}))


if __name__ == '__main__':
    main()
