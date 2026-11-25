"""Finite offline extraction; exact semantic envelopes reuse immutable Phase 12D caches."""
import hashlib
import json
import math
import pathlib
import sqlite3
import time
import osmium

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12e'
VERSION = 'phase12e/independent-envelope/v1'


def main():
    started = time.monotonic()
    plan = json.loads((OUT / 'phase12e-evaluation-plan.json').read_text(encoding='utf8'))
    corpus = json.loads((OUT / 'phase12e-corpus.json').read_text(encoding='utf8'))
    pbf = ROOT / 'data/osm/source/alps-latest.osm.pbf'
    with pbf.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == corpus['datasetSha256']
    reuse = {}
    for suffix in ['', '-v2']:
        old = json.loads((ROOT / f'data/gpx/phase12d/phase12d-semantic-plan{suffix}.json').read_text(encoding='utf8'))
        path = f"data/gpx/phase12d/cache/{old['planHash']}.sqlite"
        db = sqlite3.connect((ROOT / path).as_uri() + '?mode=ro', uri=True)
        metadata = json.loads(db.execute("SELECT value FROM metadata WHERE key='complete'").fetchone()[0])
        assert metadata['datasetSha256'] == corpus['datasetSha256'] and metadata['planHash'] == old['planHash']
        db.close()
        for record in old['records']:
            if record['bbox']:
                reuse.setdefault(tuple(record['bbox']), {'cache': path, 'region': record['relationId']})
    locations, regions = {}, {}
    path = f"data/gpx/phase12e/cache/{plan['planHash']}.sqlite"
    for record in plan['records']:
        for kind, field in [('baseline', 'baselineBbox'), ('semantic', 'bbox')]:
            bbox = record[field]
            if not bbox:
                continue
            key = f"{kind}:{record['relationId']}"
            if tuple(bbox) in reuse:
                locations[key] = reuse[tuple(bbox)]
            else:
                locations[key] = {'cache': path, 'region': key}
                regions[key] = bbox
    identity = {'version': VERSION, 'planHash': plan['planHash'], 'datasetSha256': corpus['datasetSha256'], 'locations': locations}
    db = sqlite3.connect(ROOT / path)
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT)')
    completed = db.execute("SELECT value FROM metadata WHERE key='complete'").fetchone()
    if completed:
        assert json.loads(completed[0])['identity'] == identity
        print('Completed Phase 12E extraction reused', flush=True)
        db.close()
        return
    db.executescript('DROP TABLE IF EXISTS ways; DROP TABLE IF EXISTS region_ways;'
                     'CREATE TABLE ways(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);'
                     'CREATE TABLE region_ways(region TEXT,way INTEGER,PRIMARY KEY(region,way));')
    cells = {}
    for key, b in regions.items():
        assert b[2] - b[0] < 2 and b[3] - b[1] < 2
        for x in range(math.floor(b[0] * 10), math.floor(b[2] * 10) + 1):
            for y in range(math.floor(b[1] * 10), math.floor(b[3] * 10) + 1):
                cells.setdefault((x, y), set()).add(key)

    class Extract(osmium.SimpleHandler):
        count = 0

        def way(self, way):
            if 'highway' not in way.tags:
                return
            candidates, nodes = set(), []
            for node in way.nodes:
                coordinate = [node.lon, node.lat] if node.location.valid() else None
                nodes.append({'nodeId': node.ref, 'coordinate': coordinate})
                if coordinate:
                    candidates.update(cells.get((math.floor(node.lon * 10), math.floor(node.lat * 10)), ()))
            selected = [key for key in sorted(candidates) if any(n['coordinate'] is not None and
                regions[key][0] <= n['coordinate'][0] <= regions[key][2] and
                regions[key][1] <= n['coordinate'][1] <= regions[key][3] for n in nodes)]
            if not selected:
                return
            payload = json.dumps({'id': way.id, 'tags': {t.k: t.v for t in way.tags}, 'nodes': nodes}, separators=(',', ':'))
            db.execute('INSERT INTO ways VALUES (?,?)', (way.id, payload))
            db.executemany('INSERT INTO region_ways VALUES (?,?)', [(key, way.id) for key in selected])
            self.count += 1
            if self.count % 20000 == 0:
                db.commit()
                print(f'Extracted {self.count} independent highway ways', flush=True)

    handler = Extract()
    print(f'Exact envelope reuse: {len(locations) - len(regions)}; finite new envelopes: {len(regions)}', flush=True)
    if regions:
        handler.apply_file(str(pbf), locations=True, idx='flex_mem')
    report = {'identity': identity, 'reusedEnvelopes': len(locations) - len(regions), 'extractedEnvelopes': len(regions),
              'uniqueNewWays': handler.count, 'elapsedSeconds': round(time.monotonic() - started, 3),
              'selection': 'Frozen PBF highway nodes intersect independent semantic entity envelopes; no reference geometry or relation members.'}
    db.execute('INSERT INTO metadata VALUES (?,?)', ('complete', json.dumps(report)))
    db.commit()
    db.close()
    (OUT / 'phase12e-extraction.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps({k: v for k, v in report.items() if k != 'identity'}), flush=True)


if __name__ == '__main__':
    main()
