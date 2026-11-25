/** Generate a manual SQL allowlist from locked bytes. Never connects to PostgreSQL. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { sha256Bytes, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { REPLACEMENT_MANIFEST, REPLACEMENT_OUTPUT, readJson, verifyReplacementFiles, type ReplacementManifest } from './generated-replacement-plan.ts';
import { keepProof, type ReplacementSnapshot } from './generated-replacement-live.ts';
import { LOCKED_REPLACEMENT_HASH } from './generated-replacement-lock.ts';

assert.equal(process.argv.length, 2, 'LOCAL_SQL_ARTIFACT_ONLY');
assert.equal(sha256Bytes(await readFile(REPLACEMENT_MANIFEST)), LOCKED_REPLACEMENT_HASH);
const manifest = await readJson<ReplacementManifest>(REPLACEMENT_MANIFEST); await verifyReplacementFiles(manifest);
const snapshot = await readJson<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const rows = manifest.entries.map(e => `(${literal(e.requestHash)},${literal(LOCKED_REPLACEMENT_HASH)},${e.request.mountainId},${e.request.expectedCurrentMountainRouteId},${literal(stableJson(e.request))},${literal(stableJson(keepProof(snapshot)))}::jsonb)`);
await writeFile('database/generated_route_replacement_approval.sql', [
  '-- MANUAL REVIEW / MANUAL DEPLOYMENT ONLY. Does not replace routes or upload objects.',
  '-- Requires generated_route_replacement.sql. No conflict-ignore: reruns fail closed.',
  `-- Locked manifest SHA256: ${LOCKED_REPLACEMENT_HASH}`,
  'begin;', 'set local standard_conforming_strings = on;',
  'insert into public.generated_route_replacement_approvals (request_hash,manifest_hash,mountain_id,mountain_route_id,canonical_request,keep_guard) values',
  rows.join(',\n') + ';', 'commit;', '',
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ approvedRows: rows.length, manifestSha256: LOCKED_REPLACEMENT_HASH, productionWrites: 0 }));
