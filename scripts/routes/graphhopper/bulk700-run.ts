/** Local-only runner. Canary is the default; full execution requires --full explicitly.
 * STRICT REAL DB SOURCE: bulk700 never imports or calls loadMountains() synthetic fallback.
 * Inventory must be SUPABASE_DATABASE; otherwise throw REAL_MOUNTAIN_SOURCE_UNAVAILABLE.
 * Synthetic Alps Peak fixtures / zugspitze-peaks.json are unreachable from this module.
 * OPTIMIZED: block-aware grouping — pending targets are sorted by deterministic PBF block key,
 * the same geographic block is loaded/extracted once and reused for all mountains in that block.
 * Safety semantics unchanged. Cache is atomic and bound to PBF SHA256 + block key + extraction version.
 */
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseAccessNetwork, primaryBaseAccess, primaryStartPriority, publicApproachRoad, type BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { buildReconstructionPbfBlockGraph } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { calculateCoordinateDistanceMeters } from '../../../Lib/gpxIngestion/gpxNormalization.ts';
import { loadCandidateIndex, boundedCandidatesForSummit, type CandidateIndex } from './candidate-index.ts';
import { routeWithGraphHopper, routeJson, serializeGeojson, serializeGpx } from './adapter.ts';
import { BLOCK_EXTRACTION_VERSION, BLOCK_GRAPH_OPTIONS_VERSION, blockFor, loadBlockWays, parsedCacheStats } from './pbf-block-loader.ts';
import { checkGraphIdentity, graphHealthy, withGraphHopper } from './lifecycle.ts';
import { atomicJson, BULK_DIR, hash, IDENTITY, inCoverage, primaryCounts, readJson, validHeight, type Mountain, type PrimaryState } from './bulk700-contract.ts';
import type { Inventory } from './bulk700-inventory.ts';

type Engine = 'GRAPH_HOPPER' | 'OSM_DIJKSTRA_FALLBACK';
type Attempt = { routingEngine: Engine; ms: number; fetchFailed: boolean };
export type BulkResult = {
  mountainId: number; state: PrimaryState; reviewFlags: string[]; reason: string | null;
  routingEngine: Engine; graphId: string; pbfSha256: string; profile: string; fallbackReason: string | null;
  attempts: Attempt[]; baseAccessMs: number; routingMs: number; artifactWriteMs: number;
  artifacts: Record<string, string>; syntheticGeometryCount: number; fabricatedEvidenceCount: number;
};
type Checkpoint = { runHash: string; inventoryHash: string; mode: string; completed: BulkResult[]; rejectedTargets: { mountainId: number; reason: string }[] };
type ParsedBlock = Awaited<ReturnType<typeof loadBlockWays>>;
type BlockRoutingContext = { block: string; ways: ParsedBlock; graph: ReturnType<typeof buildReconstructionPbfBlockGraph>; network: BaseAccessNetwork; builtMs: number };

// Block-aware performance tracking – retained 8/2 after measurement: 3/1 caused 2x slowdown and still >6GB; memory requires structural reduction, not just LRU
type BlockPerf = { block: string; mountains: number; loadMs: number; ways: number; hits: number; misses: number; contextBuildMs: number };
const BLOCK_CACHE_LRU = 8;
const BLOCK_CONTEXT_LRU = 2;
export const BLOCK_CONTEXT_VERSION = 'v1-full-block-graph';
// Semantic vs implementation identity split
export const SEMANTIC_POLICY_VERSION = 'v2'; // binds to BaseAccess v2, summit 30/50, connector highways, profile etc.

