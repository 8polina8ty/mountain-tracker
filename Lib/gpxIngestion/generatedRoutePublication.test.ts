import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sax from 'sax';
import { assertInsideFrozenWindow, candidateEligible, checkObjectSize, compensationTargets, existingPublicationAction, MAX_PUBLICATION_BYTES, MIME,
  obviousDuplicate, preparePublication, publicationIdentity, serializeGeojson, serializeGpx, storagePath, validateRequest,
  type CanaryManifest, type FrozenRow, type Line, type PublicationRequest } from './generatedRoutePublication.ts';
import { sha256Bytes, sha256Stable, stableJson } from './hashing.ts';
import type { NormalizedTrackGeometry } from './types.ts';
import { deploymentBlockers, LOCKED_MANIFEST_HASH, verifyLocalCanary } from '../../scripts/gpx/generated-publication-validation.ts';
import type { LiveSnapshot } from '../../scripts/gpx/generated-publication-live.ts';
import { fixtureBaseEvidence } from './baseAccessTestFixtures.ts';

const read = (path:string) => readFileSync(path,'utf8');
const root='data/gpx/generated-route-publication';
const manifest=JSON.parse(read(`${root}/generated-route-canary-v1.json`)) as CanaryManifest;
const entry=manifest.entries[0], request=entry.request;
const geometry=JSON.parse(read(`${root}/${entry.files.geojson.path}`)).features[0].geometry as Line;
const rows=JSON.parse(read('data/gpx/adaptive-start-pilot/adaptive-start-component-v2-results.json')) as FrozenRow[];
const row=rows.find(r=>r.mountainId===request.provenance.sourceMountainIdentity)!;
const candidate=row.candidates.find(c=>c.id===request.provenance.start.candidateId)!;
const live=JSON.parse(read(`${root}/deployment-read-only.json`)) as LiveSnapshot;

