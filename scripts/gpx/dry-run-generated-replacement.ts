/** GET-only production dry run. No upload, mutation, SQL, or compensation path. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { CANARY_PATH, REPLACEMENT_MANIFEST, REPLACEMENT_OUTPUT, readJson, verifyReplacementFiles, type ReplacementManifest } from './generated-replacement-plan.ts';
import { inspectReplacement, keepProof, replacementReadClient, validateOldSnapshot, type ReplacementSnapshot } from './generated-replacement-live.ts';
import { LOCKED_REPLACEMENT_HASH, requirePreparationMode } from './generated-replacement-lock.ts';

requirePreparationMode(process.argv.slice(2));
assert.equal(sha256Bytes(await readFile(REPLACEMENT_MANIFEST)), LOCKED_REPLACEMENT_HASH);
const manifest = await readJson<ReplacementManifest>(REPLACEMENT_MANIFEST); await verifyReplacementFiles(manifest);
const baseline = await readJson<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
const canary = await readJson<CanaryManifest>(CANARY_PATH);
const before = await inspectReplacement(); validateOldSnapshot(before, canary);
assert.deepEqual(before.routes, baseline.routes); assert.deepEqual(before.provenance, baseline.provenance);
const reader = replacementReadClient(), blockers: string[] = [];
if (!before.contractPaths.includes('/rpc/replace_approved_generated_mountain_route')) blockers.push('MANUAL_SQL_DEPLOYMENT_REQUIRED:REPLACEMENT_RPC_ABSENT');
const probes = await Promise.allSettled(manifest.entries.flatMap(e => (['gpx', 'geojson'] as const).map(async kind => {
  const path = e.request.newPublication.provenance.storagePaths[kind];
  return { mountainId: e.request.mountainId, kind, path, absent: await reader.objectAbsent(path) };
})));
const paths = probes.map(p => { if (p.status === 'rejected') throw p.reason; return p.value; });
for (const p of paths) if (!p.absent) blockers.push(`NEW_STORAGE_PATH_EXISTS:${p.path}`);
const newIds = manifest.entries.map(e => e.request.newPublication.publicationId);
const collisions = await reader.get(`/rest/v1/generated_route_publication_provenance?select=id&publication_id=in.(${newIds})&limit=100`);
assert.deepEqual(collisions, [], 'NEW_PROVENANCE_COLLISION');
const newApprovals = await reader.get(`/rest/v1/generated_route_publication_approvals?select=publication_id&publication_id=in.(${newIds})&limit=100`);
assert.deepEqual(newApprovals, [], 'NEW_PUBLICATION_APPROVAL_COLLISION');
const newUrls = manifest.entries.flatMap(e => [e.request.newPublication.mountainRoute.gpx_url, e.request.newPublication.mountainRoute.geojson_url]);
const references = await reader.get(`/rest/v1/mountain_routes?select=id&or=(gpx_url.in.(${newUrls.map(encodeURIComponent)}),geojson_url.in.(${newUrls.map(encodeURIComponent)}))&limit=100`);
assert.deepEqual(references, [], 'NEW_URL_ALREADY_REFERENCED');
const deliveryReads = await Promise.allSettled(canary.entries.flatMap(e => (['gpx', 'geojson'] as const).map(async kind => {
  const actual = await reader.objectBytes(e.request.mountainRoute[`${kind}_url`]);
  assert.equal(actual.bytes.length, e.files[kind].bytes); assert.equal(sha256Bytes(actual.bytes), e.files[kind].sha256); assert.equal(actual.mime, e.files[kind].contentType);
  return { mountainId: e.request.mountainRoute.mountain_id, kind, bytes: actual.bytes.length, sha256: sha256Bytes(actual.bytes), mime: actual.mime, status: 'MATCH' };
})));
const oldObjects = deliveryReads.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
const after = await inspectReplacement(); validateOldSnapshot(after, canary);
assert.deepEqual(after.routes, before.routes); assert.deepEqual(after.provenance, before.provenance); assert.deepEqual(after.approvals, before.approvals);
assert.deepEqual(keepProof(after), keepProof(baseline)); await verifyReplacementFiles(manifest);
  const READY = blockers.length === 0;
  const receipt = { mode: 'CREDENTIALED_GET_ONLY_DRY_RUN', inspectedAt: after.inspectedAt, manifestSha256: LOCKED_REPLACEMENT_HASH,
    replacementTargets: 9, keepUnchanged: 1, keepUnchangedMountainId: 50473,
    allCurrentRowsResolvedExactly: true, allV2ArtifactsValid: true, allNewStoragePathsAbsent: paths.every(p => p.absent),
    noCollisions: true, allProvenanceExpectationsMatch: true, allTenProductionRowsUnchanged: true,
    keepUnchangedProof: { before: keepProof(baseline), after: keepProof(after), sha256: sha256Stable(keepProof(after)) },
    blockers, READY_FOR_EXPLICIT_REPLACEMENT: READY, paths, oldObjects,
    writes: { storageCreated: 0, storageReused: 0, storageDeleted: 0, dbReplacements: 0, provenanceMutations: 0, approvals: 0 },
    execution: { status: READY ? 'READY' : 'NOT_ATTEMPTED', replaced: 0, unattempted: 9, unchangedByHumanDecision: 1 },
    postWriteVerification: 'NOT_APPLICABLE_NO_WRITES',
  };
  await writeFile(`${REPLACEMENT_OUTPUT}/dry-run-receipt.json`, stableJson(receipt) + '\n');
  await writeFile(`${REPLACEMENT_OUTPUT}/production-after-dry-run.json`, stableJson(after) + '\n');
  console.log(JSON.stringify({ ...receipt, paths: paths.length, oldObjects: oldObjects.length, keepUnchangedProof: receipt.keepUnchangedProof.sha256 }, null, 2));
  process.exitCode = blockers.length ? 2 : 0;