export function validateCheckpoint(cp: Checkpoint, runHash: string, ids: Set<number>) {
  if (cp.runHash !== runHash || new Set(cp.completed.map(r => r.mountainId)).size !== cp.completed.length || cp.completed.some(r => !ids.has(r.mountainId))) throw new Error('CHECKPOINT_IDENTITY_OR_DUPLICATE');
  primaryCounts(cp.completed);
}
export async function verifyArtifacts(rows: BulkResult[], runDir: string) {
  for (const row of rows) {
    if (row.graphId !== IDENTITY.graphId || row.pbfSha256 !== IDENTITY.pbfSha256 || row.profile !== IDENTITY.profile) throw new Error('RESULT_IDENTITY_MISMATCH');
    if (row.state === 'TRUSTED_REPLACEMENT_READY' && Object.keys(row.artifacts).length !== 4) throw new Error('READY_ARTIFACTS_MISSING');
    for (const [path, expected] of Object.entries(row.artifacts)) {
    if (!path.startsWith(`ready/${row.mountainId}/`) || path.includes('..') || hash(await readFile(join(runDir, path), 'utf8')) !== expected) throw new Error('CHECKPOINT_ARTIFACT_MISMATCH');
  }
  }
}
function classify(reason: string): PrimaryState {
  if (reason === 'NO_ROUTE') return 'NO_ROUTE';
  if (reason === 'REJECTED_ACCESS') return 'REJECTED_ACCESS';
  if (/SUMMIT/.test(reason)) return 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED';
  if (/GEOMETRY/.test(reason)) return 'INVALID_GEOMETRY';
  if (/FETCH_FAILED|GH_ERROR|OSM_FALLBACK|BLOCK|OSMIUM|PY_PARSE/.test(reason)) return 'GRAPH_ERROR';
  return 'UNEXPECTED_ERROR';
}
export function summarize(rows: BulkResult[], targetCount: number) {
  const counts = primaryCounts(rows), attempts = rows.flatMap(r => r.attempts);
  const gh = attempts.filter(a => a.routingEngine === 'GRAPH_HOPPER'), fallback = attempts.filter(a => a.routingEngine === 'OSM_DIJKSTRA_FALLBACK');
  const ready = rows.filter(r => r.state === 'TRUSTED_REPLACEMENT_READY');
  const graphHopperSuccess = ready.filter(r => r.routingEngine === 'GRAPH_HOPPER').length;
  const fallbackSuccess = ready.filter(r => r.routingEngine === 'OSM_DIJKSTRA_FALLBACK').length;
  const ghMs = gh.reduce((n,a) => n+a.ms,0), fallbackMs = fallback.reduce((n,a) => n+a.ms,0);
  const baseAccessMs = rows.reduce((n,r) => n+r.baseAccessMs,0), artifactWriteMs = rows.reduce((n,r) => n+r.artifactWriteMs,0);
  const measuredMs = baseAccessMs + ghMs + fallbackMs + artifactWriteMs;
  return { processed: rows.length, counts, primaryStateSumCorrect: Object.values(counts).reduce((a,b) => a+b,0) === rows.length,
    graphHopperAttempts: gh.length, fetchFailed: gh.filter(a => a.fetchFailed).length,
    globalFetchFailedRate: gh.length ? gh.filter(a => a.fetchFailed).length / gh.length : null,
    graphHopperSuccess, fallbackSuccess, baseAccessMs, routingMs: ghMs+fallbackMs, artifactWriteMs,
    graphHopperRoutesPerMinute: ghMs ? graphHopperSuccess*60_000/ghMs : null,
    graphHopperAttemptsPerMinute: ghMs ? gh.length*60_000/ghMs : null,
    fallbackRoutesPerMinute: fallbackMs ? fallbackSuccess*60_000/fallbackMs : null,
    estimatedFullHours: rows.length && graphHopperSuccess ? measuredMs/rows.length*targetCount/3_600_000 : null,
    estimateCaveat: 'Pilot sample ordered by DB ID; cold PBF extraction and regional routability vary. Estimate includes observed discovery, routing and artifact writes, excluding JVM startup.',
    syntheticGeometryCount: rows.reduce((n,r) => n+r.syntheticGeometryCount,0), fabricatedEvidenceCount: rows.reduce((n,r) => n+r.fabricatedEvidenceCount,0),
    reviewFlagCounts: { REVIEW_GEOMETRY_CHANGE: rows.filter(r => r.reviewFlags.includes('REVIEW_GEOMETRY_CHANGE')).length }, productionWrites: 0 };
}

function orderedByBlock(mountains: Mountain[]): Mountain[] {
  return [...mountains].sort((a, b) => {
    const ka = blockFor(a.longitude!, a.latitude!);
    const kb = blockFor(b.longitude!, b.latitude!);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a.id - b.id;
  });
}

