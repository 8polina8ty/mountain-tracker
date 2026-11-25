import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { ALL_IDS, KEEP_ID, REPLACEMENT_IDS, keepProof, validateOldSnapshot, type ReplacementSnapshot } from './generated-replacement-live.ts';
import { CANARY_PATH, REPLACEMENT_MANIFEST, REPLACEMENT_OUTPUT, buildReplacementPlan, validateReplacementManifest, verifyReplacementFiles, type ReplacementManifest } from './generated-replacement-plan.ts';
import { LOCKED_REPLACEMENT_HASH, requirePreparationMode } from './generated-replacement-lock.ts';

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const manifest = read<ReplacementManifest>(REPLACEMENT_MANIFEST);
const snapshot = read<ReplacementSnapshot>(`${REPLACEMENT_OUTPUT}/production-preflight.json`);
const canary = read<CanaryManifest>(CANARY_PATH);

test('locked manifest is exactly the nine human approvals and contains no keep target', async () => {
  assert.equal(sha256Bytes(readFileSync(REPLACEMENT_MANIFEST)), LOCKED_REPLACEMENT_HASH);
  assert.equal(readFileSync(`${REPLACEMENT_MANIFEST}.sha256`, 'utf8').trim(), LOCKED_REPLACEMENT_HASH);
  validateReplacementManifest(manifest); await verifyReplacementFiles(manifest);
  assert.deepEqual(manifest.entries.map(e => e.request.mountainId), [...REPLACEMENT_IDS]);
  assert(!manifest.entries.some(e => e.request.mountainId === KEEP_ID));
});

test('frozen directed OSM path and exact GPX validation reproduce the manifest without route search', async () => {
  const rebuilt = await buildReplacementPlan(snapshot);
  assert.equal(sha256Bytes(Buffer.from(rebuilt.manifestBytes)), LOCKED_REPLACEMENT_HASH);
  assert.equal(rebuilt.localObjects.length, 9);
  for (const object of rebuilt.localObjects) assert.equal(object.bytes, readFileSync(object.path, 'utf8'));
});

test('human approvals authorize formerly machine-reviewed routes without modifying historical review', () => {
  const review = read<{ rows: { mountainId: number; productStatus: string }[] }>('data/gpx/base-access-start-v2/final-review.json');
  const formerlyReview = manifest.entries.filter(e => review.rows.find(r => r.mountainId === e.request.mountainId)?.productStatus === 'NEEDS_REVIEW');
  assert.equal(formerlyReview.length, 6);
  for (const e of formerlyReview) assert.equal(e.request.humanApproval, 'APPROVE_NEW_V2');
});

for (const mutate of ['keep', 'missing', 'duplicate', 'other'] as const) test(`scope mutation rejected: ${mutate}`, () => {
  const m = structuredClone(manifest);
  if (mutate === 'keep') m.entries[0].request.mountainId = KEEP_ID;
  if (mutate === 'other') m.entries[0].request.mountainId = 999;
  if (mutate === 'missing') m.entries.pop();
  if (mutate === 'duplicate') m.entries[1] = structuredClone(m.entries[0]);
  assert.throws(() => validateReplacementManifest(m));
});

for (const field of ['id', 'distance_km', 'gpx_url', 'geojson_url', 'is_verified', 'name'] as const) test(`preflight rejects keep row drift: ${field}`, () => {
  const s = structuredClone(snapshot), r = s.routes.find(r => r.mountain_id === KEEP_ID)!;
  r[field] = field === 'distance_km' ? 7.45 : field === 'id' ? 1000 : field === 'is_verified' ? false : 'changed';
  assert.throws(() => validateOldSnapshot(s, canary));
});
for (const id of ALL_IDS) test(`exact live route/provenance identity required for mountain ${id}`, () => {
  const s = structuredClone(snapshot); s.provenance.find(p => p.mountain_id === id)!.request_hash = 'a'.repeat(64);
  assert.throws(() => validateOldSnapshot(s, canary));
});

test('extra verified rows and cross-mountain provenance fail closed', () => {
  const s = structuredClone(snapshot); s.routes.push({ ...s.routes[0], id: 99999 });
  assert.throws(() => validateOldSnapshot(s, canary));
  const t = structuredClone(snapshot); t.provenance[0].mountain_route_id = 125;
  assert.throws(() => validateOldSnapshot(t, canary));
});
test('scale-two live values match precise canonical distances but a cent of drift is rejected', () => {
  validateOldSnapshot(snapshot, canary);
  const s = structuredClone(snapshot); s.routes[0].distance_km = Number(s.routes[0].distance_km) + 0.01;
  assert.throws(() => validateOldSnapshot(s, canary));
  for (const e of manifest.entries) assert.equal(Math.round(e.request.preciseDistanceKm * 100) / 100, e.request.productionDistanceKm);
});

