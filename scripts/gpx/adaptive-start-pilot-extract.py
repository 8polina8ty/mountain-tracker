"""One finite, offline highway extraction for the frozen adaptive-start corpus.

Stores each complete OSM highway way once and maps it to shared geographic
blocks. These bounded windows are not proof of exhaustive routing outside them.
"""
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import time

import osmium


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/gpx/adaptive-start-pilot'
VERSION = 'mountain-tracker/adaptive-start-pilot-extraction/v1'


def sha256_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    started = time.monotonic()
    corpus_path = OUT / 'adaptive-start-pilot-corpus.json'
    corpus = json.loads(corpus_path.read_text(encoding='utf8'))
    corpus_hash = corpus.pop('corpusHash')
    canonical = json.dumps(corpus, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    assert hashlib.sha256(canonical.encode('utf8')).hexdigest() == corpus_hash, 'Corpus hash mismatch'
    assert len(corpus['mountains']) == 100 and len(corpus['blocks']) == 10
    pbf = ROOT / corpus['datasetPath']
    assert pbf.stat().st_size == corpus['datasetSizeBytes'], 'Frozen PBF size mismatch'
    assert sha256_file(pbf) == corpus['dataset']['pbfSha256'], 'Frozen PBF hash mismatch'
    for source in corpus['featureSources']:
        path = ROOT / source['path']
        assert path.stat().st_size == source['sizeBytes']
        assert sha256_file(path) == source['sha256'], f"Feature source changed: {source['path']}"

    regions = {block['blockId']: block['bbox'] for block in corpus['blocks']}
    cache_relative = f'data/gpx/adaptive-start-pilot/cache/{corpus_hash}.sqlite'
    cache = ROOT / cache_relative
    cache.parent.mkdir(parents=True, exist_ok=True)
    identity = {
        'version': VERSION,
        'corpusHash': corpus_hash,
        'datasetSha256': corpus['dataset']['pbfSha256'],
        'regions': regions,
        'selection': 'Complete highway ways with at least one located node in an independent frozen block window; no relations or route truth.',
    }
    if cache.exists():
        with sqlite3.connect(cache.as_uri() + '?mode=ro', uri=True) as existing:
            saved = existing.execute("SELECT value FROM metadata WHERE key='complete'").fetchone()
            if saved is None:
                raise RuntimeError('An incomplete extraction exists; preserve it for diagnosis rather than overwriting it.')
            complete = json.loads(saved[0])
            assert complete['identity'] == identity, 'Existing cache identity differs'
        print(json.dumps({'status': 'COMPLETE_CACHE_REUSED', 'cache': cache_relative, 'uniqueWays': complete['uniqueWays']}), flush=True)
        return

    cells = {}
    for key, bbox in regions.items():
        for x in range(math.floor(bbox[0] * 10), math.floor(bbox[2] * 10) + 1):
            for y in range(math.floor(bbox[1] * 10), math.floor(bbox[3] * 10) + 1):
                cells.setdefault((x, y), set()).add(key)

    db = sqlite3.connect(cache)
    db.executescript(
        'CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);'
        'CREATE TABLE ways (id INTEGER PRIMARY KEY,payload TEXT NOT NULL);'
        'CREATE TABLE region_ways (region TEXT NOT NULL,way INTEGER NOT NULL,PRIMARY KEY(region,way));'
    )
    db.execute('INSERT INTO metadata VALUES (?,?)', ('incomplete', json.dumps(identity)))
    db.commit()
    counts = {key: 0 for key in regions}

    class Extract(osmium.SimpleHandler):
        count = 0
        scanned_highways = 0

        def way(self, way):
            if 'highway' not in way.tags:
                return
            self.scanned_highways += 1
            candidates, nodes = set(), []
            for node in way.nodes:
                coordinate = [node.lon, node.lat] if node.location.valid() else None
                nodes.append({'nodeId': node.ref, 'coordinate': coordinate})
                if coordinate:
                    candidates.update(cells.get((math.floor(node.lon * 10), math.floor(node.lat * 10)), ()))
            selected = [key for key in sorted(candidates) if any(
                node['coordinate'] is not None
                and regions[key][0] <= node['coordinate'][0] <= regions[key][2]
                and regions[key][1] <= node['coordinate'][1] <= regions[key][3]
                for node in nodes
            )]
            if not selected:
                return
            payload = json.dumps({
                'id': way.id,
                'tags': {tag.k: tag.v for tag in way.tags},
                'nodes': nodes,
            }, separators=(',', ':'), ensure_ascii=False)
            db.execute('INSERT INTO ways VALUES (?,?)', (way.id, payload))
            db.executemany('INSERT INTO region_ways VALUES (?,?)', [(key, way.id) for key in selected])
            for key in selected:
                counts[key] += 1
            self.count += 1
            if self.count % 20000 == 0:
                db.commit()
                print(json.dumps({'uniqueWays': self.count, 'elapsedSeconds': round(time.monotonic() - started, 3)}), flush=True)

    handler = Extract()
    print(json.dumps({'status': 'EXTRACTING_FROZEN_PBF', 'sharedBlocks': len(regions), 'corpusHash': corpus_hash}), flush=True)
    try:
        handler.apply_file(str(pbf), locations=True, idx='flex_mem')
        report = {
            'identity': identity,
            'cache': cache_relative,
            'uniqueWays': handler.count,
            'scannedHighways': handler.scanned_highways,
            'waysPerBlock': counts,
            'regionWayMemberships': sum(counts.values()),
            'elapsedSeconds': round(time.monotonic() - started, 3),
            'geometryBoundaryLimitation': '52 km summit halo plus selected summit extent; routes requiring travel outside this window can remain unresolved. No claim of exhaustive <=100 km routing.',
            'externalRequests': 0,
            'productionWrites': 0,
        }
        db.execute('INSERT INTO metadata VALUES (?,?)', ('complete', json.dumps(report, ensure_ascii=False)))
        db.commit()
    finally:
        db.close()
    report['cacheSizeBytes'] = cache.stat().st_size
    (OUT / 'adaptive-start-pilot-extraction.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
    print(json.dumps({key: value for key, value in report.items() if key != 'identity'}), flush=True)


if __name__ == '__main__':
    main()
