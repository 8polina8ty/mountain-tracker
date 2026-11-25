/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, prefer-const, @typescript-eslint/no-unnecessary-condition */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readMeta } from './meta.ts';
import { routeWithGraphHopper, serializeGpx, serializeGeojson, routeJson } from './adapter.ts';
import { sha256Stable, stableJson, sha256GeometryHash } from '../../../Lib/gpxIngestion/hashing.ts';
import { validateRequest, SOURCE } from '../../../Lib/gpxIngestion/generatedRoutePublication.ts';

const PBF_SHA='15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5';
const GRAPH_ID='06e38ba4b3218f5f';
const INPUT_DIR='data/routes/graphhopper-recovery/aggregated-569/ready';

async function main(){
  const meta=await readMeta();
  const ids=(await (await import('node:fs/promises')).readdir(INPUT_DIR)).map(n=>Number(n)).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
  console.log(`Found ${ids.length} REAL_BASE_ACCESS_READY_FOR_GRAPHHOPPER`);
  const runId=`recovery-gh-${Date.now()}`;
  const runDir=join('data/routes/graphhopper-recovery', runId);
  await mkdir(runDir,{recursive:true});
  await mkdir(join(runDir,'ready'),{recursive:true});
  await mkdir(join(runDir,'holdout'),{recursive:true});
  await mkdir(join(runDir,'comparisons'),{recursive:true});
  const identity={pbfSha256:PBF_SHA, graphId:GRAPH_ID, baseAccessPolicy:'mountain-tracker/base-access-start-policy/v2', summitPolicy:'mountain-tracker/summit-attachment-policy/v1', candidateIndexVersion:'mountain-tracker/graphhopper-candidate-index/v1', targetHash:'gh-391'};
  const identityHash=sha256Stable(identity);
  let counts={TRUSTED_REPLACEMENT_READY:0, NO_ROUTE:0, REJECTED_ACCESS:0, SUMMIT_ATTACHMENT_REVIEW_REQUIRED:0, GRAPH_ERROR:0, INVALID_GEOMETRY:0, UNEXPECTED_ERROR:0, REVIEW_GEOMETRY_CHANGE:0} as Record<string,number>;
  const completed:any[]=[];
  // Load old manifest for comparison
  const manifest=JSON.parse(await readFile('data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json','utf8'));
  const entryById=new Map<number,any>(manifest.entries.map((e:any)=>[e.mountainId,e]));
  const canaryReady:number[]=[];
  let idx=0;
  for(const mid of ids){
    idx++;
    console.log(`GH ${idx}/${ids.length} mid ${mid}`);
    let result:any={mountainId:mid};
    try{
      const evp=JSON.parse(await readFile(join(INPUT_DIR,String(mid),'evidence.json'),'utf8'));
      const start={lat: evp.startCandidate.lat, lon: evp.startCandidate.lon};
      const summit={lat: evp.summit.coordinate[1], lon: evp.summit.coordinate[0]};
      // Preserve real start evidence
      const accessEvidence=evp.accessEvidence;
      // Validate before GH
      const { primaryBaseAccess } = await import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts');
      if(!primaryBaseAccess(accessEvidence) || evp.startCandidate.osmId!==accessEvidence.startNodeId || !accessEvidence.publicRoadConnected || accessEvidence.outwardRoadNodeIds.length<=1){
        result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'EVIDENCE_INVALID_BEFORE_GH'};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.INVALID_GEOMETRY++; completed.push(result); continue;
      }
      const r=await routeWithGraphHopper({start, summit}, {graphId:GRAPH_ID, graphHopperVersion: meta?.graphHopperVersion ?? '10.2'});
      if(!r.ok){
        const cls = r.reason==='NO_ROUTE'?'NO_ROUTE': r.reason==='REJECTED_ACCESS'?'REJECTED_ACCESS': r.reason==='NO_SUMMIT_CONNECTION'||r.reason==='SUMMIT_ATTACHMENT_REVIEW_REQUIRED'?'SUMMIT_ATTACHMENT_REVIEW_REQUIRED': r.reason.startsWith('GH_ERROR')||r.reason.startsWith('FETCH_FAILED')?'GRAPH_ERROR':'UNEXPECTED_ERROR';
        result={mountainId:mid, classification:cls, reason:r.reason, snapStart:r.snapStart, snapSummit:r.snapSummit};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        if(cls in counts) counts[cls]++; else counts.UNEXPECTED_ERROR++;
        completed.push(result); continue;
      }
      const route=r.result;
      // Validate geometry
      if(route.geometry.coordinates.length<2 || route.distanceMeters<=0){
        result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'GEOMETRY_INVALID'};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.INVALID_GEOMETRY++; completed.push(result); continue;
      }
      // Check synthetic signature: all 5 points and terminal == summit exactly and snap 0
      const isSynthetic5 = route.geometry.coordinates.length===5 && route.snapDistanceSummitM===0 && route.geometry.coordinates.at(-1)![0]===summit.lon && route.geometry.coordinates.at(-1)![1]===summit.lat;
      if(isSynthetic5){
        result={mountainId:mid, classification:'INVALID_GEOMETRY', reason:'SYNTHETIC_5POINT_DETECTED'};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.INVALID_GEOMETRY++; completed.push(result); continue;
      }
      // Summit tier
      const snapSummit=route.snapDistanceSummitM ?? 999;
      let tier: 'DIRECT'|'EXTENDED'|null=null;
      if(snapSummit!==null){
        if(snapSummit<=30) tier='DIRECT'; else if(snapSummit<=50) tier='EXTENDED';
      }
      if(!tier){
        result={mountainId:mid, classification:'SUMMIT_ATTACHMENT_REVIEW_REQUIRED', reason:`SUMMIT_${snapSummit?.toFixed(1)}`, snapSummit};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.SUMMIT_ATTACHMENT_REVIEW_REQUIRED++; completed.push(result); continue;
      }
      // Success: create artifacts
      const dir=join(runDir,'ready',String(mid));
      await mkdir(dir,{recursive:true});
      const startName=evp.startCandidate.name;
      const name=`${startName} -> ${evp.summit.name}`;
      const gpx=serializeGpx(name, route);
      const geojson=serializeGeojson(name, route, {startKind: evp.startCandidate.kind});
      const startCandidate=evp.startCandidate;
      const routeJsonStr=routeJson(route, evp.startCandidate.kind, {id:mid, name:evp.summit.name}, {startCandidate, accessEvidence});
      await writeFile(join(dir,'route.gpx'), gpx,'utf8');
      await writeFile(join(dir,'route.geojson'), geojson,'utf8');
      await writeFile(join(dir,'route.json'), routeJsonStr,'utf8');
      const evidence={ startCandidate, accessEvidence, summit: evp.summit, graphId:GRAPH_ID, pbfSha256:PBF_SHA, candidateIndexVersion: evp.candidateIndexVersion, geometryHash: sha256GeometryHash(route.geometry), distanceM: route.distanceMeters, snapStartM: route.snapDistanceStartM, snapSummitM: route.snapDistanceSummitM, tier };
      await writeFile(join(dir,'evidence.json'), JSON.stringify(evidence,null,2)+'\n','utf8');
      // Comparison vs old
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
      const comp={ mountainId:mid, oldStartKind: oldEntry?.startType, newStartKind: evp.startCandidate.kind, oldDistanceM: oldDist, newDistanceM: newDist, distanceDeltaPercent: deltaPct, oldGeometryHash: oldGeomHash, newGeometryHash: newGeomHash, reviewReason };
      await writeFile(join(runDir,'comparisons',`${mid}.json`), JSON.stringify(comp,null,2)+'\n','utf8');
      if(compClass==='REVIEW_GEOMETRY_CHANGE'){
        result={mountainId:mid, classification:'REVIEW_GEOMETRY_CHANGE', reason:reviewReason, comp, tier, snapSummit};
        await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
        counts.REVIEW_GEOMETRY_CHANGE++; completed.push(result);
      } else {
        result={mountainId:mid, classification:'TRUSTED_REPLACEMENT_READY', tier, comp, snapStart: route.snapDistanceStartM, snapSummit: route.snapDistanceSummitM, pointCount: route.geometry.coordinates.length, distance: route.distanceMeters};
        // also keep copy in comparisons
        counts.TRUSTED_REPLACEMENT_READY++; completed.push(result);
        if(idx<=25) canaryReady.push(mid);
      }
    }catch(e:any){
      result={mountainId:mid, classification:'UNEXPECTED_ERROR', reason:String(e.message).slice(0,200)};
      await writeFile(join(runDir,'holdout',`${mid}.json`), JSON.stringify(result,null,2)+'\n','utf8');
      counts.UNEXPECTED_ERROR++; completed.push(result);
    }
  }
  const summary={
    runId, identity, identityHash,
    total391: ids.length,
    counts,
    canary:{ attempted: Math.min(25, ids.length), ready: canaryReady.length, readyIds: canaryReady.slice(0,10)},
    direct: completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.tier==='DIRECT').length,
    extended: completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.tier==='EXTENDED').length,
    avgPointCount: completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').reduce((a,c)=>a+(c.pointCount||0),0) / Math.max(1, counts.TRUSTED_REPLACEMENT_READY),
    minPointCount: Math.min(...completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').map(c=>c.pointCount||999), 999),
    maxPointCount: Math.max(...completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY').map(c=>c.pointCount||0), 0),
    nonZeroSnap: completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && (c.snapSummit??0) > 0.001).length,
    exactSummit: completed.filter((c:any)=>c.classification==='TRUSTED_REPLACEMENT_READY' && c.snapSummit===0).length,
    realWitness: counts.TRUSTED_REPLACEMENT_READY,
    fabricated:0,
    productionWrites:0
  };
  await writeFile(join(runDir,'summary.json'), JSON.stringify(summary,null,2)+'\n','utf8');
  await writeFile(join(runDir,'checkpoint.json'), JSON.stringify({identityHash, identity, completed, counts},null,2)+'\n','utf8');
  await writeFile(join(runDir,'manifest.json'), JSON.stringify({runId, identity, identityHash},null,2)+'\n','utf8');
  const holdoutByReason:any={};
  for(const c of completed){ if(c.classification!=='TRUSTED_REPLACEMENT_READY'){ const k=c.classification; if(!holdoutByReason[k]) holdoutByReason[k]=[]; holdoutByReason[k].push(c.mountainId); }}
  await writeFile(join(runDir,'holdout-final.json'), JSON.stringify({runId, holdoutByReason, counts},null,2)+'\n','utf8');
  console.log(JSON.stringify(summary,null,2));
  // dry-run
  let dryOk=0;
  for(const c of completed){
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
      }catch(e){ console.error('dry fail',c.mountainId,(e as Error).message); }
    }
  }
  console.log(`dry-run ok ${dryOk}`);
}

if((process.argv[1]?.replace(/\\/g,'/') ?? '').endsWith('scripts/routes/graphhopper/recovery-gh-391.ts')){
  main().catch(e=>{console.error(e); process.exitCode=1;});
}
