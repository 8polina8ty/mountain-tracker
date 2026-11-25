"""One finite PBF pass, independent highway envelopes; no relation members or truth geometry."""
import hashlib
import json
import math
import pathlib
import time
import sqlite3
import sys
import osmium

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/phase12d'
EXPECTED = '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5'


def main():
    started = time.monotonic()
    suffix = '-v2' if len(sys.argv) > 1 and sys.argv[1] == 'qualifier-v2' else ''
    plan = json.loads((OUT / f'phase12d-semantic-plan{suffix}.json').read_text(encoding='utf8'))
    pbf = ROOT / 'data/osm/source/alps-latest.osm.pbf'
    with pbf.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != EXPECTED:
            raise RuntimeError('PHASE12D_DATASET_IDENTITY_MISMATCH')
    cache = OUT / 'cache'
    cache.mkdir(exist_ok=True)
    db_path = cache / f"{plan['planHash']}.sqlite"
    db = sqlite3.connect(db_path)
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)')
    if db.execute("SELECT value FROM metadata WHERE key='complete'").fetchone():
        print('Compatible completed extraction cache reused', flush=True)
        db.close()
        return
    # Incomplete extraction alone is restartable; completed reconstruction shards are never removed.
    db.executescript('DROP TABLE IF EXISTS ways; DROP TABLE IF EXISTS region_ways;'
                     'CREATE TABLE ways (id INTEGER PRIMARY KEY,payload TEXT NOT NULL);'
                     'CREATE TABLE region_ways (region TEXT,way INTEGER,PRIMARY KEY(region,way));')
    regions = {x['relationId']: x['bbox'] for x in plan['records'] if x['bbox']}
    cells = {}
    for key, b in regions.items():
        assert b[2] - b[0] < 2 and b[3] - b[1] < 2, 'REGION_BOUND_EXCEEDED'
        for x in range(math.floor(b[0] * 10), math.floor(b[2] * 10) + 1):
            for y in range(math.floor(b[1] * 10), math.floor(b[3] * 10) + 1):
                cells.setdefault((x, y), set()).add(key)
    class Extract(osmium.SimpleHandler):
        count = 0
        def way(self, way):
            if 'highway' not in way.tags:
                return
            candidates = set()
            nodes = []
            for node in way.nodes:
                if not node.location.valid():
                    nodes.append({'nodeId': node.ref, 'coordinate': None})
                    continue
                lon, lat = node.lon, node.lat
                candidates.update(cells.get((math.floor(lon * 10), math.floor(lat * 10)), ()))
                nodes.append({'nodeId': node.ref, 'coordinate': [lon, lat]})
            if not candidates:
                return
            # Keep whole ways touching an envelope; no artificial clipped edges.
            selected = [key for key in sorted(candidates) if any(
                n['coordinate'] is not None and
                regions[key][0] <= n['coordinate'][0] <= regions[key][2] and
                regions[key][1] <= n['coordinate'][1] <= regions[key][3] for n in nodes)]
            if not selected:
                return
            tags = {t.k: t.v for t in way.tags}
            payload = json.dumps({'id': way.id, 'tags': tags, 'nodes': nodes}, separators=(',', ':'))
            db.execute('INSERT INTO ways VALUES (?,?)', (way.id, payload))
            db.executemany('INSERT INTO region_ways VALUES (?,?)', [(key, way.id) for key in selected])
            self.count += 1
            if self.count % 20000 == 0:
                db.commit()
                print(f'Extracted {self.count} independent highway ways', flush=True)
    handler = Extract()
    print(f'Finite frozen-PBF scan for {len(regions)} semantic envelopes', flush=True)
    handler.apply_file(str(pbf), locations=True, idx='flex_mem')
    summary = {'datasetSha256': EXPECTED, 'planHash': plan['planHash'], 'extractorVersion': 'phase12d/independent-envelope/v1',
               'regions': len(regions), 'uniqueWays': handler.count, 'elapsedSeconds': round(time.monotonic() - started, 3),
               'geometrySelection': 'All frozen PBF highways touching semantic anchor envelopes; relation members never inspected.'}
    db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('complete', json.dumps(summary)))
    db.commit()
    db.close()
    (OUT / f'phase12d-extraction{suffix}.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf8')
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
