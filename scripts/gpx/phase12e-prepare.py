"""Finish the already-started ACTIVE manifest; semantic SQL projections only."""
import hashlib
import json
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12e'


def load(path):
    return json.loads(path.read_text(encoding='utf8'))


def main():
    d = load(ROOT / 'data/gpx/phase12d/phase12d-corpus.json')
    active = load(OUT / 'phase12e-118-active.json')
    with (ROOT / 'data/osm/source/alps-latest.osm.pbf').open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == d['datasetSha256'], 'DATASET_IDENTITY_MISMATCH'
    published = load(ROOT / 'data/osm/alps/publication/phase11c3-v2-batch-100.json')
    recovered_ids = set(published['baselineSnapshot']['baselineRelationIds']) | {r['canonicalRouteSourceId'] for r in published['records']}
    assert recovered_ids == set(active['activeRelationIds']) and len(recovered_ids) == 118
    assert not recovered_ids & {m['relationId'] for m in d['records'] if m['machineGreen']}
    canonical = {r['canonicalRouteSourceId']: r for r in map(json.loads, (ROOT / 'data/osm/alps/audit/canonical-confirmed-routes.jsonl').read_text(encoding='utf8').splitlines())}
    db = sqlite3.connect((ROOT / 'data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite').as_uri() + '?mode=ro', uri=True)
    records, excluded = [], []
    fields = ['from', 'to', 'via', 'name', 'official_name', 'local_name', 'alt_name', 'ref', 'route', 'roundtrip', 'is_in']
    for key in sorted({m['relationId'] for m in d['records']} | recovered_ids, key=int):
        row = db.execute("SELECT json_extract(payload,'$.tags') FROM relations WHERE id=?", (key,)).fetchone()
        tags = json.loads(row[0]) if row else {}
        reference = db.execute("SELECT id FROM routes WHERE id=?", (key,)).fetchone() is not None
        summits = canonical.get(key, {}).get('confirmedSummits', [])
        old = next((m for m in d['records'] if m['relationId'] == key), None)
        if key in recovered_ids and (not reference or len(summits) != 1 or not summits[0].get('peakName')):
            excluded.append({'relationId': key, 'reason': 'MISSING_REFERENCE' if not reference else 'NO_SINGLE_NAMED_SUMMIT'})
            continue
        records.append({'relationId': key, 'group': 'FRESH_PUBLISHED_REFERENCE' if key in recovered_ids else
                        'TRAIN' if old['split'] == 'TRAIN' else 'EXPOSED_REGRESSION_SET' if old['split'] == 'HOLDOUT' else
                        'NEGATIVE_CONTROL' if old['negativeReasons'] else 'EXTENDED_MACHINE_GREEN',
                        'humanApproved': bool(old and old['humanApproved']), 'machineGreen': bool(old and old['machineGreen']),
                        'negativeReasons': old['negativeReasons'] if old else [],
                        'facts': {'relationTags': {f: tags.get(f) for f in fields},
                                  'summits': [{'id': s['peakSourceId'], 'name': s['peakName']} for s in summits]},
                        'labels': old['labels'] if old else {'startContext': 'UNKNOWN', 'qualityBand': 'PUBLISHED_REFERENCE'},
                        'baselineReference': f'data/gpx/phase12d/phase12d-final-evaluation.json#{key}' if old else None})
    db.close()
    content = {'schemaVersion': 'phase12e/corpus/v1', 'datasetSha256': d['datasetSha256'], 'phase12dSplitHash': d['splitHash'],
               'freshSourceIds': sorted(recovered_ids), 'freshExclusions': excluded, 'zeroOverlapWithMachineGreen245': True,
               'eligibilityRule': 'All published identities with a frozen relation reference and single named confirmed summit. Missing semantic start is retained as an evaluable upstream failure, never silently removed.',
               'selectionRule': ['negative false auto accept = 0', 'maximize TRAIN acceptable matches', 'maximize TRAIN solverSolved',
                                 'maximize TRAIN routableAnchorResolved', 'minimize ambiguity', 'stable simpler/older tie'],
               'acceptance': {'negativeFalseAccept': 0, 'determinism': 1, 'hutMatchDropAllowed': 0, 'freshMatchDropAllowed': 1,
                              'realImprovement': 'At least one additional TRAIN acceptable match or solved route or routable anchor, with no HUT regression and fresh match count drop at most one.'},
               'maximumConfigurations': 12, 'records': records}
    content['corpusHash'] = hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    path = OUT / 'phase12e-corpus.json'
    if path.exists():
        assert load(path) == content, 'IMMUTABLE_CORPUS_MISMATCH'
    else:
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'total': len(records), 'fresh': sum(r['group'] == 'FRESH_PUBLISHED_REFERENCE' for r in records), 'exclusions': excluded, 'hash': content['corpusHash']}))


if __name__ == '__main__':
    main()
