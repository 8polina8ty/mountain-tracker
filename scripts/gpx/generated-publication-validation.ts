import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { assertInsideFrozenWindow, checkObjectSize, existingPublicationAction, GENERATED_PUBLICATION_CONTRACT, MIME, obviousDuplicate, preparePublication, validateRequest, type CanaryManifest, type Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { evidenceFor, fileHash, FrozenPathReader, loadFrozen, OUTPUT, readJson } from './generated-publication-frozen.ts';
import type { LiveSnapshot } from './generated-publication-live.ts';

export const LOCKED_MANIFEST_HASH = 'eddd87e777223a452b5671404327cc835e3babbd9fbe9c9357897c6b023d2c55';
export const MANIFEST_PATH = `${OUTPUT}/generated-route-canary-v1.json`;

export async function verifyLocalCanary(path = MANIFEST_PATH): Promise<CanaryManifest> {
  assert.equal(path, MANIFEST_PATH, 'ONLY_LOCKED_CANARY_SUPPORTED');
  const manifest = await readJson<CanaryManifest>(path);
  assert.equal(sha256Stable(manifest),LOCKED_MANIFEST_HASH,'LOCKED_MANIFEST_DRIFT');
  assert.equal((await readFile(`${OUTPUT}/generated-route-canary-v1.sha256`,'utf8')).trim(),LOCKED_MANIFEST_HASH);
  assert.equal(await readFile(path,'utf8'),stableJson(manifest),'NON_CANONICAL_MANIFEST');
  assert.equal(manifest.contract,GENERATED_PUBLICATION_CONTRACT); assert.equal(manifest.mode,'DRY_RUN_ONLY');
  assert.equal(manifest.entries.length,10);
  assert.equal(new Set(manifest.entries.map(e=>e.request.mountainRoute.mountain_id)).size,10);
  assert.equal(new Set(manifest.entries.map(e=>e.request.publicationId)).size,10);
  for (const [source,hash] of Object.entries(manifest.sourceArtifacts)) {
    assert(/^(?:data\/|Lib\/|scripts\/)[a-zA-Z0-9_./-]+$/.test(source) && !source.split('/').includes('..'),'INVALID_SOURCE_PATH');
    assert.equal(await fileHash(source),hash,`SOURCE_ARTIFACT_DRIFT:${source}`);
  }
  const frozen = await loadFrozen(), reader = new FrozenPathReader(frozen.corpus), geometries:Line[]=[];
  assert.deepEqual(manifest.checkpoint,frozen.checkpoint);
  try {
    for (const entry of manifest.entries) {
      const r=entry.request; validateRequest(r); assert.equal(sha256Stable(r),entry.requestHash);
      const row=frozen.rows.find(x=>x.mountainId===r.provenance.sourceMountainIdentity); assert(row);
      const c=row.candidates.find(x=>x.id===r.provenance.start.candidateId); assert(c,'CANDIDATE_NOT_IN_FROZEN_AUTO_POOL');
      const geometry=reader.materialize(c), evidence=evidenceFor(frozen,reader,row,c);
      const block=frozen.corpus.blocks.find(b=>b.blockId===row.blockId); assert(block);
      assertInsideFrozenWindow(geometry,block.bbox);
      const expected=preparePublication(r.mountainRoute.mountain_id,new URL(r.mountainRoute.geojson_url).origin,geometry,evidence);
      assert.deepEqual(entry,expected.entry,'FROZEN_PUBLICATION_MAPPING_DRIFT');
      for (const other of geometries) assert(!obviousDuplicate(other,geometry),'CANARY_DUPLICATE');
      geometries.push(geometry);
      for (const kind of ['gpx','geojson'] as const) {
        assert.equal(entry.files[kind].path,`preview/${r.publicationId}/route.${kind}`,'LOCAL_PATH_TRAVERSAL');
        const bytes=await readFile(`${OUTPUT}/${entry.files[kind].path}`);
        assert.equal(bytes.toString('utf8'),expected[kind],'SERIALIZED_BYTE_DRIFT');
        assert.equal(bytes.length,entry.files[kind].bytes); assert.equal(sha256Bytes(bytes),entry.files[kind].sha256);
        assert.equal(entry.files[kind].contentType,MIME[kind]); checkObjectSize(bytes.length);
      }
    }
  } finally { reader.close(); }
  return manifest;
}

export function deploymentBlockers(manifest: CanaryManifest, live: LiveSnapshot, options: { allowResume?: boolean } = {}): string[] {
  const blockers:string[]=[];
  if (!live.generatedTableAvailable) blockers.push('GENERATED_PROVENANCE_TABLE_MISSING');
  if (!live.generatedRpcAvailable) blockers.push('GENERATED_PUBLICATION_RPC_MISSING');
  if (live.generatedApprovalTableAvailable === false) blockers.push('GENERATED_APPROVAL_TABLE_MISSING');
  if (live.bucket.id!=='route-gpx' || !live.bucket.public) blockers.push('STORAGE_BUCKET_MISMATCH');
  for (const kind of ['gpx','geojson'] as const) if (live.bucket.allowed_mime_types && !live.bucket.allowed_mime_types.includes(MIME[kind])) blockers.push(`STORAGE_${kind.toUpperCase()}_MIME_BLOCKED`);
  const approvals = live.approvals ?? [];
  const approvalCount = Number.isInteger(live.approvalCount) ? live.approvalCount : approvals.length;
  if (live.generatedApprovalTableAvailable !== false && approvalCount !== manifest.entries.length) blockers.push(`APPROVAL_COUNT_MISMATCH:${approvalCount}`);
  for (const approval of approvals) if (approval.manifest_hash !== LOCKED_MANIFEST_HASH) blockers.push(`APPROVAL_MANIFEST_HASH_MISMATCH:${approval.publication_id}`);
  if (!Number.isInteger(live.provenanceCount)) blockers.push('PROVENANCE_COUNT_UNVERIFIED');
  else if (!(options.allowResume ?? false) && live.provenanceCount !== 0) blockers.push(`PROVENANCE_COUNT_MISMATCH:${live.provenanceCount}`);
  const expectedKeys = new Set(manifest.entries.map((entry) => entry.request.publicationIdempotencyKey));
  for (const publication of live.publications) {
    if (!expectedKeys.has(publication.publication_idempotency_key)) blockers.push(`UNEXPECTED_GENERATED_PUBLICATION:${publication.publication_idempotency_key}`);
  }
  for (const entry of manifest.entries) {
    const r=entry.request,m=r.mountainRoute;
    if (live.generatedApprovalTableAvailable !== false && !approvals.some(a=>a.publication_id===r.publicationId && a.request_hash===entry.requestHash && a.manifest_hash===LOCKED_MANIFEST_HASH)) blockers.push(`EXACT_REQUEST_APPROVAL_MISSING:${r.publicationId}`);
    for (const field of Object.keys(m)) if (!live.routeSchema.properties[field]) blockers.push(`MOUNTAIN_ROUTE_COLUMN_MISSING:${field}`);
    if (new URL(m.geojson_url).origin!==live.origin) blockers.push('DEPLOYMENT_ORIGIN_DRIFT');
    const matches=live.mountains.filter(x=>x.id===m.mountain_id && x.osm_id===r.provenance.summit.osmId && Math.abs(x.latitude-r.provenance.summit.coordinate[1])<=0.00005 && Math.abs(x.longitude-r.provenance.summit.coordinate[0])<=0.00005);
    if (matches.length!==1) blockers.push(`MOUNTAIN_IDENTITY_DRIFT:${m.mountain_id}`);
    for (const kind of ['gpx','geojson'] as const) try { checkObjectSize(entry.files[kind].bytes,live.bucket.file_size_limit); } catch { blockers.push(`STORAGE_SIZE_CEILING:${r.publicationId}:${kind}`); }
    const existing=live.publications.find(p=>p.publication_idempotency_key===r.publicationIdempotencyKey);
    try { existingPublicationAction(r,existing); } catch { blockers.push(`PUBLICATION_IDENTITY_DRIFT:${r.publicationId}`); }
    for (const route of live.routes.filter(x=>x.mountain_id===m.mountain_id && x.is_verified)) {
      if (!existing || existing.mountain_route_id!==route.id) blockers.push(`EXISTING_ROUTE_COLLISION:${m.mountain_id}:${route.id}`);
    }
    if (existing) {
      const route=live.routes.find(x=>x.id===existing.mountain_route_id);
      const visible=live.anonymousRoutes.find(x=>x.id===existing.mountain_route_id);
      if (!route || !visible || !route.is_verified || route.mountain_id!==m.mountain_id || route.name!==m.name || route.gpx_url!==m.gpx_url || route.geojson_url!==m.geojson_url) blockers.push(`EXISTING_ROUTE_OR_PUBLIC_VISIBILITY_DRIFT:${r.publicationId}`);
    }
  }
  return [...new Set(blockers)].sort();
}

export async function inspectPublicObjects(manifest: CanaryManifest): Promise<Array<{ publicationId:string; kind:'gpx'|'geojson'; status:'ABSENT'|'MATCH'|'BLOCKED'; reason?:string }>> {
  const results:Array<{ publicationId:string; kind:'gpx'|'geojson'; status:'ABSENT'|'MATCH'|'BLOCKED'; reason?:string }>=[];
  // Fixed upper bound: 20 GETs, 20 seconds and 10 MiB per object, no retries/redirects.
  for (const entry of manifest.entries) for (const kind of ['gpx','geojson'] as const) {
    const base={publicationId:entry.request.publicationId,kind};
    try {
      const response=await fetch(entry.request.mountainRoute[`${kind}_url`],{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000)});
      if (response.status===404 || response.status===400) {
        const error=await response.json().catch(()=>null);
        if (error && (String(error.statusCode)==='404' || error.code==='NoSuchKey') && /not found|does not exist/i.test(String(error.message ?? error.error))) { results.push({...base,status:'ABSENT'}); continue; }
        results.push({...base,status:'BLOCKED',reason:`UNCONFIRMED_ABSENCE_HTTP_${response.status}`}); continue;
      }
      if (!response.ok || response.headers.get('content-type')?.split(';')[0]!==MIME[kind]) { await response.body?.cancel(); results.push({...base,status:'BLOCKED',reason:'OBJECT_HTTP_OR_MIME_MISMATCH'}); continue; }
      const stream=response.body?.getReader(); assert(stream);
      const chunks:Uint8Array[]=[]; let size=0;
      while (true) { const next=await stream.read(); if(next.done)break; size+=next.value.length; if(size>entry.files[kind].bytes){await stream.cancel();throw new Error('OBJECT_SIZE_MISMATCH');} chunks.push(next.value); }
      assert.equal(size,entry.files[kind].bytes); assert.equal(sha256Bytes(Buffer.concat(chunks)),entry.files[kind].sha256);
      results.push({...base,status:'MATCH'});
    } catch { results.push({...base,status:'BLOCKED',reason:'OBJECT_READ_OR_HASH_FAILED'}); }
  }
  return results;
}
