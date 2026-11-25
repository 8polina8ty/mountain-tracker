/* eslint-disable @typescript-eslint/no-explicit-any */
/** Stratified 60-target representative gate. Real DB → BaseAccess V2 → real GraphHopper → frozen artifacts.
 * Strict real source, height>=700, no synthetic fallback, no production writes.
 */
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseAccessNetwork, primaryBaseAccess, primaryStartPriority, publicApproachRoad, type BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { buildReconstructionPbfBlockGraph } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { calculateCoordinateDistanceMeters } from '../../../Lib/gpxIngestion/gpxNormalization.ts';
import { loadCandidateIndex, boundedCandidatesForSummit, type CandidateIndex } from './candidate-index.ts';
import { routeWithGraphHopper, routeJson, serializeGeojson, serializeGpx } from './adapter.ts';
import { blockFor, loadBlockWays } from './pbf-block-loader.ts';
import { checkGraphIdentity, graphHealthy, withGraphHopper } from './lifecycle.ts';
import { atomicJson, BULK_DIR, hash, IDENTITY, inCoverage, primaryCounts, readJson, validHeight, type Mountain, type PrimaryState } from './bulk700-contract.ts';

type Engine = 'GRAPH_HOPPER' | 'OSM_DIJKSTRA_FALLBACK';
type Attempt = { routingEngine: Engine; ms: number; fetchFailed: boolean; snapStartM?: number | null; snapSummitM?: number | null; reason?: string | null };
export type StratifiedResult = {
  mountainId: number; state: PrimaryState; reviewFlags: string[]; reason: string | null;
  routingEngine: Engine; graphId: string; pbfSha256: string; profile: string; fallbackReason: string | null;
  attempts: Attempt[]; baseAccessMs: number; routingMs: number; artifactWriteMs: number;
  artifacts: Record<string, string>; syntheticGeometryCount: number; fabricatedEvidenceCount: number;
  // diagnostics for summit analysis
  bestSummitSnapM: number | null; bestStartSnapM: number | null; terminalCoord: [number, number] | null;
};
type Checkpoint = { runHash: string; inventoryHash: string; mode: string; completed: StratifiedResult[]; rejectedTargets: { mountainId:number; reason:string }[] };

