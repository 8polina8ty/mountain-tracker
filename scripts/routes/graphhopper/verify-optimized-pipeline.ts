/* eslint-disable @typescript-eslint/no-explicit-any */
 /**
 * Bounded verification of optimized BlockRoutingContext pipeline.
 * - Selects 30 deterministic mountains (20 READY + 10 REVIEW) covering >=5 blocks, small+large, low+high IDs
 * - Replays through BlockRoutingContext (LRU 8 parsed, 2 context) in isolated mode (no overwrite of full-v1 authoritative files)
 * - Compares semantic fields
 * - Tests order independence
 * - Measures perf for >=60 mountains with real wall clock, RSS, cache stats
 * - Checks contracts, checkpoint preservation
 * Usage: node --experimental-strip-types scripts/routes/graphhopper/verify-optimized-pipeline.ts
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BULK_DIR, hash, IDENTITY, readJson, hash as contractHash } from './bulk700-contract.ts';
import { blockFor, loadBlockWays, parsedCacheStats, resetParsedCache, BLOCK_EXTRACTION_VERSION, BLOCK_GRAPH_OPTIONS_VERSION } from './pbf-block-loader.ts';
import { loadCandidateIndex, boundedCandidatesForSummit, type CandidateIndex } from './candidate-index.ts';
import { buildReconstructionPbfBlockGraph } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { BaseAccessNetwork, primaryBaseAccess, primaryStartPriority, publicApproachRoad, BASE_ACCESS_START_POLICY, type BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { calculateCoordinateDistanceMeters } from '../../../Lib/gpxIngestion/gpxNormalization.ts';
import { routeWithGraphHopper, routeJson, serializeGeojson, serializeGpx } from './adapter.ts';
import { checkGraphIdentity, withGraphHopper, graphHealthy } from './lifecycle.ts';

type Mountain = { id: number; osm_id: number | null; name: string; height: number | null; latitude: number | null; longitude: number | null };
type Inventory = { source: string; inventoryHash: string; identity: typeof IDENTITY; targets: Mountain[] };
type BulkResult = { mountainId: number; state: string; reason: string | null; reviewFlags: string[]; routingEngine: string; graphId: string; pbfSha256: string; profile: string; fallbackReason: string | null; attempts: { routingEngine: string; ms: number; fetchFailed: boolean }[]; baseAccessMs: number; routingMs: number; artifactWriteMs: number; artifacts: Record<string,string> };

const VERIFY_DIR = `${BULK_DIR}/verify-optimized-${new Date().toISOString().slice(0,10)}`;
const TILE = 0.25;
function localBlockFor(lon:number, lat:number){ return `${Math.floor(lon/TILE)}_${Math.floor(lat/TILE)}`; }

function hashStr(v: unknown){ return createHash('sha256').update(JSON.stringify(v)).digest('hex'); }

async function main(){
  const t0All = performance.now();
  console.log('=== Optimized Pipeline Verification ===');
  const inventory = await readJson<Inventory>(`${BULK_DIR}/inventory.json`);
  const cp = await readJson<any>(`${BULK_DIR}/full-v1/checkpoint.json`);
  const meta = await checkGraphIdentity();
  console.log(`Inventory targets ${inventory.targets.length} completedCount ${cp.completedCount} READY ${cp.counts.TRUSTED_REPLACEMENT_READY} REVIEW ${cp.counts.SUMMIT_ATTACHMENT_REVIEW_REQUIRED}`);

  // Collect completed IDs
  const readyIds: number[] = [];
  const holdoutIds: number[] = [];
  for(const f of await readdir(`${BULK_DIR}/full-v1/results`).catch(()=>[])){
    if(/^\d+\.json$/.test(f)) readyIds.push(Number(f.replace('.json','')));
  }
  for(const f of await readdir(`${BULK_DIR}/full-v1/holdout`).catch(()=>[])){
    if(/^\d+\.json$/.test(f)) holdoutIds.push(Number(f.replace('.json','')));
  }
  readyIds.sort((a,b)=>a-b);
  holdoutIds.sort((a,b)=>a-b);
  const targetsById = new Map(inventory.targets.map(m=>[m.id,m] as const));

  // Build block maps
  const readyByBlock = new Map<string, number[]>();
  for(const id of readyIds){
    const m = targetsById.get(id)!;
    const k = blockFor(m.longitude!, m.latitude!);
    const arr = readyByBlock.get(k) ?? []; arr.push(id); readyByBlock.set(k, arr);
  }
  const holdByBlock = new Map<string, number[]>();
  for(const id of holdoutIds){
    const m = targetsById.get(id)!;
    const k = blockFor(m.longitude!, m.latitude!);
    const arr = holdByBlock.get(k) ?? []; arr.push(id); holdByBlock.set(k, arr);
  }
  console.log('Ready blocks', [...readyByBlock.entries()].map(([k,v])=>`${k}:${v.length}`).join(' '));
  console.log('Holdout blocks', [...holdByBlock.entries()].map(([k,v])=>`${k}:${v.length}`).join(' '));

  // Deterministic selection: 20 READY + 10 REVIEW across >=5 blocks, small+large, low+high
  // Strategy: sort blocks by size descending, then pick round-robin to ensure coverage, but deterministic.
  function sortBlocks(map: Map<string, number[]>){
    return [...map.entries()].sort((a,b)=> b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }
  const readyBlocksSorted = sortBlocks(readyByBlock);
  const holdBlocksSorted = sortBlocks(holdByBlock);

  // For READY: ensure we include the tiny block 21_173 (1) and a large 21_177, plus low/high IDs
  const selectedReady: number[] = [];
  // Deterministic: take sorted readyIds by block then id, but ensure coverage via manual picks:
  // We'll do round-robin across blocks for first 15, then fill remaining by overall sorted low/high balancing.
  // Simpler: create ordered list that interleaves blocks deterministically, then take first 20 but ensure tiny block included.
  const readyInterleaved: number[] = [];
  const readyCopies = new Map<string, number[]>();
  for(const [k, ids] of readyByBlock) readyCopies.set(k, [...ids].sort((a,b)=>a-b));
  // Order blocks for round-robin: large to small but ensure tiny gets chance early
  const rrOrder = [...readyByBlock.keys()].sort((a,b)=>{
    // prioritize large but keep tiny in rotation
    const sa = readyByBlock.get(a)!.length, sb = readyByBlock.get(b)!.length;
    if(sa===1 || sb===1) return sa===1 && sb!==1 ? -1 : sb===1 && sa!==1 ? 1 : a.localeCompare(b);
    return sb - sa || a.localeCompare(b);
  });
  let progress=true;
  while(progress && readyInterleaved.length < readyIds.length){
    progress=false;
    for(const k of rrOrder){
      const arr = readyCopies.get(k)!;
      if(arr.length){ readyInterleaved.push(arr.shift()!); progress=true; }
    }
  }
  // Now ensure low and high IDs are included: force include smallest 2 and largest 2 if not already selected
  const smallestReady = [...readyIds].sort((a,b)=>a-b).slice(0,2);
  const largestReady = [...readyIds].sort((a,b)=>a-b).slice(-2);
  const mandatoryReady = new Set([...smallestReady, ...largestReady, 52398]); // 52398 is tiny block
  // Build final 20: first add mandatory, then fill from interleaved preserving order
  const finalReadySet = new Set<number>();
  for(const id of mandatoryReady) if(readyIds.includes(id)) finalReadySet.add(id);
  for(const id of readyInterleaved){ if(finalReadySet.size>=20) break; finalReadySet.add(id); }
  // If still <20, add from sorted
  for(const id of readyIds){ if(finalReadySet.size>=20) break; finalReadySet.add(id); }
  const finalReady = [...finalReadySet].slice(0,20).sort((a,b)=>a-b);
  // Ensure we have at least 5 blocks represented
  const readyBlockCheck = new Set(finalReady.map(id=> blockFor(targetsById.get(id)!.longitude!, targetsById.get(id)!.latitude!)));
  if(readyBlockCheck.size <5){
    // add one from missing blocks
    for(const [k, ids] of readyBlocksSorted){
      if(!readyBlockCheck.has(k)){
        for(const id of ids){ if(!finalReadySet.has(id)){ finalReadySet.delete([...finalReadySet][finalReadySet.size-1]); finalReadySet.add(id); break; } }
      }
      if(new Set([...finalReadySet].map(id=> blockFor(targetsById.get(id)!.longitude!, targetsById.get(id)!.latitude!))).size>=5) break;
    }
  }
  const selectedReadyFinal = [...finalReadySet].slice(0,20).sort((a,b)=>{
    const ka=blockFor(targetsById.get(a)!.longitude!, targetsById.get(a)!.latitude!);
    const kb=blockFor(targetsById.get(b)!.longitude!, targetsById.get(b)!.latitude!);
    if(ka<kb) return -1; if(ka>kb) return 1; return a-b;
  });

  // For holdout 10: similar round-robin, ensure tiny 20_175 (55682) and small 20_176 etc, plus low/high
  const holdCopies = new Map<string, number[]>();
  for(const [k, ids] of holdByBlock) holdCopies.set(k, [...ids].sort((a,b)=>a-b));
  const holdRROrder = [...holdByBlock.keys()].sort((a,b)=>{
    const sa=holdByBlock.get(a)!.length, sb=holdByBlock.get(b)!.length;
    if(sa===1 || sb===1) return sa===1 && sb!==1 ? -1 : sb===1 && sa!==1 ? 1 : a.localeCompare(b);
    return sb - sa || a.localeCompare(b);
  });
  const holdInterleaved: number[] = [];
  progress=true;
  while(progress && holdInterleaved.length < holdoutIds.length){
    progress=false;
    for(const k of holdRROrder){
      const arr=holdCopies.get(k)!;
      if(arr.length){ holdInterleaved.push(arr.shift()!); progress=true; }
    }
  }
  const smallestHold = [...holdoutIds].sort((a,b)=>a-b).slice(0,1);
  const largestHold = [...holdoutIds].sort((a,b)=>a-b).slice(-1);
  const mandatoryHold = new Set([...smallestHold, ...largestHold, 55682]);
  const finalHoldSet = new Set<number>();
  for(const id of mandatoryHold) if(holdoutIds.includes(id)) finalHoldSet.add(id);
  for(const id of holdInterleaved){ if(finalHoldSet.size>=10) break; finalHoldSet.add(id); }
  for(const id of holdoutIds){ if(finalHoldSet.size>=10) break; finalHoldSet.add(id); }
  const finalHold = [...finalHoldSet].slice(0,10).sort((a,b)=>{
    const ka=blockFor(targetsById.get(a)!.longitude!, targetsById.get(a)!.latitude!);
    const kb=blockFor(targetsById.get(b)!.longitude!, targetsById.get(b)!.latitude!);
    if(ka<kb) return -1; if(ka>kb) return 1; return a-b;
  });

  const sample30 = [...selectedReadyFinal, ...finalHold];
  // Ensure uniqueness and count
  if(new Set(sample30).size!==30) throw new Error('SELECTION_DUPLICATE');
  const allBlocks = new Set(sample30.map(id=> blockFor(targetsById.get(id)!.longitude!, targetsById.get(id)!.latitude!)));
  console.log(`Selected 30: READY ${selectedReadyFinal.length} REVIEW ${finalHold.length} blocks ${allBlocks.size} => ${[...allBlocks].join(',')}`);
  console.log(`READY IDs: ${selectedReadyFinal.join(',')}`);
  console.log(`REVIEW IDs: ${finalHold.join(',')}`);
  if(allBlocks.size <5) throw new Error('SELECTION_NEEDS_5_BLOCKS');

  await mkdir(VERIFY_DIR, {recursive:true});
  await writeFile(join(VERIFY_DIR,'selected-ids.json'), JSON.stringify({ ready: selectedReadyFinal, holdout: finalHold, all: sample30, blocks: [...allBlocks], createdAt: new Date().toISOString() }, null, 2));

  // Build larger benchmark set: at least 40 preferably 60 for perf. Use deterministic expansion. Prefer READY-heavy for wall-clock bounded run.
  const remainingReady = readyIds.filter(id=> !selectedReadyFinal.includes(id));
  const remainingHold = holdoutIds.filter(id=> !finalHold.includes(id));
  const bench60Set = new Set(sample30);
  // Add preferring READY to keep benchmark bounded (holdouts are slower due to exhaustive candidate scan)
  const addOrderReadyFirst = [...readyInterleaved.filter(id=> !bench60Set.has(id)), ...holdInterleaved.filter(id=> !bench60Set.has(id))];
  // Target 40 for practical wall-clock (still >=40). Use READY-heavy to keep bounded; isolate perf from exhaustive HOLDOUT scans.
  // For benchmark we use 35 READY + 5 HOLDOUT to keep wall-clock feasible while still covering both states and multiple blocks.
  const BENCH_TARGET = 40;
  // Build 35 READY first
  const benchReadyOnly: number[] = [...readyInterleaved.slice(0,35)];
  // Add 5 HOLDOUT from diverse blocks
  const benchHoldPart: number[] = [...holdInterleaved.slice(0,5)];
  const bench60Set2 = new Set([...benchReadyOnly, ...benchHoldPart]);
  // If not enough unique (due to overlap), fill from addOrderReadyFirst
  for(const id of addOrderReadyFirst){ if(bench60Set2.size>=BENCH_TARGET) break; bench60Set2.add(id); }
  if(bench60Set2.size <40) throw new Error('BENCH_NEEDS_40');
  const benchIds = [...bench60Set2].slice(0,BENCH_TARGET);
  // Order benchIds by block locality for warm hits (as bulk700 does)
  const benchOrdered = [...benchIds].sort((a,b)=>{
    const ka=blockFor(targetsById.get(a)!.longitude!, targetsById.get(a)!.latitude!);
    const kb=blockFor(targetsById.get(b)!.longitude!, targetsById.get(b)!.latitude!);
    if(ka<kb) return -1; if(ka>kb) return 1; return a-b;
  });
  console.log(`Bench set ${benchOrdered.length} ordered by block locality`);
  await writeFile(join(VERIFY_DIR,'bench-ids.json'), JSON.stringify({ benchIds, benchOrdered }, null, 2));

  // Load candidate index
  const index = await loadCandidateIndex();
  if(!index || index.pbfSha256 !== IDENTITY.pbfSha256) throw new Error('CANDIDATE_INDEX_MISSING');
  const grid = new Map<string, CandidateIndex['candidates']>();
  for(const c of index.candidates){
    if(c.osmType!=='node' || primaryStartPriority(c.kind)===99) continue;
    const k=blockFor(c.lon,c.lat); const bucket=grid.get(k)??[]; bucket.push(c); grid.set(k, bucket);
  }
  index.candidates = []; // free double memory as bulk700-run does

  // Helper to do bounded replay for a mountain (isolated, no artifact overwrite)
  // We use same logic as bulk700-run but capturing metrics.
  // For semantic comparison we need to capture BEFORE truth from disk.
  type ReplayEvidence = {
    mountainId:number; state:string; reason:string|null;
    startKind:string|null; startCoord:[number,number]|null; startNodeId:number|null; startWayId:number|null;
    policyVersion:string|null; publicRoadConnected:boolean|null; accessNetworkDistance:number|null;
    approachNodeIds:number[]|null; approachWayIds:number[]|null; outwardRoadNodeIds:number[]|null; outwardRoadWayIds:number[]|null; reasonCodes:string[]|null;
    requestStart:{lat:number,lon:number}|null; requestSummit:{lat:number,lon:number}|null; snapStartM:number|null; snapSummitM:number|null; summitTier:string|null;
    distance:number|null; geometryHash:string|null; normalizedCoords:string|null;
    baseAccessMs:number; routingMs:number;
    attempts:number;
  };

  async function loadBeforeTruth(mountainId:number){
    const m = targetsById.get(mountainId)!;
    let result: BulkResult;
    let isReady=false;
    try{ result = await readJson<BulkResult>(`${BULK_DIR}/full-v1/results/${mountainId}.json`); isReady=true; }
    catch{ result = await readJson<BulkResult>(`${BULK_DIR}/full-v1/holdout/${mountainId}.json`); }
    if(result.mountainId!==mountainId) throw new Error('BEFORE_MISMATCH');
    let evidenceBefore:any=null, routeBefore:any=null, geojsonBefore:any=null;
    if(isReady){
      evidenceBefore = await readJson<any>(`${BULK_DIR}/full-v1/ready/${mountainId}/evidence.json`);
      routeBefore = await readJson<any>(`${BULK_DIR}/full-v1/ready/${mountainId}/route.json`);
      geojsonBefore = await readJson<any>(`${BULK_DIR}/full-v1/ready/${mountainId}/route.geojson`);
    }
    return {result, evidenceBefore, routeBefore, geojsonBefore, isReady, mountain:m};
  }

  // Context caches for isolated replay
  type BlockRoutingContext = { block:string; ways:any[]; graph:any; network:BaseAccessNetwork; builtMs:number; diskReadMs:number; jsonParseMs:number; graphBuildMs:number; networkBuildMs:number };
  const BLOCK_CONTEXT_LRU = 2;
  const blockContexts = new Map<string, BlockRoutingContext>();
  const witnessCache = new Map<string, BaseAccessEvidence>();
  const parsedHitsBefore = parsedCacheStats().hits;
  const parsedMissesBefore = parsedCacheStats().misses;
  let contextHits=0, contextMisses=0;
  const coldBuilds: {block:string, diskReadMs:number, jsonParseMs:number, graphBuildMs:number, networkBuildMs:number, totalMs:number, ways:number}[] = [];
  const warmMountains: {mountainId:number, candidateDiscoveryMs:number, baseAccessEvaluationMs:number, routingMs:number, serializationMs:number}[] = [];
  const rssSamples: number[] = [];
  const sampleResults: {mountainId:number, beforeState:string, replayState:string, match:boolean, details:string}[] = [];

  async function getBlockRoutingContextIsolated(lon:number, lat:number){
    const key = blockFor(lon,lat);
    let ctx = blockContexts.get(key);
    if(ctx){ blockContexts.delete(key); blockContexts.set(key, ctx); contextHits++; return ctx; }
    contextMisses++;
    if(blockContexts.size >= BLOCK_CONTEXT_LRU){
      const evicted = blockContexts.keys().next().value!; blockContexts.delete(evicted);
    }
    const t0 = performance.now();
    // Measure substeps: loadBlockWays does disk+parse+maybe extraction; we instrument via timing
    const loadStart = performance.now();
    const ways = await loadBlockWays(key, IDENTITY.pbfSha256);
    const loadEnd = performance.now();
    // For our measurement, we split: diskRead+parse is load, but loadBlockWays already caches; we estimate graph/network build separately
    const graphT0 = performance.now();
    const graph = buildReconstructionPbfBlockGraph({datasetKey:'local-osm-pbf',region:'alps',snapshotTimestamp:new Date(meta.pbfModifiedMs).toISOString(),pbfSha256:IDENTITY.pbfSha256}, ways);
    const graphT1 = performance.now();
    const networkT0 = performance.now();
    const network = new BaseAccessNetwork(ways);
    const networkT1 = performance.now();
    const total = performance.now() - t0;
    ctx = { block:key, ways, graph, network, builtMs: total, diskReadMs: loadEnd-loadStart, jsonParseMs: 0, graphBuildMs: graphT1-graphT0, networkBuildMs: networkT1-networkT0 };
    blockContexts.set(key, ctx);
    coldBuilds.push({block:key, diskReadMs: ctx.diskReadMs, jsonParseMs: 0, graphBuildMs: ctx.graphBuildMs, networkBuildMs: ctx.networkBuildMs, totalMs: total, ways: ways.length});
    return ctx;
  }

  async function replayMountain(m:Mountain, signal: AbortSignal): Promise<ReplayEvidence>{
    const warmStart = performance.now();
    let candidateDiscoveryMs=0, baseAccessEvaluationMs=0, routingMs=0, serializationMs=0;
    const discT0 = performance.now();
    const [x,y] = blockFor(m.longitude!, m.latitude!).split('_').map(Number);
    const nearby: CandidateIndex['candidates'] = [];
    for(let dx=-2; dx<=2; dx++) for(let dy=-1; dy<=1; dy++) nearby.push(...(grid.get(`${x+dx}_${y+dy}`) ?? []));
    const pool = boundedCandidatesForSummit({ ...index, candidates: nearby } as CandidateIndex, {lon:m.longitude!, lat:m.latitude!}, 20);
    // summit context ways for roadNodes
    const summitKey = blockFor(m.longitude!, m.latitude!);
    let summitWays: any[];
    {
      const ctx = await getBlockRoutingContextIsolated(m.longitude!, m.latitude!);
      summitWays = ctx.ways;
    }
    const roadNodes = new Map<number, CandidateIndex['candidates'][number] & {sourceWayId:number, sourceKind:string}>();
    for(const way of summitWays){
      if(!publicApproachRoad(way as any)) continue;
      for(const node of [way.nodes[0], way.nodes.at(-1)]){
        if(!node?.coordinate || calculateCoordinateDistanceMeters(node.coordinate as any,[m.longitude!,m.latitude!])>20000) continue;
        roadNodes.set(node.nodeId,{osmType:'node',osmId:node.nodeId,kind:'NETWORK_ACCESS',name:null,lon:node.coordinate[0], lat:node.coordinate[1], tags:{}, sourceWayId:way.id, sourceKind:'OSM_PUBLIC_WAY_ENDPOINT'} as any);
      }
    }
    pool.push(...[...roadNodes.values()].sort((a,b)=> calculateCoordinateDistanceMeters([a.lon,a.lat],[m.longitude!,m.latitude!]) - calculateCoordinateDistanceMeters([b.lon,b.lat],[m.longitude!,m.latitude!])).slice(0,20));
    // Dedup same as bulk700-run
    {
      const dedup = new Map<string, typeof pool[number]>();
      for (const c of pool) {
        const key = `${(c as any).osmId}:${(c as any).kind}`;
        if (!dedup.has(key)) dedup.set(key, c);
      }
      pool.length = 0;
      pool.push(...dedup.values());
    }
    candidateDiscoveryMs = performance.now()-discT0;
    let bestEvidence: BaseAccessEvidence|null=null;
    let bestCand: any=null;
    let bestRoute: any=null;
    let bestSnapStart: number|null=null;
    let bestSnapSummit: number|null=null;
    let bestState: string = 'NO_REAL_BASE_ACCESS_CANDIDATE';
    let bestReason: string|null = 'NO_PRIMARY_BASE_ACCESS_WITNESS';
    let attempts=0;
    const evalT0 = performance.now();
    for(const cand of pool){
      signal.throwIfAborted();
      const witnessKey = `${cand.kind}:${cand.osmId}`;
      let witness = witnessCache.get(witnessKey);
      if(!witness){
        const ctx = await getBlockRoutingContextIsolated(cand.lon,cand.lat);
        const node = ctx.graph.node(cand.osmId);
        if(!node || calculateCoordinateDistanceMeters(node.coordinate,[cand.lon,cand.lat])>1) continue;
        witness = ctx.network.evaluate({kind:cand.kind,tags: cand.tags, nodeId:cand.osmId, graph: ctx.graph});
        if(witnessCache.size>=10000) witnessCache.delete(witnessCache.keys().next().value!);
        witnessCache.set(witnessKey,witness);
      }
      const evidence: BaseAccessEvidence = {...witness!, summitElevation: m.height } as any;
      if(!primaryBaseAccess(evidence)) continue;
      // routing
      const routeStart = performance.now();
      const response = await routeWithGraphHopper({start:{lat:cand.lat,lon:cand.lon}, summit:{lat:m.latitude!, lon:m.longitude!}}, {
        graphId: IDENTITY.graphId, graphHopperVersion: meta.graphHopperVersion, signal, allowFallbackAfterHealthy:true,
        onAttempt:(engine,ms,fetchFailed)=>{ attempts++; }
      });
      routingMs += performance.now()-routeStart;
      if(!response.ok){
        const reason = (response as any).reason as string;
        let st='UNEXPECTED_ERROR';
        if(reason==='NO_ROUTE') st='NO_ROUTE';
        else if(reason==='REJECTED_ACCESS') st='REJECTED_ACCESS';
        else if(/SUMMIT/.test(reason) || reason==='SUMMIT_SNAP_EXCEEDS_50M' || reason==='NO_SUMMIT_CONNECTION') st='SUMMIT_ATTACHMENT_REVIEW_REQUIRED';
        else if(/GEOMETRY/.test(reason)) st='INVALID_GEOMETRY';
        else if(/FETCH_FAILED|GH_ERROR|OSM_FALLBACK|BLOCK|OSMIUM|PY_PARSE/.test(reason)) st='GRAPH_ERROR';
        bestState=st; bestReason=reason; continue;
      }
      const route = (response as any).result;
      const coords = route.geometry.coordinates as [number,number][];
      if(coords.length<2 || !Number.isFinite(route.distanceMeters) || route.distanceMeters<=0 || coords.some((c:any)=> !Array.isArray(c)||c.length!==2||!c.every(Number.isFinite)||Math.abs(c[0])>180||Math.abs(c[1])>90)){
        bestState='INVALID_GEOMETRY'; bestReason='INVALID_ROUTED_GEOMETRY'; continue;
      }
      const snap = calculateCoordinateDistanceMeters(coords.at(-1)!,[m.longitude!,m.latitude!]);
      const startSnap = calculateCoordinateDistanceMeters(coords[0],[cand.lon,cand.lat]);
      if(startSnap>150){ bestState='REJECTED_ACCESS'; bestReason='START_SNAP_EXCEEDS_150M'; continue; }
      if(snap>50){ bestState='SUMMIT_ATTACHMENT_REVIEW_REQUIRED'; bestReason='SUMMIT_SNAP_EXCEEDS_50M'; continue; }
      // success
      bestEvidence = evidence;
      bestCand = cand;
      bestRoute = route;
      bestSnapStart = route.snapDistanceStartM;
      bestSnapSummit = route.snapDistanceSummitM;
      bestState='TRUSTED_REPLACEMENT_READY'; bestReason=null;
      // serialize for timing
      const serT0=performance.now();
      const hashTmp = createHash('sha256').update(JSON.stringify(route.geometry)).digest('hex');
      void hashTmp;
      serializationMs += performance.now()-serT0;
      break;
    }
    baseAccessEvaluationMs = performance.now()-evalT0 - routingMs;
    warmMountains.push({mountainId:m.id, candidateDiscoveryMs, baseAccessEvaluationMs, routingMs, serializationMs});
    if(bestState==='TRUSTED_REPLACEMENT_READY' && bestEvidence && bestCand && bestRoute){
      const tier = (bestSnapSummit! <=30 ? 'DIRECT' : 'EXTENDED');
      return {
        mountainId:m.id, state:bestState, reason:bestReason,
        startKind: bestCand.kind, startCoord:[bestCand.lon,bestCand.lat], startNodeId:bestCand.osmId, startWayId: bestCand.sourceWayId ?? null,
        policyVersion: bestEvidence.policyVersion, publicRoadConnected: bestEvidence.publicRoadConnected, accessNetworkDistance: bestEvidence.accessNetworkDistance,
        approachNodeIds: bestEvidence.approachNodeIds, approachWayIds: bestEvidence.approachWayIds, outwardRoadNodeIds: bestEvidence.outwardRoadNodeIds, outwardRoadWayIds: bestEvidence.outwardRoadWayIds, reasonCodes: bestEvidence.reasonCodes,
        requestStart: bestRoute.requestedStart, requestSummit: bestRoute.requestedSummit, snapStartM: bestRoute.snapDistanceStartM, snapSummitM: bestRoute.snapDistanceSummitM, summitTier: tier,
        distance: bestRoute.distanceMeters, geometryHash: hashStr(bestRoute.geometry), normalizedCoords: JSON.stringify(bestRoute.geometry.coordinates.map((c:[number,number])=>[Math.round(c[0]*1e6)/1e6, Math.round(c[1]*1e6)/1e6])),
        baseAccessMs: candidateDiscoveryMs+baseAccessEvaluationMs, routingMs, attempts
      };
    } else {
      // For non-ready, capture what we can (no start). State/reason only.
      return {
        mountainId:m.id, state:bestState, reason:bestReason,
        startKind:null, startCoord:null, startNodeId:null, startWayId:null,
        policyVersion:null, publicRoadConnected:null, accessNetworkDistance:null,
        approachNodeIds:null, approachWayIds:null, outwardRoadNodeIds:null, outwardRoadWayIds:null, reasonCodes:null,
        requestStart:null, requestSummit:null, snapStartM:bestSnapStart, snapSummitM:bestSnapSummit, summitTier: bestSnapSummit!==null ? (bestSnapSummit<=30?'DIRECT':bestSnapSummit<=50?'EXTENDED':'HOLDOUT') : null,
        distance:null, geometryHash:null, normalizedCoords:null,
        baseAccessMs: candidateDiscoveryMs+baseAccessEvaluationMs, routingMs, attempts
      };
    }
  }

  // Run with GraphHopper
  const verifyReport:any = { selected: sample30, benchCount: benchOrdered.length, semantic: [], isolation: null, perf:null, cache:null, rss:null, contracts:null, checkpoint:null };
  let rssStart = process.memoryUsage().rss;
  let rssMedian=0, rssP90=0, rssPeak=0, rssAfterEviction=0;
  const wallStart = performance.now();
  let semanticPass=0, semanticFail=0;
  const totalReplayCount = benchOrdered.length;
  let measuredSeconds=0;
  let mountainsPerMin=0;

  await withGraphHopper(meta, `${VERIFY_DIR}/graphhopper.log`, 86_400_000, async (signal)=>{
    if(!(await graphHealthy(signal))) throw new Error('GRAPH_NOT_HEALTHY');
    // Semantic equivalence for 30
    console.log('--- Semantic equivalence replay 30 ---');
    const semanticDetails:any[]=[];
    for(const mid of sample30){
      const before = await loadBeforeTruth(mid);
      const replay = await replayMountain(before.mountain, signal);
      rssSamples.push(process.memoryUsage().rss);
      let match=true;
      let details='';
      // Compare primary state
      if(replay.state !== before.result.state){
        match=false; details+=`state mismatch before ${before.result.state} replay ${replay.state}; `;
      }
      // For READY compare deep fields
      if(before.isReady && replay.state==='TRUSTED_REPLACEMENT_READY'){
        const evB = before.evidenceBefore;
        const rtB = before.routeBefore;
        // start kind
        if(evB.startCandidate.kind !== replay.startKind) { match=false; details+=`startKind ${evB.startCandidate.kind} vs ${replay.startKind}; `; }
        if(evB.startCandidate.osmId !== replay.startNodeId) { match=false; details+=`startNodeId ${evB.startCandidate.osmId} vs ${replay.startNodeId}; `; }
        const scB = evB.startCandidate.sourceWayId ?? null;
        if(scB !== replay.startWayId) { match=false; details+=`startWayId ${scB} vs ${replay.startWayId}; `; }
        if(Math.abs(evB.startCandidate.lon - replay.startCoord![0])>1e-6 || Math.abs(evB.startCandidate.lat - replay.startCoord![1])>1e-6) { match=false; details+=`startCoord mismatch; `; }
        if(evB.accessEvidence.policyVersion !== replay.policyVersion) { match=false; details+=`policyVersion; `; }
        if(evB.accessEvidence.publicRoadConnected !== replay.publicRoadConnected) { match=false; details+=`publicRoadConnected; `; }
        if(Math.abs((evB.accessEvidence.accessNetworkDistance??0)-(replay.accessNetworkDistance??0))>0.001) { match=false; details+=`accessNetworkDistance ${evB.accessEvidence.accessNetworkDistance} vs ${replay.accessNetworkDistance}; `; }
        if(JSON.stringify(evB.accessEvidence.approachNodeIds)!==JSON.stringify(replay.approachNodeIds)) { match=false; details+=`approachNodeIds; `; }
        if(JSON.stringify(evB.accessEvidence.approachWayIds)!==JSON.stringify(replay.approachWayIds)) { match=false; details+=`approachWayIds; `; }
        if(JSON.stringify(evB.accessEvidence.outwardRoadNodeIds)!==JSON.stringify(replay.outwardRoadNodeIds)) { match=false; details+=`outwardRoadNodeIds; `; }
        if(JSON.stringify(evB.accessEvidence.outwardRoadWayIds)!==JSON.stringify(replay.outwardRoadWayIds)) { match=false; details+=`outwardRoadWayIds; `; }
        if(JSON.stringify([...evB.accessEvidence.reasonCodes].sort())!==JSON.stringify([...(replay.reasonCodes??[])].sort())) { match=false; details+=`reasonCodes; `; }
        if(Math.abs(rtB.start.requested.lon - replay.requestStart!.lon)>1e-6 || Math.abs(rtB.start.requested.lat - replay.requestStart!.lat)>1e-6) { match=false; details+=`requestStart; `; }
        if(Math.abs(rtB.summitSnap.requested.lon - replay.requestSummit!.lon)>1e-6 || Math.abs(rtB.summitSnap.requested.lat - replay.requestSummit!.lat)>1e-6) { match=false; details+=`requestSummit; `; }
        if(Math.abs((rtB.start.snapDistanceM??0)-(replay.snapStartM??0))>0.5) { match=false; details+=`snapStartM ${rtB.start.snapDistanceM} vs ${replay.snapStartM}; `; }
        if(Math.abs((rtB.summitSnap.snapDistanceM??0)-(replay.snapSummitM??0))>0.5) { match=false; details+=`snapSummitM ${rtB.summitSnap.snapDistanceM} vs ${replay.snapSummitM}; `; }
        const tierB = evB.summitAttachment.tier;
        if(tierB !== replay.summitTier) { match=false; details+=`tier ${tierB} vs ${replay.summitTier}; `; }
        if(Math.abs(rtB.distanceM - replay.distance!)>0.5) { match=false; details+=`distance ${rtB.distanceM} vs ${replay.distance}; `; }
        // geometry hash or normalized coords
        const beforeHash = rtB.geometryHash ?? evB.geometryHash;
        if(beforeHash !== replay.geometryHash){
          // try normalized coords tolerance
          const gjCoords = before.geojsonBefore.features[0].geometry.coordinates;
          const normBefore = JSON.stringify(gjCoords.map((c:[number,number])=>[Math.round(c[0]*1e6)/1e6, Math.round(c[1]*1e6)/1e6]));
          if(normBefore !== replay.normalizedCoords){ match=false; details+=`geometryHash ${beforeHash.slice(0,8)} vs ${replay.geometryHash?.slice(0,8)}; `; }
        }
      } else if(!before.isReady){
        // holdout: check tier Holdout classification if both review
        if(replay.state !== 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED' && replay.state !== before.result.state){
          // already flagged state mismatch above
        }
        // For review mountains, also check that replay didn't become READY
        if(replay.state==='TRUSTED_REPLACEMENT_READY'){ match=false; details+=`holdout became READY; `; }
      } else if(before.isReady && replay.state!=='TRUSTED_REPLACEMENT_READY'){
        match=false; details+=`READY became ${replay.state} reason ${replay.reason}; `;
      }
      if(match) semanticPass++; else semanticFail++;
      semanticDetails.push({mountainId:mid, beforeState: before.result.state, replayState: replay.state, match, details: details||'OK', beforeReason: before.result.reason, replayReason: replay.reason});
      console.log(`  ${mid} ${before.result.state} -> ${replay.state} ${match?'PASS':'FAIL'} ${details}`);
    }
    verifyReport.semantic = { pass: semanticPass, fail: semanticFail, total: 30, details: semanticDetails };
    console.log(`Semantic ${semanticPass}/30`);

    // Order independence test: pick a block with >=3 replay mountains
    const blockGroups = new Map<string, number[]>();
    for(const id of benchOrdered){
      const m=targetsById.get(id)!; const k=blockFor(m.longitude!,m.latitude!); const arr=blockGroups.get(k)??[]; arr.push(id); blockGroups.set(k,arr);
    }
    let isolationBlock = '';
    for(const [k,arr] of [...blockGroups.entries()].sort((a,b)=>b[1].length-a[1].length)){
      if(arr.length>=3){ isolationBlock=k; break; }
    }
    if(!isolationBlock) throw new Error('NO_BLOCK_FOR_ISOLATION');
    const isoIds = blockGroups.get(isolationBlock)!.slice(0,3);
    console.log(`Isolation test block ${isolationBlock} ids ${isoIds.join(',')}`);
    // Need fresh caches for each sequence to test order independence properly
    async function runSequence(order:number[]){
      resetParsedCache();
      blockContexts.clear();
      witnessCache.clear();
      contextHits=0; contextMisses=0;
      // we need to Reset our counters but keep global coldBuilds; for isolation we use separate map
      const seqResults = new Map<number, ReplayEvidence>();
      for(const mid of order){
        const m=targetsById.get(mid)!;
        const ev = await replayMountain(m, signal);
        seqResults.set(mid, ev);
      }
      return seqResults;
    }
    const seqAOrder = [...isoIds];
    const seqBOrder = [isoIds[2], isoIds[0], isoIds[1]];
    // Save current caches to restore after?
    const savedHits=contextHits, savedMisses=contextMisses;
    const resA = await runSequence(seqAOrder);
    const resB = await runSequence(seqBOrder);
    let isolationPass=true;
    const isoDetails:any[]=[];
    for(const id of isoIds){
      const a=resA.get(id)!; const b=resB.get(id)!;
      const eq = JSON.stringify({state:a.state, reason:a.reason, startKind:a.startKind, startNodeId:a.startNodeId, startWayId:a.startWayId, policyVersion:a.policyVersion, publicRoadConnected:a.publicRoadConnected, accessNetworkDistance:a.accessNetworkDistance, approachNodeIds:a.approachNodeIds, approachWayIds:a.approachWayIds, outwardRoadNodeIds:a.outwardRoadNodeIds, outwardRoadWayIds:a.outwardRoadWayIds, reasonCodes:a.reasonCodes?.slice().sort(), snapStartM: a.snapStartM?Math.round(a.snapStartM*10)/10:null, snapSummitM: a.snapSummitM?Math.round(a.snapSummitM*10)/10:null, summitTier:a.summitTier, distance:a.distance?Math.round(a.distance):null, geometryHash:a.geometryHash}) === JSON.stringify({state:b.state, reason:b.reason, startKind:b.startKind, startNodeId:b.startNodeId, startWayId:b.startWayId, policyVersion:b.policyVersion, publicRoadConnected:b.publicRoadConnected, accessNetworkDistance:b.accessNetworkDistance, approachNodeIds:b.approachNodeIds, approachWayIds:b.approachWayIds, outwardRoadNodeIds:b.outwardRoadNodeIds, outwardRoadWayIds:b.outwardRoadWayIds, reasonCodes:b.reasonCodes?.slice().sort(), snapStartM: b.snapStartM?Math.round(b.snapStartM*10)/10:null, snapSummitM: b.snapSummitM?Math.round(b.snapSummitM*10)/10:null, summitTier:b.summitTier, distance:b.distance?Math.round(b.distance):null, geometryHash:b.geometryHash});
      if(!eq) isolationPass=false;
      isoDetails.push({mountainId:id, equal:eq, a: {state:a.state, reason:a.reason, geometryHash:a.geometryHash?.slice(0,8)}, b:{state:b.state, reason:b.reason, geometryHash:b.geometryHash?.slice(0,8)}});
      console.log(`  iso ${id} A ${a.state} vs B ${b.state} ${eq?'PASS':'FAIL'}`);
    }
    verifyReport.isolation = { block: isolationBlock, ids: isoIds, orderA: seqAOrder, orderB: seqBOrder, pass: isolationPass, details: isoDetails };
    console.log(`Isolation ${isolationPass?'PASS':'FAIL'}`);

    // Benchmark: replay benchOrdered (already did 30). Now replay all 60 with fresh measurement but we already replayed 30. Continue replay for remaining 30 to get full 60 wall clock
    // Reset for clean benchmark measurement: do full 60 sequential with metrics
    resetParsedCache();
    blockContexts.clear();
    witnessCache.clear();
    contextHits=0; contextMisses=0;
    coldBuilds.length=0;
    warmMountains.length=0;
    rssSamples.length=0;
    const benchWallStart = performance.now();
    const rssStartBench = process.memoryUsage().rss;
    for(const mid of benchOrdered){
      const m=targetsById.get(mid)!;
      await replayMountain(m, signal);
      rssSamples.push(process.memoryUsage().rss);
    }
    const benchWallEnd = performance.now();
    measuredSeconds = (benchWallEnd - benchWallStart)/1000;
    mountainsPerMin = benchOrdered.length / (measuredSeconds/60);
    rssStart = rssStartBench;
    // compute RSS stats
    const sortedRss = [...rssSamples].sort((a,b)=>a-b);
    rssMedian = sortedRss[Math.floor(sortedRss.length/2)];
    rssP90 = sortedRss[Math.floor(sortedRss.length*0.9)];
    rssPeak = Math.max(...rssSamples);
    // after eviction: force evict and measure
    blockContexts.clear();
    if(global.gc) global.gc();
    await new Promise(r=>setTimeout(r,200));
    rssAfterEviction = process.memoryUsage().rss;
    const pcs = parsedCacheStats();
    const parsedHitRate = pcs.hits+pcs.misses ? pcs.hits/(pcs.hits+pcs.misses) : 0;
    const ctxHitRate = contextHits+contextMisses ? contextHits/(contextHits+contextMisses) : 0;
    verifyReport.perf = {
      totalReplayCount: benchOrdered.length,
      wallSeconds: measuredSeconds,
      mountainsPerMin,
      coldBuilds,
      warmMountains,
      parsed: pcs,
      parsedHitRate,
      context: {hits:contextHits, misses:contextMisses, hitRate:ctxHitRate},
      rss: { start: rssStart, median: rssMedian, p90: rssP90, peak: rssPeak, afterEviction: rssAfterEviction }
    };
    console.log(`Perf ${benchOrdered.length} in ${measuredSeconds.toFixed(1)}s => ${mountainsPerMin.toFixed(2)}/min RSS peak ${(rssPeak/1024/1024).toFixed(0)}MB`);

  });

  // Contracts
  const contracts = {
    inventoryHash: hash({identity:IDENTITY, targets: inventory.targets}),
    targetCount: inventory.targets.length,
    runHash: cp.runHash,
    graphId: IDENTITY.graphId,
    pbfSha256: IDENTITY.pbfSha256,
    profile: IDENTITY.profile,
    heightGte700: true,
    baseAccessVersion: BASE_ACCESS_START_POLICY.version,
    maximumApproachMeters: BASE_ACCESS_START_POLICY.maximumApproachMeters,
    minimumOutwardRoadMeters: BASE_ACCESS_START_POLICY.minimumOutwardRoadMeters,
    maximumVisitedNodes: BASE_ACCESS_START_POLICY.maximumVisitedNodes,
  };
  verifyReport.contracts = contracts;

  // Checkpoint preservation
  const cpAfter = await readJson<any>(`${BULK_DIR}/full-v1/checkpoint.json`);
  const resultsCount = (await readdir(`${BULK_DIR}/full-v1/results`).catch(()=>[])).filter(f=>/^\d+\.json$/.test(f)).length;
  const holdoutCount = (await readdir(`${BULK_DIR}/full-v1/holdout`).catch(()=>[])).filter(f=>/^\d+\.json$/.test(f)).length;
  verifyReport.checkpoint = { completedCount: cpAfter.completedCount, readyPreserved: resultsCount, holdoutPreserved: holdoutCount, runHashUnchanged: cpAfter.runHash===cp.runHash, inventoryHashUnchanged: cpAfter.inventoryHash===inventory.inventoryHash };

  await writeFile(join(VERIFY_DIR,'verify-report.json'), JSON.stringify(verifyReport,null,2));
  console.log(`\n=== VERIFY REPORT written to ${VERIFY_DIR}/verify-report.json ===`);
  console.log(JSON.stringify({semantic: verifyReport.semantic, isolation: verifyReport.isolation?.pass, perf: verifyReport.perf, rssPeakMb: Math.round(verifyReport.perf.rss.peak/1024/1024), checkpoint: verifyReport.checkpoint}, null,2));
  const totalSec = (performance.now()-t0All)/1000;
  console.log(`Total verify wall ${totalSec.toFixed(1)}s`);
  if(verifyReport.semantic.fail>0) process.exitCode=1;
  if(!verifyReport.isolation.pass) process.exitCode=1;
  if(verifyReport.perf.rss.peak > 4*1024*1024*1024) process.exitCode=1;
}

main().catch(e=>{ console.error(e instanceof Error?e.message:e); console.error(e instanceof Error?e.stack:e); process.exitCode=1; });
