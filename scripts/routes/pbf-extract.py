"""Finite, offline pyosmium extraction. No pilot files, credentials, or network."""
import argparse
import json
import math
from pathlib import Path
import sqlite3
import time
import subprocess
import os

import osmium


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def peak_rss_mb():
    if os.name != 'nt':
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
            'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return counters.PeakWorkingSetSize / 1048576


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf8'))
    root = Path(config['directory'])
    root.mkdir(parents=True, exist_ok=True)
    pbf = Path(config['input'])
    # Header parsing fails before any extraction if the input is not readable PBF.
    with osmium.io.Reader(str(pbf)) as reader:
        reader.header()
    started = time.monotonic()
    db = sqlite3.connect(root / 'index.sqlite')
    db.executescript('PRAGMA journal_mode=WAL; PRAGMA cache_size=-32768;'
                     'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);'
                     'CREATE TABLE IF NOT EXISTS peaks(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,x INTEGER,y INTEGER,ele REAL);'
                     'CREATE TABLE IF NOT EXISTS ways(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);'
                     'CREATE TABLE IF NOT EXISTS block_ways(block TEXT,way INTEGER,PRIMARY KEY(block,way));'
                     'CREATE TABLE IF NOT EXISTS features(identity TEXT PRIMARY KEY,payload TEXT NOT NULL);'
                     'CREATE TABLE IF NOT EXISTS block_features(block TEXT,identity TEXT,PRIMARY KEY(block,identity));')
    identity = json.dumps(config['identity'], sort_keys=True)
    saved = db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
    if saved and saved[0] != identity:
        raise RuntimeError('STALE_EXTRACTION_IDENTITY')
    db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)', ('identity', identity))
    db.commit()
    if not db.execute("SELECT 1 FROM metadata WHERE key='peaks_complete'").fetchone():
        counts = {'namedNodePeaks': 0, 'unlocatedNodePeaks': 0, 'nonNodePeaks': 0}

        class Peaks(osmium.SimpleHandler):
            def node(self, node):
                if node.tags.get('natural') != 'peak' or not node.tags.get('name', '').strip():
                    return
                if not node.location.valid():
                    counts['unlocatedNodePeaks'] += 1
                    return
                tags = dict(node.tags)
                try:
                    elevation = float(tags.get('ele', ''))
                    if not math.isfinite(elevation):
                        elevation = None
                except ValueError:
                    elevation = None
                summit = {'osmType': 'node', 'osmId': node.id, 'name': tags['name'].strip(),
                          'lon': node.lon, 'lat': node.lat, 'elevation': elevation, 'tags': tags}
                x, y = math.floor(node.lon / config['tileDegrees']), math.floor(node.lat / config['tileDegrees'])
                db.execute('INSERT OR REPLACE INTO peaks VALUES (?,?,?,?,?)',
                           (node.id, json.dumps(summit, ensure_ascii=False), x, y, elevation))
                counts['namedNodePeaks'] += 1

            def way(self, way):
                if way.tags.get('natural') == 'peak' and way.tags.get('name'):
                    counts['nonNodePeaks'] += 1

            def relation(self, relation):
                if relation.tags.get('natural') == 'peak' and relation.tags.get('name'):
                    counts['nonNodePeaks'] += 1

        emit({'stage': 'PEAK_INDEX', 'input': str(pbf)})
        peak_source = pbf
        if config.get('osmium'):
            tool = config['osmium']
            peak_source = root / 'peak-objects.osm.pbf'
            subprocess.run([tool['executable'], *tool['prefix'], 'tags-filter', str(pbf),
                            'n/natural=peak', 'w/natural=peak', 'r/natural=peak',
                            '--omit-referenced', '--overwrite', '-o', str(peak_source)], check=True, timeout=1800)
        Peaks().apply_file(str(peak_source))
        db.execute('INSERT INTO metadata VALUES (?,?)', ('peaks_complete', json.dumps(counts)))
        db.commit()
    counts = json.loads(db.execute("SELECT value FROM metadata WHERE key='peaks_complete'").fetchone()[0])
    filters, values = [], []
    for bound, operator in [('minElevation', '>='), ('maxElevation', '<=')]:
        if config.get(bound) is not None:
            filters.append('ele ' + operator + ' ?')
            values.append(config[bound])
    where = ' WHERE ' + ' AND '.join(filters) if filters else ''
    eligible = db.execute('SELECT count(*) FROM peaks' + where, values).fetchone()[0]
    selected = [json.loads(row[0]) for row in db.execute(
        'SELECT payload FROM peaks' + where + ' ORDER BY x,y,id LIMIT ? OFFSET ?',
        values + [config['limit'], config['offset']])]
    regions = {}
    for summit in selected:
        x, y = math.floor(summit['lon'] / config['tileDegrees']), math.floor(summit['lat'] / config['tileDegrees'])
        key = f'{x}_{y}'
        summit['block'] = key
        tile, halo = config['tileDegrees'], config['haloDegrees']
        regions[key] = [x * tile - halo, y * tile - halo, (x + 1) * tile + halo, (y + 1) * tile + halo]
    selection = {'counts': counts, 'eligible': eligible, 'selected': selected, 'blocks': regions,
                 'selectionRule': 'Named natural=peak nodes; optional elevation bounds; tile x,y then OSM id. Non-node peaks counted separately, not assigned invented coordinates.'}
    (root / 'selection.json').write_text(json.dumps(selection, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    if not selected:
        emit({'stage': 'COMPLETE', 'selected': 0, 'eligible': eligible})
        db.close()
        return
    adaptive = config.get('adaptiveSubdivision') or {}
    max_ways = int(adaptive.get('maxWays', 150000))
    max_features = int(adaptive.get('maxFeatures', 300000))
    min_tile = float(adaptive.get('minTileDegrees', 0.0625))
    halo = float(config['haloDegrees'])
    base_tile = float(config['tileDegrees'])
    block_tiles: dict[str, float] = {k: base_tile for k in regions}
    # Selection is written after adaptive finalization; keep initial draft for resume detection.
    # Persist initial selection early so fingerprint drift is visible, then overwrite after subdivision.
    if not db.execute("SELECT 1 FROM metadata WHERE key='blocks_complete'").fetchone():
        # Mutable state for adaptive loop
        subdivision_log: list[dict] = []
        # Helper to build spatial index for current regions
        def build_cells(current_regions: dict[str, list[float]]):
            c: dict[tuple[int, int], set[str]] = {}
            for key, bbox in current_regions.items():
                for x in range(math.floor(bbox[0] * 10), math.floor(bbox[2] * 10) + 1):
                    for y in range(math.floor(bbox[1] * 10), math.floor(bbox[3] * 10) + 1):
                        c.setdefault((x, y), set()).add(key)
            return c

        cells = build_cells(regions)

        def memberships(lon: float, lat: float):
            return [key for key in cells.get((math.floor(lon * 10), math.floor(lat * 10)), ())
                    if regions[key][0] <= lon <= regions[key][2] and regions[key][1] <= lat <= regions[key][3]]

        def feature(object_type: str, osmid: int, tags: dict, coordinate, node_count=None):
            if not coordinate:
                return
            blocks = memberships(*coordinate)
            if not blocks:
                return
            if not any(key in tags for key in ('highway', 'information', 'amenity', 'place', 'railway', 'tourism', 'natural', 'ele', 'mountain_pass')):
                return
            key = f'{object_type}:{osmid}'
            record = {'objectType': object_type, 'osmid': str(osmid), 'name': tags.get('name'), 'coordinate': coordinate,
                      'tags': tags, 'wayNodeCount': node_count}
            db.execute('INSERT OR REPLACE INTO features VALUES (?,?)', (key, json.dumps(record, ensure_ascii=False)))
            db.executemany('INSERT OR IGNORE INTO block_features VALUES (?,?)', [(b, key) for b in blocks])

        class Network(osmium.SimpleHandler):
            ways = 0

            def node(self, node):
                if node.location.valid() and len(node.tags):
                    feature('node', node.id, dict(node.tags), [node.lon, node.lat])

            def way(self, way):
                tags = dict(way.tags)
                if 'highway' not in tags and not any(k in tags for k in ('amenity', 'place', 'railway', 'tourism', 'information')):
                    return
                nodes, blocks = [], set()
                for n in way.nodes:
                    coordinate = [n.lon, n.lat] if n.location.valid() else None
                    nodes.append({'nodeId': n.ref, 'coordinate': coordinate})
                    if coordinate:
                        blocks.update(memberships(*coordinate))
                if not blocks:
                    return
                known = [n['coordinate'] for n in nodes if n['coordinate']]
                if known:
                    feature('way', way.id, tags, [sum(c[i] for c in known) / len(known) for i in (0, 1)], len(nodes))
                if 'highway' in tags:
                    payload = {'id': way.id, 'tags': tags, 'nodes': nodes}
                    db.execute('INSERT OR REPLACE INTO ways VALUES (?,?)', (way.id, json.dumps(payload, ensure_ascii=False)))
                    db.executemany('INSERT OR IGNORE INTO block_ways VALUES (?,?)', [(b, way.id) for b in blocks])
                    self.ways += 1
                if self.ways and self.ways % 10000 == 0:
                    db.commit()

        handler = Network()

        def extract_and_index(block_items: list[tuple[str, list[float]]]):
            if not block_items:
                return
            # Resume-skip: blocks already indexed (DB has rows) do not need re-extraction
            pending = []
            for k, b in block_items:
                cnt = db.execute('SELECT count(*) FROM block_ways WHERE block=?', (k,)).fetchone()[0]
                fcnt = db.execute('SELECT count(*) FROM block_features WHERE block=?', (k,)).fetchone()[0]
                if cnt > 0 or fcnt > 0:
                    emit({'stage': 'SKIP_INDEXED_BLOCK', 'block': k, 'ways': cnt})
                    continue
                pending.append((k, b))
            if not pending:
                return
            if config.get('osmium'):
                tool = config['osmium']
                block_dir = root / 'blocks'
                block_dir.mkdir(exist_ok=True)
                sorted_items = sorted(pending)
                for start in range(0, len(sorted_items), 2):
                    batch = sorted_items[start:start + 2]
                    # Use hash of block ids for config name to avoid collisions after subdivision
                    batch_hash = str(abs(hash(tuple(k for k, _ in batch))))[:8]
                    extract_config = root / f'osmium-blocks-{start}-{batch_hash}.json'
                    extract_config.write_text(json.dumps({'extracts': [
                        {'output': str(block_dir / (key.replace('/', '_') + '.osm.pbf')), 'bbox': bbox} for key, bbox in batch
                    ]}), encoding='utf8')
                    emit({'stage': 'OSMIUM_COMPLETE_WAYS', 'batch': start // 2, 'blocks': len(batch), 'keys': [k for k, _ in batch]})
                    subprocess.run([tool['executable'], *tool['prefix'], 'extract', '--config', str(extract_config),
                                    '--strategy', 'complete_ways', '--overwrite', str(pbf)], check=True, timeout=1800)
                    for key, _ in batch:
                        emit({'stage': 'INDEX_LOCAL_BLOCK', 'block': key})
                        block_pbf = block_dir / (key.replace('/', '_') + '.osm.pbf')
                        handler.apply_file(str(block_pbf), locations=True,
                                           idx='sparse_file_array,' + str(block_dir / (key.replace('/', '_') + '.locations.idx')))
                        db.commit()
            else:
                handler.apply_file(str(pbf), locations=True, idx='sparse_file_array,' + str(root / 'node-locations.idx'))
                db.commit()

        emit({'stage': 'SHARED_BLOCK_EXTRACTION', 'blocks': len(regions), 'selected': len(selected), 'adaptive': bool(adaptive)})
        # Initial extraction of all base blocks
        extract_and_index(list(regions.items()))

        # Adaptive subdivision loop: check way/feature counts per block
        iteration = 0
        while True:
            iteration += 1
            if iteration > 8:
                raise RuntimeError('ADAPTIVE_SUBDIVISION_TOO_DEEP')
            oversized: list[str] = []
            for key in list(regions.keys()):
                ways = db.execute('SELECT count(*) FROM block_ways WHERE block=?', (key,)).fetchone()[0]
                feats = db.execute('SELECT count(*) FROM block_features WHERE block=?', (key,)).fetchone()[0]
                tile = block_tiles.get(key, base_tile)
                if (ways > max_ways or feats > max_features) and tile > min_tile + 1e-9:
                    oversized.append(key)
            if not oversized:
                break
            emit({'stage': 'ADAPTIVE_SUBDIVIDE', 'iteration': iteration, 'parents': oversized, 'threshold_ways': max_ways})
            new_children: dict[str, list[float]] = {}
            for parent in sorted(oversized):
                parent_tile = block_tiles[parent]
                child_tile = parent_tile / 2
                # Determine child tile coordinates for peaks belonging to parent
                peaks_in_parent = [s for s in selected if s['block'] == parent]
                # Generate child bboxes for those peaks deterministically
                for summit in peaks_in_parent:
                    cx = math.floor(summit['lon'] / child_tile)
                    cy = math.floor(summit['lat'] / child_tile)
                    child_key = f'{parent}/{cx}_{cy}'
                    if child_key in regions or child_key in new_children:
                        continue
                    # Deterministic child bbox with same halo as parent (sufficient for 20km tiers; further levels still 0.25 halo)
                    bbox = [cx * child_tile - halo, cy * child_tile - halo, (cx + 1) * child_tile + halo, (cy + 1) * child_tile + halo]
                    new_children[child_key] = bbox
                    block_tiles[child_key] = child_tile
                # Also handle case where parent had no selected peak but still oversized? Keep parent as is (should not happen)
                # Reassign each peak in parent to its child
                for summit in peaks_in_parent:
                    cx = math.floor(summit['lon'] / child_tile)
                    cy = math.floor(summit['lat'] / child_tile)
                    child_key = f'{parent}/{cx}_{cy}'
                    summit['block'] = child_key
                # Capture parent diagnostics before removal
                parent_ways = db.execute('SELECT count(*) FROM block_ways WHERE block=?', (parent,)).fetchone()[0]
                parent_feats = db.execute('SELECT count(*) FROM block_features WHERE block=?', (parent,)).fetchone()[0]
                # Remove parent from regions and DB
                db.execute('DELETE FROM block_ways WHERE block=?', (parent,))
                db.execute('DELETE FROM block_features WHERE block=?', (parent,))
                # Remove parent block file artifacts (keep for diagnostics but not required)
                subdivision_log.append({'parent': parent, 'parentTile': parent_tile, 'childTile': child_tile,
                                        'children': sorted([k for k in new_children if k.startswith(parent + '/')]),
                                        'parentWays': parent_ways, 'parentFeatures': parent_feats})
                regions.pop(parent, None)
                block_tiles.pop(parent, None)
                db.commit()
            # Merge new children into regions
            for k, v in new_children.items():
                regions[k] = v
            # Rebuild spatial index for the full current region set (needed for subsequent child indexing)
            cells = build_cells(regions)
            # Extract and index only the newly created children
            extract_and_index(list(new_children.items()))
            db.commit()
        # Finalize selection with child assignments and persist diagnostics
        selection = {'counts': counts, 'eligible': eligible, 'selected': selected, 'blocks': regions,
                     'selectionRule': 'Named natural=peak nodes; optional elevation bounds; tile x,y then OSM id. Non-node peaks counted separately, not assigned invented coordinates.',
                     'adaptiveSubdivision': {'maxWays': max_ways, 'maxFeatures': max_features, 'minTileDegrees': min_tile,
                                             'subdivisions': subdivision_log, 'finalTiles': {k: block_tiles[k] for k in regions}}}
        (root / 'selection.json').write_text(json.dumps(selection, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        if subdivision_log:
            (root / 'subdivision.json').write_text(json.dumps({'log': subdivision_log, 'finalBlockCount': len(regions)}, indent=2) + '\n', encoding='utf8')
        emit({'stage': 'ADAPTIVE_COMPLETE', 'finalBlocks': len(regions), 'subdivisions': len(subdivision_log)})
        db.execute('INSERT INTO metadata VALUES (?,?)', ('blocks_complete', json.dumps({'blocks': len(regions), 'ways': handler.ways, 'adaptive': bool(subdivision_log)})))
        db.commit()
    report = {'stage': 'COMPLETE', 'discovered': counts, 'eligible': eligible, 'selected': len(selected),
              'elapsedSeconds': round(time.monotonic() - started, 3), 'peakPythonRssMb': peak_rss_mb(),
              'externalRequests': 0, 'productionWrites': 0}
    report_path = root / 'extraction-report.json'
    if report_path.exists():
        previous = json.loads(report_path.read_text(encoding='utf8'))
        report['peakPythonRssMb'] = max(report['peakPythonRssMb'], previous['peakPythonRssMb'])
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    emit(report)
    db.close()


if __name__ == '__main__':
    main()