test('no CLI arguments can turn preparation into an unreviewed writer', () => {
  requirePreparationMode([]); requirePreparationMode(['--dry-run']);
  assert.throws(() => requirePreparationMode(['--execute']), /EXACT_LOCKED_MANIFEST/);
  assert.throws(() => requirePreparationMode(['--execute', '--confirm-manifest', '0'.repeat(64)]), /EXACT_LOCKED_MANIFEST/);
  assert.throws(() => requirePreparationMode(['--execute', '--manifest', REPLACEMENT_MANIFEST, '--manifest-sha256', LOCKED_REPLACEMENT_HASH.slice(0, -1) + 'x']), /EXACT_LOCKED_MANIFEST/);
  assert.throws(() => requirePreparationMode(['--execute', '--manifest', REPLACEMENT_MANIFEST]), /EXACT_LOCKED_MANIFEST/);
  assert.throws(() => requirePreparationMode(['--dry-run', '--execute']));
});

test('manual approval SQL binds every request byte and the exact immutable keep snapshot', () => {
  const sql = readFileSync('database/generated_route_replacement_approval.sql', 'utf8');
  const rows = sql.split('\n').filter(l => l.startsWith("('")); assert.equal(rows.length, 9);
  const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
  for (const [index, e] of manifest.entries.entries()) {
    assert.equal(sha256Stable(e.request), e.requestHash);
    assert.equal(sha256Stable(e.request.newPublication), e.request.newPublicationRequestHash);
    const value = `(${literal(e.requestHash)},${literal(LOCKED_REPLACEMENT_HASH)},${e.request.mountainId},${e.request.expectedCurrentMountainRouteId},${literal(stableJson(e.request))},${literal(stableJson(keepProof(snapshot)))}::jsonb)`;
    assert.equal(rows[index], value + (index === 8 ? ';' : ','));
  }
  assert.match(sql, /set local standard_conforming_strings = on/);
  assert.doesNotMatch(sql, /on conflict|update public\.|delete from|select public\./i);
});

test('manual RPC has service authorization, exact allowlist, CAS, keep exclusion and atomic audit', () => {
  const sql = readFileSync('database/generated_route_replacement.sql', 'utf8');
  assert.match(sql, /security definer set search_path = ''/i);
  assert.match(sql, /auth.role\(\) is distinct from 'service_role'/);
  assert.match(sql, /a.request_hash = v_hash and a.manifest_hash = v_manifest and a.canonical_request = v_text for share/);
  assert.match(sql, /v_approval.mountain_id = 50473/);
  assert.match(sql, /KEEP_50473_CHANGED/);
  assert.match(sql, /REPLACEMENT_EXPECTED_OLD_STATE_DRIFT/);
  assert.match(sql, /jsonb_populate_record\(null::public.mountain_routes, v_request -> 'expectedOldRoute'\)/);
  assert.match(sql, /jsonb_populate_record\(null::public.generated_route_publication_provenance, v_request -> 'expectedOldProvenance'\)/);
  assert.match(sql, /where id = v_approval.mountain_route_id and mountain_id = v_approval.mountain_id and mountain_id <> 50473/);
  assert.match(sql, /p.mountain_route_id = v_current.id and p.mountain_id = v_mountain.id and p.mountain_id <> 50473/);
  assert.match(sql, /v_audit.new_route is distinct from to_jsonb\(v_current\)/);
  assert.match(sql, /v_audit.new_provenance is distinct from to_jsonb\(v_provenance\)/);
  assert.match(sql, /REPLACEMENT_STORAGE_METADATA_MISMATCH/);
  assert.match(sql, /round\(\(v_route ->> 'distance_km'\)::numeric,2\)/);
  assert(sql.indexOf("'UNCHANGED'::text") < sql.indexOf('update public.mountain_routes'));
  assert(sql.indexOf('update public.mountain_routes') < sql.indexOf('insert into public.generated_route_replacement_audit'));
  assert.doesNotMatch(sql, /\bdelete\s+from|\btruncate\s|insert into public.mountain_routes|update storage\.|insert into storage\./i);
  for (const table of ['approvals', 'audit']) {
    assert(sql.includes(`alter table public.generated_route_replacement_${table} enable row level security`));
    assert(sql.includes(`revoke all on public.generated_route_replacement_${table} from public, anon, authenticated, service_role`));
    assert(sql.includes(`grant select on public.generated_route_replacement_${table} to service_role`));
  }
  assert.match(sql, /revoke all on function public.replace_approved_generated_mountain_route\(jsonb\) from public, anon, authenticated, service_role/);
});

test('GET-only dry run cannot call a write transport or import the old executor', () => {
  for (const path of ['generated-replacement-live.ts', 'dry-run-generated-replacement.ts']) {
    const source = readFileSync(`scripts/gpx/${path}`, 'utf8');
    assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)|\.rpc\(|\.upload\(|\.upsert\(|generated-publication-execute/);
  }
});