function classify(reason: string): PrimaryState {
  if (reason === 'NO_ROUTE') return 'NO_ROUTE';
  if (reason === 'REJECTED_ACCESS') return 'REJECTED_ACCESS';
  if (/SUMMIT/.test(reason)) return 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED';
  if (/GEOMETRY/.test(reason)) return 'INVALID_GEOMETRY';
  if (/FETCH_FAILED|GH_ERROR|OSM_FALLBACK|BLOCK|OSMIUM|PY_PARSE/.test(reason)) return 'GRAPH_ERROR';
  return 'UNEXPECTED_ERROR';
}
export function summarize(rows: StratifiedResult[], _targetCount:number) {
  const counts = primaryCounts(rows);
  const attempts = rows.flatMap(r=>r.attempts);
  const gh = attempts.filter(a=>a.routingEngine==='GRAPH_HOPPER'), fb = attempts.filter(a=>a.routingEngine==='OSM_DIJKSTRA_FALLBACK');
  const ready = rows.filter(r=>r.state==='TRUSTED_REPLACEMENT_READY');
  const ghMs = gh.reduce((n,a)=>n+a.ms,0), fbMs = fb.reduce((n,a)=>n+a.ms,0);
  const baseAccessMs = rows.reduce((n,r)=>n+r.baseAccessMs,0), artifactWriteMs = rows.reduce((n,r)=>n+r.artifactWriteMs,0);
  return {
    processed: rows.length, counts, primaryStateSumCorrect: Object.values(counts).reduce((a,b)=>a+b,0)===rows.length,
    graphHopperAttempts: gh.length, fetchFailed: gh.filter(a=>a.fetchFailed).length, globalFetchFailedRate: gh.length?gh.filter(a=>a.fetchFailed).length/gh.length:null,
    graphHopperSuccess: ready.filter(r=>r.routingEngine==='GRAPH_HOPPER').length, fallbackSuccess: ready.filter(r=>r.routingEngine==='OSM_DIJKSTRA_FALLBACK').length,
    baseAccessMs, routingMs: ghMs+fbMs, artifactWriteMs,
    graphHopperRoutesPerMinute: ghMs? ready.filter(r=>r.routingEngine==='GRAPH_HOPPER').length*60_000/ghMs:null,
    graphHopperAttemptsPerMinute: ghMs? gh.length*60_000/ghMs:null,
    fallbackRoutesPerMinute: fbMs? ready.filter(r=>r.routingEngine==='OSM_DIJKSTRA_FALLBACK').length*60_000/fbMs:null,
    syntheticGeometryCount: rows.reduce((n,r)=>n+r.syntheticGeometryCount,0), fabricatedEvidenceCount: rows.reduce((n,r)=>n+r.fabricatedEvidenceCount,0),
    reviewFlagCounts: { REVIEW_GEOMETRY_CHANGE: rows.filter(r=>r.reviewFlags.includes('REVIEW_GEOMETRY_CHANGE')).length }, productionWrites:0,
    // summit buckets
    summitBuckets: (()=> {
      const b={ le30:0, b30_50:0, b50_100:0, b100_250:0, gt250:0, null:0 };
      for(const r of rows){
        const v=r.bestSummitSnapM;
        if(v===null||v===undefined) b.null++;
        else if(v<=30) b.le30++;
        else if(v<=50) b.b30_50++;
        else if(v<=100) b.b50_100++;
        else if(v<=250) b.b100_250++;
        else b.gt250++;
      }
      return b;
    })(),
    summitStats: (()=>{
      const vals=rows.map(r=>r.bestSummitSnapM).filter((v):v is number=> typeof v==='number');
      if(!vals.length) return { median:null,p90:null,max:null, min:null };
      vals.sort((a,b)=>a-b);
      const med= vals[Math.floor(vals.length/2)];
      const p90= vals[Math.floor(vals.length*0.9)];
      const max= vals[vals.length-1];
      const min= vals[0];
      return { median:med, p90, max, min, count: vals.length };
    })(),
  };
}

