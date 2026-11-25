/**
 * Post-execution read-only production verification.
 * Verifies all 10 routes, replacement audit, storage objects, and 50473 immutability.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Bytes, sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import {
  REPLACEMENT_IDS, KEEP_ID, ALL_IDS, inspectReplacement, keepProof,
  type ReplacementSnapshot,
} from './generated-replacement-live.ts';
import {
  REPLACEMENT_OUTPUT, CANARY_PATH, readJson,
  type ReplacementManifest,
} from './generated-replacement-plan.ts';
import { LOCKED_REPLACEMENT_HASH } from './generated-replacement-lock.ts';
import { readCredentials } from './generated-publication-live.ts';

const EXPECTED_DISTANCES: Record<number, number> = {
  138: 4.93, 150: 5.01, 796: 3.49, 12895: 7.37,
  49632: 13.91, 50473: 7.44, 51088: 14.52, 55190: 10.15,
  69594: 5.53, 73101: 6.12,
};
const EXPECTED_ROUTES: Record<number, number> = {
  138: 120, 150: 121, 796: 122, 12895: 123,
  49632: 124, 50473: 125, 51088: 126, 55190: 127,
  69594: 128, 73101: 129,
};

async function main() {
  const manifest = await readJson<ReplacementManifest>(`${REPLACEMENT_OUTPUT}/replacement-manifest.json`);
  assert.equal(sha256Bytes(await readFile(`${REPLACEMENT_OUTPUT}/replacement-manifest.json`)), LOCKED_REPLACEMENT_HASH);
  const canary = await readJson<CanaryManifest>(CANARY_PATH);
  const receipt = await readJson<{ routes: Array<{ mountainId: number; rpcAction: string; postVerifyResult: string }> }>(`${REPLACEMENT_OUTPUT}/execution-receipt.json`);

  console.log('[post-verify] Loading live production state...');
  const live = await inspectReplacement();

  const errors: string[] = [];
  const { origin, key } = readCredentials();

  // 1. Verify all 10 routes exist with exact IDs and distances
  console.log('\n── Route table ──');
  for (const id of ALL_IDS) {
    const route = live.routes.find(r => r.mountain_id === id && r.is_verified === true);
    const prov = live.provenance.find(p => p.mountain_id === id);
    const expectedRow = EXPECTED_ROUTES[id];
    const expectedDist = EXPECTED_DISTANCES[id];
    if (!route) { errors.push(`ROUTE_MISSING:${id}`); continue; }
    if (route.id !== expectedRow) errors.push(`ROUTE_ID:${id}:expected=${expectedRow}:actual=${route.id}`);
    const actualDist = Math.round(Number(route.distance_km) * 100) / 100;
    if (actualDist !== expectedDist) errors.push(`DISTANCE:${id}:expected=${expectedDist}:actual=${actualDist}`);
    if (!route.is_verified) errors.push(`NOT_VERIFIED:${id}`);
    if (!prov) errors.push(`PROVENANCE_MISSING:${id}`);
    if (prov && prov.mountain_route_id !== route.id) errors.push(`PROVENANCE_ROUTE_BINDING:${id}`);
    const isKeep = id === KEEP_ID;
    console.log(`  ${id} | row ${route.id} | ${actualDist} km | ${isKeep ? 'PRESERVED' : 'REPLACED'}`);
  }

  // 2. Verify replacement audit count = 9
  console.log('\n── Replacement audit ──');
  const auditResponse = await fetch(`${origin}/rest/v1/generated_route_replacement_audit?select=*&limit=100`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  assert(auditResponse.ok, `AUDIT_HTTP_${auditResponse.status}`);
  const auditRows = await auditResponse.json() as Array<{
    request_hash: string; manifest_hash: string; mountain_id: number;
    mountain_route_id: number; old_route: Record<string, unknown>;
    new_route: Record<string, unknown>; old_provenance: Record<string, unknown>;
    new_provenance: Record<string, unknown>;
  }>;
  if (auditRows.length !== 9) errors.push(`AUDIT_COUNT:${auditRows.length}`);
  console.log(`  Audit rows: ${auditRows.length}`);

  for (const audit of auditRows) {
    if (audit.manifest_hash !== LOCKED_REPLACEMENT_HASH) errors.push(`AUDIT_MANIFEST_HASH:${audit.mountain_id}`);
    if (!REPLACEMENT_IDS.includes(audit.mountain_id as typeof REPLACEMENT_IDS[number])) errors.push(`AUDIT_UNEXPECTED_MOUNTAIN:${audit.mountain_id}`);
    const entry = manifest.entries.find(e => e.request.mountainId === audit.mountain_id);
    if (!entry) { errors.push(`AUDIT_NO_MANIFEST_ENTRY:${audit.mountain_id}`); continue; }
    if (audit.request_hash !== entry.requestHash) errors.push(`AUDIT_REQUEST_HASH:${audit.mountain_id}`);
    if (audit.mountain_route_id !== EXPECTED_ROUTES[audit.mountain_id]) errors.push(`AUDIT_ROUTE_ID:${audit.mountain_id}`);
    const newRoute = audit.new_route as Record<string, unknown>;
    if (newRoute.gpx_url !== entry.request.newPublication.mountainRoute.gpx_url) errors.push(`AUDIT_NEW_GPX_URL:${audit.mountain_id}`);
    if (newRoute.geojson_url !== entry.request.newPublication.mountainRoute.geojson_url) errors.push(`AUDIT_NEW_GEOJSON_URL:${audit.mountain_id}`);
    console.log(`  ${audit.mountain_id}: request_hash=${audit.request_hash.slice(0,12)}... REPLACED`);
  }

  // 3. Verify 9 routes reference NEW V2 storage paths
  console.log('\n── V2 Storage paths ──');
  for (const entry of manifest.entries) {
    const route = live.routes.find(r => r.mountain_id === entry.request.mountainId);
    if (!route) continue;
    if (route.gpx_url !== entry.request.newPublication.mountainRoute.gpx_url) errors.push(`V2_GPX_URL:${entry.request.mountainId}`);
    if (route.geojson_url !== entry.request.newPublication.mountainRoute.geojson_url) errors.push(`V2_GEOJSON_URL:${entry.request.mountainId}`);
    console.log(`  ${entry.request.mountainId}: GPX=${entry.request.newPublication.provenance.storagePaths.gpx.slice(0,30)}...`);
  }

  // 4. Verify 50473 references OLD storage paths
  console.log('\n── 50473 preservation ──');
  const keepRoute = live.routes.find(r => r.mountain_id === KEEP_ID);
  if (keepRoute) {
    const oldEntry = canary.entries.find(e => e.request.mountainRoute.mountain_id === KEEP_ID);
    if (oldEntry) {
      if (keepRoute.gpx_url !== oldEntry.request.mountainRoute.gpx_url) errors.push('KEEP_50473_GPX_URL_CHANGED');
      if (keepRoute.geojson_url !== oldEntry.request.mountainRoute.geojson_url) errors.push('KEEP_50473_GEOJSON_URL_CHANGED');
      console.log(`  50473: row=${keepRoute.id} dist=${Number(keepRoute.distance_km)}km gpx=UNCHANGED`);
    }
  }

  // 5. Verify new V2 objects exist in storage
  console.log('\n── Storage objects ──');
  let objectsExist = 0;
  for (const entry of manifest.entries) {
    for (const kind of ['gpx', 'geojson'] as const) {
      const path = entry.request.newPublication.provenance.storagePaths[kind];
      const response = await fetch(`${origin}/storage/v1/object/info/public/route-gpx/${path}`, {
        method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) objectsExist++;
      else errors.push(`V2_OBJECT_MISSING:${path}`);
    }
  }
  console.log(`  New V2 objects: ${objectsExist}/18`);

  // 6. Verify old objects still exist
  let oldObjectsExist = 0;
  for (const entry of canary.entries) {
    for (const kind of ['gpx', 'geojson'] as const) {
      const url = entry.request.mountainRoute[`${kind}_url`];
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/storage/v1/object/public/route-gpx/', '');
      const response = await fetch(`${origin}/storage/v1/object/info/public/route-gpx/${path}`, {
        method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) oldObjectsExist++;
      else errors.push(`OLD_OBJECT_MISSING:${path}`);
    }
  }
  console.log(`  Old objects preserved: ${oldObjectsExist}/20`);

  // 7. No duplicate verified routes
  for (const id of ALL_IDS) {
    const verified = live.routes.filter(r => r.mountain_id === id && r.is_verified === true);
    if (verified.length !== 1) errors.push(`DUPLICATE_VERIFIED:${id}:count=${verified.length}`);
  }

  // 8. Verify keep proof matches preflight
  const baseline = await readJson<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
  const keepBefore = keepProof(baseline);
  const keepAfter = keepProof(live);
  if (sha256Stable(keepBefore) !== sha256Stable(keepAfter)) errors.push('KEEP_PROOF_DRIFTED');

  // 9. Verify receipt matches
  const replacedCount = receipt.routes.filter(r => r.rpcAction === 'REPLACED').length;
  if (replacedCount !== 9) errors.push(`RECEIPT_REPLACED_COUNT:${replacedCount}`);

  // 10. All provenance ACTIVE
  for (const id of ALL_IDS) {
    const p = live.provenance.find(x => x.mountain_id === id);
    if (p && p.publication_status !== 'ACTIVE') errors.push(`PROVENANCE_NOT_ACTIVE:${id}`);
  }

  // 11. No non-target mountains modified (spot-check: no new verified routes for other mountains)
  const nonTargetRoutes = live.routes.filter(r => !ALL_IDS.includes(Number(r.mountain_id)) && r.is_verified);
  // This is just informational
  console.log(`\n  Non-target verified routes: ${nonTargetRoutes.length}`);

  console.log('\n════════════════════════════════════════');
  if (errors.length) {
    console.log(`[post-verify] FAIL: ${errors.length} errors`);
    for (const e of errors) console.log(`  ✗ ${e}`);
    process.exitCode = 1;
  } else {
    console.log('[post-verify] ALL CHECKS PASS');
    console.log('\n  REPLACED = 9');
    console.log('  UNCHANGED_BY_HUMAN_DECISION = 1');
    console.log('  FAILED = 0');
  }
}

main().catch(error => {
  console.error('[post-verify] FATAL:', error);
  process.exitCode = 1;
});
