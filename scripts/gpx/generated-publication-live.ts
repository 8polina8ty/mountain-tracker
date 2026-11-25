/** Bounded GET-only production inspection. No SQL, RPC calls, or Storage mutations. */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

export interface MountainRow { id: number; osm_id: number; name: string | null; latitude: number; longitude: number }
export interface ExistingRoute { id: number; mountain_id: number; name: string; start_location: string | null; geojson_url: string | null; gpx_url: string | null; source_name: string | null; source_url: string | null; is_verified: boolean }
export interface LiveSnapshot {
  inspectedAt: string;
  origin: string;
  mountainSchema: Record<string, unknown>;
  routeSchema: { properties: Record<string, { type: string; format?: string }>; required: string[] };
  bucket: { id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null };
  generatedTableAvailable: boolean;
  generatedRpcAvailable: boolean;
  generatedApprovalTableAvailable: boolean;
  approvalCount: number;
  provenanceCount: number;
  phase11PublicationPaths: string[];
  mountains: MountainRow[];
  routes: ExistingRoute[];
  anonymousRoutes: ExistingRoute[];
  publications: Array<{ publication_idempotency_key: string; request_hash: string; publication_status: string; mountain_route_id: number }>;
  approvals?: Array<{ publication_id: string; request_hash: string; manifest_hash: string }>;
}

export function readCredentials() {
  if (existsSync('.env.local')) loadEnvFile('.env.local');
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!origin) throw new Error('SUPABASE_URL_MISSING');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY_MISSING');
  if (!publicKey) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_MISSING');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('INVALID_SUPABASE_ORIGIN');
  return { origin: parsed.origin, key, publicKey };
}

export async function inspectDeployment(osmIds: number[]): Promise<LiveSnapshot> {
  const { origin, key, publicKey } = readCredentials();
  async function get(path: string, anonymous = false, openApi = false) {
    const credential = anonymous ? publicKey : key;
    const headers: Record<string, string> = { apikey: credential, Accept: openApi ? 'application/openapi+json' : 'application/json' };
    if (credential.startsWith('eyJ')) headers.Authorization = `Bearer ${credential}`;
    const response = await fetch(`${origin}${path}`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if (response.status === 503 && !openApi) {
        const body = await response.json().catch(() => null);
        if (body && /reload|retry|schema/i.test(JSON.stringify(body))) throw new Error(`POSTGREST_SCHEMA_CACHE_RELOADING:${path.split('?')[0]}`);
      }
      throw new Error(`READ_ONLY_HTTP_${response.status}:${path.split('?')[0]}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('READ_ONLY_RESPONSE_TOO_LARGE');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // Exact total row count via PostgREST HEAD + count=exact. Bounded: never materializes rows.
  async function count(path: string) {
    const headers: Record<string, string> = { apikey: key, Accept: 'application/json', Prefer: 'count=exact', 'Range-Unit': 'items' };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(`${origin}${path}`, { method: 'HEAD', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if (response.status === 503) {
        const body = await response.json().catch(() => null);
        if (body && /reload|retry|schema/i.test(JSON.stringify(body))) throw new Error(`POSTGREST_SCHEMA_CACHE_RELOADING:${path.split('?')[0]}`);
      }
      throw new Error(`READ_ONLY_HTTP_${response.status}:${path.split('?')[0]}`);
    }
    const range = response.headers.get('content-range') ?? '';
    const total = Number(range.slice(range.lastIndexOf('/') + 1));
    if (!Number.isInteger(total) || total < 0) throw new Error('POSTGREST_COUNT_HEADER_UNPARSEABLE');
    return total;
  }
  async function settledReads(reads: Promise<unknown>[]) {
    const results = await Promise.allSettled(reads);
    const failure = results.find(r=>r.status==='rejected');
    if (failure?.status==='rejected') throw failure.reason;
    return results.map(r=>r.status==='fulfilled' ? r.value : undefined);
  }
  const [apiValue, bucketValue, mountainValue] = await settledReads([
    get('/rest/v1/', false, true), get('/storage/v1/bucket/route-gpx'),
    get(`/rest/v1/mountains?select=id,osm_id,name,latitude,longitude&osm_id=in.(${[...new Set(osmIds)].sort((a,b)=>a-b).join(',')})&order=id.asc&limit=1000`),
  ]);
  const api=apiValue as { definitions: Record<string, unknown>; paths: Record<string, unknown> };
  const bucket=bucketValue as LiveSnapshot['bucket'];
  const mountains=mountainValue as MountainRow[];
  if (mountains.length >= 1000) throw new Error('MOUNTAIN_INSPECTION_TRUNCATED');
  const ids = mountains.map((m: MountainRow) => m.id);
  const filter = ids.length ? `&mountain_id=in.(${ids.join(',')})` : '&id=eq.-1';
  const path = `/rest/v1/mountain_routes?select=id,mountain_id,name,start_location,geojson_url,gpx_url,source_name,source_url,is_verified${filter}&order=id.asc&limit=1000`;
  const generatedTableAvailable = Boolean(api.definitions?.generated_route_publication_provenance);
  const generatedApprovalTableAvailable = Boolean(api.definitions?.generated_route_publication_approvals);
  const [routeValue, anonymousValue, publicationValue, approvalValue, approvalCountValue, provenanceCountValue] = await settledReads([
    get(path), get(`${path}&is_verified=eq.true`, true),
    generatedTableAvailable ? get(`/rest/v1/generated_route_publication_provenance?select=publication_idempotency_key,request_hash,publication_status,mountain_route_id${filter}&limit=1000`) : Promise.resolve([]),
    generatedApprovalTableAvailable ? get('/rest/v1/generated_route_publication_approvals?select=publication_id,request_hash,manifest_hash&limit=1000') : Promise.resolve([]),
    generatedApprovalTableAvailable ? count('/rest/v1/generated_route_publication_approvals?select=publication_id&limit=1') : Promise.resolve(0),
    generatedTableAvailable ? count('/rest/v1/generated_route_publication_provenance?select=mountain_route_id&limit=1') : Promise.resolve(0),
  ]);
  const routes=routeValue as ExistingRoute[], anonymousRoutes=anonymousValue as ExistingRoute[];
  const publications=publicationValue as LiveSnapshot['publications'], approvals=approvalValue as NonNullable<LiveSnapshot['approvals']>;
  const approvalCount=approvalCountValue as number, provenanceCount=provenanceCountValue as number;
  if ([routes, anonymousRoutes, publications, approvals].some(rows => rows.length >= 1000)) throw new Error('PUBLICATION_INSPECTION_TRUNCATED');
  return { inspectedAt: new Date().toISOString(), origin, mountainSchema: api.definitions.mountains as LiveSnapshot['mountainSchema'],
    routeSchema: api.definitions.mountain_routes as LiveSnapshot['routeSchema'], bucket: { id: bucket.id, public: bucket.public,
      file_size_limit: bucket.file_size_limit, allowed_mime_types: bucket.allowed_mime_types },
    generatedTableAvailable, generatedRpcAvailable: Boolean(api.paths?.['/rpc/publish_generated_mountain_route']),
    generatedApprovalTableAvailable, approvalCount, provenanceCount,
    phase11PublicationPaths: Object.keys(api.paths ?? {}).filter(p => /osm_route_publication|publish_approved_osm_route/.test(p)).sort(),
    mountains, routes, anonymousRoutes, publications, approvals };
}
