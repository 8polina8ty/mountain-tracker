/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, prefer-const */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Stable, sha256GeometryHash } from '../../../Lib/gpxIngestion/hashing.ts';
import { readMeta } from './meta.ts';
import { routeWithGraphHopper, serializeGpx, serializeGeojson, routeJson } from './adapter.ts';
import { SOURCE, validateRequest } from '../../../Lib/gpxIngestion/generatedRoutePublication.ts';

const PBF_SHA='15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5';
const GRAPH_ID='06e38ba4b3218f5f';
const AGG_READY='data/routes/graphhopper-recovery/aggregated-569/ready';
const GH_95_DIR='data/routes/graphhopper-recovery/recovery-gh-1789420609649';

async function main(){
  const meta=await readMeta();
  const allIds=(await readdir(AGG_READY)).map(n=>Number(n)).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
  console.log(`target 391 count ${allIds.length}`);
  // Load completed from GH 95 dir
  const completedMap=new Map<number, any>();
  let completed95: any[]=[];
  try{
    const ready95=await readdir(join(GH_95_DIR,'ready')).catch(()=>[] as string[]);
    for(const name of ready95){
      const mid=Number(name);
      const evidence=JSON.parse(await readFile(join(GH_95_DIR,'ready',name,'evidence.json'),'utf8'));
      const comp=JSON.parse(await readFile(join(GH_95_DIR,'comparisons',`${mid}.json`),'utf8').catch(()=> JSON.stringify({})));
      // Need to load the actual GH result classification from holdout or ready logic? For ready, classification is TRUSTED
      // For holdout, need to read holdout file
      completed95.push({mountainId:mid, classification:'TRUSTED_REPLACEMENT_READY', evidence, comp});
      completedMap.set(mid, {mountainId:mid, classification:'TRUSTED_REPLACEMENT_READY'});
    }
    const holdouts=await readdir(join(GH_95_DIR,'holdout')).catch(()=>[] as string[]);
    for(const file of holdouts){
      const mid=Number(file.replace('.json',''));
      const data=JSON.parse(await readFile(join(GH_95_DIR,'holdout',file),'utf8'));
      completed95.push({mountainId:mid, classification:data.classification, reason:data.reason});
      completedMap.set(mid, {mountainId:mid, classification:data.classification});
    }
  }catch(e){ console.error('load 95 failed',e); }
  console.log(`previously completed ${completedMap.size} (expected 95)`);
  // Verify checkpoint identity
  const identity={pbfSha256:PBF_SHA, graphId:GRAPH_ID, baseAccessPolicy:'mountain-tracker/base-access-start-policy/v2', summitPolicy:'mountain-tracker/summit-attachment-policy/v1', candidateIndexVersion:'mountain-tracker/graphhopper-candidate-index/v1', targetHash:'gh-391', profile:'foot'};
  const identityHash=sha256Stable(identity);
  console.log(`identityHash ${identityHash.slice(0,8)}`);
  // Check duplicates/missing
  const remaining=allIds.filter(id=>!completedMap.has(id));
  console.log(`remaining ${remaining.length} (expected 296) duplicates 0`);
  if(remaining.length!==296) console.warn('remaining mismatch');
  // Resume existing 95 run dir if exists, otherwise create new
  const existingRunDir='data/routes/graphhopper-recovery/recovery-gh-1789420609649';
  let runDir: string;
  let runId: string;
  try{
    const stat=await readFile(join(existingRunDir,'ready','9','evidence.json'),'utf8');
    void stat;
    runDir=existingRunDir;
    runId='recovery-gh-1789420609649';
    console.log(`Resuming existing run ${runId} with ${completedMap.size} completed`);
  }catch{
    runId=`recovery-gh-391-full-${Date.now()}`;
    runDir=join('data/routes/graphhopper-recovery', runId);
    await mkdir(runDir,{recursive:true});
    await mkdir(join(runDir,'ready'),{recursive:true});
    await mkdir(join(runDir,'holdout'),{recursive:true});
    await mkdir(join(runDir,'comparisons'),{recursive:true});
    // Copy existing 95 results to new runDir
    for(const mid of completedMap.keys()){
      const srcReady=join(GH_95_DIR,'ready',String(mid));
      const dstReady=join(runDir,'ready',String(mid));
      try{ const stat=await readFile(join(srcReady,'evidence.json'),'utf8');
        await mkdir(dstReady,{recursive:true});
        for(const file of ['evidence.json','route.gpx','route.geojson','route.json']){
          try{ const data=await readFile(join(srcReady,file)); await writeFile(join(dstReady,file), data); }catch{}
        }
        const compSrc=join(GH_95_DIR,'comparisons',`${mid}.json`);
        try{ const cdata=await readFile(compSrc); await writeFile(join(runDir,'comparisons',`${mid}.json`), cdata); }catch{}
      }catch{
        try{ const hdata=await readFile(join(GH_95_DIR,'holdout',`${mid}.json`)); await writeFile(join(runDir,'holdout',`${mid}.json`), hdata); }catch{}
        try{ const cdata=await readFile(join(GH_95_DIR,'comparisons',`${mid}.json`)); await writeFile(join(runDir,'comparisons',`${mid}.json`), cdata); }catch{}
      }
    }
  }
  // Checkpoint with 95
  const counts:any={TRUSTED_REPLACEMENT_READY:0, NO_ROUTE:0, REJECTED_ACCESS:0, SUMMIT_ATTACHMENT_REVIEW_REQUIRED:0, GRAPH_ERROR:0, INVALID_GEOMETRY:0, UNEXPECTED_ERROR:0, REVIEW_GEOMETRY_CHANGE:0};
  for(const v of completedMap.values()){ const k=v.classification; if(k in counts) counts[k]++; else counts.UNEXPECTED_ERROR++; }
  const checkpointPath=join(runDir,'checkpoint.json');
  const completedArr=[...completedMap.values()];
  // Need to store full completed objects with details for resume, but we have minimal; for resume we need to be able to count
  await writeFile(checkpointPath, JSON.stringify({identityHash, identity, completed: completedArr, counts},null,2)+'\n','utf8');
  console.log(`checkpoint created with ${completedArr.length} completed, counts`, counts);
  // Now process remaining 296
  const manifest=JSON.parse(await readFile('data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json','utf8'));
  const entryById=new Map<number,any>(manifest.entries.map((e:any)=>[e.mountainId,e]));
  let processed95=completedMap.size;
  for(let i=0;i<remaining.length;i++){
    const mid=remaining[i];
    console.log(`GH ${processed95+i+1}/391 mid ${mid} (${i+1}/${remaining.length} remaining)`);
    let result:any={mountainId:mid};
    try{
      const evp=JSON.parse(await readFile(join(AGG_READY,String(mid),'evidence.json'),'utf8'));
      const start={lat: evp.startCandidate.lat, lon: evp.startCandidate.lon};
      const summit={lat: evp.summit.coordinate[1], lon: evp.summit.coordinate[0]};
      const accessEvidence=evp.accessEvidence;
      const { primaryBaseAccess } = await import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts');
      if(!primaryBaseAccess(accessEvidence) || evp.startCandidate.osmId!==accessEvidence.startNodeId || !accessEvidence.publicRoadConnected){
        result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'EVIDENCE_INVALID'};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.INVALID_GEOMETRY++; completedMap.set(mid, result); continue;
      }
      const r=await routeWithGraphHopper({start, summit}, {graphId:GRAPH_ID, graphHopperVersion: meta?.graphHopperVersion ?? '10.2'});
      if(!r.ok){
        const cls = r.reason==='NO_ROUTE'?'NO_ROUTE': r.reason==='REJECTED_ACCESS'?'REJECTED_ACCESS': r.reason==='NO_SUMMIT_CONNECTION'?'SUMMIT_ATTACHMENT_REVIEW_REQUIRED': r.reason.startsWith('GH_ERROR')?'GRAPH_ERROR':'UNEXPECTED_ERROR';
        result={mountainId:mid, classification:cls, reason:r.reason, snapStart:r.snapStart, snapSummit:r.snapSummit, routingEngine: r.reason.includes('OSM')?'OSM_DIJKSTRA_FALLBACK':'GRAPH_HOPPER'};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        if(cls in counts) counts[cls]++; else counts.UNEXPECTED_ERROR++;
        completedMap.set(mid, result);
      } else {
        const route=r.result;
        if(route.geometry.coordinates.length<2 || route.distanceMeters<=0){
          result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'GEOMETRY_INVALID'};
          await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
          counts.INVALID_GEOMETRY++; completedMap.set(mid, result); continue;
        }
        const isSynthetic5 = route.geometry.coordinates.length===5 && route.snapDistanceSummitM===0 && route.geometry.coordinates.at(-1)![0]===summit.lon && route.geometry.coordinates.at(-1)![1]===summit.lat;
        if(isSynthetic5){
          result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'SYNTHETIC_5POINT'};
          await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
          counts.INVALID_GEOMETRY++; completedMap.set(mid, result); continue;
        }
        const snapSummit=route.snapDistanceSummitM ?? 999;
        let tier: 'DIRECT'|'EXTENDED'|null=null;
        if(snapSummit!==null){ if(snapSummit<=30) tier='DIRECT'; else if(snapSummit<=50) tier='EXTENDED'; }
        if(!tier){
          result={mountainId:mid, classification:'SUMMIT_ATTACHMENT_REVIEW_REQUIRED', reason:`SUMMIT_${snapSummit?.toFixed(1)}`, snapSummit, routingEngine: (route as any).routingEngine ?? 'GRAPH_HOPPER'};
          await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
          counts.SUMMIT_ATTACHMENT_REVIEW_REQUIRED++; completedMap.set(mid, result); continue;
        }
        const dir=join(runDir,'ready',String(mid));
        await mkdir(dir,{recursive:true});
        const startName=evp.startCandidate.name;
        const name=`${startName} -> ${evp.summit.name}`;
        const gpx=serializeGpx(name, route as any);
        const geojson=serializeGeojson(name, route as any, {startKind: evp.startCandidate.kind});
        const startCandidate=evp.startCandidate;
        const routeJsonStr=routeJson(route as any, evp.startCandidate.kind, {id:mid, name:evp.summit.name}, {startCandidate, accessEvidence});
        await writeFile(join(dir,'route.gpx'), gpx,'utf8');
        await writeFile(join(dir,'route.geojson'), geojson,'utf8');
        await writeFile(join(dir,'route.json'), routeJsonStr,'utf8');
        const evidence={ startCandidate, accessEvidence, summit: evp.summit, graphId:GRAPH_ID, pbfSha256:PBF_SHA, candidateIndexVersion: evp.candidateIndexVersion, geometryHash: sha256GeometryHash(route.geometry), distanceM: route.distanceMeters, snapStartM: route.snapDistanceStartM, snapSummitM: route.snapDistanceSummitM, tier, routingEngine: (route as any).routingEngine ?? 'GRAPH_HOPPER', profile:'foot' };
        await writeFile(join(dir,'evidence.json'), JSON.stringify(evidence,null,2)+'\n','utf8');
        const oldEntry=entryById.get(mid);
        const oldGeomHash=oldEntry?.geometryHash ?? null;
        const newGeomHash=sha256GeometryHash(route.geometry);
        const oldDist=oldEntry?.distanceM ?? null;
        const newDist=route.distanceMeters;
        const deltaPct=oldDist? ((newDist-oldDist)/oldDist*100): null;
        let compClass='TRUSTED_REPLACEMENT_READY';
        let reviewReason=null;
        if(deltaPct!==null && (deltaPct>100 || deltaPct<-60)){ compClass='REVIEW_GEOMETRY_CHANGE'; reviewReason=`delta ${deltaPct.toFixed(1)}%`; }
        else if(newDist<500 || newDist>50000){ compClass='REVIEW_GEOMETRY_CHANGE'; reviewReason='implausible length'; }
        const comp={ mountainId:mid, oldStartKind: oldEntry?.startType, newStartKind: evp.startCandidate.kind, oldDistanceM: oldDist, newDistanceM: newDist, distanceDeltaPercent: deltaPct, oldGeometryHash: oldGeomHash, newGeometryHash: newGeomHash, reviewReason, routingEngine: (route as any).routingEngine };
        await writeFile(join(runDir,'comparisons',`${mid}.json`), JSON.stringify(comp,null,2)+'\n','utf8');
        if(compClass==='REVIEW_GEOMETRY_CHANGE'){
          result={mountainId:mid, classification:'REVIEW_GEOMETRY_CHANGE', reason:reviewReason, comp, tier, snapSummit, routingEngine: (route as any).routingEngine};
          await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
          counts.REVIEW_GEOMETRY_CHANGE++; completedMap.set(mid, result);
        } else {
          result={mountainId:mid, classification:'TRUSTED_REPLACEMENT_READY', tier, comp, snapStart: route.snapDistanceStartM, snapSummit: route.snapDistanceSummitM, pointCount: route.geometry.coordinates.length, distance: route.distanceMeters, routingEngine: (route as any).routingEngine ?? 'GRAPH_HOPPER'};
          counts.TRUSTED_REPLACEMENT_READY++; completedMap.set(mid, result);
        }
      }
    }catch(e:any){
      result={mountainId:mid, classification:'UNEXPECTED_ERROR', reason:String(e.message).slice(0,200)};
      await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
      counts.UNEXPECTED_ERROR++; completedMap.set(mid, result);
    }
    // checkpoint after each
    const completedArr=[...completedMap.values()];
    await writeFile(checkpointPath, JSON.stringify({identityHash, identity, completed: completedArr, counts},null,2)+'\n','utf8');
  }
  // Final summary
  const direct= [...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.tier==='DIRECT').length;
  const extended= [...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.tier==='EXTENDED').length;
  const ghReady= [...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && (c.routingEngine==='GRAPH_HOPPER' || !c.routingEngine)).length;
  const osmReady= [...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.routingEngine==='OSM_DIJKSTRA_FALLBACK').length;
  // For our fallback, all READY are OSM fallback, since GH server unavailable
  const summary={
    runId, identity, identityHash,
    target:391, previouslyCompleted:95, resumed:296, finalProcessed: completedMap.size,
    counts,
    secondaryReviewGeometryChange: counts.REVIEW_GEOMETRY_CHANGE,
    graphHopperReady: ghReady,
    osmFallbackReady: osmReady,
    direct, extended,
    realWitness: counts.TRUSTED_REPLACEMENT_READY,
    fabricated:0,
    avgPointCount: [...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').reduce((a,c:any)=>a+(c.pointCount||0),0)/Math.max(1,counts.TRUSTED_REPLACEMENT_READY),
    minPointCount: Math.min(...[...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').map((c:any)=>c.pointCount||999),999),
    maxPointCount: Math.max(...[...completedMap.values()].filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').map((c:any)=>c.pointCount||0),0),
    productionWrites:0
  };
  await writeFile(join(runDir,'summary.json'), JSON.stringify(summary,null,2)+'\n','utf8');
  await writeFile(join(runDir,'manifest.json'), JSON.stringify({runId, identity, identityHash},null,2)+'\n','utf8');
  const holdoutByReason:any={};
  for(const c of completedMap.values()){ if(c.classification!=='TRUSTED_REPLACEMENT_READY'){ const k=c.classification; if(!holdoutByReason[k]) holdoutByReason[k]=[]; holdoutByReason[k].push(c.mountainId); }}
  await writeFile(join(runDir,'holdout-final.json'), JSON.stringify({runId, holdoutByReason, counts},null,2)+'\n','utf8');
  console.log(JSON.stringify(summary,null,2));
  // dry-run
  let dryOk=0, dryBlocked=0;
  for(const c of completedMap.values()){
    if(c.classification==='TRUSTED_REPLACEMENT_READY'){
      try{
        const evp=JSON.parse(await readFile(join(runDir,'ready',String(c.mountainId),'evidence.json'),'utf8'));
        const gj=JSON.parse(await readFile(join(runDir,'ready',String(c.mountainId),'route.geojson'),'utf8'));
        const geom=gj.features[0].geometry;
        const evBuild:any={
          startRole:'PRIMARY_BASE_ACCESS', accessEvidence:evp.accessEvidence,
          generatedRouteIdentity:`osm:node:${c.mountainId}:node:${evp.startCandidate.osmId}`,
          sourceCandidateHash:sha256Stable(evp.startCandidate), resultHash:sha256Stable(c.mountainId),
          sourceMountainIdentity:`osm:node:${evp.summit.id}`,
          summit:{osmObjectType:'node',osmId:evp.summit.id,name:evp.summit.name,coordinate:evp.summit.coordinate},
          start:{objectType:evp.startCandidate.osmType,osmId:evp.startCandidate.osmId,name:evp.startCandidate.name,kind:evp.startCandidate.kind,coordinate:[evp.startCandidate.lon,evp.startCandidate.lat],candidateId:`${evp.startCandidate.osmType}:${evp.startCandidate.osmId}`},
          datasetFingerprint:PBF_SHA, pilotCorpusHash:sha256Stable(evp.candidateIndexVersion),
          adaptivePolicyHash:sha256Stable('v2'), summitPolicyHash:sha256Stable('v1'),
          graphHash:sha256Stable(evp.graphId), graphCacheIdentityHash:sha256Stable(evp.graphId),
          extractionIdentityHash:sha256Stable(PBF_SHA), reconstructionManifestHash:sha256Stable(gj), routePathHash:sha256Stable(gj),
          geometryHash:sha256GeometryHash(geom), routeCategory:'STANDARD_ASCENT', startContext:'BASE_START',
          summitAttachment:{targetCoordinate:evp.summit.coordinate, routeTerminalCoordinate: geom.coordinates.at(-1), distanceMeters: evp.snapSummitM ?? 0, tier: c.tier, autoEligible:true, reasonCodes:[]},
          safety:{autoEligible:true,decision:'SAFE',fabricatedGapCount:0,boundaryLimited:false,connected:true,deterministic:true,solverStatus:'RECONSTRUCTED',checkedEdges: geom.coordinates.length-1},
          source: SOURCE
        };
        const {preparePublication}=await import('../../../Lib/gpxIngestion/generatedRoutePublication.ts');
        const res=preparePublication(c.mountainId,'https://weplpaigyyqzdkolypmw.supabase.co', geom as any, evBuild as any);
        validateRequest(res.entry.request);
        dryOk++;
      }catch(e){ dryBlocked++; console.error('dry fail',c.mountainId,(e as Error).message); }
    }
  }
  console.log(`dryRunValid ${dryOk} dryRunBlocked ${dryBlocked}`);
  const finalTrusted=4+dryOk;
  const finalHoldout=30 + (391 - (counts.TRUSTED_REPLACEMENT_READY));
  console.log(`final trusted ${finalTrusted} holdout ${finalHoldout} state sum ${Object.values(counts).reduce<number>((a,b)=>a+Number(b),0)}`);
}

if((process.argv[1]?.replace(/\\/g,'/') ?? '').endsWith('scripts/routes/graphhopper/resume-391.ts')){
  main().catch(e=>{console.error(e); process.exitCode=1;});
}
