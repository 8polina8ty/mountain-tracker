"""Offline, deterministic Phase 12D corpus; never read relation members/geometry."""
import hashlib
import json
import pathlib
import sqlite3
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12d'
ALPS = ROOT / 'data/osm/alps'
EXPECTED = '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def write_once(path, value):
    if path.exists():
        if load(path) != value:
            raise RuntimeError(f'INCOMPATIBLE_EXISTING_ARTIFACT:{path.name}')
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    closing = load(ROOT / 'data/gpx/phase12c/phase12c-closing-decision.json')
    assert closing['phase12cAcceptance'] == 'STRICT_NEGATIVE_ACCEPTED'
    print('Verifying frozen PBF SHA-256...', flush=True)
    actual = digest(ROOT / 'data/osm/source/alps-latest.osm.pbf')
    if actual != EXPECTED:
        raise RuntimeError('PHASE12D_DATASET_IDENTITY_MISMATCH')
    sources = ['staging/phase11i-human-calibration-result.json',
               'staging/phase11g-expanded-green-candidates.json',
               'staging/phase11f3-start-context-classification.json',
               'audit/canonical-confirmed-routes.jsonl',
               'audit/phase11e-topology-recovery-audit.json',
               'publication/phase11-final-closure-report.json',
               'checkpoints/fafc4f7a772832f2/manifest.json']
    human = load(ALPS / sources[0])['records']
    extended = load(ALPS / sources[1])['records']
    starts = load(ALPS / sources[2])['routes']
    canonical = {x['canonicalRouteSourceId']: x for x in
                 map(json.loads, (ALPS / sources[3]).read_text(encoding='utf8').splitlines())}
    old = {x['sourceRelationId']: x for x in starts}
    green = {k: {'startContext': v['startContext']['type'],
                 'verticalGainMeters': v['startContext']['verticalGainMeters']}
             for k, v in old.items() if v['startContext']['type'] in ['BASE_START', 'HUT_START']}
    assert len(green) == 124
    assert not set(green) & {x['canonicalRouteSourceId'] for x in extended}
    green.update({x['canonicalRouteSourceId']: x for x in extended})
    assert len(green) == 245 and len(human) == 44
    assert all(x['humanDecision'] == 'VISUALLY_APPROVED' for x in human)
    gold = {x['canonicalRelationId']: x for x in human}
    assert set(gold) <= set(green)
    order = lambda key: hashlib.sha256(('phase12d/split/v1:' + key).encode()).hexdigest()
    split = {}
    for context, train_count, expected_count in [('BASE_START', 16, 23), ('HUT_START', 14, 21)]:
        ids = sorted([k for k, v in gold.items() if v['startContext'] == context], key=order)
        assert len(ids) == expected_count
        split.update({k: 'TRAIN' if i < train_count else 'HOLDOUT' for i, k in enumerate(ids)})
    negative = {'274491': ['START_HIGH_MOUNTAIN']}
    for context, category in [('HIGH_MOUNTAIN_START', 'START_HIGH_MOUNTAIN'),
                              ('AMBIGUOUS_START', 'START_AMBIGUOUS')]:
        ids = sorted([k for k, v in old.items() if v['startContext']['type'] == context], key=order)
        for key in ids[:6]:
            negative.setdefault(key, []).append(category)
    topology = load(ALPS / sources[4])['records']
    for item in sorted([x for x in topology if x['recovery']['status'] == 'BLOCKED'],
                       key=lambda x: order(x['sourceRelationId']))[:6]:
        negative.setdefault(item['sourceRelationId'], []).append('TOPOLOGY_FAILURE')
    checkpoint = ALPS / 'checkpoints/fafc4f7a772832f2/bulk-store.sqlite'
    db = sqlite3.connect(checkpoint.as_uri() + '?mode=ro', uri=True)
    # SQL projects original tags only. Route geometry and member identities never enter this builder.
    def tags_for(key):
        row = db.execute("SELECT json_extract(payload,'$.tags') FROM relations WHERE id=?", (key,)).fetchone()
        return json.loads(row[0]) if row else {}
    records = []
    for key in sorted(set(green) | set(negative), key=int):
        tags = tags_for(key)
        summits = canonical.get(key, {}).get('confirmedSummits', [])
        facts = {'relationTags': {k: tags.get(k) for k in ['name', 'ref', 'from', 'to', 'route', 'roundtrip']},
                 'summits': [{'id': x['peakSourceId'], 'name': x['peakName']} for x in summits]}
        context = green.get(key, {}).get('startContext', old.get(key, {}).get('startContext', {}).get('type', 'AMBIGUOUS_START'))
        score = canonical.get(key, {}).get('qualityScore')
        records.append({'relationId': key, 'machineGreen': key in green, 'humanApproved': key in gold,
                        'split': split.get(key), 'negativeReasons': sorted(set(negative.get(key, []))),
                        'facts': facts, 'factsHash': stable_hash(facts),
                        'labels': {'startContext': context, 'qualityScore': score,
                                   'qualityBand': gold.get(key, {}).get('qualityBand', 'UNKNOWN' if score is None else
                                                                     'Q90+' if score >= 90 else 'Q75_89' if score >= 75 else 'Q65_74' if score >= 65 else 'BELOW_Q65'),
                                   'distanceM': canonical.get(key, {}).get('distanceMeters'),
                                   'verticalGainM': green.get(key, {}).get('verticalGainMeters', old.get(key, {}).get('startContext', {}).get('verticalGainMeters'))},
                        'truthReference': f'{checkpoint.relative_to(ROOT).as_posix()}#routes/{key}'})
    db.close()
    OUT.mkdir(exist_ok=True, parents=True)
    corpus = {'schemaVersion': 'phase12d/corpus/v1', 'datasetSha256': actual,
              'sourceArtifacts': {p: digest(ALPS / p) for p in sources},
              'phase12cLimitations': closing['documentedLimitations'],
              'splitVersion': 'phase12d/split/v1', 'splitHash': stable_hash(split), 'split': split,
              'counts': {'humanGold': 44, 'extendedGreen': 245, 'negative': len(negative), 'unique': len(records)},
              'negativeCoverageLimitation': 'Frozen inspected road-safety artifacts contain only SAFE records; no fabricated road-blocked relation labels. Hard-access adversarial graph controls are tested separately.',
              'acceptanceCriteria': {'minimumExtended': 120, 'requiredGold': 44, 'negativeFalseAccept': 0,
                                     'determinismRate': 1, 'trainingImprovementMinimumAdditionalMatches': 1,
                                     'maximumHoldoutMatchCountDrop': 1, 'safetyRegressionAllowed': False,
                                     'noImprovementOutcome': 'CALIBRATION_PARTIAL'},
              'records': records}
    write_once(OUT / 'phase12d-corpus.json', corpus)
    print(json.dumps({'counts': corpus['counts'], 'splitHash': corpus['splitHash']}), flush=True)


if __name__ == '__main__':
    main()
