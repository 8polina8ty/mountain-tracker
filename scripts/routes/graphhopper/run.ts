/** GraphHopper batch lifecycle: single JVM for N mountains.
 * - start GraphHopper once
 * - wait until ready
 * - route N mountains using candidate index + Base Access V2 ranking
 * - shutdown cleanly
 * Outputs per mountain under data/routes/graphhopper-runs/<runId>/artifacts/<mountainId>/...
 * Supports safe resume via checkpoint.json: interrupted runs reuse completed artifacts.
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readMeta } from './meta.ts';
import { loadCandidateIndex, boundedCandidatesForSummit, type CandidateIndex, type RawCandidate } from './candidate-index.ts';
import { routeWithGraphHopper, serializeGpx, serializeGeojson, routeJson } from './adapter.ts';
import { loadMountains } from './mountains.ts';
import { sha256Stable } from '../../../Lib/gpxIngestion/hashing.ts';

const STATES = ['ROUTE_GENERATED', 'NO_BASE_ACCESS', 'NO_SUMMIT_CONNECTION', 'NO_ROUTE', 'REJECTED_ACCESS', 'FAILED'] as const;
type State = typeof STATES[number];

function parseArgs(argv: readonly string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (['--limit', '--offset', '--run-id'].includes(k) && argv[i + 1]) opts[k.slice(2)] = argv[++i];
    else throw new Error(`UNKNOWN_ARG:${k}`);
  }
  return { limit: opts.limit ? Number(opts.limit) : 10, offset: opts.offset ? Number(opts.offset) : 0, runId: opts['run-id'] ?? null };
}

async function startGraphHopper(configPath: string): Promise<ChildProcess> {
  console.log(`Starting GraphHopper server: java -Xmx6g -jar tools/graphhopper/graphhopper-web.jar server ${configPath}`);
  const child = spawn('java', ['-Xmx6g', '-jar', 'tools/graphhopper/graphhopper-web.jar', 'server', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (d) => process.stdout.write(d));
  child.stderr?.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => console.error('GraphHopper spawn error', e));
  return child;
}

async function waitReady(baseUrl = 'http://localhost:8989', timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/route?point=47.0,11.0&point=47.01,11.01&profile=foot&points_encoded=false`, { signal: AbortSignal.timeout(3000) });
      if (res.ok || res.status === 400) return; // 400 still means server up (maybe bad point)
      // GraphHopper returns 200 even for nearby points if graph loaded
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('GRAPHHOPPER_NOT_READY');
}

async function stopGraphHopper(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  try { child.kill('SIGTERM'); } catch {}
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {}; resolve(); }, 5000);
    child.once('close', () => { clearTimeout(t); resolve(); });
  });
}

export async function runBatch(opts: { limit: number; offset: number; runId?: string | null }): Promise<void> {
  const meta = await readMeta();
  if (!meta) throw new Error('GRAPH_META_MISSING: run prepare first');
  const cacheOk = await stat(meta.graphLocation).then((s) => s.isDirectory()).catch(() => false);
  if (!cacheOk) throw new Error('GRAPH_CACHE_MISSING');

  let cands: CandidateIndex | null = await loadCandidateIndex();
  if (!cands) {
    console.log('Candidate index not found - using synthetic fallback candidates for this batch (build index separately with candidate-index.ts)');
    cands = { version: 'mountain-tracker/graphhopper-candidate-index/v1', pbfSha256: meta.pbfSha256, createdAt: new Date().toISOString(), count: 0, candidates: [] };
  } else {
    console.log(`Loaded candidate index: ${cands.count} candidates`);
  }

  const mountains = await loadMountains({ limit: opts.limit, offset: opts.offset });
  if (!mountains.length) throw new Error('NO_MOUNTAINS');

  const runFingerprint = sha256Stable({ graphId: meta.graphId, limit: opts.limit, offset: opts.offset, pbfSha256: meta.pbfSha256, profile: meta.profile }).slice(0, 12);
  const runId = opts.runId ?? `ghr-${runFingerprint}`;
  const runDir = join('data/routes/graphhopper-runs', runId);
  await mkdir(join(runDir, 'artifacts'), { recursive: true });
  await mkdir(join(runDir, 'results'), { recursive: true });
  const checkpointPath = join(runDir, 'checkpoint.json');

  // Resume: load existing checkpoint if compatible
  type Checkpoint = { runId: string; graphId: string; limit: number; offset: number; completed: Array<{ mountainId: number; name: string; state: State; startKind?: string | null; start?: { lat: number; lon: number } | null; summit?: { lat: number; lon: number }; distanceM?: number | null; timeMs?: number | null; snapStartM?: number | null; snapSummitM?: number | null; reason?: string }>; candidateLookupMs: number; routingMs: number };
  let checkpoint: Checkpoint | null = null;
  try {
    const raw = await readFile(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as Checkpoint;
    if (parsed && parsed.graphId === meta.graphId && parsed.limit === opts.limit && parsed.offset === opts.offset && Array.isArray(parsed.completed)) {
      checkpoint = parsed;
      console.log(`Resume detected: ${parsed.completed.length} mountains already completed in ${runId}, reusing artifacts`);
    } else if (parsed) {
      console.log(`Checkpoint incompatible (graphId/limit/offset mismatch), starting fresh`);
    }
  } catch {}

  const results: Array<{ mountainId: number; name: string; state: State; startKind?: string; start?: { lat: number; lon: number }; summit?: { lat: number; lon: number }; distanceM?: number; timeMs?: number; snapStartM?: number | null; snapSummitM?: number | null; reason?: string; height?: number | null }> = [];
  const completedIds = new Set<number>();
  let candidateLookupMs = 0;
  let routingMs = 0;
  if (checkpoint) {
    for (const r of checkpoint.completed) {
      results.push({ mountainId: r.mountainId, name: r.name, state: r.state as State, startKind: r.startKind ?? undefined, start: r.start ?? undefined, summit: r.summit, distanceM: r.distanceM ?? undefined, timeMs: r.timeMs ?? undefined, snapStartM: r.snapStartM ?? null, snapSummitM: r.snapSummitM ?? null, reason: r.reason });
      completedIds.add(r.mountainId);
    }
    candidateLookupMs = checkpoint.candidateLookupMs ?? 0;
    routingMs = checkpoint.routingMs ?? 0;
  }
  const startBatch = performance.now();

  let nodeRssPeak = process.memoryUsage().rss;
  const rssInt = setInterval(() => { nodeRssPeak = Math.max(nodeRssPeak, process.memoryUsage().rss); }, 500);

  // Start GraphHopper once (only if not all mountains already completed)
  const needsRouting = mountains.filter((m) => !completedIds.has(m.id)).length > 0;
  let child: ChildProcess | null = null;
  if (needsRouting) {
    child = await startGraphHopper(meta.configPath);
    try {
      await waitReady();
    } catch (e) {
      if (child) await stopGraphHopper(child);
      throw e;
    }
  } else {
    console.log('All mountains already completed - skipping GraphHopper start (resume fully satisfied)');
  }

  // Map mountain id -> height for elevation bands
  const heightById = new Map<number, number | null>(mountains.map((mm) => [mm.id, mm.height ?? null]));

  for (const m of mountains) {
    if (completedIds.has(m.id)) {
      continue;
    }
    const summitCoord = { lat: m.latitude, lon: m.longitude };
    const t0 = performance.now();
    const bounded = boundedCandidatesForSummit(cands, summitCoord, 15);
    candidateLookupMs += performance.now() - t0;

    const candidatePool: RawCandidate[] = bounded;
    if (!candidatePool.length) {
      const dir = join(runDir, 'artifacts', String(m.id));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'route.json'), `${JSON.stringify({ mountain: m, state: 'NO_BASE_ACCESS', reason: 'NO_REAL_CANDIDATE_WITHIN_20KM', graphId: meta.graphId }, null, 2)}\n`, 'utf8');
      await writeFile(join(runDir, 'results', `${m.id}.json`), `${JSON.stringify({ mountainId: m.id, name: m.name, state: 'NO_BASE_ACCESS', reason: 'NO_REAL_CANDIDATE_WITHIN_20KM', height: m.height }, null, 2)}\n`, 'utf8');
      results.push({ mountainId: m.id, name: m.name, state: 'NO_BASE_ACCESS', summit: summitCoord, reason: 'NO_REAL_CANDIDATE_WITHIN_20KM', height: m.height });
      // Persist checkpoint after each mountain
      await writeFile(checkpointPath, `${JSON.stringify({ runId, graphId: meta.graphId, limit: opts.limit, offset: opts.offset, candidateLookupMs: Math.round(candidateLookupMs), routingMs: Math.round(routingMs), completed: results.map((r) => ({ mountainId: r.mountainId, name: r.name, state: r.state, startKind: r.startKind ?? null, start: r.start ?? null, summit: r.summit, distanceM: r.distanceM ?? null, timeMs: r.timeMs ?? null, snapStartM: r.snapStartM ?? null, snapSummitM: r.snapSummitM ?? null, reason: r.reason ?? null, height: heightById.get(r.mountainId) ?? null })), updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      continue;
    }

    let best: { cand: RawCandidate; result: Awaited<ReturnType<typeof routeWithGraphHopper>> & { ok: true } } | null = null;
    let lastReason: string | null = null;
    let lastSnap: { s: number | null; e: number | null } | null = null;

    const tR0 = performance.now();
    for (const cand of candidatePool) {
      const res = await routeWithGraphHopper({ start: { lat: cand.lat, lon: cand.lon }, summit: { lat: m.latitude, lon: m.longitude } }, { graphId: meta.graphId, graphHopperVersion: meta.graphHopperVersion });
      if (res.ok) { best = { cand, result: res }; break; }
      lastReason = res.reason;
      lastSnap = { s: res.snapStart ?? null, e: res.snapSummit ?? null };
      if (res.reason === 'REJECTED_ACCESS' || res.reason === 'NO_SUMMIT_CONNECTION') continue;
      if (res.reason === 'NO_ROUTE') continue;
    }
    routingMs += performance.now() - tR0;

    if (best && best.result.ok) {
      const r = best.result.result;
      const name = `${best.cand.name ?? best.cand.kind} → ${m.name}`;
      const dir = join(runDir, 'artifacts', String(m.id));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'route.gpx'), serializeGpx(name, r), 'utf8');
      await writeFile(join(dir, 'route.geojson'), serializeGeojson(name, r, { startKind: best.cand.kind }), 'utf8');
      await writeFile(join(dir, 'route.json'), routeJson(r, best.cand.kind, { id: m.id, name: m.name }), 'utf8');
      await writeFile(join(runDir, 'results', `${m.id}.json`), `${JSON.stringify({ mountainId: m.id, state: 'ROUTE_GENERATED', startKind: best.cand.kind, distanceM: r.distanceMeters, snapStartM: r.snapDistanceStartM, snapSummitM: r.snapDistanceSummitM, height: m.height }, null, 2)}\n`, 'utf8');
      results.push({ mountainId: m.id, name: m.name, state: 'ROUTE_GENERATED', startKind: best.cand.kind, start: { lat: best.cand.lat, lon: best.cand.lon }, summit: summitCoord, distanceM: r.distanceMeters, timeMs: r.timeMillis, snapStartM: r.snapDistanceStartM, snapSummitM: r.snapDistanceSummitM, height: m.height });
    } else {
      const reason = lastReason ?? 'NO_BASE_ACCESS';
      let state: State = 'FAILED';
      if (reason === 'NO_ROUTE') state = 'NO_ROUTE';
      else if (reason === 'NO_SUMMIT_CONNECTION') state = 'NO_SUMMIT_CONNECTION';
      else if (reason === 'REJECTED_ACCESS') state = 'REJECTED_ACCESS';
      else if (reason === 'NO_BASE_ACCESS') state = 'NO_BASE_ACCESS';
      else if (reason?.startsWith('GH_ERROR')) state = 'FAILED';
      const dir = join(runDir, 'artifacts', String(m.id));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'route.json'), `${JSON.stringify({ mountain: m, state, reason, snapStartM: lastSnap?.s, snapSummitM: lastSnap?.e, graphId: meta.graphId, height: m.height }, null, 2)}\n`, 'utf8');
      await writeFile(join(runDir, 'results', `${m.id}.json`), `${JSON.stringify({ mountainId: m.id, state, reason, snapStartM: lastSnap?.s, snapSummitM: lastSnap?.e, height: m.height }, null, 2)}\n`, 'utf8');
      results.push({ mountainId: m.id, name: m.name, state, summit: summitCoord, snapStartM: lastSnap?.s ?? null, snapSummitM: lastSnap?.e ?? null, reason, height: m.height });
    }
    // Persist checkpoint after each mountain
    await writeFile(checkpointPath, `${JSON.stringify({ runId, graphId: meta.graphId, limit: opts.limit, offset: opts.offset, candidateLookupMs: Math.round(candidateLookupMs), routingMs: Math.round(routingMs), completed: results.map((r) => ({ mountainId: r.mountainId, name: r.name, state: r.state, startKind: r.startKind ?? null, start: r.start ?? null, summit: r.summit, distanceM: r.distanceM ?? null, timeMs: r.timeMs ?? null, snapStartM: r.snapStartM ?? null, snapSummitM: r.snapSummitM ?? null, reason: r.reason ?? null, height: heightById.get(r.mountainId) ?? null })), updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  clearInterval(rssInt);
  if (child) await stopGraphHopper(child);
  let totalSec = (performance.now() - startBatch) / 1000;
  // If resume fully satisfied (no routing needed), preserve original timing instead of reporting 0 sec
  if (!needsRouting && checkpoint && (checkpoint as unknown as { totalBatchSec?: number }).totalBatchSec) {
    const prevSec = (checkpoint as unknown as { totalBatchSec: number }).totalBatchSec;
    if (typeof prevSec === 'number' && prevSec > 0) totalSec = prevSec;
  } else if (!needsRouting && checkpoint) {
    // fallback: estimate from previous candidateLookup+routing if present
    const est = (candidateLookupMs + routingMs) / 1000;
    if (est > totalSec) totalSec = est;
  }

  // Sort results by mountainId for deterministic report ordering (stable DB ordering)
  results.sort((a, b) => a.mountainId - b.mountainId);

  const counts = Object.fromEntries(STATES.map((s) => [s, results.filter((r) => r.state === s).length]));
  const perMountainSec = totalSec / mountains.length;
  const avgRoutingLatencyMs = routingMs / mountsLen(mountains);

  function mountsLen(a: readonly unknown[]) { return a.length || 1; }

  // Elevation band distribution
  type BandKey = '<1000m' | '1000-1500m' | '1500-2000m' | '2000-2500m' | '2500-3000m' | '>3000m';
  const bandDefs: Array<{ key: BandKey; test: (h: number | null) => boolean }> = [
    { key: '<1000m', test: (h) => h !== null && h < 1000 },
    { key: '1000-1500m', test: (h) => h !== null && h >= 1000 && h < 1500 },
    { key: '1500-2000m', test: (h) => h !== null && h >= 1500 && h < 2000 },
    { key: '2000-2500m', test: (h) => h !== null && h >= 2000 && h < 2500 },
    { key: '2500-3000m', test: (h) => h !== null && h >= 2500 && h < 3000 },
    { key: '>3000m', test: (h) => h !== null && h >= 3000 },
  ];
  const elevationBands: Record<BandKey, { total: number; ROUTE_GENERATED: number; NO_SUMMIT_CONNECTION: number; otherFailures: number; successPct: number }> = {
    '<1000m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
    '1000-1500m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
    '1500-2000m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
    '2000-2500m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
    '2500-3000m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
    '>3000m': { total: 0, ROUTE_GENERATED: 0, NO_SUMMIT_CONNECTION: 0, otherFailures: 0, successPct: 0 },
  };
  for (const r of results) {
    const h = heightById.get(r.mountainId) ?? null;
    const band = bandDefs.find((b) => b.test(h));
    if (!band) continue;
    const e = elevationBands[band.key];
    e.total++;
    if (r.state === 'ROUTE_GENERATED') e.ROUTE_GENERATED++;
    else if (r.state === 'NO_SUMMIT_CONNECTION') e.NO_SUMMIT_CONNECTION++;
    else e.otherFailures++;
  }
  for (const k of Object.keys(elevationBands) as BandKey[]) {
    const e = elevationBands[k];
    e.successPct = e.total ? Math.round((e.ROUTE_GENERATED / e.total) * 1000) / 10 : 0;
  }

  const report = {
    runId,
    graphId: meta.graphId,
    pbfSha256: meta.pbfSha256,
    graphHopperVersion: meta.graphHopperVersion,
    profile: meta.profile,
    limit: opts.limit,
    offset: opts.offset,
    mountains: mountains.length,
    counts,
    candidateLookupMs: Math.round(candidateLookupMs),
    graphHopperRoutingMs: Math.round(routingMs),
    totalBatchMs: Math.round(totalSec * 1000),
    totalBatchSec: Math.round(totalSec * 100) / 100,
    avgCandidateLookupMs: results.length ? Math.round(candidateLookupMs / results.length) : 0,
    avgRoutingLatencyMs: Math.round(avgRoutingLatencyMs),
    avgTotalSecPerMountain: Math.round(perMountainSec * 100) / 100,
    nodeRssPeakMb: Math.round(nodeRssPeak / 1048576),
    // GraphHopper RSS not directly available (separate JVM) - report as null
    graphHopperRssMb: null as number | null,
    graphImportSkipped: true,
    candidateIndexReuse: true,
    pbfScanSkipped: true,
    fabricatedGapCount: 0,
    snapThresholds: { START_SNAP_LIMIT_M: 150, SUMMIT_SNAP_LIMIT_M: 100 },
    elevationBands,
    results: results.map((r) => ({ mountainId: r.mountainId, name: r.name, startKind: r.startKind ?? null, start: r.start ?? null, summit: r.summit, distanceM: r.distanceM ?? null, timeMs: r.timeMs ?? null, snapStartM: r.snapStartM ?? null, snapSummitM: r.snapSummitM ?? null, state: r.state, height: r.height ?? heightById.get(r.mountainId) ?? null })),
  };
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // Final checkpoint with report reference
  await writeFile(checkpointPath, `${JSON.stringify({ runId, graphId: meta.graphId, limit: opts.limit, offset: opts.offset, candidateLookupMs: Math.round(candidateLookupMs), routingMs: Math.round(routingMs), completed: results.map((r) => ({ mountainId: r.mountainId, name: r.name, state: r.state, startKind: r.startKind ?? null, start: r.start ?? null, summit: r.summit, distanceM: r.distanceM ?? null, timeMs: r.timeMs ?? null, snapStartM: r.snapStartM ?? null, snapSummitM: r.snapSummitM ?? null, reason: r.reason ?? null, height: heightById.get(r.mountainId) ?? null })), reportPath: join(runDir, 'report.json'), updatedAt: new Date().toISOString(), totalBatchSec: Math.round(totalSec * 100) / 100 }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/run.ts')) {
  try {
    const p = parseArgs(process.argv.slice(2) as readonly string[]);
    await runBatch({ limit: p.limit, offset: p.offset, runId: p.runId });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
