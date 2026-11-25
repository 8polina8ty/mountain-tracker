/** Deterministic stratified 60-target sample from 62,014 future >=700m inventory.
 * Covers: longitude bands (4), latitude bands (3), elevation bands (6), ID tertiles.
 * No randomness beyond inventory-order determinism; reproducible via inventoryHash.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BBOX, hash, readJson, atomicJson, type Mountain } from './bulk700-contract.ts';
import type { Inventory } from './bulk700-inventory.ts';

const BULK_DIR = 'data/routes/graphhopper-bulk/700m';
const ELEV_BANDS: Array<{ label: string; min: number; max: number | null }> = [
  { label: '700-999', min: 700, max: 999 },
  { label: '1000-1499', min: 1000, max: 1499 },
  { label: '1500-1999', min: 1500, max: 1999 },
  { label: '2000-2499', min: 2000, max: 2499 },
  { label: '2500-2999', min: 2500, max: 2999 },
  { label: '>=3000', min: 3000, max: null },
];
function elevBand(height: number): number {
  if (height < 1000) return 0;
  if (height < 1500) return 1;
  if (height < 2000) return 2;
  if (height < 2500) return 3;
  if (height < 3000) return 4;
  return 5;
}
function lonBand(lon: number): number {
  const w = (BBOX[2] - BBOX[0]) / 4;
  let b = Math.floor((lon - BBOX[0]) / w);
  if (b < 0) b = 0;
  if (b > 3) b = 3;
  return b;
}
function latBand(lat: number): number {
  const h = (BBOX[3] - BBOX[1]) / 3;
  let b = Math.floor((lat - BBOX[1]) / h);
  if (b < 0) b = 0;
  if (b > 2) b = 2;
  return b;
}
function idTertileRank(id: number, sortedIds: number[]): number {
  const idx = sortedIds.indexOf(id);
  if (idx < sortedIds.length / 3) return 0;
  if (idx < (2 * sortedIds.length) / 3) return 1;
  return 2;
}

export async function stratify() {
  const inv = await readJson<Inventory>(`${BULK_DIR}/inventory.json`);
  if (inv.source !== 'SUPABASE_DATABASE') throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: stratified requires real DB inventory');
  const targets = inv.targets;
  if (targets.length !== 62014) throw new Error(`STRATIFIED_EXPECTS_62014_GOT_${targets.length}`);
  // sanity: all height >=700
  for (const m of targets) if (!(typeof m.height === 'number' && m.height >= 700)) throw new Error('INVALID_HEIGHT_FOR_BULK');
  const sortedIds = [...targets].map(m => m.id).sort((a,b)=>a-b);
  // Build 72 cells: lon 0-3, lat 0-2, elev 0-5
  const cells = new Map<string, Mountain[]>();
  for (const m of targets) {
    const key = `${lonBand(m.longitude!)}_${latBand(m.latitude!)}_${elevBand(m.height!)}`;
    const arr = cells.get(key) ?? [];
    arr.push(m);
    cells.set(key, arr);
  }
  // Sort each cell by deterministic hash of id+inventoryHash to avoid pure ID order clustering, then by id for tie
  for (const [k, arr] of cells) {
    arr.sort((a,b) => {
      const ha = hash(`${inv.inventoryHash}:${a.id}`);
      const hb = hash(`${inv.inventoryHash}:${b.id}`);
      if (ha < hb) return -1;
      if (ha > hb) return 1;
      return a.id - b.id;
    });
  }
  // Deterministic round-robin picking across cells ordered by (lon,lat,elev) lexicographically
  const cellKeys = [...cells.keys()].sort();
  const picked: Mountain[] = [];
  let round = 0;
  while (picked.length < 60) {
    let pickedThisRound = false;
    for (const k of cellKeys) {
      const arr = cells.get(k)!;
      if (round < arr.length) {
        picked.push(arr[round]);
        pickedThisRound = true;
        if (picked.length === 60) break;
      }
    }
    if (!pickedThisRound) throw new Error('STRATIFIED_INSUFFICIENT_CELLS');
    round++;
  }
  // Ensure we have spread: sort final pick by inventoryHash-seeded hash for stable but not geographically clustered order?
  // Keep picked sorted by id for determinism in downstream reporting, but also store selection order
  const selectionOrder = [...picked];
  picked.sort((a,b)=> a.id - b.id);
  // Compute distributions
  const elevDist = [0,0,0,0,0,0];
  const lonDist = [0,0,0,0];
  const latDist = [0,0,0];
  const idDist = [0,0,0];
  for (const m of picked) {
    elevDist[elevBand(m.height!)]++;
    lonDist[lonBand(m.longitude!)]++;
    latDist[latBand(m.latitude!)]++;
    idDist[idTertileRank(m.id, sortedIds)]++;
  }
  const meta = {
    source: 'SUPABASE_DATABASE' as const,
    generatedAt: new Date().toISOString(),
    inventoryHash: inv.inventoryHash,
    identity: inv.identity,
    bbox: BBOX,
    method: 'deterministic round-robin over 72 cells (4 lon x 3 lat x 6 elev), seeded by inventoryHash hash, 60 picks, avoids single-cluster concentration',
    bands: { lonBands: 4, latBands: 3, elevBands: ELEV_BANDS.map(b=>b.label), idTertiles: ['low','middle','high'] },
    cellCount: cells.size,
    totalFutureTargets: targets.length,
    targetCount: 60,
    elevDistribution: Object.fromEntries(ELEV_BANDS.map((b,i)=>[b.label, elevDist[i]])),
    lonDistribution: { 'band0_4.84-7.82': lonDist[0], 'band1_7.82-10.80': lonDist[1], 'band2_10.80-13.78': lonDist[2], 'band3_13.78-16.76': lonDist[3] },
    latDistribution: { 'band0_42.70-44.60': latDist[0], 'band1_44.60-46.50': latDist[1], 'band2_46.50-48.40': latDist[2] },
    idDistribution: { low: idDist[0], middle: idDist[1], high: idDist[2] },
    deterministic: true,
    reproducible: 'hash(inventoryHash + id) ordering within cells + lexicographic cell round-robin',
    hash: hash({ inventoryHash: inv.inventoryHash, pickedIds: picked.map(m=>m.id).sort((a,b)=>a-b) }),
  };
  const out = { meta, targets: picked, selectionOrderIds: selectionOrder.map(m=>m.id) };
  await mkdir(dirname(`${BULK_DIR}/canary-stratified/targets.json`), { recursive: true });
  await atomicJson(`${BULK_DIR}/canary-stratified/targets.json`, out);
  console.log(JSON.stringify(meta,null,2));
  console.log(`Picked IDs: ${picked.map(m=>m.id).join(',')}`);
  return out;
}
if (process.argv[1]?.replace(/\\/g,'/').endsWith('/bulk700-stratified-sample.ts')) {
  stratify().catch(e=>{ console.error(e instanceof Error?e.message:String(e)); process.exitCode=1; });
}
