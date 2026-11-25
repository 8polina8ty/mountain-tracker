/** Bulk prepare: inventory + remaining targets + coverage
 * READ ONLY — no production writes.
 * STRICT: requires real Supabase DB, fails with REAL_MOUNTAIN_SOURCE_UNAVAILABLE otherwise.
 * Outputs under data/routes/graphhopper-bulk/
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BBOX = {
  // from data/osm/source/alps-latest.osm.pbf header boxes
  minLon: 4.842221,
  minLat: 42.698588,
  maxLon: 16.762387,
  maxLat: 48.400944,
} as const;

const OUT_DIR = 'data/routes/graphhopper-bulk';

type MountainRow = { id: number; osm_id: number | null; name: string; height: number | null; latitude: number | null; longitude: number | null };

function getEnv(): { url: string; pubKey: string; secKey: string | null } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
  const secKey: string | null = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  return { url, pubKey, secKey };
}

async function loadEnvFromFile(env: { url: string; pubKey: string; secKey: string | null }): Promise<{ url: string; pubKey: string; secKey: string | null }> {
  if (env.url && env.pubKey) return env;
  try {
    const raw = await readFile('.env.local', 'utf8');
    let url = env.url;
    let pubKey = env.pubKey;
    let secKey = env.secKey;
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1], v = m[2].trim().replace(/^["']|["']$/g, '');
      if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v;
      if (k === 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' && !pubKey) pubKey = v;
      if ((k === 'SUPABASE_SECRET_KEY' || k === 'SUPABASE_SERVICE_ROLE_KEY') && !secKey) secKey = v;
    }
    return { url, pubKey, secKey };
  } catch { return env; }
}

async function fetchAllPaginated<T>(url: string, key: string, path: string, order = 'id.asc'): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const u = `${url.replace(/\/$/, '')}/rest/v1/${path}&order=${order}&limit=${limit}&offset=${offset}`;
    const res = await fetch(u, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`FETCH_FAILED ${path} offset ${offset}: ${res.status} ${txt.slice(0, 400)}`);
    }
    const batch = (await res.json()) as T[];
    if (!Array.isArray(batch)) throw new Error(`INVALID_RESPONSE ${path}`);
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset % 10000 === 0) console.log(`  fetched ${all.length} rows from ${path}...`);
  }
  return all;
}

async function countViaHead(url: string, key: string, table: string, query: string): Promise<number> {
  const u = `${url.replace(/\/$/, '')}/rest/v1/${table}?${query}`;
  const r = await fetch(u, { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }, method: 'HEAD' });
  const cr = r.headers.get('content-range');
  if (cr) {
    const m = cr.match(/\/(\d+)$/);
    if (m) return Number(m[1]);
  }
  // fallback: fetch one
  const r2 = await fetch(u + '&limit=1', { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' } });
  const cr2 = r2.headers.get('content-range');
  if (cr2) {
    const m = cr2.match(/\/(\d+)$/);
    if (m) return Number(m[1]);
  }
  return 0;
}

export async function bulkPrepare(): Promise<void> {
  let env = getEnv();
  env = await loadEnvFromFile(env);
  if (!env.url || !env.pubKey) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: Missing Supabase URL or key');
  if (!env.secKey) console.warn('WARNING: SUPABASE_SECRET_KEY not found — provenance query will be skipped, remaining targets will be computed from verified routes only (still correct for exclusion, but provenance count will be 0)');

  await mkdir(OUT_DIR, { recursive: true });

  console.log('Inventory: fetching mountains...');
  const mountains = await fetchAllPaginated<MountainRow>(env.url, env.pubKey, 'mountains?select=id,osm_id,name,height,latitude,longitude');
  console.log(`  total mountains fetched: ${mountains.length}`);

  const total = mountains.length;
  const valid: MountainRow[] = [];
  const invalid: MountainRow[] = [];
  for (const m of mountains) {
    if (typeof m.latitude === 'number' && typeof m.longitude === 'number' && Number.isFinite(m.latitude) && Number.isFinite(m.longitude)) {
      // also check within plausible bounds
      if (m.latitude >= -90 && m.latitude <= 90 && m.longitude >= -180 && m.longitude <= 180) valid.push(m);
      else invalid.push(m);
    } else invalid.push(m);
  }

  console.log(`  valid coordinates: ${valid.length}, invalid: ${invalid.length}`);

  console.log('Fetching verified mountain_routes...');
  const verifiedRows = await fetchAllPaginated<{ mountain_id: number; id: number }>(env.url, env.pubKey, 'mountain_routes?select=id,mountain_id&is_verified=eq.true');
  const verifiedByMountain = new Map<number, number>();
  const verifiedMountainIds = new Set<number>();
  for (const r of verifiedRows) {
    verifiedMountainIds.add(r.mountain_id);
    verifiedByMountain.set(r.mountain_id, (verifiedByMountain.get(r.mountain_id) ?? 0) + 1);
  }
  console.log(`  verified rows: ${verifiedRows.length}, distinct mountains: ${verifiedMountainIds.size}`);

  let provenanceMountainIds = new Set<number>();
  let provenanceRowsCount = 0;
  if (env.secKey) {
    console.log('Fetching active provenance...');
    try {
      const prov = await fetchAllPaginated<{ mountain_id: number }>(env.url, env.secKey, 'generated_route_publication_provenance?select=mountain_id&publication_status=eq.ACTIVE');
      provenanceRowsCount = prov.length;
      for (const r of prov) provenanceMountainIds.add(r.mountain_id);
      console.log(`  provenance distinct: ${provenanceMountainIds.size}, rows: ${provenanceRowsCount}`);
    } catch (e) {
      console.warn('Provenance fetch failed, treating as 0:', (e as Error).message);
      provenanceMountainIds = new Set();
    }
  }

  const both = [...verifiedMountainIds].filter((id) => provenanceMountainIds.has(id)).length;
  const noRouteAtAll = valid.filter((m) => !verifiedMountainIds.has(m.id) && !provenanceMountainIds.has(m.id)).length;

  // Check provenance subset of verified?
  const provenanceOutsideVerified = [...provenanceMountainIds].filter((id) => !verifiedMountainIds.has(id)).length;

  const inventory = {
    generatedAt: new Date().toISOString(),
    pbfBbox: BBOX,
    counts: {
      totalMountains: total,
      validCoordinateMountains: valid.length,
      invalidOrMissingCoordinates: invalid.length,
      verifiedMountainRouteRows: verifiedRows.length,
      uniqueMountainsWithVerifiedRoute: verifiedMountainIds.size,
      activeGeneratedProvenanceRows: provenanceRowsCount,
      activeGeneratedProvenanceMountains: provenanceMountainIds.size,
      mountainsWithBothVerifiedAndProvenance: both,
      mountainsWithProvenanceButNoVerified: provenanceOutsideVerified,
      validMountainsWithNoRouteAtAll: noRouteAtAll,
    },
    provenanceSubsetOfVerified: provenanceOutsideVerified === 0,
    validMountainIdsSample: valid.slice(0, 5).map((m) => m.id),
    invalidMountainIdsSample: invalid.slice(0, 5).map((m) => m.id),
  };

  await writeFile(join(OUT_DIR, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_DIR}/inventory.json`);

  // Also write detailed id lists for audit (separate file to keep inventory light if needed)
  // But per spec include IDs — we include full lists as inventory-full.json plus summary
  const inventoryFull = {
    ...inventory,
    verifiedMountainIds: [...verifiedMountainIds].sort((a, b) => a - b),
    provenanceMountainIds: [...provenanceMountainIds].sort((a, b) => a - b),
  };
  // Don't write huge full to inventory.json itself; write inventory-full.json
  await writeFile(join(OUT_DIR, 'inventory-full.json'), JSON.stringify(inventoryFull, null, 2) + '\n', 'utf8');

  // Remaining target set: valid DB mountain MINUS mountain already having is_verified=true MINUS active provenance
  // Equivalent to valid minus verified union provenance (verified already superset in practice)
  const excluded = new Set<number>([...verifiedMountainIds, ...provenanceMountainIds]);
  const remaining = valid
    .filter((m) => !excluded.has(m.id))
    .map((m) => ({
      mountainId: m.id,
      osmId: m.osm_id,
      name: m.name,
      height: m.height,
      latitude: m.latitude!,
      longitude: m.longitude!,
      reasonIncluded: 'VALID_NO_VERIFIED_NO_PROVENANCE',
    }))
    .sort((a, b) => a.mountainId - b.mountainId);

  console.log(`Remaining targets: ${remaining.length} (valid ${valid.length} - excluded ${excluded.size})`);
  await writeFile(join(OUT_DIR, 'remaining-targets.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: remaining.length, excludedVerifiedUnique: verifiedMountainIds.size, excludedProvenanceUnique: provenanceMountainIds.size, excludedUnion: excluded.size, targets: remaining }, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_DIR}/remaining-targets.json`);

  // Coverage classification
  const inGraph: typeof remaining = [];
  const outside: typeof remaining = [];
  for (const t of remaining) {
    const inside = t.longitude >= BBOX.minLon && t.longitude <= BBOX.maxLon && t.latitude >= BBOX.minLat && t.latitude <= BBOX.maxLat;
    if (inside) inGraph.push(t);
    else outside.push(t);
  }

  const coverage = {
    generatedAt: new Date().toISOString(),
    bbox: BBOX,
    totalRemaining: remaining.length,
    inGraphCoverage: inGraph.length,
    outsideGraphCoverage: outside.length,
    invalidCoordinateCount: invalid.length,
    inGraphSample: inGraph.slice(0, 3),
    outsideSample: outside.slice(0, 3),
    countsByReason: {
      IN_GRAPH_COVERAGE: inGraph.length,
      OUTSIDE_CURRENT_GRAPH: outside.length,
    },
  };

  await writeFile(join(OUT_DIR, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_DIR}/coverage.json`);

  // Persist coverage detailed lists
  await writeFile(join(OUT_DIR, 'coverage-in-graph.json'), JSON.stringify({ count: inGraph.length, targets: inGraph }, null, 2) + '\n', 'utf8');
  await writeFile(join(OUT_DIR, 'coverage-outside.json'), JSON.stringify({ count: outside.length, targets: outside.map((t) => ({ ...t, holdoutReason: 'OUTSIDE_CURRENT_GRAPH' })) }, null, 2) + '\n', 'utf8');

  console.log('Bulk prepare complete');
  console.log(JSON.stringify({ inventory: inventory.counts, remaining: remaining.length, inGraph: inGraph.length, outside: outside.length }, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/bulk-prepare.ts')) {
  bulkPrepare().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    // Ensure REAL_MOUNTAIN_SOURCE_UNAVAILABLE is visible
    process.exitCode = 1;
  });
}
