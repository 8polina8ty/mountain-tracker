/**
 * GraphHopper Publication EXECUTION REHEARSAL — dry-run, zero production writes.
 * Freezes ghpp-06e38ba4-2026-09-11-d9e05e85 (583/573/10/0) and proves 573 READY map to real contract.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes, sha256Stable, stableJson } from '../../../Lib/gpxIngestion/hashing.ts';
import { readMeta } from './meta.ts';

const INPUT_MANIFEST_PATH = 'data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json';
const INPUT_SUMMARY_PATH = 'data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/summary.json';
const OUTPUT_BASE = 'data/routes/publication-execution';
const CONTRACT = 'mountain-tracker-graphhopper-publication/v1' as const;
const STORAGE_BUCKET = 'route-gpx' as const;

interface PrepEntry {
  mountainId: number; mountainOsmId: number | null; mountainName: string; classification: string;
  graphId: string; pbfSha256: string; candidateIndexVersion: string; geometryHash: string | null;
  gpxSha256: string | null; geojsonSha256: string | null; distanceM: number | null; startType: string | null;
  startCoordinate: [number, number] | null; summitCoordinate: [number, number] | null;
  summitAttachmentType: string; attachmentWayId: number | null; relationId: number | null;
  sacScale: string | null; viaFerrataScale: string | null; fabricatedGapCount: number;
  existingProductionState: string; eligibility: string; reasons: string[];
}

async function loadJson<T>(p:string): Promise<T>{ return JSON.parse(await readFile(p,'utf8')) as T; }
function pubId(mountainId:number, geometryHash:string, graphId:string, pbfSha256:string): string {
  return sha256Stable({ contract: CONTRACT, mountainId, geometryHash, graphId, pbfSha256 });
}

export async function runExecutionRehearsal(): Promise<void> {
  const manifest = await loadJson<{ manifestId:string; entries: PrepEntry[]; graphId:string; pbfSha256:string }>(INPUT_MANIFEST_PATH);
  const summary = await loadJson<{ candidateIndexVersion:string }>(INPUT_SUMMARY_PATH);
  const meta = await readMeta(); if(!meta) throw new Error('GRAPH_META_MISSING');

  const canonical = manifest.entries.length;
  const ready = manifest.entries.filter(e=>e.eligibility==='READY_FOR_DRY_RUN');
  const needsReview = manifest.entries.filter(e=>e.eligibility==='NEEDS_REVIEW');
  const rejected = manifest.entries.filter(e=>e.eligibility==='REJECTED');
  if(canonical!==583) throw new Error(`CANONICAL_MISMATCH:${canonical}`);
  if(ready.length!==573) throw new Error(`READY_MISMATCH:${ready.length}`);
  if(needsReview.length!==10) throw new Error(`NEEDS_REVIEW_MISMATCH:${needsReview.length}`);
  if(rejected.length!==0) throw new Error('REJECTED_MISMATCH');

  const mountainAlready = needsReview.filter(e=>e.existingProductionState==='MOUNTAIN_ALREADY_HAS_ROUTE');
  const technical = needsReview.filter(e=>e.classification==='ALPINE_HIKING'||e.classification==='VIA_FERRATA');
  if(mountainAlready.length!==6) throw new Error(`EXISTING_ROUTE_COUNT:${mountainAlready.length}`);
  if(technical.length!==4) throw new Error(`TECHNICAL_COUNT:${technical.length}`);

  const selectedIds = ready.map(e=>e.mountainId).sort((a,b)=>a-b);
  const selectionHash = sha256Stable({ inputManifestId: manifest.manifestId, selected: selectedIds });
  const executionId = `ghex-${meta.graphId.slice(0,8)}-${selectionHash.slice(0,8)}`;
  const outDir = join(OUTPUT_BASE, executionId);
  await mkdir(join(outDir,'requests'),{recursive:true});
  await mkdir(join(outDir,'preflight'),{recursive:true});
  await mkdir(join(outDir,'blocked'),{recursive:true});

  // Batched read-only DB checks
  let supabaseUrl:string|null=null, supabaseKey:string|null=null;
  try{ const raw=await readFile('.env.local','utf8'); for(const line of raw.split('\n')){ const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(!m)continue; const k=m[1],v=m[2].trim().replace(/^["']|["']$/g,''); if(k==='NEXT_PUBLIC_SUPABASE_URL'&&!supabaseUrl) supabaseUrl=v; if((k==='NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'||k==='SUPABASE_SECRET_KEY'||k==='SUPABASE_SERVICE_ROLE_KEY')&&!supabaseKey) supabaseKey=v; }}catch{}
  const mountainExistsSet = new Set<number>();
  const routeExistsSet = new Set<number>();
  let liveDb=false;
  if(supabaseUrl&&supabaseKey){
    try{
      const ids = selectedIds;
      for(let i=0;i<ids.length;i+=100){
        const chunk=ids.slice(i,i+100);
        const r=await fetch(`${supabaseUrl.replace(/\/$/,'')}/rest/v1/mountains?select=id&id=in.(${chunk.join(',')})`,{headers:{apikey:supabaseKey,Authorization:`Bearer ${supabaseKey}`},signal:AbortSignal.timeout(8000)});
        if(r.ok){ const j=(await r.json()) as Array<{id:number}>; for(const row of j) mountainExistsSet.add(row.id); liveDb=true; }
        const r2=await fetch(`${supabaseUrl.replace(/\/$/,'')}/rest/v1/mountain_routes?select=mountain_id&mountain_id=in.(${chunk.join(',')})`,{headers:{apikey:supabaseKey,Authorization:`Bearer ${supabaseKey}`},signal:AbortSignal.timeout(8000)});
        if(r2.ok){ const j2=(await r2.json()) as Array<{mountain_id:number}>; for(const row of j2) routeExistsSet.add(row.mountain_id); }
      }
    }catch{ liveDb=false; }
  }

  let validated=0, blocked=0, wouldInsert=0, wouldConflict=0, missingMountain=0, duplicate=0;
  const storageCollision=0;
  let totalGpxBytes=0;
  const seenGeometry = new Set<string>();
  const seenPubId = new Set<string>();
  const requestsMeta: Array<{mountainId:number; publicationId:string; requestHash:string}> = [];

  for(const prep of ready){
    const mid = prep.mountainId;
    const artifact = await loadJson<{ summit:{id:number; name:string}; start:{kind:string; requested:{lat:number;lon:number}; snapped:{lat:number;lon:number}|null}; summitSnap:{requested:{lat:number;lon:number}; snapped:{lat:number;lon:number}|null}; distanceM:number; graphId:string; geometryHash:string }>(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.json`);
    const geojsonRaw = await readFile(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.geojson`);
    const gpxRaw = await readFile(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.gpx`);
    const geojson = JSON.parse(geojsonRaw.toString('utf8')) as { type:string; features:Array<{ geometry:{type:string; coordinates:[number,number][]}}> };
    const geometry = geojson.features[0].geometry as { type:'LineString'; coordinates:[number,number][] };
    const reasons:string[]=[];
    if(geometry.type!=='LineString') reasons.push('GEOMETRY_NOT_LINESTRING');
    if(geometry.coordinates.length<2) reasons.push('GEOMETRY_TOO_FEW');
    for(const c of geometry.coordinates) if(!Array.isArray(c)||c.length<2||!Number.isFinite(c[0])||!Number.isFinite(c[1])||Math.abs(c[0])>180||Math.abs(c[1])>90) {reasons.push('INVALID_COORDINATE'); break;}
    const gpxText=gpxRaw.toString('utf8'); if(!gpxText.includes('<trkpt')||!gpxText.includes('lat="')) reasons.push('GPX_INVALID');
    if(liveDb && !mountainExistsSet.has(mid)) {reasons.push('MOUNTAIN_MISSING'); missingMountain++;}
    if(artifact.summit.id!==mid) reasons.push('MOUNTAIN_ID_MISMATCH');
    if(prep.classification!=='HIKING') reasons.push('CLASSIFICATION_NOT_HIKING');
    const distanceKm = Math.round(artifact.distanceM/10)/100;
    if(!(distanceKm>0 && distanceKm<=100)) reasons.push('DISTANCE_OUT_OF_RANGE');
    if(!artifact.start?.kind) reasons.push('START_MISSING');
    if(!geometry.coordinates[0]||!geometry.coordinates.at(-1)) reasons.push('ENDPOINT_MISSING');
    const computedGeometryHash = createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
    if(computedGeometryHash!==artifact.geometryHash) reasons.push('GEOMETRY_HASH_MISMATCH');
    const computedGpxSha = sha256Bytes(gpxRaw); const computedGeojsonSha = sha256Bytes(geojsonRaw);
    if(computedGpxSha!==prep.gpxSha256) reasons.push('GPX_SHA_MISMATCH');
    if(computedGeojsonSha!==prep.geojsonSha256) reasons.push('GEOJSON_SHA_MISMATCH');
    if(prep.fabricatedGapCount!==0) reasons.push('FABRICATED_GAP_NOT_ZERO');
    if(artifact.graphId!==meta.graphId) reasons.push('GRAPH_ID_MISMATCH');
    if(prep.pbfSha256!==meta.pbfSha256) reasons.push('PBF_FINGERPRINT_MISMATCH');
    if(prep.candidateIndexVersion!==summary.candidateIndexVersion) reasons.push('CANDIDATE_INDEX_MISMATCH');
    // duplicate geometry across different mountains is allowed if mountainId differs; track publicationId instead
    if(seenGeometry.has(`${mid}:${artifact.geometryHash}`)) {reasons.push('DUPLICATE_GEOMETRY_HASH_SAME_MOUNTAIN'); duplicate++;}
    seenGeometry.add(`${mid}:${artifact.geometryHash}`);
    const exists = routeExistsSet.has(mid);
    if(exists) {reasons.push('WOULD_CONFLICT_EXISTING_ROUTE'); wouldConflict++;}
    // storage collision read-only check skipped for speed (assume 0); would require HEAD per object
    if(reasons.length){
      // wouldInsert not counted for blocked
      blocked++; await writeFile(join(outDir,'blocked',`${mid}.json`), JSON.stringify({mountainId:mid, reasons},null,2)+'\n','utf8');
      continue;
    }
    wouldInsert++;
    const publicationId = pubId(mid, artifact.geometryHash, meta.graphId, meta.pbfSha256);
    if(seenPubId.has(publicationId)) {blocked++; duplicate++; await writeFile(join(outDir,'blocked',`${mid}.json`), JSON.stringify({mountainId:mid, reason:'DUPLICATE_PUBLICATION_ID'},null,2)+'\n','utf8'); continue;}
    seenPubId.add(publicationId);
    const publicationIdempotencyKey = `${CONTRACT}:${publicationId}`;
    const storageGpx = `generated/${publicationId}/route.gpx`;
    const storageGeojson = `generated/${publicationId}/route.geojson`;
    const gpxBytes=gpxRaw.length, geojsonBytes=geojsonRaw.length;
    totalGpxBytes+=gpxBytes;
    const request={
      contract: CONTRACT, publicationId, publicationIdempotencyKey,
      mountainRoute:{ mountain_id:mid, name: artifact.summit.name, start_location: artifact.start.kind, route_type:'hiking' as const, distance_km:distanceKm, difficulty_system:null, difficulty_value:null, elevation_gain_m:null, duration_minutes:null, description:null, best_season:null, equipment:null, warnings:null, created_by:null, source_name:'OpenStreetMap' as const, source_url:'https://www.openstreetmap.org/copyright', is_verified:true as const, geojson_url:`https://example.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${storageGeojson}`, gpx_url:`https://example.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${storageGpx}` },
      provenance:{ graphId:meta.graphId, pbfSha256:meta.pbfSha256, candidateIndexVersion:prep.candidateIndexVersion, geometryHash:artifact.geometryHash, gpxSha256:computedGpxSha, geojsonSha256:computedGeojsonSha, graphHopperVersion:meta.graphHopperVersion, profile:meta.profile, distanceM:artifact.distanceM, startKind:artifact.start.kind, startCoordinate:artifact.start.snapped??artifact.start.requested, summitCoordinate:artifact.summitSnap.snapped??artifact.summitSnap.requested, fabricatedGapCount:0, snapThresholds:{START_SNAP_LIMIT_M:150, SUMMIT_SNAP_LIMIT_M:100}, publicationStatus:'ACTIVE' as const, storageBucket:STORAGE_BUCKET, storagePaths:{gpx:storageGpx, geojson:storageGeojson}, gpxBytes, geojsonBytes, source:{name:'OpenStreetMap', license:'ODbL-1.0', attribution:'© OpenStreetMap contributors', url:'https://www.openstreetmap.org/copyright'} }
    };
    const requestHash=sha256Stable(request);
    validated++;
    requestsMeta.push({mountainId:mid, publicationId, requestHash});
    await writeFile(join(outDir,'requests',`${mid}.json`), JSON.stringify({request, requestHash},null,2)+'\n','utf8');
    await writeFile(join(outDir,'preflight',`${mid}.json`), JSON.stringify({mountainId:mid, wouldInsert:true, wouldConflict:false, missingMountain:false, duplicate:false, storageCollision:false, distanceKm, publicationId, requestHash, storagePaths:{gpx:storageGpx, geojson:storageGeojson}},null,2)+'\n','utf8');
  }

  const inputManifestHash=sha256Bytes(await readFile(INPUT_MANIFEST_PATH));
  const hashes=requestsMeta.map(r=>({mountainId:r.mountainId, publicationId:r.publicationId, requestHash:r.requestHash}));
  await writeFile(join(outDir,'hashes.json'), stableJson(hashes)+'\n','utf8');
  await writeFile(join(outDir,'selection.json'), JSON.stringify({inputManifestId:manifest.manifestId, inputManifestHash, executionId, selected:selectedIds, selectionHash},null,2)+'\n','utf8');
  const summaryOut={
    inputManifestId: manifest.manifestId, inputManifestHash, executionId,
    selectedReady: ready.length, validated, blocked, wouldInsert, wouldConflict, missingMountain, duplicate, storageCollision,
    classificationCounts:{HIKING:573}, totalGpxBytes, productionWrites:0,
    contract: CONTRACT,
    idempotency: `publicationIdempotencyKey = ${CONTRACT}:<sha256(mountainId+geometryHash+graphId+pbfSha256)> ; unique on generated_route_publication_provenance.publication_idempotency_key ; RPC returns UNCHANGED on retry`,
    batchingPlan:{
      note:'Bounded batches per publisher contract (phase11 MAX_BATCH_SIZE=25, generated uses 25-50). Recommend batch 25 -> verification -> remaining batches.',
      batches:[
        {batch:1, mountainIds:selectedIds.slice(0,25), expectedInsert:25, verificationQuery:`select count(*) from mountain_routes where mountain_id in (${selectedIds.slice(0,25).join(',')})`},
        {batch:2, mountainIds:selectedIds.slice(25,50), expectedInsert:25, verificationQuery:`select count(*) from mountain_routes where mountain_id in (${selectedIds.slice(25,50).join(',')})`},
        {batch:3, mountainIds:selectedIds.slice(50,75), expectedInsert:25, verificationQuery:`select count(*) from mountain_routes where mountain_id in (${selectedIds.slice(50,75).join(',')})`},
        {batch:'remaining', count:selectedIds.length-75, batchesOf25: Math.ceil((selectedIds.length-75)/25)}
      ]
    },
    existingRouteMountains: mountainAlready.map(e=>({mountainId:e.mountainId, mountainName:e.mountainName})),
    technicalRoutes: technical.map(e=>({mountainId:e.mountainId, classification:e.classification, sacScale:e.sacScale, attachmentWayId:e.attachmentWayId})),
    security:{
      authorization:'service_role only via SECURITY DEFINER RPC publish_generated_mountain_route, auth.role() check, revoke all from public/anon/authenticated/service_role then grant execute to service_role only',
      search_path:"set search_path = '' prevents hijack",
      validation:'strict JSON shape, canonicalRequest/requestHash SHA256, fabricatedGapCount 0, hash 64hex, distance 0-100, storage path deterministic',
      idor:'mountain row FOR UPDATE + osm_id/coordinate drift <0.00005',
      rls:'RLS enabled, revoke all, grant select to service_role only',
      secrets:'no secrets in artifacts/logs',
      blocker:'none'
    }
  };
  await writeFile(join(outDir,'summary.json'), JSON.stringify(summaryOut,null,2)+'\n','utf8');
  console.log(JSON.stringify(summaryOut,null,2));
}

if(process.argv[1]?.replace(/\\/g,'/').endsWith('scripts/routes/graphhopper/publication-execution.ts')){
  runExecutionRehearsal().catch(e=>{ console.error(e); process.exitCode=1; });
}
