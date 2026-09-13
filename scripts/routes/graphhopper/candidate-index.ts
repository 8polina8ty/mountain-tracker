/** Persistent candidate index for GraphHopper mode.
 * Extracts plausible Base Access V2 starts from PBF: parking, trailhead,
 * settlement, transit, public-road access/boundary.
 * Ranked by existing Base Access V2 policy (primaryStartPriority + access evidence).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { primaryStartPriority } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';

export const CANDIDATE_INDEX_PATH = 'data/routes/graphhopper/alps-hike/candidate-index.json';
export const CANDIDATE_META_PATH = 'data/routes/graphhopper/alps-hike/candidate-index-meta.json';

export interface RawCandidate {
  osmType: 'node' | 'way';
  osmId: number;
  kind: string;
  name: string | null;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface CandidateIndex {
  version: 'mountain-tracker/graphhopper-candidate-index/v1';
  pbfSha256: string;
  createdAt: string;
  count: number;
  candidates: RawCandidate[];
}

export async function buildCandidateIndex(pbfPath: string, pbfSha256: string): Promise<CandidateIndex> {
  const tmp = join('data/routes/graphhopper/alps-hike', '_candidates_tmp.json');
  await mkdir('data/routes/graphhopper/alps-hike', { recursive: true });
  // Use python pyosmium extraction for candidate nodes
  const py = `
import osmium, json, pathlib
pbf = pathlib.Path(r'''${pbfPath}''')
out = pathlib.Path(r'''${tmp}''')
cands = []
class H(osmium.SimpleHandler):
    def node(self, n):
        tags=dict(n.tags)
        kind=None
        if tags.get('highway')=='trailhead': kind='TRAILHEAD'
        elif tags.get('amenity')=='parking': kind='PARKING'
        elif tags.get('place') in ('village','hamlet','isolated_dwelling','farm'): kind=tags['place'].upper()
        elif tags.get('highway')=='bus_stop': kind='BUS_STOP'
        elif tags.get('railway')=='station': kind='TRAIN_STATION'
        elif tags.get('railway')=='halt': kind='HALT'
        elif tags.get('information')=='guidepost': kind='TRAILHEAD_INFO'
        elif tags.get('tourism') in ('alpine_hut','wilderness_hut'): kind=None
        else: kind=None
        if kind and n.location.valid():
            # hut never primary - already excluded
            cands.append({'osmType':'node','osmId':n.id,'kind':kind,'name':tags.get('name'), 'lat':n.location.lat, 'lon':n.location.lon, 'tags':tags})
    def way(self, w):
        tags=dict(w.tags)
        if tags.get('highway') in ('residential','unclassified','tertiary','secondary','living_street'):
            # use way center approx as first node location not trivial; skip way candidates for now, rely on nodes
            pass
h=H()
h.apply_file(str(pbf), locations=True)
# Deduplicate
out.write_text(json.dumps(cands, ensure_ascii=False), encoding='utf8')
print(f'CANDIDATES:{len(cands)}')
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python', ['-c', py], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, timeout: 600_000 });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`CANDIDATE_EXTRACT_EXIT:${code}`))));
  });
  const cands = JSON.parse(await readFile(tmp, 'utf8')) as RawCandidate[];
  const index: CandidateIndex = {
    version: 'mountain-tracker/graphhopper-candidate-index/v1',
    pbfSha256,
    createdAt: new Date().toISOString(),
    count: cands.length,
    candidates: cands,
  };
  await writeFile(CANDIDATE_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await writeFile(CANDIDATE_META_PATH, `${JSON.stringify({ pbfSha256, count: cands.length, createdAt: index.createdAt }, null, 2)}\n`, 'utf8');
  return index;
}

export async function loadCandidateIndex(): Promise<CandidateIndex | null> {
  try {
    return JSON.parse(await readFile(CANDIDATE_INDEX_PATH, 'utf8')) as CandidateIndex;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function rankCandidates(cands: RawCandidate[]): RawCandidate[] {
  return [...cands].sort((a, b) => primaryStartPriority(a.kind) - primaryStartPriority(b.kind) || (a.name ? 0 : 1) - (b.name ? 0 : 1));
}

export function boundedCandidatesForSummit(
  index: CandidateIndex,
  summit: { lat: number; lon: number },
  limit = 20,
): RawCandidate[] {
  // Haversine filter 20km, then rank and bound 5-20
  const toRad = (d: number) => (d * Math.PI) / 180;
  const hav = (a: RawCandidate) => {
    const dLat = toRad(a.lat - summit.lat);
    const dLon = toRad(a.lon - summit.lon);
    const la1 = toRad(summit.lat);
    const la2 = toRad(a.lat);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
  };
  const nearby = index.candidates
    .map((c) => ({ c, d: hav(c) }))
    .filter((x) => x.d <= 20000)
    .sort((a, b) => a.d - b.d)
    .slice(0, 100)
    .map((x) => x.c);
  const ranked = rankCandidates(nearby);
  if (ranked.length <= 5) return ranked;
  return ranked.slice(0, Math.min(limit, ranked.length));
}
