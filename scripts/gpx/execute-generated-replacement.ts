/**
 * Bounded replacement executor. Uploads V2 objects to Storage, verifies delivered bytes,
 * then calls replace_approved_generated_mountain_route RPC.
 *
 * Usage: node --experimental-strip-types scripts/gpx/execute-generated-replacement.ts
 *   --execute --manifest <path> --manifest-sha256 <locked-hash>
 *
 * All writes are bounded to the exact locked manifest. No direct service-role UPDATEs.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sha256Bytes, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import {
  KEEP_ID, inspectReplacement, validateOldSnapshot,
  type ReplacementSnapshot,
} from './generated-replacement-live.ts';
import {
  REPLACEMENT_OUTPUT, CANARY_PATH, readJson,
  validateReplacementManifest, verifyReplacementFiles,
  type ReplacementManifest, type ReplacementEntry,
} from './generated-replacement-plan.ts';
import {
  LOCKED_REPLACEMENT_HASH, parseExecuteArgs,
} from './generated-replacement-lock.ts';
import { ROUTE_DISTANCE_SCALE } from './generated-publication-execute.ts';
import { readCredentials } from './generated-publication-live.ts';
import { createHash } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── Receipt ───────────────────────────────────────────────────────────────
export interface PerRouteReceipt {
  mountainId: number;
  mountainRouteId: number;
  requestHash: string;
  oldPublicationId: string;
  newPublicationId: string;
  storageGpxPath: string;
  storageGeojsonPath: string;
  uploadedGpx: boolean;
  uploadedGeojson: boolean;
  deliveredGpxSha256: string | null;
  deliveredGeojsonSha256: string | null;
  rpcAction: string | null;
  rpcError: string | null;
  postVerifyResult: string | null;
  timestamp: string;
}

export interface ExecutionReceipt {
  mode: 'EXECUTE_REPLACEMENT';
  manifestSha256: string;
  startedAt: string;
  completedAt: string | null;
  routes: PerRouteReceipt[];
  summary: {
    replaced: number;
    unchanged: number;
    failed: number;
    storageCreated: number;
    storageVerified: number;
    keepUnchangedMountainId: number;
  };
  status: 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED';
  stopReason: string | null;
}

const RECEIPT_PATH = `${REPLACEMENT_OUTPUT}/execution-receipt.json`;

async function writeReceipt(receipt: ExecutionReceipt) {
  await mkdir(REPLACEMENT_OUTPUT, { recursive: true });
  await writeFile(RECEIPT_PATH, stableJson(receipt) + '\n');
}

// ─── Storage pre-flight and upload ────────────────────────────────────────
async function ensureStorageAbsent(path: string, bucket = 'route-gpx'): Promise<boolean> {
  const { origin, key } = readCredentials();
  const response = await fetch(`${origin}/storage/v1/object/info/public/${bucket}/${path}`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.ok) return false;
  const body = await response.json().catch(() => null) as { statusCode?: string | number; message?: string } | null;
  if (response.status === 404 || (response.status === 400 && String(body?.statusCode) === '404' && /not found/i.test(body?.message ?? '')))
    return true;
  throw new Error(`STORAGE_PROBE_FAILED:${response.status}:${path}`);
}

async function uploadToStorage(
  client: AnyClient,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  bucket = 'route-gpx',
): Promise<'UPLOADED' | 'UPLOAD_FAILED' | 'UPLOAD_UNCERTAIN'> {
  try {
    const { error } = await client.storage.from(bucket).upload(path, bytes, {
      contentType, upsert: false, cacheControl: '3600',
    });
    if (error) {
      const msg = String(error.message ?? 'UPLOAD_ERROR');
      if (/exist|already|conflict|duplicate/i.test(msg)) return 'UPLOAD_FAILED';
      return 'UPLOAD_UNCERTAIN';
    }
    return 'UPLOADED';
  } catch {
    return 'UPLOAD_UNCERTAIN';
  }
}

async function verifyStorageObject(
  client: AnyClient,
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  bucket = 'route-gpx',
): Promise<{ status: 'MATCH' | 'MISMATCH'; detail?: string }> {
  try {
    const { data, error } = await client.storage.from(bucket).download(path);
    if (error || !data) return { status: 'MISMATCH', detail: `DOWNLOAD_ERROR:${error?.message ?? 'NO_DATA'}` };
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.length !== expectedBytes) return { status: 'MISMATCH', detail: `SIZE:${bytes.length}:${expectedBytes}` };
    if (sha256Hex(bytes) !== expectedSha256) return { status: 'MISMATCH', detail: 'HASH' };
    return { status: 'MATCH' };
  } catch (error) {
    return { status: 'MISMATCH', detail: `VERIFY_ERROR:${error instanceof Error ? error.message : String(error)}` };
  }
}

async function fetchPublicDeliveryHash(url: string, expectedBytes: number, expectedSha256: string, expectedMime: string): Promise<{ sha256: string; bytes: number; mime: string } | null> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const mime = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (mime !== expectedMime) return null;
    const stream = response.body?.getReader();
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await stream.read();
      if (next.done) break;
      size += next.value.length;
      if (size > expectedBytes + 1) { await stream.cancel(); return null; }
      chunks.push(next.value);
    }
    if (size !== expectedBytes) return null;
    const hash = sha256Hex(Buffer.concat(chunks));
    if (hash !== expectedSha256) return null;
    return { sha256: hash, bytes: size, mime };
  } catch {
    return null;
  }
}

// ─── RPC call ──────────────────────────────────────────────────────────────
async function callReplacementRpc(
  client: AnyClient,
  canonicalRequest: string,
  requestHash: string,
  manifestHash: string,
): Promise<{ action: string; mountainRouteId: number } | { error: string }> {
  const envelope = { canonicalRequest, requestHash, manifestHash };
  try {
    // The RPC is deployed but not in Supabase generated types; use dynamic dispatch.
    const { data, error } = await (client as unknown as { rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> })
      .rpc('replace_approved_generated_mountain_route', { p_request: envelope });
    if (error) return { error: String(error.message ?? 'RPC_ERROR') };
    const rows = data as Array<{ action: string; mountain_route_id: number }>;
    if (!rows?.length || !rows[0]) return { error: 'RPC_EMPTY_RESULT' };
    const row = rows[0];
    if (!['REPLACED', 'UNCHANGED'].includes(row.action) || !Number.isSafeInteger(row.mountain_route_id) || row.mountain_route_id <= 0)
      return { error: `RPC_INVALID_RESULT:${row.action}:${row.mountain_route_id}` };
    return { action: row.action, mountainRouteId: row.mountain_route_id };
  } catch (error) {
    return { error: `RPC_EXCEPTION:${error instanceof Error ? error.message : String(error)}` };
  }
}

// ─── Post-replacement verification ────────────────────────────────────────
async function verifyPostReplacement(
  client: AnyClient,
  entry: ReplacementEntry,
  expectedMountainRouteId: number,
): Promise<{ ok: boolean; detail: string }> {
  const key = entry.request.newPublicationRequestHash;
  try {
    const { data: provRows, error: provErr } = await client.from('generated_route_publication_provenance')
      .select('*')
      .eq('request_hash', key);
    if (provErr) return { ok: false, detail: `PROVENANCE_READ_ERROR:${provErr.message}` };
    if (!provRows?.length) return { ok: false, detail: 'PROVENANCE_ROW_MISSING' };
    if (provRows.length !== 1) return { ok: false, detail: `PROVENANCE_ROW_COUNT:${provRows.length}` };
    const p = provRows[0] as Record<string, unknown>;
    if (p.publication_id !== entry.request.newPublication.publicationId) return { ok: false, detail: 'PROVENANCE_PUBLICATION_ID' };
    if (p.publication_status !== 'ACTIVE') return { ok: false, detail: `PROVENANCE_STATUS:${p.publication_status}` };
    if (Number(p.mountain_route_id) !== expectedMountainRouteId) return { ok: false, detail: `PROVENANCE_ROUTE_ID:${p.mountain_route_id}:${expectedMountainRouteId}` };
    if (Number(p.mountain_id) !== entry.request.mountainId) return { ok: false, detail: 'PROVENANCE_MOUNTAIN_ID' };

    const { data: routeRows, error: routeErr } = await client.from('mountain_routes')
      .select('*')
      .eq('id', expectedMountainRouteId);
    if (routeErr) return { ok: false, detail: `ROUTE_READ_ERROR:${routeErr.message}` };
    if (!routeRows?.length) return { ok: false, detail: 'ROUTE_ROW_MISSING' };
    const route = routeRows[0] as Record<string, unknown>;
    if (Number(route.mountain_id) !== entry.request.mountainId) return { ok: false, detail: 'ROUTE_MOUNTAIN_ID' };
    if (!route.is_verified) return { ok: false, detail: 'ROUTE_NOT_VERIFIED' };
    if (route.name !== entry.request.newPublication.mountainRoute.name) return { ok: false, detail: 'ROUTE_NAME' };
    if (route.gpx_url !== entry.request.newPublication.mountainRoute.gpx_url) return { ok: false, detail: 'ROUTE_GPX_URL' };
    if (route.geojson_url !== entry.request.newPublication.mountainRoute.geojson_url) return { ok: false, detail: 'ROUTE_GEOJSON_URL' };
    const actualDistance = Number(route.distance_km);
    if (Math.round(actualDistance * ROUTE_DISTANCE_SCALE) !== Math.round(entry.request.productionDistanceKm * ROUTE_DISTANCE_SCALE))
      return { ok: false, detail: `ROUTE_DISTANCE:${actualDistance}:${entry.request.productionDistanceKm}` };

    // Verify 50473 unchanged
    const { data: keepRows } = await client.from('mountain_routes')
      .select('id,mountain_id,distance_km,is_verified,gpx_url,geojson_url')
      .eq('id', 125)
      .eq('mountain_id', 50473);
    if (!keepRows?.length || Number(keepRows[0].distance_km) !== 7.44 || !keepRows[0].is_verified)
      return { ok: false, detail: 'KEEP_50473_DRIFT' };

    return { ok: true, detail: 'POST_VERIFY_PASS' };
  } catch (error) {
    return { ok: false, detail: `POST_VERIFY_ERROR:${error instanceof Error ? error.message : String(error)}` };
  }
}

// ─── Main execution ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const parsed = parseExecuteArgs(args);

  console.log(`[replacement-executor] Manifest path: ${parsed.manifestPath}`);
  console.log(`[replacement-executor] Manifest SHA256: ${parsed.manifestSha256}`);
  assert.equal(parsed.manifestSha256, LOCKED_REPLACEMENT_HASH, 'MANIFEST_SHA256_MISMATCH');

  // Load and verify manifest
  const manifest = await readJson<ReplacementManifest>(parsed.manifestPath);
  assert.equal(sha256Bytes(await readFile(parsed.manifestPath)), LOCKED_REPLACEMENT_HASH, 'MANIFEST_FILE_SHA256_MISMATCH');
  validateReplacementManifest(manifest);
  await verifyReplacementFiles(manifest);
  console.log('[replacement-executor] Manifest verified: 9 entries, hashes match.');

  // Load canary and snapshot
  const canary = await readJson<CanaryManifest>(CANARY_PATH);
  const snapshot = await readJson<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
  validateOldSnapshot(snapshot, canary);

  // Live re-verification
  const snapshotLive = await inspectReplacement();
  assert.deepEqual(snapshotLive.routes, snapshot.routes, 'LIVE_ROUTE_DRIFT');
  assert.deepEqual(snapshotLive.provenance, snapshot.provenance, 'LIVE_PROVENANCE_DRIFT');
  console.log('[replacement-executor] Live state matches preflight snapshot.');

  // Verify RPC exists via live API schema
  assert(snapshotLive.contractPaths.includes('/rpc/replace_approved_generated_mountain_route'), 'REPLACEMENT_RPC_ABSENT');
  console.log('[replacement-executor] Replacement RPC confirmed in API schema.');

  // Supabase client
  const { origin, key } = readCredentials();
  const supabase = createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as AnyClient;

  // Initialize receipt
  const receipt: ExecutionReceipt = {
    mode: 'EXECUTE_REPLACEMENT',
    manifestSha256: LOCKED_REPLACEMENT_HASH,
    startedAt: new Date().toISOString(),
    completedAt: null,
    routes: manifest.entries.map(e => ({
      mountainId: e.request.mountainId,
      mountainRouteId: e.request.expectedCurrentMountainRouteId,
      requestHash: e.requestHash,
      oldPublicationId: String(e.request.expectedOldProvenance.publication_id),
      newPublicationId: e.request.newPublication.publicationId,
      storageGpxPath: e.request.newPublication.provenance.storagePaths.gpx,
      storageGeojsonPath: e.request.newPublication.provenance.storagePaths.geojson,
      uploadedGpx: false,
      uploadedGeojson: false,
      deliveredGpxSha256: null,
      deliveredGeojsonSha256: null,
      rpcAction: null,
      rpcError: null,
      postVerifyResult: null,
      timestamp: '',
    })),
    summary: { replaced: 0, unchanged: 0, failed: 0, storageCreated: 0, storageVerified: 0, keepUnchangedMountainId: KEEP_ID },
    status: 'IN_PROGRESS',
    stopReason: null,
  };
  await writeReceipt(receipt);

  let stopReason: string | null = null;

  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i];
    const routeReceipt = receipt.routes[i];
    const mountainId = entry.request.mountainId;
    console.log(`\n[replacement-executor] ── Route ${i + 1}/9: mountain ${mountainId} ──`);

    // A. Pre-re-verify: 50473 unchanged
    try {
      const { data: keepRows } = await supabase.from('mountain_routes')
        .select('id,mountain_id,distance_km,is_verified')
        .eq('id', 125)
        .eq('mountain_id', 50473)
        .single();
      if (!keepRows || Number(keepRows.distance_km) !== 7.44 || !keepRows.is_verified) {
        stopReason = `KEEP_50473_DRIFT_BEFORE_ROUTE_${mountainId}`;
        break;
      }
    } catch (error) {
      stopReason = `KEEP_50473_CHECK_FAILED:${error instanceof Error ? error.message : String(error)}`;
      break;
    }

    // A2. Pre-re-verify target route still matches
    try {
      const { data: routeRows } = await supabase.from('mountain_routes')
        .select('*')
        .eq('id', entry.request.expectedCurrentMountainRouteId)
        .eq('mountain_id', mountainId);
      if (!routeRows?.length) {
        stopReason = `TARGET_ROUTE_MISSING:${mountainId}:${entry.request.expectedCurrentMountainRouteId}`;
        break;
      }
      const route = routeRows[0] as Record<string, unknown>;
      if (route.gpx_url !== entry.request.expectedOldRoute.gpx_url || route.geojson_url !== entry.request.expectedOldRoute.geojson_url) {
        stopReason = `TARGET_ROUTE_DRIFTED:${mountainId}`;
        break;
      }
    } catch (error) {
      stopReason = `TARGET_ROUTE_CHECK_FAILED:${mountainId}:${error instanceof Error ? error.message : String(error)}`;
      break;
    }

    // B. Check new storage paths absent
    for (const kind of ['gpx', 'geojson'] as const) {
      const path = entry.request.newPublication.provenance.storagePaths[kind];
      const absent = await ensureStorageAbsent(path);
      if (!absent) {
        stopReason = `NEW_STORAGE_EXISTS:${path}`;
        break;
      }
    }
    if (stopReason) break;

    // B2. Upload GPX
    const gpxPath = entry.request.newPublication.provenance.storagePaths.gpx;
    const gpxFile = entry.files.gpx;
    const gpxBytes = await readFile(gpxFile.path);
    assert.equal(gpxBytes.length, gpxFile.bytes, `GPX_LOCAL_SIZE:${mountainId}`);
    assert.equal(sha256Hex(gpxBytes), gpxFile.sha256, `GPX_LOCAL_HASH:${mountainId}`);

    const gpxUpload = await uploadToStorage(supabase, gpxPath, gpxBytes, gpxFile.contentType);
    if (gpxUpload !== 'UPLOADED') {
      routeReceipt.rpcError = `GPX_UPLOAD_${gpxUpload}`;
      routeReceipt.timestamp = new Date().toISOString();
      receipt.summary.failed++;
      stopReason = `GPX_UPLOAD_FAILED:${mountainId}:${gpxUpload}`;
      break;
    }
    routeReceipt.uploadedGpx = true;
    receipt.summary.storageCreated++;
    console.log(`[replacement-executor] GPX uploaded: ${gpxPath} (${gpxFile.bytes} bytes)`);

    // C. Upload GeoJSON
    const geojsonPath = entry.request.newPublication.provenance.storagePaths.geojson;
    const geojsonFile = entry.files.geojson;
    const geojsonBytes = await readFile(geojsonFile.path);
    assert.equal(geojsonBytes.length, geojsonFile.bytes, `GEOJSON_LOCAL_SIZE:${mountainId}`);
    assert.equal(sha256Hex(geojsonBytes), geojsonFile.sha256, `GEOJSON_LOCAL_HASH:${mountainId}`);

    const geojsonUpload = await uploadToStorage(supabase, geojsonPath, geojsonBytes, geojsonFile.contentType);
    if (geojsonUpload !== 'UPLOADED') {
      routeReceipt.rpcError = `GEOJSON_UPLOAD_${geojsonUpload}`;
      routeReceipt.timestamp = new Date().toISOString();
      receipt.summary.failed++;
      stopReason = `GEOJSON_UPLOAD_FAILED:${mountainId}:${geojsonUpload}`;
      break;
    }
    routeReceipt.uploadedGeojson = true;
    receipt.summary.storageCreated++;
    console.log(`[replacement-executor] GeoJSON uploaded: ${geojsonPath} (${geojsonFile.bytes} bytes)`);

    // D. Verify uploaded Storage objects before RPC
    for (const kind of ['gpx', 'geojson'] as const) {
      const path = entry.request.newPublication.provenance.storagePaths[kind];
      const file = entry.files[kind];
      const verdict = await verifyStorageObject(supabase, path, file.bytes, file.sha256);
      if (verdict.status !== 'MATCH') {
        stopReason = `STORAGE_VERIFY_FAILED:${mountainId}:${kind}:${verdict.detail}`;
        break;
      }
      receipt.summary.storageVerified++;
    }
    if (stopReason) break;

    // D2. Verify public delivery bytes (mandatory per spec)
    for (const kind of ['gpx', 'geojson'] as const) {
      const file = entry.files[kind];
      const url = entry.request.newPublication.mountainRoute[`${kind}_url`];
      const delivered = await fetchPublicDeliveryHash(url, file.bytes, file.sha256, file.contentType);
      if (!delivered) {
        stopReason = `DELIVERY_HASH_MISMATCH:${mountainId}:${kind}`;
        break;
      }
      if (kind === 'gpx') routeReceipt.deliveredGpxSha256 = delivered.sha256;
      else routeReceipt.deliveredGeojsonSha256 = delivered.sha256;
      console.log(`[replacement-executor] Delivery verified: ${kind} sha256=${delivered.sha256.slice(0, 16)}...`);
    }
    if (stopReason) break;

    // E. Invoke replacement RPC
    const canonicalRequest = stableJson(entry.request);
    const rpcResult = await callReplacementRpc(supabase, canonicalRequest, entry.requestHash, LOCKED_REPLACEMENT_HASH);
    if ('error' in rpcResult) {
      routeReceipt.rpcError = rpcResult.error;
      routeReceipt.timestamp = new Date().toISOString();
      // Check if committed despite error
      const postVerify = await verifyPostReplacement(supabase, entry, entry.request.expectedCurrentMountainRouteId);
      routeReceipt.postVerifyResult = postVerify.ok ? 'COMMITTED_VIA_RECONCILIATION' : postVerify.detail;
      if (postVerify.ok) {
        routeReceipt.rpcAction = 'REPLACED';
        receipt.summary.replaced++;
        console.log('[replacement-executor] RPC error but reconciliation confirms commit.');
      } else {
        receipt.summary.failed++;
        stopReason = `RPC_FAILED:${mountainId}:${rpcResult.error}`;
        break;
      }
    } else {
      routeReceipt.rpcAction = rpcResult.action;
      console.log(`[replacement-executor] RPC action: ${rpcResult.action}`);

      if (rpcResult.action === 'REPLACED') {
        receipt.summary.replaced++;
        // F. Post-verify
        const postVerify = await verifyPostReplacement(supabase, entry, rpcResult.mountainRouteId);
        routeReceipt.postVerifyResult = postVerify.ok ? 'PASS' : postVerify.detail;
        if (!postVerify.ok) {
          stopReason = `POST_VERIFY_FAILED:${mountainId}:${postVerify.detail}`;
          break;
        }
        routeReceipt.mountainRouteId = rpcResult.mountainRouteId;
      } else if (rpcResult.action === 'UNCHANGED') {
        receipt.summary.unchanged++;
        routeReceipt.postVerifyResult = 'IDEMPOTENT_RESUME';
      } else {
        stopReason = `RPC_UNEXPECTED_ACTION:${mountainId}:${rpcResult.action}`;
        break;
      }
    }

    routeReceipt.timestamp = new Date().toISOString();
    console.log(`[replacement-executor] Route ${mountainId} complete: ${routeReceipt.rpcAction}`);
    await writeReceipt(receipt);
  }

  receipt.completedAt = new Date().toISOString();
  receipt.status = stopReason ? 'STOPPED' : 'COMPLETED';
  receipt.stopReason = stopReason;
  await writeReceipt(receipt);

  console.log('\n[replacement-executor] ═══════════════════════════════════════');
  console.log(`[replacement-executor] Status: ${receipt.status}`);
  console.log(`[replacement-executor] Replaced: ${receipt.summary.replaced}`);
  console.log(`[replacement-executor] Unchanged: ${receipt.summary.unchanged}`);
  console.log(`[replacement-executor] Failed: ${receipt.summary.failed}`);
  console.log(`[replacement-executor] Storage created: ${receipt.summary.storageCreated}`);
  if (stopReason) console.log(`[replacement-executor] Stop reason: ${stopReason}`);

  process.exitCode = receipt.status === 'COMPLETED' ? 0 : 1;
}

main().catch(error => {
  console.error('[replacement-executor] FATAL:', error);
  process.exitCode = 1;
});
