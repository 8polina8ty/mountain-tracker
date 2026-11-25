/** Credentialed, bounded GET-only inspection. This module has no write operation. */
import assert from 'node:assert/strict';
import { readCredentials } from './generated-publication-live.ts';
import { stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';

export const REPLACEMENT_IDS = [138, 150, 796, 12895, 49632, 51088, 55190, 69594, 73101] as const;
export const KEEP_ID = 50473;
export const ALL_IDS = [...REPLACEMENT_IDS, KEEP_ID].sort((a, b) => a - b);
export type JsonRow = Record<string, unknown>;
export interface ReplacementSnapshot {
  inspectedAt: string; origin: string; routes: JsonRow[]; provenance: JsonRow[];
  mountains: JsonRow[]; approvals: JsonRow[]; bucket: JsonRow;
  contractPaths: string[]; definitions: Record<string, unknown>;
}

export function replacementReadClient() {
  const { origin, key } = readCredentials();
  async function responseFor(path: string, openApi = false) {
    assert(path.startsWith('/rest/v1/') || path.startsWith('/storage/v1/'));
    const headers: Record<string, string> = { apikey: key, Accept: openApi ? 'application/openapi+json' : 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    return fetch(origin + path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  }
  async function get(path: string, openApi = false): Promise<unknown> {
    const response = await responseFor(path, openApi);
    if (!response.ok) throw new Error(`REPLACEMENT_READ_HTTP_${response.status}:${path.split('?')[0]}`);
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength < 10 * 1024 * 1024, 'REPLACEMENT_READ_TOO_LARGE');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function objectAbsent(path: string) {
    assert.match(path, /^generated\/[a-f0-9]{64}\/route\.(gpx|geojson)$/);
    const response = await responseFor(`/storage/v1/object/info/public/route-gpx/${path}`);
    if (response.ok) return false;
    const body = await response.json().catch(() => null) as { statusCode?: string | number; message?: string } | null;
    if (response.status === 404 || response.status === 400 && String(body?.statusCode) === '404' && /not found/i.test(body?.message ?? '')) return true;
    throw new Error(`OBJECT_PROBE_FAILED:${response.status}`);
  }
  async function objectBytes(url: string) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin); assert(!parsed.search && !parsed.hash && !parsed.username && !parsed.password);
    assert.match(parsed.pathname, /^\/storage\/v1\/object\/public\/route-gpx\/generated\/[a-f0-9]{64}\/route\.(gpx|geojson)$/);
    const response = await responseFor(parsed.pathname);
    assert(response.ok, `OBJECT_DELIVERY_HTTP_${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); assert(bytes.byteLength <= 10 * 1024 * 1024);
    return { bytes, mime: response.headers.get('content-type')?.split(';')[0].trim() };
  }
  return { origin, get, objectAbsent, objectBytes };
}

export async function inspectReplacement(): Promise<ReplacementSnapshot> {
  const { origin, get } = replacementReadClient();
  const reads = await Promise.allSettled([
    get('/rest/v1/', true), get('/storage/v1/bucket/route-gpx'),
    get(`/rest/v1/mountains?select=id,osm_id,name,latitude,longitude&id=in.(${ALL_IDS})&limit=100`),
    get(`/rest/v1/mountain_routes?select=*&mountain_id=in.(${ALL_IDS})&order=id.asc&limit=1000`),
    get(`/rest/v1/generated_route_publication_provenance?select=*&mountain_id=in.(${ALL_IDS})&order=mountain_id.asc&limit=1000`),
  ]);
  const values = reads.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
  const api = values[0] as { paths: Record<string, unknown>; definitions: Record<string, unknown> };
  const provenance = values[4] as JsonRow[];
  assert(provenance.length < 1000 && (values[3] as unknown[]).length < 1000, 'TRUNCATED_PREFLIGHT');
  const ids = provenance.map(p => p.publication_id);
  assert(ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)));
  const approvals = ids.length ? await get(`/rest/v1/generated_route_publication_approvals?select=*&publication_id=in.(${ids})&limit=1000`) as JsonRow[] : [];
  return { inspectedAt: new Date().toISOString(), origin, bucket: values[1] as JsonRow,
    mountains: values[2] as JsonRow[], routes: values[3] as JsonRow[], provenance, approvals,
    contractPaths: Object.keys(api.paths).filter(p => /generated|replac/i.test(p)).sort(),
    definitions: Object.fromEntries(Object.entries(api.definitions).filter(([k]) => /generated|mountain_routes|replac/i.test(k))) };
}

export function validateOldSnapshot(snapshot: ReplacementSnapshot, canary: CanaryManifest) {
  assert.deepEqual(canary.entries.map(e => e.request.mountainRoute.mountain_id).sort((a, b) => a - b), ALL_IDS);
  for (const id of ALL_IDS) {
    const mountain = snapshot.mountains.filter(m => m.id === id);
    const routes = snapshot.routes.filter(r => r.mountain_id === id && r.is_verified === true);
    const provenance = snapshot.provenance.filter(p => p.mountain_id === id);
    assert.equal(mountain.length, 1, `MOUNTAIN_COUNT:${id}`);
    assert.equal(routes.length, 1, `VERIFIED_ROUTE_COUNT:${id}`);
    assert.equal(provenance.length, 1, `PROVENANCE_COUNT:${id}`);
    const route = routes[0], p = provenance[0];
    const expected = canary.entries.find(e => e.request.mountainRoute.mountain_id === id)!;
    assert.equal(p.mountain_route_id, route.id, `ROW_BINDING:${id}`);
    assert.equal(p.publication_status, 'ACTIVE');
    assert.equal(p.publication_id, expected.request.publicationId);
    assert.equal(p.request_hash, expected.requestHash);
    assert.equal(p.publication_idempotency_key, expected.request.publicationIdempotencyKey);
    assert.equal(p.generated_route_identity, expected.request.provenance.generatedRouteIdentity);
    assert.equal(p.dataset_fingerprint, expected.request.provenance.datasetFingerprint);
    assert.equal(p.publication_contract_version, expected.request.contract);
    assert.equal(stableJson(p.canonical_request), stableJson(expected.request), `OLD_CANONICAL_REQUEST:${id}`);
    const approval = snapshot.approvals.filter(a => a.publication_id === p.publication_id);
    assert.equal(approval.length, 1); assert.equal(approval[0].request_hash, p.request_hash);
    for (const [field, value] of Object.entries(expected.request.mountainRoute)) {
      if (field === 'distance_km') {
        assert(route[field] !== null && Number.isFinite(Number(route[field])));
        assert.equal(Math.round(Number(route[field]) * 100), Math.round(Number(value) * 100), `DISTANCE:${id}`);
      } else assert.equal(stableJson(route[field]), stableJson(value), `OLD_FIELD:${id}:${field}`);
    }
    assert.equal(Number(mountain[0].osm_id), expected.request.provenance.summit.osmId);
    const [lon, lat] = expected.request.provenance.summit.coordinate;
    assert(Math.abs(Number(mountain[0].longitude) - lon) < 0.00005 && Math.abs(Number(mountain[0].latitude) - lat) < 0.00005);
  }
  assert.equal(Math.round(Number(snapshot.routes.find(r => r.mountain_id === KEEP_ID && r.is_verified)?.distance_km) * 100), 744, 'KEEP_50473_DISTANCE_CHANGED');
}

export function keepProof(snapshot: ReplacementSnapshot) {
  return { routes: snapshot.routes.filter(r => r.mountain_id === KEEP_ID), provenance: snapshot.provenance.filter(p => p.mountain_id === KEEP_ID) };
}
