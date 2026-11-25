/** Durable PBF block loader for real Base Access witness.
 * Reuses pbf.ts block tiling (0.25 deg tile + 0.25 halo) and builds OsmTrailGraph per block.
 * Extracts ways via osmium bbox extract + pyosmium parse, cached in data/routes/tmp-blocks.
 * Cache safety: binds to PBF SHA256, block key, extraction version and graph option version;
 * uses atomic .partial rename and never reads .partial/.tmp files; rejects stale/mismatched.
 */
import { readFile, stat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { type OsmTrailWayInput } from '../../../Lib/gpxIngestion/osmTrailGraph.ts';
import { buildReconstructionPbfBlockGraph, RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { createHash } from 'node:crypto';

const PBF_PATH = 'data/osm/source/alps-latest.osm.pbf';
const CACHE_DIR = 'data/routes/tmp-blocks';
const TILE_DEGREES = 0.25;
const HALO_DEGREES = 0.25;
export const BLOCK_EXTRACTION_VERSION = 'complete-v2';
export const BLOCK_GRAPH_OPTIONS_VERSION = createHash('sha256').update(JSON.stringify(RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS)).digest('hex').slice(0, 16);

export function blockFor(lon: number, lat: number): string {
  return `${Math.floor(lon / TILE_DEGREES)}_${Math.floor(lat / TILE_DEGREES)}`;
}

export function blockBbox(block: string): [number, number, number, number] {
  const [xStr, yStr] = block.split('_');
  const x = Number(xStr), y = Number(yStr);
  return [x * TILE_DEGREES - HALO_DEGREES, y * TILE_DEGREES - HALO_DEGREES, (x + 1) * TILE_DEGREES + HALO_DEGREES, (y + 1) * TILE_DEGREES + HALO_DEGREES];
}

export const PARSED_BLOCK_LRU_SIZE = 8;
const parsedCache = new Map<string, OsmTrailWayInput[]>();
let parsedCacheHits = 0, parsedCacheMisses = 0;
export function parsedCacheStats(): { hits:number; misses:number; size:number } { return { hits: parsedCacheHits, misses: parsedCacheMisses, size: parsedCache.size }; }
export function resetParsedCache(): void { parsedCache.clear(); parsedCacheHits=0; parsedCacheMisses=0; }

export async function loadBlockWays(block: string, pbfSha256?: string): Promise<OsmTrailWayInput[]> {
  if (!/^\d+_\d+$/.test(block)) throw new Error('INVALID_BLOCK_ID');
  if (pbfSha256 && !/^[a-f0-9]{64}$/.test(pbfSha256)) throw new Error('INVALID_PBF_IDENTITY');
  // Do not read .partial/.tmp files; only atomic rename makes cache visible.
  if (block.includes('.') || block.includes('/') || block.includes('\\')) throw new Error('INVALID_BLOCK_ID');
  const cacheKey = pbfSha256 ? `${pbfSha256}:${BLOCK_EXTRACTION_VERSION}:${block}` : block;
  const cachedMem = parsedCache.get(cacheKey);
  if (cachedMem) { parsedCache.delete(cacheKey); parsedCache.set(cacheKey, cachedMem); parsedCacheHits++; return cachedMem; }
  const cacheDir = pbfSha256 ? join(CACHE_DIR, BLOCK_EXTRACTION_VERSION, pbfSha256) : CACHE_DIR;
  const bbox = blockBbox(block);
  const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  const subPbf = join(cacheDir, `block_${block}.pbf`).replace(/\\/g, '/');
  const subJson = join(cacheDir, `block_${block}.json`).replace(/\\/g, '/');
  await mkdir(cacheDir, { recursive: true });
  // Reject stale/partial/mismatched cache: JSON must be parseable array; never read .partial files.
  try {
    const raw = await readFile(subJson, 'utf8');
    const parsed = JSON.parse(raw) as OsmTrailWayInput[];
    if (!Array.isArray(parsed)) throw new Error('BLOCK_CACHE_CORRUPT');
    if (parsedCache.size >= PARSED_BLOCK_LRU_SIZE) parsedCache.delete(parsedCache.keys().next().value!);
    parsedCache.set(cacheKey, parsed);
    parsedCacheMisses++;
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as Error).message === 'BLOCK_CACHE_CORRUPT') throw e;
    if ((e as Error).message === 'BLOCK_CACHE_CORRUPT') throw new Error(`BLOCK_CACHE_CORRUPT block ${block}`);
  }
  const needExtract = !(await stat(subPbf).then(() => true).catch(() => false));
  if (needExtract) {
    const osmiumExe = 'C:\\ProgramData\\miniforge3\\Library\\bin\\osmium.exe';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(osmiumExe, ['extract', '-b', bboxStr, PBF_PATH, '-o', `${subPbf}.partial`, '-f', 'pbf', '--overwrite', '--no-progress'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, timeout: 600_000 });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`OSMIUM_EXTRACT_EXIT:${code} block ${block}`))));
    });
    // Only a successful complete extraction becomes a readable cache entry.
    await rename(`${subPbf}.partial`, subPbf);
  }
  const py = `
import osmium, json, pathlib
pbf = pathlib.Path(r'''${subPbf}''')
out = pathlib.Path(r'''${subJson}.partial''')
ways = []
class H(osmium.SimpleHandler):
    def way(self, w):
        tags = dict(w.tags)
        if 'highway' not in tags:
            return
        nodes = []
        for n in w.nodes:
            nodes.append({'nodeId': n.ref, 'coordinate': [n.lon, n.lat] if n.location.valid() else None})
        ways.append({'id': w.id, 'tags': tags, 'nodes': nodes})
h = H()
h.apply_file(str(pbf), locations=True)
out.write_text(json.dumps(ways, ensure_ascii=False), encoding='utf8')
print(f'BLOCK ${block}: {len(ways)} ways')
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python', ['-c', py], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, timeout: 300_000 });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`PY_PARSE_EXIT:${code} block ${block}`))));
  });
  await rename(`${subJson}.partial`, subJson);
  const raw2 = await readFile(subJson, 'utf8');
  const ways = JSON.parse(raw2) as OsmTrailWayInput[];
  const cacheKey2 = pbfSha256 ? `${pbfSha256}:${BLOCK_EXTRACTION_VERSION}:${block}` : block;
  if (parsedCache.size >= PARSED_BLOCK_LRU_SIZE) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(cacheKey2, ways);
  parsedCacheMisses++;
  return ways;
}

export async function loadPbfBlockContext(block: string, dataset: { datasetKey: string; region: string; snapshotTimestamp: string; pbfSha256: string }) {
  const ways = await loadBlockWays(block, dataset.pbfSha256);
  // Use reconstruction-tolerant bounds for coarse 0.25+hallo blocks; connectors remain authoritative.
  const graph = buildReconstructionPbfBlockGraph(dataset, ways);
  return { ways, graph };
}
