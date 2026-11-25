import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { inspectReplacement, validateOldSnapshot, keepProof } from './generated-replacement-live.ts';
import { stableJson, sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';

assert.equal(process.argv.length, 2, 'GET_ONLY_NO_EXECUTION_ARGUMENTS');
const snapshot = await inspectReplacement();
const manifest = JSON.parse(await readFile('data/gpx/generated-route-publication/generated-route-canary-v1.json', 'utf8')) as CanaryManifest;
validateOldSnapshot(snapshot, manifest);
const output = 'data/gpx/base-access-v2-replacement';
await mkdir(output, { recursive: true });
await writeFile(`${output}/production-preflight.json`, stableJson(snapshot) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ contractPaths: snapshot.contractPaths, keepProofHash: sha256Stable(keepProof(snapshot)),
  rows: snapshot.routes.map(r => ({ mountainId: r.mountain_id, routeId: r.id, name: r.name, distanceKm: r.distance_km })),
  writes: { storage: 0, database: 0 } }, null, 2));
