import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import { assertInsideFrozenWindow, candidateEligible, GENERATED_PUBLICATION_CONTRACT, obviousDuplicate, preparePublication, type CanaryManifest, type Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { loadFrozen, FrozenPathReader, evidenceFor, OUTPUT, PILOT, fileHash, readJson } from './generated-publication-frozen.ts';
import type { LiveSnapshot } from './generated-publication-live.ts';

if (process.argv.length!==2) throw new Error('OFFLINE_PREPARATION_ACCEPTS_NO_FLAGS');
const frozen = await loadFrozen();
const live = await readJson<LiveSnapshot>(`${OUTPUT}/deployment-read-only.json`);
const reader = new FrozenPathReader(frozen.corpus);
const excluded: CanaryManifest['selection']['excluded'] = [];
const best: Array<ReturnType<typeof preparePublication> & { geometry:Line }> = [];
try {
  // Existing frozen candidate order is the generator's score ranking. Preserve it.
  for (const row of frozen.rows) {
    const summit = frozen.corpus.mountains.find(m=>m.mountainId===row.mountainId)!.summit;
    const matches = live.mountains.filter(m=>m.osm_id===summit.osmId && calculateCoordinateDistanceMeters(summit.coordinate,[m.longitude,m.latitude])<=5);
    if (matches.length!==1) { excluded.push({ mountain:row.mountainId,candidate:null,reason:'MISSING_OR_AMBIGUOUS_DEPLOYED_MOUNTAIN' }); continue; }
    // Conservative: exclude the whole mountain if any verified legacy route exists.
    // This makes unavailable legacy geometry fail closed without external downloads.
    if (live.routes.some(r=>r.mountain_id===matches[0].id && r.is_verified)) { excluded.push({ mountain:row.mountainId,candidate:null,reason:'EXISTING_VERIFIED_ROUTE_CONSERVATIVE_COLLISION' }); continue; }
    for (const c of row.candidates) {
      if (!candidateEligible(row,c)) { excluded.push({ mountain:row.mountainId,candidate:c.id,reason:'STRICT_GATE_OR_UNRESOLVED_NAME' }); continue; }
      const geometry = reader.materialize(c);
      const block = frozen.corpus.blocks.find(b=>b.blockId===row.blockId); assert(block);
      assertInsideFrozenWindow(geometry,block.bbox);
      const evidence = evidenceFor(frozen,reader,row,c);
      const prepared = preparePublication(matches[0].id,live.origin,geometry,evidence);
      best.push({ ...prepared,geometry }); break;
    }
  }
} finally { reader.close(); }
best.sort((a,b)=>a.entry.request.mountainRoute.mountain_id-b.entry.request.mountainRoute.mountain_id);
const selected: typeof best = [];
function pick(category: string, count: number) {
  for (const item of best.filter(x=>x.entry.request.provenance.routeCategory===category)) {
    if (selected.filter(x=>x.entry.request.provenance.routeCategory===category).length>=count) break;
    if (selected.some(x=>obviousDuplicate(x.geometry,item.geometry))) { excluded.push({ mountain:item.entry.request.provenance.sourceMountainIdentity,candidate:item.entry.request.provenance.start.candidateId,reason:'EXACT_OR_NEAR_CANARY_DUPLICATE' }); continue; }
    selected.push(item);
  }
}
pick('HUT_ASCENT',2); pick('STANDARD_ASCENT',10-selected.length);
assert.equal(selected.length,10,'INSUFFICIENT_STRICT_DISTINCT_CANARY_ROUTES');
selected.sort((a,b)=>a.entry.request.mountainRoute.mountain_id-b.entry.request.mountainRoute.mountain_id);
const paths = [
  `${PILOT}/adaptive-start-component-v2-results.json`, `${PILOT}/adaptive-start-component-v2-artifact-hashes.json`,
  `${PILOT}/adaptive-start-pilot-corpus.json`,`${PILOT}/ADAPTIVE_START_COMPONENT_V2_REPORT.md`,
  `${PILOT}/oversized-component-diagnostic.json`,`${PILOT}/adaptive-start-summit-snap-policy.json`,
  `${PILOT}/adaptive-start-summit-snap-diagnostic.json`,`${OUTPUT}/deployment-read-only.json`,
  'Lib/gpxIngestion/adaptiveStartDiscovery.ts','Lib/gpxIngestion/summitAttachment.ts',
  'Lib/gpxIngestion/hashing.ts','scripts/osm-import/route-similarity.ts',
  ...frozen.corpus.featureSources.map(s=>s.path),
];
for (const source of frozen.corpus.featureSources) assert.equal(await fileHash(source.path),source.sha256,'FEATURE_SOURCE_DRIFT');
const sourceArtifacts = Object.fromEntries(await Promise.all(paths.map(async path=>[path,await fileHash(path)])));
const manifest: CanaryManifest = { contract:GENERATED_PUBLICATION_CONTRACT,mode:'DRY_RUN_ONLY',sourceArtifacts,checkpoint:frozen.checkpoint,
  selection:{policy:'frozen-generator-rank; named-strict-best-per-mountain; unique-osm-id-and-5m; exclude-existing-verified-mountains; mountain-db-id-ascending; two-best-hut-mountains-then-standard; exact-near-dedup/v1',excluded},
  entries:selected.map(x=>x.entry) };
await mkdir(OUTPUT,{recursive:true});
for (const item of selected) {
  await mkdir(`${OUTPUT}/preview/${item.entry.request.publicationId}`,{recursive:true});
  for (const kind of ['gpx','geojson'] as const) await writeFile(`${OUTPUT}/${item.entry.files[kind].path}`,item[kind]);
}
await writeFile(`${OUTPUT}/generated-route-canary-v1.json`,stableJson(manifest));
await writeFile(`${OUTPUT}/generated-route-canary-v1.sha256`,sha256Stable(manifest)+'\n');
const approvalSql = '-- MANUAL REVIEW / MANUAL DEPLOYMENT ONLY. DO NOT APPLY during canary preparation.\n' +
  '-- Requires database/generated_route_publication.sql. Approves exact request bytes, publishes zero routes.\n' +
  `-- Locked manifest SHA-256: ${sha256Stable(manifest)}\nbegin;\n` +
  'insert into public.generated_route_publication_approvals (publication_id,request_hash,manifest_hash) values\n' +
  manifest.entries.map(e=>`('${e.request.publicationId}','${e.requestHash}','${sha256Stable(manifest)}')`).join(',\n') + ';\ncommit;\n';
await writeFile('database/generated_route_canary_approval.sql',approvalSql);
console.log(JSON.stringify({manifestHash:sha256Stable(manifest),CANARY_COUNT:10,routes:selected.map(x=>({mountain:x.entry.request.mountainRoute.mountain_id,name:x.entry.request.mountainRoute.name,category:x.entry.request.provenance.routeCategory,distance:x.entry.request.mountainRoute.distance_km})),DB_WRITES:0,STORAGE_WRITES:0,PUBLICATION_WRITES:0},null,2));
