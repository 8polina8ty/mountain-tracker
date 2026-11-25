/** Local preparation only. Never uploads, invokes RPCs, or applies SQL. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildReplacementPlan, readJson, REPLACEMENT_MANIFEST, REPLACEMENT_OUTPUT, verifyReplacementFiles } from './generated-replacement-plan.ts';
import type { ReplacementSnapshot } from './generated-replacement-live.ts';
import { sha256Bytes } from '../../Lib/gpxIngestion/hashing.ts';

assert.equal(process.argv.length, 2, 'PREPARATION_ONLY');
const snapshot = await readJson<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
const { manifest, manifestBytes, localObjects } = await buildReplacementPlan(snapshot);
for (const file of localObjects) {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.bytes, { flag: 'wx' });
}
await verifyReplacementFiles(manifest);
await writeFile(REPLACEMENT_MANIFEST, manifestBytes, { flag: 'wx' });
const hash = sha256Bytes(Buffer.from(manifestBytes));
await writeFile(`${REPLACEMENT_MANIFEST}.sha256`, hash + '\n', { flag: 'wx' });
console.log(JSON.stringify({ manifestSha256: hash, replacements: manifest.entries.map(e => ({ mountainId: e.request.mountainId,
  routeId: e.request.expectedCurrentMountainRouteId, oldKm: e.request.expectedOldRoute.distance_km, newKm: e.request.productionDistanceKm })), productionWrites: 0 }, null, 2));
