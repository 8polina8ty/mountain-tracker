import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BULK_DIR = 'data/routes/graphhopper-bulk/700m';
export const IDENTITY = Object.freeze({ graphId: '06e38ba4b3218f5f', pbfSha256: '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5', profile: 'foot' });
export const PRIMARY_STATES = ['TRUSTED_REPLACEMENT_READY', 'NO_REAL_BASE_ACCESS_CANDIDATE', 'NO_ROUTE', 'REJECTED_ACCESS', 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED', 'GRAPH_ERROR', 'INVALID_GEOMETRY', 'UNEXPECTED_ERROR'] as const;
export type PrimaryState = typeof PRIMARY_STATES[number];
export type Mountain = { id: number; osm_id: number | null; name: string; height: number | null; latitude: number | null; longitude: number | null };
export const BBOX = [4.842221, 42.698588, 16.762387, 48.400944] as const;
export function validHeight(m: Mountain): boolean { return typeof m.height === 'number' && Number.isFinite(m.height) && m.height >= 700; }
export function validCoordinates(m: Mountain): boolean {
  return typeof m.latitude === 'number' && Number.isFinite(m.latitude) && Math.abs(m.latitude) <= 90 && typeof m.longitude === 'number' && Number.isFinite(m.longitude) && Math.abs(m.longitude) <= 180;
}
export function inCoverage(m: Mountain): boolean {
  return validCoordinates(m) && m.longitude! >= BBOX[0] && m.longitude! <= BBOX[2] && m.latitude! >= BBOX[1] && m.latitude! <= BBOX[3];
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export function primaryCounts(rows: { state: PrimaryState }[]): Record<PrimaryState, number> {
  const counts = Object.fromEntries(PRIMARY_STATES.map(s => [s, 0])) as Record<PrimaryState, number>;
  for (const row of rows) {
    if (!PRIMARY_STATES.includes(row.state)) throw new Error('INVALID_PRIMARY_STATE');
    counts[row.state]++;
  }
  if (Object.values(counts).reduce((a, b) => a + b, 0) !== rows.length) throw new Error('PRIMARY_STATE_SUM_MISMATCH');
  return counts;
}