test('obsolete v1 canary cannot be republished after the policy source changes',async()=>{
  await assert.rejects(verifyLocalCanary(), /SOURCE_ARTIFACT_DRIFT/);
});
test('GeoJSON byte/hash stability and actual LineString topology endpoints',()=>{
  const {publicationStatus: _status,geojsonSha256: _geo,gpxSha256: _gpx,storageBucket: _bucket,storagePaths: _paths,geojsonBytes: _gb,gpxBytes: _pb,...evidence}=request.provenance;
  void [_status,_geo,_gpx,_bucket,_paths,_gb,_pb];
  const output=serializeGeojson(request.mountainRoute.name,geometry,evidence);
  assert.equal(output,read(`${root}/${entry.files.geojson.path}`));
  assert.equal(sha256Bytes(Buffer.from(output)),entry.files.geojson.sha256);
  const json=JSON.parse(output); assert.equal(json.type,'FeatureCollection'); assert.equal(json.features.length,1);
  assert.deepEqual(json.mountainTracker.topologyEndpoints,{startCoordinate:geometry.coordinates[0],endCoordinate:geometry.coordinates.at(-1)});
  assert.equal(serializeGeojson(request.mountainRoute.name,geometry,evidence),output);
});
test('GPX is strict XML GPX 1.1, one track and segment, exact coordinates, no elevation/time',()=>{
  const xml=serializeGpx(request.mountainRoute.name,geometry);
  assert.equal(xml,read(`${root}/${entry.files.gpx.path}`)); assert.equal(sha256Bytes(Buffer.from(xml)),entry.files.gpx.sha256);
  const parser=sax.parser(true,{xmlns:true}); const tags:string[]=[],points:number[][]=[];
  parser.onopentag=(node)=>{
    tags.push(node.name);
    const attr=(name:string)=>{ const value=node.attributes[name];return typeof value==='object'?value.value:value; };
    if(node.name==='gpx'){assert.equal(attr('version'),'1.1');assert.equal(attr('creator'),'Mountain Tracker');assert.equal(node.uri,'http://www.topografix.com/GPX/1/1');}
    if(node.name==='trkpt')points.push([Number(attr('lon')),Number(attr('lat'))]);
  };
  parser.write(xml).close();
  assert.equal(tags.filter(t=>t==='trk').length,1); assert.equal(tags.filter(t=>t==='trkseg').length,1);
  assert(!tags.includes('time') && !tags.includes('ele')); assert.deepEqual(points,geometry.coordinates);
});
test('GPX escapes semantic names and rejects illegal XML control bytes',()=>{
  assert.match(serializeGpx('A & B <C> "D"',geometry),/A &amp; B &lt;C&gt; &quot;D&quot;/);
  assert.throws(()=>serializeGpx('A\u0000B',geometry));
});
test('MultiLineString is excluded rather than joined',()=>{
  const multi:NormalizedTrackGeometry={type:'MultiLineString',coordinates:[[[1,1],[2,2]],[[3,3],[4,4]]]};
  assert.throws(()=>serializeGpx('Route',multi),/DISCONNECTED/);
  assert.throws(()=>serializeGeojson('Route',multi,request.provenance),/DISCONNECTED/);
});
test('elevation samples, invalid coordinates and empty geometry fail closed',()=>{
  for(const g of [{type:'LineString',coordinates:[[1,1,100],[2,2,200]]},{type:'LineString',coordinates:[]},{type:'LineString',coordinates:[[181,0],[1,2]]}] as NormalizedTrackGeometry[])
    assert.throws(()=>serializeGpx('Route',g));
});
test('old SAFE candidates without v2 access evidence fail primary publication',()=>{
  for (const r of rows) for (const c of r.candidates) assert.equal(candidateEligible(r,c),false);
});
test('SAFE candidate with proven v2 primary access passes',()=>{
  assert(candidateEligible(row,{ ...candidate, kind:'PARKING', category:'STANDARD_ASCENT',
    startContext:{...candidate.startContext!,type:'BASE_START'}, startRole:'PRIMARY_BASE_ACCESS',accessEvidence:fixtureBaseEvidence() }));
});
test('review, unsafe, disconnected, failed, boundary-limited and nondeterministic candidates are excluded',()=>{
  for(const change of [{autoEligible:false},{safety:'NEEDS_REVIEW'},{safety:'UNSAFE'},{solverStatus:'DISCONNECTED'},{solverStatus:'FAILED'},{duplicateOf:'better'},{tags:{}}])
    assert.equal(candidateEligible(row,{...candidate,...change} as typeof candidate),false);
  for(const change of [{status:'NEEDS_REVIEW'},{graphStatus:'GRAPH_COMPONENT_LIMIT'},{determinismVerified:false},{reasons:['BOUNDARY_LIMIT_REACHED']}])
    assert.equal(candidateEligible({...row,...change},candidate),false);
});
test('HIGH and AMBIGUOUS starts are excluded',()=>{
  for(const type of ['HIGH_MOUNTAIN_START','AMBIGUOUS_START'])assert.equal(candidateEligible(row,{...candidate,startContext:{...candidate.startContext!,type} as typeof candidate.startContext}),false);
});
test('geometry touching the frozen extraction window boundary is excluded',()=>{
  assertInsideFrozenWindow({type:'LineString',coordinates:[[1,1],[2,2]]},[0,0,3,3]);
  assert.throws(()=>assertInsideFrozenWindow({type:'LineString',coordinates:[[0,1],[2,2]]},[0,0,3,3]),/BOUNDARY/);
});
test('REVIEW_PROXIMITY summit attachment cannot be published',()=>{
  assert.equal(candidateEligible({...row,summitAttachment:{...row.summitAttachment!,tier:'REVIEW_PROXIMITY',autoEligible:false}},candidate),false);
});
test('manifest and publication identities are stable and changes alter the identity',()=>{
  assert.equal(sha256Stable(manifest),LOCKED_MANIFEST_HASH);
  const reversed=Object.fromEntries(Object.entries(manifest).reverse()); assert.equal(sha256Stable(reversed),LOCKED_MANIFEST_HASH);
  assert.equal(publicationIdentity(request.mountainRoute.mountain_id,request.provenance),request.publicationId);
  assert.notEqual(publicationIdentity(request.mountainRoute.mountain_id,{...request.provenance,geometryHash:'f'.repeat(64)}),request.publicationId);
  assert.equal(stableJson({b:1,a:2}),stableJson({a:2,b:1}));
});
test('existing Phase 11 similarity recognizes exact and near duplicates',()=>{
  const a:Line={type:'LineString',coordinates:[[10,45],[10.001,45.001],[10.002,45.002]]};
  assert(obviousDuplicate(a,a));
  assert(obviousDuplicate(a,{type:'LineString',coordinates:a.coordinates.map(([x,y])=>[x+0.00001,y])}));
  assert(!obviousDuplicate(a,{type:'LineString',coordinates:[[11,46],[11.001,46.001]]}));
});
test('canary uniqueness and safe diversity are locked',()=>{
  assert.equal(new Set(manifest.entries.map(e=>e.request.mountainRoute.mountain_id)).size,10);
  assert.equal(manifest.entries.filter(e=>e.request.provenance.routeCategory==='HUT_ASCENT').length,2);
  assert.equal(manifest.entries.filter(e=>e.request.provenance.routeCategory==='STANDARD_ASCENT').length,8);
});
test('immutable Storage paths reject traversal, encoded traversal and unknown formats',()=>{
  for(const id of ['../x','a/../b','%2e%2e','/absolute','A'.repeat(64)])assert.throws(()=>storagePath(id,'gpx'));
  assert.throws(()=>storagePath(request.publicationId,'xml' as 'gpx'));
  assert.equal(storagePath(request.publicationId,'gpx'),request.provenance.storagePaths.gpx);
});
test('MIME mapping and 10 MiB / deployed lower ceiling are enforced',()=>{
  assert.equal(MIME.gpx,'application/gpx+xml');assert.equal(MIME.geojson,'application/geo+json');
  checkObjectSize(MAX_PUBLICATION_BYTES); assert.throws(()=>checkObjectSize(MAX_PUBLICATION_BYTES+1));
  assert.throws(()=>checkObjectSize(500,499)); assert.throws(()=>checkObjectSize(0)); assert.throws(()=>checkObjectSize(NaN));
});
test('RPC request rejects missing hashes, forged safety, unknown mountain data and path/URL drift',()=>{
  validateRequest(request);
  const mutations:Array<(r:PublicationRequest)=>void>=[r=>{r.provenance.gpxSha256='';},r=>{r.mountainRoute.elevation_gain_m=1200 as never;},r=>{r.provenance.safety.fabricatedGapCount=1 as never;},r=>{r.provenance.safety.autoEligible=false as never;},r=>{r.mountainRoute.route_type='climbing' as never;},r=>{r.mountainRoute.gpx_url='https://evil.example/route.gpx';},r=>{r.provenance.storagePaths.gpx='../x';},r=>{r.provenance.summitAttachment.tier='REVIEW_PROXIMITY';}];
  for(const mutate of mutations){const changed=structuredClone(request);mutate(changed);assert.throws(()=>validateRequest(changed));}
});
test('exact repeated publication is UNCHANGED; changed hashes fail closed',()=>{
  assert.equal(existingPublicationAction(request,undefined),'CREATE');
  assert.equal(existingPublicationAction(request,{request_hash:entry.requestHash,publication_status:'ACTIVE'}),'UNCHANGED');
  assert.throws(()=>existingPublicationAction(request,{request_hash:'a'.repeat(64),publication_status:'ACTIVE'}),/CHANGED_HASH/);
  assert.throws(()=>existingPublicationAction(request,{request_hash:entry.requestHash,publication_status:'WITHDRAWN'}));
});
test('database drift and existing verified routes block the dry run',()=>{
  const next=structuredClone(live);next.generatedTableAvailable=true;next.generatedRpcAvailable=true;next.generatedApprovalTableAvailable=true;next.provenanceCount=0;
  next.approvals=manifest.entries.map(e=>({publication_id:e.request.publicationId,request_hash:e.requestHash,manifest_hash:LOCKED_MANIFEST_HASH}));
  assert.deepEqual(deploymentBlockers(manifest,next),[]);
  next.approvals=next.approvals.slice(0,9);assert(deploymentBlockers(manifest,next).includes('APPROVAL_COUNT_MISMATCH:9'));
  next.approvals.push({publication_id:'c'.repeat(64),request_hash:'d'.repeat(64),manifest_hash:'e'.repeat(64)});
  assert(deploymentBlockers(manifest,next).some(x=>x.startsWith('APPROVAL_MANIFEST_HASH_MISMATCH')));
  next.approvals=manifest.entries.map(e=>({publication_id:e.request.publicationId,request_hash:e.requestHash,manifest_hash:LOCKED_MANIFEST_HASH}));
  next.provenanceCount=1;assert(deploymentBlockers(manifest,next).includes('PROVENANCE_COUNT_MISMATCH:1'));next.provenanceCount=0;
  next.generatedApprovalTableAvailable=false;assert(deploymentBlockers(manifest,next).includes('GENERATED_APPROVAL_TABLE_MISSING'));next.generatedApprovalTableAvailable=true;
  next.provenanceCount=undefined as unknown as number;assert(deploymentBlockers(manifest,next).includes('PROVENANCE_COUNT_UNVERIFIED'));next.provenanceCount=0;
  next.routes.push({id:123,mountain_id:request.mountainRoute.mountain_id,name:'existing',start_location:null,geojson_url:null,gpx_url:null,source_name:null,source_url:null,is_verified:true});
  assert(deploymentBlockers(manifest,next).some(x=>x.startsWith('EXISTING_ROUTE_COLLISION')));
  next.bucket.allowed_mime_types=[MIME.geojson];assert(deploymentBlockers(manifest,next).includes('STORAGE_GPX_MIME_BLOCKED'));
});
test('manual SQL is service-only, RLS-protected, exactly approved, and atomic',()=>{
  const sql=read('database/generated_route_publication.sql');
  assert.match(sql,/security definer set search_path = ''/i);
  assert.match(sql,/auth\.role\(\) is distinct from 'service_role'/);
  assert.equal((sql.match(/enable row level security/g)||[]).length,2);
  assert.match(sql,/from public, anon, authenticated, service_role/);
  assert.match(sql,/grant execute on function public\.publish_generated_mountain_route\(jsonb\) to service_role/);
  assert.match(sql,/a\.request_hash = v_hash/); assert.match(sql,/extensions\.digest/);
  assert(sql.indexOf('insert into public.mountain_routes')<sql.indexOf('insert into public.generated_route_publication_provenance'));
  assert.match(sql,/GENERATED_CHANGED_HASH_OR_ROW_FAIL_CLOSED/);
  assert.match(sql,/return query select 'UNCHANGED'/);
  assert(!/grant (insert|update|delete|all)/i.test(sql));
  const approvals=read('database/generated_route_canary_approval.sql');
  for(const e of manifest.entries)assert(approvals.includes(`('${e.request.publicationId}','${e.requestHash}','${LOCKED_MANIFEST_HASH}')`));
  assert.equal((approvals.match(/^\('[a-f0-9]{64}'/gm)||[]).length,10);
});
test('compensation targets only exact newly created objects and never uncertain commits',()=>{
  const paths=Object.values(request.provenance.storagePaths);
  assert.deepEqual(compensationTargets(paths,[paths[0]],'ABSENT'),[paths[0]]);
  assert.deepEqual(compensationTargets(paths,[],'ABSENT'),[]);
  assert.deepEqual(compensationTargets(paths,paths,'UNKNOWN'),[]);
  assert.deepEqual(compensationTargets(paths,paths,'COMMITTED'),[]);
  assert.throws(()=>compensationTargets(paths,[storagePath('a'.repeat(64),'gpx')],'ABSENT'));
  assert.throws(()=>compensationTargets(paths,['../route.gpx'],'ABSENT'));
});
test('current mountain page selects verified routes and reuses map and GPX action',()=>{
  const page=read('app/[locale]/mountain/[id]/page.tsx');
  assert.match(page,/\.from\("mountain_routes"\)/);assert.match(page,/\.eq\("mountain_id", mountainId\)/);assert.match(page,/\.eq\("is_verified", true\)/);
  assert.match(page,/route\.geojson_url &&/);assert.match(page,/geojsonUrl=\{route\.geojson_url\}/);
  assert.match(page,/route\.gpx_url &&/);assert.match(page,/route\/\$\{route.id\}\/gpx/);
});
test('existing GPX endpoint guards mountain ownership, verification and absolute HTTP(S)',()=>{
  const endpoint=read('app/[locale]/mountain/[id]/route/[routeId]/gpx/route.ts');
  assert.match(endpoint,/\.eq\("mountain_id", mountainId\)/);assert.match(endpoint,/\.eq\("is_verified", true\)/);
  assert(endpoint.includes('if (!/^https?:\\/\\//i.test(gpxUrl))'));
  for(const e of manifest.entries){const url=new URL(e.request.mountainRoute.gpx_url);assert.equal(url.protocol,'https:');assert.match(url.pathname,/\/storage\/v1\/object\/public\/route-gpx\/generated\/[a-f0-9]{64}\/route.gpx$/);}
});
test('dry run contains no production mutation entrypoint; all mutations live in the gated execute bridge',()=>{
  const cli=read('scripts/gpx/publish-generated-route-canary.ts'),network=read('scripts/gpx/generated-publication-live.ts'),execute=read('scripts/gpx/generated-publication-execute.ts');
  assert.match(cli,/parseExecuteArgs/);assert.match(cli,/--execute/);assert.match(cli,/--confirm-manifest/);assert.match(cli,/--confirm-publications/);
  assert(!/\.upload\(|\.rpc\(|\.insert\(|\.remove\(|\.storage\.from|createClient\(/.test(cli+network));
  assert.match(execute,/upsert: false/);
  assert.match(execute,/.rpc\('publish_generated_mountain_route'/);
  assert.match(execute,/autoRefreshToken: false/);assert.match(execute,/persistSession: false/);
  assert.match(network,/method: 'GET'/);assert.match(network,/AbortSignal.timeout\(20_000\)/);
});
test('unknown measurements remain null and exact geometry defines the distance',()=>{
  const result=preparePublication(request.mountainRoute.mountain_id,new URL(request.mountainRoute.gpx_url).origin,geometry,
    {...request.provenance,startRole:'PRIMARY_BASE_ACCESS',accessEvidence:fixtureBaseEvidence(),
      start:{...request.provenance.start,kind:'PARKING'},startContext:'BASE_START',routeCategory:'STANDARD_ASCENT'});
  // preparePublication is normally given evidence without serialization fields.
  assert.equal(result.entry.request.mountainRoute.distance_km,request.mountainRoute.distance_km);
  for(const e of manifest.entries){assert.equal(e.request.mountainRoute.elevation_gain_m,null);assert.equal(e.request.mountainRoute.duration_minutes,null);assert.equal(e.request.mountainRoute.difficulty_value,null);}
});