export async function runStratified() {
  const inv = await readJson<{ inventoryHash:string; identity: typeof IDENTITY; targets: Mountain[] }>(`${BULK_DIR}/inventory.json`);
  const strat = await readJson<{ meta:{ inventoryHash:string; hash:string }; targets: Mountain[] }>(`${BULK_DIR}/canary-stratified/targets.json`);
  if (strat.meta.inventoryHash !== inv.inventoryHash) throw new Error('STRATIFIED_INVENTORY_MISMATCH');
  if (hash(inv.identity)!==hash(IDENTITY)) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: invalid identity');
  if (strat.targets.length!==60) throw new Error('STRATIFIED_REQUIRES_60');
  // strict guards
  if (strat.targets.some(m=>!validHeight(m))) throw new Error('INVALID_HEIGHT_FOR_BULK');
  if (strat.targets.some(m=>!inCoverage(m))) throw new Error('STRATIFIED_OUT_OF_COVERAGE');
  const runDir = `${BULK_DIR}/canary-stratified/run`;
  await mkdir(runDir,{recursive:true});
  const lockPath = `${BULK_DIR}/canary-stratified/runner.lock`;
  const lock = await open(lockPath,'wx').catch(()=>{ throw new Error('STRATIFIED_LOCK_EXISTS'); });
  await lock.writeFile(JSON.stringify({pid:process.pid, mode:'stratified', at:new Date().toISOString()}));
  try {
    const sourceFiles=['bulk700-stratified-run.ts','bulk700-contract.ts','bulk700-inventory.ts','adapter.ts','lifecycle.ts','pbf-block-loader.ts','candidate-index.ts','../../../Lib/gpxIngestion/baseAccessStartPolicy.ts','../../../Lib/gpxIngestion/pbfBlockGraph.ts','../../../Lib/gpxIngestion/osmTrailGraph.ts','../../../Lib/gpxIngestion/gpxNormalization.ts','../../osm-import/phase11c9-road-safety.ts'];
    const sourceHash=hash(await Promise.all(sourceFiles.map(p=>readFile(`scripts/routes/graphhopper/${p}`,'utf8'))));
    const index=await loadCandidateIndex();
    if(!index||index.pbfSha256!==IDENTITY.pbfSha256||index.count!==index.candidates.length) throw new Error('REAL_CANDIDATE_INDEX_UNAVAILABLE');
    const runHash=hash({identity:IDENTITY, inventoryHash:inv.inventoryHash, stratifiedHash: strat.meta.hash, sourceHash, candidateHash: hash(index)});
    let cp: Checkpoint={runHash, inventoryHash: inv.inventoryHash, mode:'stratified', completed:[], rejectedTargets:[]};
    try{
      const saved=await readJson<Omit<Checkpoint,'completed'> & {completedCount:number}>(`${runDir}/checkpoint.json`);
      cp={...saved, completed:[]};
      for(const dir of ['results','holdout']){
        const files=await readdir(`${runDir}/${dir}`).catch((e:NodeJS.ErrnoException)=>{ if(e.code==='ENOENT') return []; throw e; });
        for(const name of files.filter(n=>/^\d+\.json$/.test(n))) cp.completed.push(await readJson<StratifiedResult>(`${runDir}/${dir}/${name}`));
      }
      if(cp.completed.length < saved.completedCount || cp.completed.length > saved.completedCount+1) throw new Error('CHECKPOINT_RESULT_COUNT_MISMATCH');
    } catch(e){ if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    const stratIds=new Set(strat.targets.map(m=>m.id));
    if(cp.runHash!==runHash || new Set(cp.completed.map(r=>r.mountainId)).size!==cp.completed.length || cp.completed.some(r=>!stratIds.has(r.mountainId))) throw new Error('CHECKPOINT_IDENTITY_OR_DUPLICATE');
    primaryCounts(cp.completed);
    // verify artifacts for ready
    for(const row of cp.completed){
      if(row.graphId!==IDENTITY.graphId||row.pbfSha256!==IDENTITY.pbfSha256||row.profile!==IDENTITY.profile) throw new Error('RESULT_IDENTITY_MISMATCH');
      if(row.state==='TRUSTED_REPLACEMENT_READY' && Object.keys(row.artifacts).length!==4) throw new Error('READY_ARTIFACTS_MISSING');
      for(const [path,expected] of Object.entries(row.artifacts)){
        if(!path.startsWith(`ready/${row.mountainId}/`)||path.includes('..')||hash(await readFile(join(runDir,path),'utf8'))!==expected) throw new Error('CHECKPOINT_ARTIFACT_MISMATCH');
      }
    }
    const counts=primaryCounts(cp.completed);
    const checkpoint=()=> atomicJson(`${runDir}/checkpoint.json`,{runHash: cp.runHash, inventoryHash: cp.inventoryHash, mode:'stratified', completedCount: cp.completed.length, counts, rejectedTargets: cp.rejectedTargets});
    await checkpoint();
    const completedIds=new Set(cp.completed.map(r=>r.mountainId));
    const grid=new Map<string, CandidateIndex['candidates']>();
    for(const c of index.candidates){
      if(c.osmType!=='node'||primaryStartPriority(c.kind)===99) continue;
      const key=blockFor(c.lon,c.lat), bucket=grid.get(key)??[];
      bucket.push(c); grid.set(key,bucket);
    }
    index.candidates=[];
    const contexts=new Map<string, {ways: Awaited<ReturnType<typeof loadBlockWays>>}>();
    const witnessCache=new Map<string, BaseAccessEvidence>();
    const meta=await checkGraphIdentity();
    const context=async(lon:number,lat:number)=>{
      const key=blockFor(lon,lat);
      let ctx=contexts.get(key);
      if(!ctx){ if(contexts.size>=2) contexts.delete(contexts.keys().next().value!); ctx={ways: await loadBlockWays(key, IDENTITY.pbfSha256)}; contexts.set(key,ctx); }
      return ctx;
    };
    let serverHealthy=false;
    let infrastructureError: string|null=null;
    try{
      if(completedIds.size!==strat.targets.length) await withGraphHopper(meta, `${runDir}/graphhopper.log`, 2_700_000, async signal=>{
        serverHealthy=true;
        for(const m of strat.targets){
          if(completedIds.has(m.id)) continue;
          signal.throwIfAborted();
          if(!validHeight(m)){ if(!cp.rejectedTargets.some(r=>r.mountainId===m.id)) cp.rejectedTargets.push({mountainId:m.id, reason:'INVALID_HEIGHT_FOR_BULK'}); await checkpoint(); continue; }
          if(!(await graphHealthy(signal))) throw new Error('GRAPHHOPPER_GLOBAL_HEALTH_LOST');
          const result: StratifiedResult={mountainId:m.id, state:'NO_REAL_BASE_ACCESS_CANDIDATE', reviewFlags:[], reason:'NO_PRIMARY_BASE_ACCESS_WITNESS', routingEngine:'GRAPH_HOPPER', ...IDENTITY, fallbackReason:null, attempts:[], baseAccessMs:0, routingMs:0, artifactWriteMs:0, artifacts:{}, syntheticGeometryCount:0, fabricatedEvidenceCount:0, bestSummitSnapM:null, bestStartSnapM:null, terminalCoord:null};
          let discoveryStart=performance.now();
          let bestSnap: number|null=null;
          let bestStart: number|null=null;
          let bestTerminal: [number,number]|null=null;
          try{
            const [x,y]=blockFor(m.longitude!,m.latitude!).split('_').map(Number);
            const nearby=[] as CandidateIndex['candidates'];
            for(let dx=-2;dx<=2;dx++) for(let dy=-1;dy<=1;dy++) nearby.push(...(grid.get(`${x+dx}_${y+dy}`)??[]));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pool=boundedCandidatesForSummit({ ...index, candidates: nearby } as any, {lon:m.longitude!, lat:m.latitude!}, 20);
            const summitContext=await context(m.longitude!,m.latitude!);
            const roadNodes=new Map<number, CandidateIndex['candidates'][number] & { sourceWayId:number; sourceKind:string }>();
            for(const way of summitContext.ways){
              if(!publicApproachRoad(way)) continue;
              for(const node of [way.nodes[0], way.nodes.at(-1)]){
                if(!node?.coordinate||calculateCoordinateDistanceMeters(node.coordinate,[m.longitude!,m.latitude!])>20_000) continue;
                roadNodes.set(node.nodeId,{osmType:'node', osmId:node.nodeId, kind:'NETWORK_ACCESS', name:null, lon:node.coordinate[0], lat:node.coordinate[1], tags:{}, sourceWayId:way.id, sourceKind:'OSM_PUBLIC_WAY_ENDPOINT'});
              }
            }
            pool.push(...[...roadNodes.values()].sort((a,b)=>calculateCoordinateDistanceMeters([a.lon,a.lat],[m.longitude!,m.latitude!])-calculateCoordinateDistanceMeters([b.lon,b.lat],[m.longitude!,m.latitude!])).slice(0,20));
            for(const cand of pool){
              signal.throwIfAborted();
              const witnessKey=`${cand.kind}:${cand.osmId}`;
              let witness=witnessCache.get(witnessKey);
              if(!witness){
                const ctx=await context(cand.lon,cand.lat);
                const ways=ctx.ways.filter(w=>w.nodes.some(n=>n.coordinate && Math.abs(n.coordinate[0]-cand.lon)<=0.03 && Math.abs(n.coordinate[1]-cand.lat)<=0.02));
                const graph=buildReconstructionPbfBlockGraph({datasetKey:'local-osm-pbf',region:'alps',snapshotTimestamp:new Date(meta.pbfModifiedMs).toISOString(),pbfSha256:IDENTITY.pbfSha256}, ways);
                const node=graph.node(cand.osmId);
                if(!node||calculateCoordinateDistanceMeters(node.coordinate,[cand.lon,cand.lat])>1) continue;
                witness=new BaseAccessNetwork(ways).evaluate({kind:cand.kind,tags:cand.tags,nodeId:cand.osmId,graph});
                if(witnessCache.size>=10_000) witnessCache.delete(witnessCache.keys().next().value!);
                witnessCache.set(witnessKey,witness);
              }
              const evidence: BaseAccessEvidence={...witness, summitElevation:m.height};
              if(!primaryBaseAccess(evidence)) continue;
              result.baseAccessMs+=performance.now()-discoveryStart;
              const routeStart=performance.now();
              const response=await routeWithGraphHopper({start:{lat:cand.lat, lon:cand.lon}, summit:{lat:m.latitude!, lon:m.longitude!}}, {
                graphId: IDENTITY.graphId, graphHopperVersion: meta.graphHopperVersion, signal, allowFallbackAfterHealthy:true,
                onAttempt:(routingEngine,ms,fetchFailed)=>{ result.attempts.push({routingEngine, ms, fetchFailed}); result.routingEngine=routingEngine; if(fetchFailed) result.fallbackReason='FETCH_FAILED'; }
              });
              // capture snap distances even on failure (adapter includes snap)
              if(!response.ok){
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const snapStart=(response as any).snapStart as number|null|undefined;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const snapSummit=(response as any).snapSummit as number|null|undefined;
                const entry=result.attempts[result.attempts.length-1];
                if(entry){ entry.snapStartM=snapStart??null; entry.snapSummitM=snapSummit??null; entry.reason=response.reason; }
                if(typeof snapSummit==='number' && (bestSnap===null || snapSummit < bestSnap)){ bestSnap=snapSummit; bestStart=snapStart??null; }
                result.routingMs+=performance.now()-routeStart;
                discoveryStart=performance.now();
                result.state=classify(response.reason); result.reason=response.reason; continue;
              }
              const route=response.result;
              const coords=route.geometry.coordinates;
              if(coords.length<2||!Number.isFinite(route.distanceMeters)||route.distanceMeters<=0||coords.some(c=>!Array.isArray(c)||c.length!==2||!c.every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>90)){
                result.state='INVALID_GEOMETRY'; result.reason='INVALID_ROUTED_GEOMETRY'; result.routingMs+=performance.now()-routeStart; discoveryStart=performance.now(); continue;
              }
              const snap=calculateCoordinateDistanceMeters(coords.at(-1)!,[m.longitude!,m.latitude!]);
              const startSnap=calculateCoordinateDistanceMeters(coords[0],[cand.lon,cand.lat]);
              // update best
              if(bestSnap===null || snap < bestSnap){ bestSnap=snap; bestStart=startSnap; bestTerminal=coords.at(-1) as [number,number]; }
              const entry=result.attempts[result.attempts.length-1];
              if(entry){ entry.snapStartM=startSnap; entry.snapSummitM=snap; entry.reason='OK'; }
              result.routingMs+=performance.now()-routeStart;
              discoveryStart=performance.now();
              if(startSnap>150){ result.state='REJECTED_ACCESS'; result.reason='START_SNAP_EXCEEDS_150M'; continue; }
              if(snap>50){ result.state='SUMMIT_ATTACHMENT_REVIEW_REQUIRED'; result.reason='SUMMIT_SNAP_EXCEEDS_50M'; continue; }
              result.state='TRUSTED_REPLACEMENT_READY'; result.reason=null;
              result.routingEngine=route.routingEngine; result.fallbackReason=route.fallbackReason??null;
              if(route.distanceMeters<500||route.distanceMeters>50_000) result.reviewFlags.push('REVIEW_GEOMETRY_CHANGE');
              result.baseAccessMs+=performance.now()-discoveryStart;
              const writeStart=performance.now();
              const prefix=`ready/${m.id}`;
              await mkdir(join(runDir,prefix),{recursive:true});
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const name=`${(cand as any).name ?? cand.kind} → ${m.name}`;
              const artifacts: Record<string,string>={
                'route.gpx': serializeGpx(name, route), 'route.geojson': serializeGeojson(name, route),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                'route.json': routeJson(route, cand.kind, {id:m.id, name:m.name}, {startCandidate: cand as any, accessEvidence: evidence}),
                'evidence.json': JSON.stringify({...IDENTITY, startCandidate: cand, accessEvidence: evidence, mountain:m, geometryHash: hash(route.geometry), summitAttachment:{distanceMeters:snap, tier: snap<=30?'DIRECT':'EXTENDED', terminal: coords.at(-1)}, routingEngine: route.routingEngine, fallbackReason: route.fallbackReason??null},null,2),
              };
              for(const [file,content] of Object.entries(artifacts)){ await writeFile(join(runDir,prefix,file),content); result.artifacts[`${prefix}/${file}`]=hash(content); }
              result.artifactWriteMs+=performance.now()-writeStart;
              discoveryStart=performance.now();
              break;
            }
          }catch(e){
            signal.throwIfAborted();
            result.reason=e instanceof Error?e.message:'UNKNOWN_ERROR'; result.state=classify(result.reason); result.artifacts={};
          }
          result.baseAccessMs+=performance.now()-discoveryStart;
          result.bestSummitSnapM=bestSnap;
          result.bestStartSnapM=bestStart;
          result.terminalCoord=bestTerminal;
          const writeStart=performance.now();
          await atomicJson(`${runDir}/${result.state==='TRUSTED_REPLACEMENT_READY'?'results':'holdout'}/${m.id}.json`, result);
          result.artifactWriteMs+=performance.now()-writeStart;
          cp.completed.push(result); completedIds.add(m.id);
          counts[result.state]++;
          await checkpoint();
          console.log(`stratified ${cp.completed.length}/${strat.targets.length}: ${m.id} ${result.state} ${result.routingEngine} snap=${bestSnap}`);
          if(result.attempts.some(a=>a.fetchFailed) && !(await graphHealthy(signal))) throw new Error('GRAPHHOPPER_GLOBAL_HEALTH_LOST');
        }
      });
    }catch(e){ infrastructureError=e instanceof Error?e.message:'UNKNOWN_INFRASTRUCTURE_ERROR'; }
    const summary=summarize(cp.completed, inv.targets.length);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readyForFull700mBulk = !infrastructureError && cp.rejectedTargets.length===0 && summary.processed===strat.targets.length && summary.graphHopperAttempts>0 && (summary as any).graphHopperSuccess>0 && (summary as any).globalFetchFailedRate!==1 && summary.syntheticGeometryCount===0 && summary.fabricatedEvidenceCount===0;
    await atomicJson(`${BULK_DIR}/canary-stratified/report.json`, {...summary, inventoryHash: inv.inventoryHash, stratifiedHash: strat.meta.hash, sourceHash, serverHealthy, infrastructureError, readyForFull700mBulk, checkpointResumeReady:true, rejectedTargets: cp.rejectedTargets, targetCount: inv.targets.length, stratifiedTargetCount: strat.targets.length, remainingUnprocessed: inv.targets.length - cp.completed.length, mode:'stratified', shutdownComplete: infrastructureError!=='GRAPHHOPPER_SHUTDOWN_UNCONFIRMED'});
    console.log(JSON.stringify({...summary, serverHealthy, infrastructureError, readyForFull700mBulk},null,2));
    if(!readyForFull700mBulk) process.exitCode=1;
  } finally{ await lock.close(); await unlink(lockPath).catch(()=>{}); }
}
if(process.argv[1]?.replace(/\\/g,'/').endsWith('/bulk700-stratified-run.ts')){
  runStratified().catch(e=>{ console.error(e instanceof Error?e.message:String(e)); process.exitCode=1; });
}
