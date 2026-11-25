/** Read-only, fail-closed DB inventory. No publication or database mutation APIs. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, BBOX, BULK_DIR, hash, IDENTITY, inCoverage, readJson, validCoordinates, validHeight, type Mountain } from './bulk700-contract.ts';

export type Inventory = {
  source: 'SUPABASE_DATABASE'; generatedAt: string; identity: typeof IDENTITY; inventoryHash: string;
  counts: Record<string, number>; targets: Mountain[]; excludedAcceptedIds: number[]; closedOldHoldoutIds: number[];
};
async function credentials() {
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    for (const line of (await readFile('.env.local', 'utf8')).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* Credentials may already be in process.env. */ }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: complete read visibility requires URL and server key');
  return { url, key };
}
export async function acceptedCorpus() {
  const root = 'identity-repair/provenance-integrity/real-evidence';
  const oldIds: number[] = [], existing: number[] = [];
  for (const name of (await readdir(root)).filter(n => /^\d+\.json$/.test(n))) {
    const row = await readJson<{ mountainId: number; classification: string }>(join(root, name));
    oldIds.push(row.mountainId);
    if (row.classification === 'REAL_EVIDENCE_VALID') existing.push(row.mountainId);
  }
  const recovery = await readJson<{ completed: { mountainId: number; classification: string }[] }>('data/routes/graphhopper-recovery/recovery-gh-1789420609649/checkpoint.json');
  const routed = recovery.completed.filter(r => r.classification === 'TRUSTED_REPLACEMENT_READY').map(r => r.mountainId);
  const trusted = [...new Set([...existing, ...routed])].sort((a,b) => a-b);
  if (existing.length !== 4 || routed.length !== 153 || trusted.length !== 157 || new Set(oldIds).size !== 573) throw new Error('ACCEPTED_CORPUS_IDENTITY_MISMATCH');
  return { trusted, oldIds, closedOldHoldoutIds: oldIds.filter(id => !trusted.includes(id)).sort((a,b) => a-b) };
}
export async function prepare700Inventory(): Promise<Inventory> {
  const { url, key } = await credentials();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' };
  async function request(path: string, method = 'GET') {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, { method, headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`REAL_MOUNTAIN_SOURCE_UNAVAILABLE: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? NaN);
    if (!Number.isSafeInteger(total)) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: exact count missing');
    return { response, total };
  }
  async function rows<T extends { id: number }>(path: string): Promise<T[]> {
    const all: T[] = [];
    let lastId = -1, expected: number | null = null;
    for (let page = 0; page < 10_000; page++) {
      const { response, total } = await request(`${path}&order=id.asc&limit=1000&offset=${all.length}`);
      if (expected !== null && total !== expected) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: inventory changed during pagination');
      expected = total;
      const batch = await response.json() as T[];
      if (!Array.isArray(batch) || batch.some(r => !Number.isSafeInteger(r.id) || r.id <= lastId)) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: invalid page');
      for (const row of batch) {
        if (row.id <= lastId) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: duplicate/unordered ID');
        lastId = row.id;
      }
      all.push(...batch);
      if (all.length === total) return all;
      if (!batch.length || all.length > total) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: incomplete page');
    }
    throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: pagination limit');
  }
  const totalBefore = (await request('mountains?select=id', 'HEAD')).total;
  // First height guard is part of the DB query, not just client filtering.
  const mountains = await rows<Mountain>('mountains?select=id,osm_id,name,height,latitude,longitude&height=gte.700');
  if (mountains.some(m => !validHeight(m))) throw new Error('INVALID_HEIGHT_FOR_BULK: DB filter violated');
  const verified = await rows<{ id: number; mountain_id: number }>('mountain_routes?select=id,mountain_id&is_verified=eq.true');
  const corpus = await acceptedCorpus();
  // Old invalid generated rows must not be relabelled as accepted just because DB is_verified is true.
  const old = new Set(corpus.oldIds);
  const legacy = verified.filter(r => !old.has(r.mountain_id)).map(r => r.mountain_id);
  const accepted = new Set([...corpus.trusted, ...legacy]);
  const closed = new Set(corpus.closedOldHoldoutIds);
  const inside = mountains.filter(inCoverage);
  const targets = inside.filter(m => !accepted.has(m.id) && !closed.has(m.id));
  const totalAfter = (await request('mountains?select=id', 'HEAD')).total;
  if (totalAfter !== totalBefore) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: DB changed during inventory');
  const counts = {
    totalDbMountains: totalBefore, heightAtLeast700: mountains.length,
    dbMountainsTotal: totalBefore, dbMountainsAtLeast700: mountains.length,
    invalidCoordinatesAtLeast700: mountains.filter(m => !validCoordinates(m)).length,
    insideGraphCoverage: inside.length, outsideGraphCoverage: mountains.filter(m => validCoordinates(m) && !inCoverage(m)).length,
    trustedCorpus: corpus.trusted.length, legacyVerifiedUnique: new Set(legacy).size,
    alreadyAcceptedExcludedInsideGraph: inside.filter(m => accepted.has(m.id)).length,
    closedOldHoldoutExcludedInsideGraph: inside.filter(m => closed.has(m.id)).length,
    futureBulkTargets: targets.length,
  };
  const inventory: Inventory = { source: 'SUPABASE_DATABASE', generatedAt: new Date().toISOString(), identity: IDENTITY, counts, targets, excludedAcceptedIds: [...accepted].sort((a,b) => a-b), closedOldHoldoutIds: corpus.closedOldHoldoutIds, inventoryHash: hash({ identity: IDENTITY, targets }) };
  await atomicJson(`${BULK_DIR}/inventory.json`, inventory);
  await atomicJson(`${BULK_DIR}/inventory-audit.json`, { ...counts, bbox: BBOX, coverageDefinition: 'PBF header bounding box; routing availability is checked per mountain, not inferred from bbox', allHeightEligibleRows: mountains, verifiedRows: verified, trustedIds: corpus.trusted, oldCorpusRecoveryClosed: true });
  console.log(JSON.stringify(counts, null, 2));
  return inventory;
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/bulk700-inventory.ts')) {
  prepare700Inventory().catch(async e => {
    await atomicJson(`${BULK_DIR}/inventory-failure.json`, { error: 'REAL_MOUNTAIN_SOURCE_UNAVAILABLE', detail: e instanceof Error ? e.message : 'unknown', at: new Date().toISOString() });
    console.error(e instanceof Error ? e.message : 'REAL_MOUNTAIN_SOURCE_UNAVAILABLE'); process.exitCode = 1;
  });
}
