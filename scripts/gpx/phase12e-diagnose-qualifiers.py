"""Read-only semantic diagnosis of TRAIN name coverage; never reads relation members."""
import hashlib
import json
import pathlib
import re
import time
import unicodedata
import osmium

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12e'


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).lower().split())


def main():
    plan = json.loads((OUT / 'phase12e-evaluation-plan.json').read_text(encoding='utf8'))
    corpus = json.loads((OUT / 'phase12e-corpus.json').read_text(encoding='utf8'))
    train_ids = {m['relationId'] for m in corpus['records'] if m['group'] == 'TRAIN'}
    hints = [h['name'] for r in plan['records'] if r['relationId'] in train_ids and r['evidence']['signal']
             for h in [r['evidence']['signal']['startHint'], *r['evidence']['signal']['viaHints'], r['evidence']['signal']['summitHint']]]
    # Broad suffix removal is diagnostic candidate discovery ONLY, not a resolver rule.
    wanted = {normalize(re.sub(r'\s*\([^()]*\)$', '', h)) for h in hints}
    rows, statuses, named = [], [], 0
    started = time.monotonic()
    pbf = ROOT / 'data/osm/source/alps-latest.osm.pbf'
    with pbf.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == corpus['datasetSha256']
    processor = osmium.FileProcessor(str(pbf), entities=osmium.osm.NODE | osmium.osm.WAY).with_filter(
        osmium.filter.KeyFilter('name', 'official_name', 'alt_name', 'short_name', 'local_name', 'old_name'))
    for obj in processor:
        tags = {t.k: t.v for t in obj.tags}
        names = [name for k, v in tags.items() if re.match(r'^(name|official_name|alt_name|short_name|local_name|old_name)(:.*)?$', k) for name in v.split(';')]
        named += 1
        matches = sorted({name for name in names if normalize(re.sub(r'\s*\([^()]*\)$', '', name)) in wanted})
        status = any(re.search(r'\((verf\.|verfallen|ruins?|ruine|rudere|abandoned|abbandonato|abandonné)\)\s*$', n, re.I) for n in names)
        if not matches and not status:
            continue
        row = {'objectType': 'node' if obj.is_node() else 'way', 'osmId': obj.id, 'tags': tags,
               'coordinate': [obj.location.lon, obj.location.lat] if obj.is_node() and obj.location.valid() else None,
               'matchedNames': matches}
        if matches:
            rows.append(row)
        if status:
            statuses.append(row)
    report = {'version': 'phase12e/qualifier-diagnosis/v1', 'datasetSha256': corpus['datasetSha256'],
              'trainHintCount': len(hints), 'namedObjectsInspected': named, 'elapsedSeconds': round(time.monotonic() - started, 3),
              'policy': 'Node/way name tags only. No relation objects, member sequences or reference geometry. Diagnostic suffix comparison does not authorize stripping.',
              'trainNameMatches': sorted(rows, key=lambda r: (r['objectType'], r['osmId'])),
              'statusExamples': sorted(statuses, key=lambda r: (r['objectType'], r['osmId']))}
    path = OUT / 'phase12e-qualifier-diagnosis.json'
    if path.exists():
        raise RuntimeError('DIAGNOSIS_ALREADY_EXISTS_REUSE_IT')
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'namedObjects': named, 'trainNameMatches': len(rows), 'statusExamples': len(statuses), 'seconds': report['elapsedSeconds']}), flush=True)


if __name__ == '__main__':
    main()
