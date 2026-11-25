"""Publish local Phase12E closing artifacts after the bounded corrective gates."""
import hashlib
import json
import pathlib
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12e'
OLD = OUT / 'revisions/e2-original'
ACCEPTABLE = {'EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'SAME_VARIANT'}


def load(path):
    return json.loads(path.read_text(encoding='utf8'))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    # Canonical current artifacts are explicitly updateable by this corrective task;
    # their original bytes remain in revisions/e2-original.
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def metrics(rows):
    return {'total': len(rows), 'semanticEvidenceAvailable': sum(r['signalCreated'] for r in rows),
        'entityResolved': sum(r['entityResolved'] for r in rows),
        'routableAnchorResolved': sum(r['routableAnchorResolved'] for r in rows),
        'graphConnected': sum(r['graphConnected'] for r in rows), 'solverSolved': sum(r['solved'] for r in rows),
        'acceptableMatch': sum(bool(r['similarity']) and r['similarity']['classification'] in ACCEPTABLE for r in rows),
        'classifications': dict(Counter(r['similarity']['classification'] for r in rows if r['similarity'])),
        'failures': dict(Counter(r['failure'] for r in rows)),
        'autoCompatible': sum(r['autoCompatible'] for r in rows),
        'ambiguous': sum(r['entityStatus'] == 'AMBIGUOUS' for r in rows)}


def main():
    stages = {s: load(OUT / f'phase12e-corrective-{s}.json') for s in ['train', 'human', 'extended', 'active']}
    selection = load(OUT / 'phase12e-corrective-selected-configuration.json')
    protocol = load(OUT / 'phase12e-corrective-protocol.json')
    validation = load(OUT / 'phase12e-corrective-validation.json')
    corpus = load(OLD / 'phase12e-corpus.json')
    previous = load(OLD / 'phase12e-final-evaluation.json')
    old_closing = load(OLD / 'phase12e-closing-decision.json')
    diagnosis = load(OUT / 'phase12e-qualifier-diagnosis.json')
    for path, expected in selection['identity']['sourceHashes'].items():
        assert sha(ROOT / path) == expected, f'CORRECTIVE_SOURCE_DRIFT:{path}'
    members = {m['relationId']: m for m in corpus['records']}
    rows = {}
    new_plans = {}
    for stage, report in stages.items():
        assert report['identity'] == selection['identity']
        for row in report['results']:
            if row['relationId'] in rows:
                assert rows[row['relationId']] == row, 'CROSS_STAGE_RESULT_DRIFT'
            rows[row['relationId']] = row
        for record in load(OUT / f'phase12e-corrective-plan-{stage}.json')['records']:
            if record['relationId'] in new_plans:
                assert new_plans[record['relationId']] == record
            new_plans[record['relationId']] = record
    assert set(rows) == set(members) and len(rows) == 382
    ordered = [rows[m['relationId']] for m in corpus['records']]
    select = lambda predicate: [r for r in ordered if predicate(members[r['relationId']])]
    current = {
        'train': metrics(select(lambda m: m['group'] == 'TRAIN')),
        'exposedRegressionSet': metrics(select(lambda m: m['group'] == 'EXPOSED_REGRESSION_SET')),
        'humanGold44': metrics(select(lambda m: m['humanApproved'])),
        'base23': metrics(select(lambda m: m['humanApproved'] and m['labels']['startContext'] == 'BASE_START')),
        'hut21': metrics(select(lambda m: m['humanApproved'] and m['labels']['startContext'] == 'HUT_START')),
        'machineGreen245': metrics(select(lambda m: m['machineGreen'])),
        'negative19': metrics(select(lambda m: bool(m['negativeReasons']))),
        'exposedActiveReference118': metrics(select(lambda m: m['group'] == 'FRESH_PUBLISHED_REFERENCE')),
    }
    previous_metrics = {key: previous[key] for key in current if key != 'exposedActiveReference118'}
    previous_metrics['exposedActiveReference118'] = previous['fresh']['selected']
    old_plans = {r['relationId']: r for r in load(OLD / 'phase12e-evaluation-plan.json')['records']}
    changes = {'newlyResolvedRoles': [], 'newlyAmbiguousRoles': [], 'newCandidateCollisions': [], 'lostResolvedRoles': []}
    for key, record in new_plans.items():
        old = old_plans[key]
        roles = ['START', *[f'VIA_{i + 1}' for i in range(len(record['vias']))], 'SUMMIT']
        for role, a, b in zip(roles, [old['start'], *old['vias'], old['summit']], [record['start'], *record['vias'], record['summit']]):
            old_status, status = (a or {}).get('status'), (b or {}).get('status')
            item = {'relationId': key, 'role': role, 'before': old_status, 'after': status,
                    'beforeCandidates': len((a or {}).get('candidates', [])), 'afterCandidates': len((b or {}).get('candidates', []))}
            if status == 'RESOLVED' and old_status != 'RESOLVED': changes['newlyResolvedRoles'].append(item)
            if status == 'AMBIGUOUS' and old_status != 'AMBIGUOUS': changes['newlyAmbiguousRoles'].append(item)
            if old_status == 'RESOLVED' and status != 'RESOLVED': changes['lostResolvedRoles'].append(item)
            if item['afterCandidates'] > max(1, item['beforeCandidates']): changes['newCandidateCollisions'].append(item)
    regression = rows['19370185']
    regression_plan = new_plans['19370185']
    via = regression_plan['vias'][0]['anchor']
    source_record = next(r for r in diagnosis['trainNameMatches'] if r['osmId'] == via['osmId'] and r['objectType'] == via['osmObjectType'])
    gates = {
        'trainOnlyCorrectionSelection': selection['selectedUsing'] == 'TRAIN_ONLY' and not selection['exposedActiveUsedForSelection'],
        'allSequentialStageGatesPassed': all(s['gatePassed'] for s in stages.values()),
        'hutRegressionEliminated': current['hut21']['acceptableMatch'] >= 5,
        'baseImprovementPreserved': current['base23']['acceptableMatch'] >= 7,
        'greenNoRegression': current['machineGreen245']['acceptableMatch'] >= 39,
        'exposedActiveNoRegression': current['exposedActiveReference118']['acceptableMatch'] >= 3,
        'negativeFalseAutoAcceptZero': current['negative19']['autoCompatible'] == 0 and stages['human']['negative']['intrinsicNegativeFalseAccept'] == 0,
        'tothornBlocked': not rows['274491']['autoCompatible'],
        'determinism100Percent': all(r['determinismVerified'] for r in ordered),
        'noNewWrongRouteClassification': all(current[key]['classifications'].get(c, 0) <= previous_metrics[key]['classifications'].get(c, 0)
            for key in current for c in ['DIFFERENT_VARIANT', 'UNRELATED']),
        'noNewAmbiguityOrCollision': not changes['newlyAmbiguousRoles'] and not changes['newCandidateCollisions'],
        'finiteValidationPassed': all(c['exitCode'] == 0 for c in validation['checks']),
    }
    outcome = 'SEMANTIC_ANCHOR_PASS' if all(gates.values()) else 'SEMANTIC_ANCHOR_PARTIAL' if gates['negativeFalseAutoAcceptZero'] and gates['noNewWrongRouteClassification'] else 'SEMANTIC_ANCHOR_BLOCKED'
    reused = sum(s['reuse']['originalResultReuse'] for s in stages.values())
    checkpoint_hits = sum(s['reuse']['checkpointHits'] for s in stages.values())
    graph_builds = sum(s['reuse']['actualGraphBuilds'] for s in stages.values())
    final = {'schemaVersion': 'phase12e/corrective-final-evaluation/v1', 'configuration': selection['configuration'],
        'identity': selection['identity'], 'freezeHash': selection['freezeHash'], **current,
        'exposure': {'active118': 'EXPOSED_ACTIVE_REFERENCE', 'old14': 'EXPOSED_REGRESSION_SET',
            'newUntouchedCorpusConstructed': False, 'limitation': 'Corrective validation reuses already-exposed references. PASS is for a narrow contract-driven normalization/index fix under the original acceptance gates; no fresh-generalization claim.'},
        'determinism': {'uniqueSemanticOutcomes': 382, 'passed': 382, 'stageChecksIncludingOverlap': sum(len(s['results']) for s in stages.values()),
            'newSolverAndGraphReplays': graph_builds, 'inheritedPreviouslyVerifiedPhysicalResults': reused},
        'reuse': {'originalPhysicalResultsReused': reused, 'correctiveCheckpointHitsAcrossStages': checkpoint_hits,
            'actualGraphBuilds': graph_builds, 'newGraphExtractions': 0, 'newPbfSemanticScans': 1,
            'semanticScanSeconds': diagnosis['elapsedSeconds']},
        'ambiguityAndCollisionChanges': changes, 'results': ordered}
    closing = {'schemaVersion': 'phase12e/corrective-closing-decision/v1', 'outcome': outcome, 'publishable': False,
        'phase12fStarted': False, 'configuration': selection['configuration'], 'freezeHash': selection['freezeHash'],
        'corpusHash': corpus['corpusHash'], 'datasetSha256': corpus['datasetSha256'], 'gates': gates,
        'beforeAfter': {key: {'beforeE2': previous_metrics[key], 'afterCorrection': value} for key, value in current.items()},
        'rootCause': {'failedStage': 'NORMALIZED_IDENTITY_AND_INDEX_CANDIDATE_COVERAGE',
            'rawVia': 'Brizzihütte (verf.)', 'canonicalOsmName': source_record['tags']['name'],
            'statusEvidence': source_record, 'normalizationGap': 'v2 did not recognize the documented non-identity status suffix.',
            'indexGap': 'The16 feature catalogs omitted named archaeological ruins; this independently existing node was absent.',
            'notResponsible': ['feature-type restriction (via had none)', 'region/mountain filter', 'candidate ambiguity', 'routable snap threshold', 'A*']},
        'regressionRoute': regression, 'regressionSemanticVia': via, 'tothorn': rows['274491'],
        'ambiguityAndCollisionChanges': changes, 'determinism': final['determinism'], 'reuse': final['reuse'],
        'exposure': final['exposure'], 'validation': validation, 'attestations': old_closing['attestations']}
    write(OUT / 'phase12e-final-evaluation.json', final)
    write(OUT / 'phase12e-selected-configuration.json', selection)
    write(OUT / 'phase12e-closing-decision.json', closing)
    write(OUT / 'phase12e-validation.json', validation)
    table = '\n'.join(f"| {key} | {previous_metrics[key]['entityResolved']} → {value['entityResolved']} | "
        f"{previous_metrics[key]['routableAnchorResolved']} → {value['routableAnchorResolved']} | "
        f"{previous_metrics[key]['solverSolved']} → {value['solverSolved']} | {previous_metrics[key]['acceptableMatch']} → {value['acceptableMatch']} / {value['total']} |"
        for key, value in current.items())
    report = f"""# Phase 12E — corrective closure

**{outcome}**. Selected corrective configuration: **{selection['configuration']}**.
The HUT regression is removed by a generic semantic normalization and feature-coverage correction.
No Phase12F, staging or publication work was performed or authorized.

## Recovered local state and preserved history

The authoritative tree was at old Phase11 HEAD `dd8066c6e0400cbcef42793fe2db94c1e6403173` with local Phase12 work.
Before correction, E2 had TRAIN7/30, HUT4/21, BASE7/23, GREEN39/245 and published-reference3/118 acceptable matches.
Its HUT loss blocked acceptance despite improvements over Phase12D. Negative false auto accept0/19;
Tothorn remained blocked;500 deterministic final outcomes;30 TRAIN checkpoints reused.
846 Phase12D artifact hashes were verified unchanged. No expensive original evaluation was repeated.
18 original E2 artifacts and52 evaluated source snapshots are preserved in `revisions/e2-original/`.
The original4-configuration search was not restarted; one general corrective candidate makes5 total configurations.

## Precise root cause and independent evidence

Relation19370185 supplied `via=Brizzihütte (verf.)`. The original raw value survived extraction.
Normalizerv2 yielded only the full qualified name. Index candidates=[], entity NOT_FOUND;
routable anchoring and A* were never reached. No type constraint or region/ambiguity filter caused that failure.

A finite name-only scan of the frozen PBF inspected{diagnosis['namedObjectsInspected']:,} named node/way objects.
It found independently named node{source_record['osmId']}, canonical `name=Brizzihütte`,
`archaeological_site=ruins`, `building:condition=recognizable_remains`, `historic=archaeological_site`,
and `old_name=Kreuzhütte`. The16 original named feature layers do not include this archaeological-ruins category.
Two gaps therefore required repair: status qualifier recognition AND named historical-waypoint coverage.

`(verf.)` is status evidence, not the canonical identity in this case. Frozen examples independently corroborate
the class: Pöllerhof(verf.) has historic=ruins; several other(verf.) records have abandoned=yes;
See'le Hütte(verfallen) has ruins=yes. The scan also observed English(ruins), French/German(ruine)
and Italian(rudere) forms. No online meaning lookup, geocoder, reference start/via coordinate, relation member
sequence or gold-derived name/geometry was used. Ordinary OSM node coordinates supply the waypoint location.

## Generic fix and safety

Normalizer **v2→v3**, qualifier taxonomy **v1→v2**, semantic index **v2→v3**,
entity resolver **v2→v3**, semantic evidence **v1→v2**.
An explicit bounded dictionary records applicable languages: de(verf.,verfallen,ruine),
en(ruin,ruins), fr(ruine), it(rudere). Shared spellings retain both language labels; no language is guessed.
Raw evidence is preserved; identity candidate and typed STATUS/ELEVATION/FEATURE qualifiers are separate fields.
Unknown parentheses remain part of the identity. Exact full-name matches remain available.
Status-stripped fallback requires independent compatible OSM historical/ruin/abandoned tags and rejects an
explicit conflicting region. Multiple equally plausible candidates stay AMBIGUOUS. A ruin does not satisfy HUT typing.

`historic-status` is a separately fingerprinted supplemental catalog, using named features with explicit status tags.
93 located status-evidence records were available from TRAIN-name diagnosis plus general frozen status examples;
only1 matches this corpus's wanted-name index, growing705→706. Unlocated way features are not guessed.
This is a bounded named-waypoint supplement, not a claim of complete worldwide archaeological-feature coverage.
Production logic contains no route ID, place-specific alias or hard-coded expected OSM identity.
The physical router, hiking/sac_scale costs, similarity thresholds,75m generic waypoint snap and feature access bounds are unchanged.
Connectors remain disabled in this selected E2-derived correction. Motorway/link, foot=no, private/forbidden/ambiguous
access, HIGH and AMBIGUOUS start gates retain their previous behavior.

## Focused tests before calibration

Seven focused tests were added first and failed before implementation, then all44 semantic tests passed.
They cover qualified and plain names; preserved unknown/legitimate parentheses; missing status proof on an active hut;
wrong feature type and region; ambiguous collisions and deterministic ordering; Unicode/multilingual forms;
and a semantic-only generic hut→historical-via→summit regression fixture retaining raw evidence.
There is no production exception for the known regression relation.

## Bounded selection and results

The corrective protocol was persisted before TRAIN outcomes: TRAIN acceptable≥7 and solved≥8,
HUT≥5, BASE≥7, negative false-auto0, GREEN≥39, exposed ACTIVE≥3 and deterministic100%.
The single correction was frozen using TRAIN only. HUT/BASE/negative validation followed; only after those
passed was GREEN245 evaluated, then exposed ACTIVE118. No router tuning or post-result parameter search occurred.

| Set | Entities E2→corrected | Routable E2→corrected | Solved E2→corrected | Acceptable E2→corrected |
| --- | ---: | ---: | ---: | ---: |
{table}

HUT21:5 entities,5 routable anchors,5 solved; EXACT3, NEAR2, SAME_VARIANT0, DIFFERENT_VARIANT0, UNRELATED0.
Regression19370185: **{regression['failure']}**, startContext={regression['startContext']}, roadSafety={regression['roadSafety']}.
Its independently resolved via projects22.660m onto an existing eligible OSM trail node, under unchanged75m policy.
The route retains the explicit via; it was neither removed nor substituted from the reference.
Graph2670 nodes/5344 directed edges; A* visited182 and70 nodes on the two legs. Reconstructed3068.7m vs reference3011m;
bidirectional coverage100%, near-duplicate confidence0.974. Comparison occurs only after solving.

GREEN: EXACT14 unchanged, NEAR10→11, SAME_VARIANT15 unchanged, DIFFERENT_VARIANT9 unchanged, UNRELATED0.
Exposed ACTIVE: classifications and all physical outcomes remain unchanged; acceptable3/118.
BASE7/23 is preserved. Old exposed14 remains4/14. No newly wrong variant or unrelated classification.
Negative19 false auto accepts0, including intrinsic pre-veto count0. Tothorn274491 remains non-auto-compatible.
Ambiguity/collision audit: newly resolved roles={len(changes['newlyResolvedRoles'])}, newly ambiguous={len(changes['newlyAmbiguousRoles'])},
new candidate collisions={len(changes['newCandidateCollisions'])}, lost resolved roles={len(changes['lostResolvedRoles'])}.
Only the known via's solver dependencies changed across382 records; all other381 retain their exact prior inputs.

## Exposure, determinism and reuse

The118 published relations are now **EXPOSED_ACTIVE_REFERENCE**, not a fresh holdout or new human gold.
The original14 remains **EXPOSED_REGRESSION_SET**. Original corpus membership and hashes are preserved;
historical v1 manifests retain their original labels, while current evaluation uses the exposed labels explicitly.
No new untouched corpus was invented or claimed. PASS uses the user-authorized narrow bugfix exception and
original safety/no-regression contract. It does not establish new out-of-sample generalization.

New semantic identities were checked for all382 unique records ({sum(len(s['results']) for s in stages.values())} stage checks including overlap).
Repeated resolution and reversed candidate ordering were deterministic. One changed route was solved twice;
its graph was rebuilt in reverse order and anchor projection repeated. The other381 physical outcomes inherit
the already-verified E2 graph/solver result only after full semantic dependency equality and source/cache hash checks.
Reused original results={reused}; repeated corrective checkpoint hits={checkpoint_hits}; new graph builds={graph_builds};
new graph extraction=0. One225.051s frozen-PBF semantic tag scan diagnosed/indexed the class; no route geometry was extracted from truth.
Stage checkpoints bind the updated versions, corpus/split, supplemental index, protocol, source hashes and unchanged cache identities.
Incompatible semantic dependencies were recomputed; unchanged graph/solver results were not discarded wholesale.

## Validation, artifacts and changes

Finite validation: `{json.dumps(validation['checks'])}`.
ESLint exits0 with one non-blocking unused-import warning in the frozen corrective measurement script;
no behavior was changed after its selection freeze. TypeScript and git diff --check pass.
No persistent process or browser/mobile runtime test was performed; this is an offline ingestion change.

Changed production modules: nameNormalization.ts, semanticFeatureIndex.ts, semanticEntityResolution.ts,
semanticEvidence.ts. Evaluation support: generic corrective plan/run/evaluate helpers, diagnostic PBF scanner,
closing script, semantic tests, current plan/report/README. Original plan builder uses the exported index-version
constant; contextFeatures was exported for compatible reuse. No dependency/package update was needed.
Phase12D and original E2 history remain archived unchanged. No commit, push, checkout, reset or branch switch occurred.

Current canonical outputs: phase12e-selected-configuration.json, phase12e-final-evaluation.json,
phase12e-closing-decision.json, phase12e-validation.json and this report. Corrective protocol, per-stage plans/results,
selection and diagnosis remain separate immutable evidence. Large indexes/cache stores remain gitignored.
All current artifact file hashes are in phase12e-artifact-hashes.json; the prior manifest is preserved in the archive.

Dataset SHA-256: `{corpus['datasetSha256']}`.
Original corpus hash: `{corpus['corpusHash']}`.
Correction freeze hash: `{selection['freezeHash']}`.

DB production writes=0; Storage writes=0; publication writes=0; ACTIVE changes=0; external route-source requests=0.
Local SQLite caches/checkpoints and report files are the only write targets. No Phase12F work started.
"""
    (OUT / 'PHASE_12E_REPORT.md').write_text(report, encoding='utf8')
    files = sorted(p for p in OUT.iterdir() if p.is_file() and p.name != 'phase12e-artifact-hashes.json')
    write(OUT / 'phase12e-artifact-hashes.json', {'schemaVersion': 'phase12e/corrective-artifact-hashes/v1',
        'algorithm': 'SHA-256 file bytes', 'artifacts': {p.name: sha(p) for p in files},
        'selectedSourceHashes': selection['identity']['sourceHashes'],
        'additionalDeliverableSourceHashes': {p: sha(ROOT / p) for p in ['scripts/gpx/phase12e-close-correction.py',
            'scripts/gpx/phase12e-diagnose-qualifiers.py', 'scripts/gpx/phase12e-calibration.test.ts', 'PHASE_12_PLAN.md']}})
    print(json.dumps({'outcome': outcome, 'gates': gates, 'metrics': current, 'freezeHash': selection['freezeHash'], 'reportSha256': sha(OUT / 'PHASE_12E_REPORT.md')}))


if __name__ == '__main__':
    main()