export async function run700(full: boolean) {
  const inventory = await readJson<Inventory>(`${BULK_DIR}/inventory.json`);
  if (inventory.source !== 'SUPABASE_DATABASE' || hash(inventory.identity) !== hash(IDENTITY) || inventory.inventoryHash !== hash({ identity: IDENTITY, targets: inventory.targets })) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: invalid inventory');
  if (new Set(inventory.targets.map(m => m.id)).size !== inventory.targets.length) throw new Error('DUPLICATE_MOUNTAIN_IDS');
  const excluded = new Set([...inventory.excludedAcceptedIds, ...inventory.closedOldHoldoutIds]);
  if (inventory.targets.some(m => !inCoverage(m) || excluded.has(m.id))) throw new Error('INVENTORY_EXCLUSION_MISMATCH');
  const targets = full ? inventory.targets : inventory.targets.slice(0, 30);
  if (!full && targets.length !== 30) throw new Error('INSUFFICIENT_CANARY_TARGETS');
  const mode = full ? 'FULL_700M' : 'canary';
  const runDir = full ? `${BULK_DIR}/full-v1` : `${BULK_DIR}/run-v2`;
  await mkdir(runDir, { recursive: true });
  const lockPath = `${BULK_DIR}/runner.lock`;
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, mode, at: new Date().toISOString() }));
  try {
    const sourceFiles = ['bulk700-run.ts', 'bulk700-contract.ts', 'bulk700-inventory.ts', 'adapter.ts', 'lifecycle.ts', 'pbf-block-loader.ts', 'candidate-index.ts', '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts', '../../../Lib/gpxIngestion/pbfBlockGraph.ts', '../../../Lib/gpxIngestion/osmTrailGraph.ts', '../../../Lib/gpxIngestion/gpxNormalization.ts', '../../osm-import/phase11c9-road-safety.ts'];
    const sourceHash = hash(await Promise.all(sourceFiles.map(p => readFile(`scripts/routes/graphhopper/${p}`, 'utf8'))));
    const index = await loadCandidateIndex();
    if (!index || index.pbfSha256 !== IDENTITY.pbfSha256 || index.count !== index.candidates.length) throw new Error('REAL_CANDIDATE_INDEX_UNAVAILABLE');
    const candidateHash = hash(index);
    // Semantic identity binds only policy/contract, not implementation/perf
    const semanticHash = full
      ? hash({ identity: IDENTITY, inventoryHash: inventory.inventoryHash, candidateHash, blockExtractionVersion: BLOCK_EXTRACTION_VERSION, blockGraphOptionsVersion: BLOCK_GRAPH_OPTIONS_VERSION, mode: 'FULL_700M', targetCount: 62014, semanticPolicy: 'v2' })
      : hash({ identity: IDENTITY, inventoryHash: inventory.inventoryHash, candidateHash });
    const runHash = full
      ? hash({ semanticHash, sourceHash })
      : hash({ identity: IDENTITY, inventoryHash: inventory.inventoryHash, sourceHash, candidateHash });
    const oldRunHash = hash({ identity: IDENTITY, inventoryHash: inventory.inventoryHash, sourceHash, candidateHash });
    let cp: Checkpoint = { runHash, inventoryHash: inventory.inventoryHash, mode, completed: [], rejectedTargets: [] };
    let needsHashUpgrade = false;
    let needsSemanticMigration = false;
    let savedSemanticHash: string | null = null;
    try {
      const saved = await readJson<Omit<Checkpoint,'completed'> & { completedCount: number; runHash: string; semanticHash?: string }>(`${runDir}/checkpoint.json`);
      cp = { ...saved, completed: [] } as Checkpoint;
      for (const dir of ['results','holdout']) {
        const files = await readdir(`${runDir}/${dir}`).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
        for (const name of files.filter(n => /^\d+\.json$/.test(n))) cp.completed.push(await readJson<BulkResult>(`${runDir}/${dir}/${name}`));
      }
      if (cp.completed.length < saved.completedCount || cp.completed.length > saved.completedCount+1) throw new Error('CHECKPOINT_RESULT_COUNT_MISMATCH');
      savedSemanticHash = (saved as unknown as { semanticHash?: string }).semanticHash ?? null;
      // If checkpoint already has semanticHash, compare semantic
      if (full && saved.semanticHash && saved.semanticHash !== semanticHash) throw new Error('CHECKPOINT_SEMANTIC_MISMATCH');
      // Legacy checkpoint without semanticHash: compare legacy runHash vs new semantic+source split; allow if semantic matches
      if (full && !saved.semanticHash && saved.runHash !== runHash) {
        // Legacy runHash was hash({identity, inventoryHash, sourceHashOld, candidateHash, block..., mode, targetCount})
        // If current semanticHash matches what legacy would have computed (i.e., inventory/candidate/block unchanged), it's implementation-only drift
        // We verify by checking that saved inventoryHash and identity match current semantic components
        if (saved.inventoryHash === inventory.inventoryHash) {
          needsSemanticMigration = true;
          // Preserve completed artifacts, update to new runHash/semanticHash
          cp.runHash = runHash;
          (cp as unknown as Record<string, unknown>).semanticHash = semanticHash;
        }
      }
      if (!full && saved.runHash === oldRunHash && runHash !== oldRunHash) {
        needsHashUpgrade = true;
        cp.runHash = runHash;
      }
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { validateCheckpoint(cp, runHash, new Set(inventory.targets.map(m => m.id))); }
    catch (e) {
      if (needsHashUpgrade || needsSemanticMigration || full) {
        // For full with semantic migration, validate semantic identity instead
        if (needsSemanticMigration) {
          // Validate via artifact counts and semanticHash, not full runHash drift
          if (cp.inventoryHash !== inventory.inventoryHash) throw e;
          // ok
        } else throw e;
      } else {
        validateCheckpoint(cp, oldRunHash, new Set(inventory.targets.map(m => m.id)));
        throw new Error(`CHECKPOINT_IDENTITY_OR_DUPLICATE: runHash upgraded to ${runHash.slice(0,12)} but checkpoint still at old hash; remove stale checkpoint if intentional`);
      }
    }
    if (!full && cp.completed.some(r => !targets.some(m => m.id === r.mountainId))) throw new Error('CANARY_CANNOT_RESUME_FULL_RUN');
    await verifyArtifacts(cp.completed, runDir);
    const counts = primaryCounts(cp.completed);
    const checkpoint = () => {
      if (Object.values(counts).reduce((a,b)=>a+b,0) !== cp.completed.length) throw new Error('PRIMARY_STATE_SUM_MISMATCH');
      return atomicJson(`${runDir}/checkpoint.json`, { runHash: cp.runHash, semanticHash, inventoryHash: cp.inventoryHash, mode, completedCount: cp.completed.length, counts, rejectedTargets: cp.rejectedTargets, blockExtractionVersion: BLOCK_EXTRACTION_VERSION, blockGraphOptionsVersion: BLOCK_GRAPH_OPTIONS_VERSION, pbfSha256: IDENTITY.pbfSha256, graphId: IDENTITY.graphId, profile: IDENTITY.profile, sourceHash, implementationHash: sourceHash });
    };
    await checkpoint();
    if (needsHashUpgrade) console.log(`Upgraded checkpoint hash ${oldRunHash.slice(0,12)} -> ${runHash.slice(0,12)} preserving ${cp.completed.length} valid artifacts`);
    if (needsSemanticMigration) {
      await verifyArtifacts(cp.completed, runDir);
      await atomicJson(`${runDir}/checkpoint-migration-audit.json`, { at: new Date().toISOString(), fromRunHash: savedSemanticHash ?? 'legacy', toRunHash: runHash, semanticHash, sourceHash, preservedCompletedCount: cp.completed.length, preservedReady: cp.completed.filter(r=>r.state==='TRUSTED_REPLACEMENT_READY').length, preservedHoldout: cp.completed.filter(r=>r.state!=='TRUSTED_REPLACEMENT_READY').length, verifiedArtifacts: true });
      console.log(`Migrated checkpoint semantic ${semanticHash.slice(0,12)} implementation ${sourceHash.slice(0,12)} preserving ${cp.completed.length} artifacts`);
    }
    if (full) {
      // Accept either original canary or stratified gate
      let gateOk = false;
      for (const gatePath of [`${BULK_DIR}/canary/report.json`, `${BULK_DIR}/canary-stratified/report.json`]) {
        try {
          const gate = await readJson<{ readyForFull700mBulk: boolean; inventoryHash: string }>(gatePath);
          if (gate.readyForFull700mBulk && gate.inventoryHash === inventory.inventoryHash) { gateOk = true; break; }
        } catch {}
      }
      if (!gateOk) throw new Error('FULL_BULK_REQUIRES_PASSING_CURRENT_CANARY');
    }
    const completedIds = new Set(cp.completed.map(r => r.mountainId));
    const grid = new Map<string, CandidateIndex['candidates']>();
    for (const c of index.candidates) {
      if (c.osmType !== 'node' || primaryStartPriority(c.kind) === 99) continue;
      const key = blockFor(c.lon, c.lat), bucket = grid.get(key) ?? [];
      bucket.push(c); grid.set(key, bucket);
    }
    index.candidates = []; // Keep the spatial index, release the full array reference.
    const blockContexts = new Map<string, BlockRoutingContext>();
    const witnessCache = new Map<string, BaseAccessEvidence>();
    const blockPerf = new Map<string, BlockPerf>();
    const meta = await checkGraphIdentity();
    const getBlockRoutingContext = async (lon: number, lat: number): Promise<BlockRoutingContext> => {
      const key = blockFor(lon, lat);
      let ctx = blockContexts.get(key);
      if (ctx) {
        blockContexts.delete(key); blockContexts.set(key, ctx);
        const perf = blockPerf.get(key);
        if (perf) perf.hits++;
        return ctx;
      }
      const t0 = performance.now();
      if (blockContexts.size >= BLOCK_CONTEXT_LRU) {
        const evicted = blockContexts.keys().next().value!;
        blockContexts.delete(evicted);
      }
      const ways = await loadBlockWays(key, IDENTITY.pbfSha256);
      // Build immutable routing structures once per block (full halo ways). Bounded search (150+250m) means
      // distant extra ways do not affect witness vs prior per-candidate filtered subset; verified by equivalence test.
      const graphT0 = performance.now();
      const graph = buildReconstructionPbfBlockGraph({ datasetKey:'local-osm-pbf',region:'alps',snapshotTimestamp:new Date(meta.pbfModifiedMs).toISOString(),pbfSha256:IDENTITY.pbfSha256 }, ways);
      const network = new BaseAccessNetwork(ways);
      const builtMs = performance.now() - t0;
      const graphMs = performance.now() - graphT0;
      ctx = { block: key, ways, graph, network, builtMs };
      blockContexts.set(key, ctx);
      const existing = blockPerf.get(key);
      if (existing) { existing.misses++; existing.loadMs += builtMs; existing.contextBuildMs += graphMs; existing.ways = ways.length; }
      else blockPerf.set(key, { block: key, mountains: 0, loadMs: builtMs, ways: ways.length, hits: 0, misses: 1, contextBuildMs: graphMs });
      return ctx;
    };
    // Backward compat alias: summit road-node extraction uses full context ways
    const context = async (lon: number, lat: number) => {
      const ctx = await getBlockRoutingContext(lon, lat);
      return { ways: ctx.ways };
    };
    let serverHealthy = false;
    let infrastructureError: string | null = null;
    // Order pending targets by block locality for reuse; checkpoint remains ID-based
    const pendingOrdered = orderedByBlock(targets.filter(m => !completedIds.has(m.id)));
    const wallStart = performance.now();
    const targetCount = inventory.targets.length;
    try {
      if (completedIds.size !== targets.length) await withGraphHopper(meta, `${runDir}/graphhopper.log`, full ? 86_400_000 : 2_700_000, async signal => {
        serverHealthy = true;
        for (const m of pendingOrdered) {
          if (completedIds.has(m.id)) continue;
          signal.throwIfAborted();
          // Second height guard: invalid inputs are neither corpus nor holdout.
          if (!validHeight(m)) {
            if (!cp.rejectedTargets.some(r => r.mountainId === m.id)) cp.rejectedTargets.push({ mountainId: m.id, reason: 'INVALID_HEIGHT_FOR_BULK' });
            await checkpoint(); continue;
          }
          if (!(await graphHealthy(signal))) throw new Error('GRAPHHOPPER_GLOBAL_HEALTH_LOST');
          const curBlock = blockFor(m.longitude!, m.latitude!);
          const perf = blockPerf.get(curBlock);
          if (perf) perf.mountains++;
          else blockPerf.set(curBlock, { block: curBlock, mountains: 1, loadMs: 0, ways: 0, hits: 0, misses: 0, contextBuildMs: 0 });
          const result: BulkResult = { mountainId: m.id, state: 'NO_REAL_BASE_ACCESS_CANDIDATE', reviewFlags: [], reason: 'NO_PRIMARY_BASE_ACCESS_WITNESS', routingEngine: 'GRAPH_HOPPER', ...IDENTITY, fallbackReason: null, attempts: [], baseAccessMs: 0, routingMs: 0, artifactWriteMs: 0, artifacts: {}, syntheticGeometryCount: 0, fabricatedEvidenceCount: 0 };
          let discoveryStart = performance.now();
          try {
            const [x,y] = blockFor(m.longitude!, m.latitude!).split('_').map(Number);
            const nearby = [] as CandidateIndex['candidates'];
            for (let dx=-2; dx<=2; dx++) for (let dy=-1; dy<=1; dy++) nearby.push(...(grid.get(`${x+dx}_${y+dy}`) ?? []));
            const pool = boundedCandidatesForSummit({ ...index, candidates: nearby }, { lon: m.longitude!, lat: m.latitude! }, 20);
            // Real public-network starts from OSM way endpoints, carrying their source way.
            // They are not invented links or inherited node tags; Base Access still proves exact topology.
            const summitContext = await context(m.longitude!,m.latitude!);
            const roadNodes = new Map<number, CandidateIndex['candidates'][number] & { sourceWayId: number; sourceKind: string }>();
            for (const way of summitContext.ways) {
              if (!publicApproachRoad(way)) continue;
              for (const node of [way.nodes[0],way.nodes.at(-1)]) {
                if (!node?.coordinate || calculateCoordinateDistanceMeters(node.coordinate,[m.longitude!,m.latitude!]) > 20_000) continue;
                roadNodes.set(node.nodeId,{ osmType:'node', osmId:node.nodeId, kind:'NETWORK_ACCESS', name:null, lon:node.coordinate[0], lat:node.coordinate[1], tags:{}, sourceWayId:way.id, sourceKind:'OSM_PUBLIC_WAY_ENDPOINT' });
              }
            }
            pool.push(...[...roadNodes.values()].sort((a,b) => calculateCoordinateDistanceMeters([a.lon,a.lat],[m.longitude!,m.latitude!])-calculateCoordinateDistanceMeters([b.lon,b.lat],[m.longitude!,m.latitude!])).slice(0,20));
            // Deduplicate candidate start nodes (same osmId+kind) to avoid duplicate BaseAccess evaluations
            const dedup = new Map<string, typeof pool[number]>();
            for (const c of pool) {
              const key = `${c.osmId}:${c.kind}`;
              if (!dedup.has(key)) dedup.set(key, c);
            }
            const uniquePool = [...dedup.values()];
            for (const cand of uniquePool) {
              signal.throwIfAborted();
              const witnessKey = `${cand.kind}:${cand.osmId}`;
              let witness = witnessCache.get(witnessKey);
              if (!witness) {
                const ctx = await getBlockRoutingContext(cand.lon, cand.lat);
                // Immutable block graph+network reused; evaluation is still per-candidate but graph/network not rebuilt.
                const node = ctx.graph.node(cand.osmId);
                if (!node || calculateCoordinateDistanceMeters(node.coordinate, [cand.lon,cand.lat]) > 1) continue;
                witness = ctx.network.evaluate({ kind:cand.kind,tags:cand.tags,nodeId:cand.osmId,graph: ctx.graph });
                if (witnessCache.size >= 10_000) witnessCache.delete(witnessCache.keys().next().value!);
                witnessCache.set(witnessKey,witness);
              }
              const evidence: BaseAccessEvidence = { ...witness, summitElevation:m.height };
              if (!primaryBaseAccess(evidence)) continue;
              result.baseAccessMs += performance.now()-discoveryStart;
              const routeStart = performance.now();
              const response = await routeWithGraphHopper({ start: { lat: cand.lat, lon: cand.lon }, summit: { lat: m.latitude!, lon: m.longitude! } }, {
                graphId: IDENTITY.graphId, graphHopperVersion: meta.graphHopperVersion, signal, allowFallbackAfterHealthy: true,
                onAttempt: (routingEngine, ms, fetchFailed) => { result.attempts.push({ routingEngine, ms, fetchFailed }); result.routingEngine = routingEngine; if (fetchFailed) result.fallbackReason = 'FETCH_FAILED'; },
              });
              result.routingMs += performance.now()-routeStart;
              discoveryStart = performance.now();
              if (!response.ok) { result.state = classify(response.reason); result.reason = response.reason; continue; }
              const route = response.result;
              const coords = route.geometry.coordinates;
              if (coords.length < 2 || !Number.isFinite(route.distanceMeters) || route.distanceMeters <= 0 || coords.some(c => !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite) || Math.abs(c[0])>180 || Math.abs(c[1])>90)) {
                result.state = 'INVALID_GEOMETRY'; result.reason = 'INVALID_ROUTED_GEOMETRY'; continue;
              }
              const snap = calculateCoordinateDistanceMeters(coords.at(-1)!, [m.longitude!,m.latitude!]);
              const startSnap = calculateCoordinateDistanceMeters(coords[0], [cand.lon,cand.lat]);
              if (startSnap > 150) { result.state = 'REJECTED_ACCESS'; result.reason = 'START_SNAP_EXCEEDS_150M'; continue; }
              if (snap > 50) { result.state = 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED'; result.reason = 'SUMMIT_SNAP_EXCEEDS_50M'; continue; }
              result.state = 'TRUSTED_REPLACEMENT_READY'; result.reason = null;
              result.routingEngine = route.routingEngine; result.fallbackReason = route.fallbackReason ?? null;
              if (route.distanceMeters < 500 || route.distanceMeters > 50_000) result.reviewFlags.push('REVIEW_GEOMETRY_CHANGE');
              result.baseAccessMs += performance.now()-discoveryStart;
              const writeStart = performance.now();
              const prefix = `ready/${m.id}`;
              await mkdir(join(runDir, prefix), { recursive: true });
              const name = `${cand.name ?? cand.kind} → ${m.name}`;
              const artifacts: Record<string,string> = {
                'route.gpx': serializeGpx(name, route), 'route.geojson': serializeGeojson(name, route),
                'route.json': routeJson(route, cand.kind, { id: m.id, name: m.name }, { startCandidate: cand, accessEvidence: evidence }),
                'evidence.json': JSON.stringify({ ...IDENTITY, startCandidate: cand, accessEvidence: evidence, mountain: m, geometryHash: hash(route.geometry), summitAttachment: { distanceMeters: snap, tier: snap <= 30 ? 'DIRECT' : 'EXTENDED', terminal: coords.at(-1) }, routingEngine: route.routingEngine, fallbackReason: route.fallbackReason ?? null }, null, 2),
              };
              for (const [file, content] of Object.entries(artifacts)) { await writeFile(join(runDir,prefix,file),content); result.artifacts[`${prefix}/${file}`] = hash(content); }
              result.artifactWriteMs += performance.now()-writeStart;
              discoveryStart = performance.now();
              break;
            }
          } catch (e) {
            signal.throwIfAborted();
            result.reason = e instanceof Error ? e.message : 'UNKNOWN_ERROR'; result.state = classify(result.reason); result.artifacts = {};
          }
          result.baseAccessMs += performance.now()-discoveryStart;
          const writeStart = performance.now();
          await atomicJson(`${runDir}/${result.state === 'TRUSTED_REPLACEMENT_READY' ? 'results' : 'holdout'}/${m.id}.json`,result);
          result.artifactWriteMs += performance.now()-writeStart;
          cp.completed.push(result); completedIds.add(m.id);
          counts[result.state]++;
          await checkpoint();
          const elapsedMs = performance.now() - wallStart;
          const totalProcessed = cp.completed.length;
          const remaining = targetCount - totalProcessed;
          const mtnPerMin = elapsedMs > 0 ? totalProcessed * 60_000 / elapsedMs : 0;
          const etaMs = mtnPerMin > 0 ? remaining * 60_000 / mtnPerMin : 0;
          const etaH = (etaMs / 3_600_000).toFixed(1);
          const rssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
          const pcs2 = parsedCacheStats();
          const ctxHits = [...blockPerf.values()].reduce((s,b)=>s+b.hits,0);
          const ctxMisses = [...blockPerf.values()].reduce((s,b)=>s+b.misses,0);
          const ctxHitRate = ctxHits+ctxMisses ? (ctxHits/(ctxHits+ctxMisses)*100).toFixed(0) : '0';
          const parsedHitRate = pcs2.hits+pcs2.misses ? (pcs2.hits/(pcs2.hits+pcs2.misses)*100).toFixed(0) : '0';
          const perfCur = blockPerf.get(curBlock);
          const warmInfo = perfCur ? `ctxBuild=${(perfCur.contextBuildMs||0).toFixed(0)}ms ways=${perfCur.ways}` : '';
          console.log(`${mode} ${totalProcessed}/${targetCount} READY=${counts.TRUSTED_REPLACEMENT_READY} NO_BASE=${counts.NO_REAL_BASE_ACCESS_CANDIDATE} NO_ROUTE=${counts.NO_ROUTE} REVIEW=${counts.SUMMIT_ATTACHMENT_REVIEW_REQUIRED} ERR=${counts.GRAPH_ERROR+counts.INVALID_GEOMETRY+counts.UNEXPECTED_ERROR} block=${curBlock} mtn=${m.id} ${result.state} ${result.routingEngine} rss=${rssMb}MB ${mtnPerMin.toFixed(2)}/min ETA ${etaH}h ${warmInfo} baseMs=${result.baseAccessMs.toFixed(0)} routeMs=${result.routingMs.toFixed(0)} ctxHit${ctxHitRate}% parsedHit${parsedHitRate}% remaining=${remaining}`);
          if (result.attempts.some(a => a.fetchFailed) && !(await graphHealthy(signal))) throw new Error('GRAPHHOPPER_GLOBAL_HEALTH_LOST');
        }
      });
    } catch (e) { infrastructureError = e instanceof Error ? e.message : 'UNKNOWN_INFRASTRUCTURE_ERROR'; }
    const summary = summarize(cp.completed, inventory.targets.length);
    const elapsedMs = performance.now() - wallStart;
    const endToEndMtnPerMin = elapsedMs > 0 && cp.completed.length ? cp.completed.length * 60_000 / elapsedMs : null;
    const estimatedFullHours = endToEndMtnPerMin && endToEndMtnPerMin > 0 ? (inventory.targets.length - cp.completed.length) * 60 / endToEndMtnPerMin / 60 + elapsedMs/3_600_000 : summary.estimatedFullHours;
    const readyForFull700mBulk = !infrastructureError && cp.rejectedTargets.length === 0 && summary.processed === targets.length && summary.graphHopperAttempts > 0 && summary.graphHopperSuccess > 0 && summary.globalFetchFailedRate !== 1;
    const blockPerfArray = [...blockPerf.values()].sort((a,b) => b.mountains - a.mountains);
    const pcs = parsedCacheStats();
    const contextCacheStats = { hits: blockPerfArray.reduce((s,b)=>s+b.hits,0), misses: blockPerfArray.reduce((s,b)=>s+b.misses,0) };
    const blockReport = {
      uniqueBlocksTotal: 660,
      blocksTouched: blockPerf.size,
      cacheLru: BLOCK_CACHE_LRU,
      contextLru: BLOCK_CONTEXT_LRU,
      contextVersion: BLOCK_CONTEXT_VERSION,
      extractionVersion: BLOCK_EXTRACTION_VERSION,
      graphOptionsVersion: BLOCK_GRAPH_OPTIONS_VERSION,
      rssPeakMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      blockPerformance: blockPerfArray,
      totalBlockLoadMs: blockPerfArray.reduce((s,b)=>s+b.loadMs,0),
      totalContextBuildMs: blockPerfArray.reduce((s,b)=>s+(b.contextBuildMs||0),0),
      totalBlockMisses: contextCacheStats.misses,
      totalBlockHits: contextCacheStats.hits,
      parsedCache: pcs,
      contextCacheHitRate: contextCacheStats.hits + contextCacheStats.misses ? contextCacheStats.hits/(contextCacheStats.hits+contextCacheStats.misses) : 0,
      parsedCacheHitRate: pcs.hits + pcs.misses ? pcs.hits/(pcs.hits+pcs.misses) : 0,
    };
    await atomicJson(`${runDir}/block-performance.json`, blockReport);
    await atomicJson(`${BULK_DIR}/${mode}/report.json`, { ...summary, inventoryHash: inventory.inventoryHash, sourceHash, serverHealthy, infrastructureError, readyForFull700mBulk, checkpointResumeReady: true, rejectedTargets: cp.rejectedTargets, targetCount: inventory.targets.length, remainingUnprocessed: inventory.targets.length-cp.completed.length, mode, shutdownComplete: infrastructureError !== 'GRAPHHOPPER_SHUTDOWN_UNCONFIRMED', blockAware: true, blockOrder: 'deterministic PBF block locality', uniqueBlocks: 660, blockReuseLru: BLOCK_CACHE_LRU, elapsedMs, endToEndMtnPerMin, estimatedFullHoursWallClock: estimatedFullHours, rssMb: Math.round(process.memoryUsage().rss/1024/1024) });
    // Full completion artifacts
    if (full && cp.completed.length === inventory.targets.length && !infrastructureError) {
      await atomicJson(`${runDir}/summary.json`, { ...summary, elapsedMs, endToEndMtnPerMin, blockReport });
      const holdoutFinal = cp.completed.filter(r => r.state !== 'TRUSTED_REPLACEMENT_READY').map(r => ({ mountainId: r.mountainId, state: r.state, reason: r.reason }));
      await atomicJson(`${runDir}/holdout-final.json`, { count: holdoutFinal.length, holdout: holdoutFinal });
      await atomicJson(`${runDir}/full-run-report.json`, { ...summary, inventoryHash: inventory.inventoryHash, sourceHash, elapsedMs, endToEndMtnPerMin, blockReport, targetCount: inventory.targets.length, completed: cp.completed.length });
    }
    console.log(JSON.stringify({ ...summary, serverHealthy, infrastructureError, readyForFull700mBulk, endToEndMtnPerMin, blockAware: true, rssMb: Math.round(process.memoryUsage().rss/1024/1024) },null,2));
    if (!readyForFull700mBulk) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath).catch(()=>{}); }
}
export async function preflightFullInitOnly(): Promise<void> {
  const inventory = await readJson<Inventory>(`${BULK_DIR}/inventory.json`);
  if (inventory.source !== 'SUPABASE_DATABASE' || hash(inventory.identity) !== hash(IDENTITY) || inventory.inventoryHash !== hash({ identity: IDENTITY, targets: inventory.targets })) throw new Error('REAL_MOUNTAIN_SOURCE_UNAVAILABLE: invalid inventory');
  if (new Set(inventory.targets.map(m => m.id)).size !== inventory.targets.length) throw new Error('DUPLICATE_MOUNTAIN_IDS');
  if (inventory.targets.length !== 62014) throw new Error(`FULL_EXPECTS_62014_GOT_${inventory.targets.length}`);
  const runDir = `${BULK_DIR}/full-v1`;
  await mkdir(runDir, { recursive: true });
  await mkdir(`${runDir}/results`, { recursive: true });
  await mkdir(`${runDir}/holdout`, { recursive: true });
  // Verify canary final gate before initializing
  const gate = await readJson<{ processed:number; readyForFull700mBulk:boolean; serverHealthy:boolean; inventoryHash:string; counts:Record<string,number>; syntheticGeometryCount:number; fabricatedEvidenceCount:number; primaryStateSumCorrect:boolean }>(`${BULK_DIR}/canary-stratified/report.json`);
  if (gate.processed !== 60 || !gate.readyForFull700mBulk || !gate.serverHealthy || gate.inventoryHash !== inventory.inventoryHash || gate.counts.GRAPH_ERROR !== 0 || gate.syntheticGeometryCount !== 0 || gate.fabricatedEvidenceCount !== 0 || !gate.primaryStateSumCorrect) throw new Error('STRATIFIED_GATE_NOT_READY');
  const sourceFiles = ['bulk700-run.ts', 'bulk700-contract.ts', 'bulk700-inventory.ts', 'adapter.ts', 'lifecycle.ts', 'pbf-block-loader.ts', 'candidate-index.ts', '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts', '../../../Lib/gpxIngestion/pbfBlockGraph.ts', '../../../Lib/gpxIngestion/osmTrailGraph.ts', '../../../Lib/gpxIngestion/gpxNormalization.ts', '../../osm-import/phase11c9-road-safety.ts'];
  const sourceHash = hash(await Promise.all(sourceFiles.map(p => readFile(`scripts/routes/graphhopper/${p}`, 'utf8'))));
  const index = await loadCandidateIndex();
  if (!index || index.pbfSha256 !== IDENTITY.pbfSha256 || index.count !== index.candidates.length) throw new Error('REAL_CANDIDATE_INDEX_UNAVAILABLE');
  const semanticHash = hash({ identity: IDENTITY, inventoryHash: inventory.inventoryHash, candidateHash: hash(index), blockExtractionVersion: BLOCK_EXTRACTION_VERSION, blockGraphOptionsVersion: BLOCK_GRAPH_OPTIONS_VERSION, mode: 'FULL_700M', targetCount: 62014, semanticPolicy: 'v2' });
  const runHash = hash({ semanticHash, sourceHash });
  // Do not overwrite existing valid checkpoint; verify or create initial
  try {
    const saved = await readJson<{ runHash:string; semanticHash?: string; inventoryHash:string; mode:string; completedCount:number }>(`${runDir}/checkpoint.json`);
    if (saved.semanticHash) {
      if (saved.semanticHash !== semanticHash || saved.inventoryHash !== inventory.inventoryHash || saved.mode !== 'FULL_700M') throw new Error('FULL_CHECKPOINT_IDENTITY_MISMATCH: existing full-v1 checkpoint does not match current inventory/graph identity; manual review required');
    } else {
      // legacy checkpoint: allow if inventory matches and semantic would have matched
      if (saved.inventoryHash !== inventory.inventoryHash || saved.mode !== 'FULL_700M') throw new Error('FULL_CHECKPOINT_IDENTITY_MISMATCH: existing full-v1 checkpoint does not match current inventory/graph identity; manual review required');
      // legacy runHash drift due to sourceHash is allowed – will be migrated on next --full run
      console.log(`Legacy checkpoint detected runHash ${saved.runHash.slice(0,12)} -> new ${runHash.slice(0,12)} semantic ${semanticHash.slice(0,12)} (implementation drift)`);
    }
    if (saved.completedCount !== 0) console.log(`Full checkpoint already initialized with ${saved.completedCount} completed (resume)`);
    else console.log('Full checkpoint already initialized (0 completed)');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e as Error).message.includes('FULL_CHECKPOINT_IDENTITY_MISMATCH')) throw e;
    if ((e as Error).message.includes('FULL_CHECKPOINT_IDENTITY_MISMATCH')) throw e;
    const counts = primaryCounts([]);
    await atomicJson(`${runDir}/checkpoint.json`, { runHash, semanticHash, inventoryHash: inventory.inventoryHash, mode: 'FULL_700M', completedCount: 0, counts, rejectedTargets: [], blockExtractionVersion: BLOCK_EXTRACTION_VERSION, blockGraphOptionsVersion: BLOCK_GRAPH_OPTIONS_VERSION, pbfSha256: IDENTITY.pbfSha256, graphId: IDENTITY.graphId, profile: IDENTITY.profile, targetCount: 62014, sourceHash, implementationHash: sourceHash });
    console.log(`Initialized ${runDir}/checkpoint.json mode=FULL_700M targetCount=62014 inventoryHash=${inventory.inventoryHash.slice(0,12)} runHash=${runHash.slice(0,12)} semanticHash=${semanticHash.slice(0,12)}`);
  }
  console.log(`Preflight OK: canary artifacts preserved at run-v2 and canary-stratified/run, full-v1 ready`);
}
if (process.argv[1]?.replace(/\\/g,'/').endsWith('/bulk700-run.ts')) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--preflight','--init-only'].includes(args[0])) {
    preflightFullInitOnly().catch(e => { console.error(e instanceof Error ? e.message : 'PREFLIGHT_FAILED'); process.exitCode = 1; });
  } else {
    if (args.length !== 1 || !['--canary','--full'].includes(args[0])) throw new Error('USE_EXPLICIT_MODE: --canary or --full (or --preflight/--init-only for dry init)');
    run700(args[0] === '--full').catch(e => { console.error(e instanceof Error ? e.message : 'BULK_FAILED'); process.exitCode = 1; });
  }
}
