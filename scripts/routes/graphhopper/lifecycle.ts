import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { currentMeta, isCompatible, readMeta, type GraphMeta } from './meta.ts';
import { IDENTITY } from './bulk700-contract.ts';

export const LOCAL_GRAPH_URL = 'http://localhost:8989';
export const GRAPH_JAR = 'tools/graphhopper/graphhopper-web.jar';
export async function checkGraphIdentity(): Promise<GraphMeta> {
  const meta = await readMeta();
  if (!meta || meta.graphId !== IDENTITY.graphId || meta.pbfSha256 !== IDENTITY.pbfSha256 || meta.profile !== IDENTITY.profile) throw new Error('GRAPH_IDENTITY_MISMATCH');
  const actual = await currentMeta('data/osm/source/alps-latest.osm.pbf', meta.configPath);
  if (!isCompatible(meta, actual)) throw new Error('GRAPH_PBF_CONFIG_MISMATCH');
  for (const name of ['nodes', 'edges', 'geometry', 'location_index', 'properties']) {
    if ((await stat(`${meta.graphLocation}/${name}`)).size < 100) throw new Error('GRAPH_CACHE_INCOMPLETE');
  }
  const properties = await readFile(`${meta.graphLocation}/properties.txt`, 'utf8');
  if (!properties.includes('profiles=foot|153326525')) throw new Error('GRAPH_CACHE_PROFILE_MISMATCH');
  if (!(await stat(GRAPH_JAR).catch(() => null))?.isFile()) throw new Error('GRAPHHOPPER_JAR_MISSING');
  if (createHash('sha256').update(await readFile(GRAPH_JAR)).digest('hex') !== 'ead763749c395ea0cc45b3fd10092d6de84d62fb5cbaf7d416ba6cc142c5716c') throw new Error('GRAPHHOPPER_10_2_JAR_MISMATCH');
  return meta;
}
export async function graphHealthy(signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(3000);
    const response = await fetch(`${LOCAL_GRAPH_URL}/info`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return false;
    const info = await response.json() as { version?: string; profiles?: { name: string }[]; bbox?: number[] };
    return info.version === '10.2' && !!info.profiles?.some(p => p.name === 'foot') && Array.isArray(info.bbox) && info.bbox.length === 4;
  } catch { return false; }
}
export async function stopGraph(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    const deadline = setTimeout(() => { cleanup(); reject(new Error('GRAPHHOPPER_SHUTDOWN_UNCONFIRMED')); }, 10_000);
    const cleanup = () => { clearTimeout(timeout); clearTimeout(deadline); };
    child.once('close', () => { cleanup(); resolve(); });
    child.kill('SIGTERM');
  });
}
/** One owned JVM, bounded readiness and batch deadline; every exit path closes it. */
export async function withGraphHopper<T>(meta: GraphMeta, logPath: string, maximumMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(maximumMs) || maximumMs <= 0 || maximumMs > 86_400_000) throw new Error('INVALID_BATCH_DEADLINE');
  // Never attach to an unrelated server or mistake its health for this child.
  try {
    await fetch(`${LOCAL_GRAPH_URL}/info`, { signal: AbortSignal.timeout(2000) });
    throw new Error('GRAPHHOPPER_PORT_ALREADY_IN_USE');
  } catch (e) { if (e instanceof Error && e.message === 'GRAPHHOPPER_PORT_ALREADY_IN_USE') throw e; }
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const abort = new AbortController();
  const child = spawn('java', ['-Xmx6g', '-jar', GRAPH_JAR, 'server', meta.configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
  const interrupt = () => abort.abort(new Error('BATCH_INTERRUPTED'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  child.once('error', () => abort.abort(new Error('GRAPHHOPPER_SPAWN_FAILED')));
  child.once('exit', () => abort.abort(new Error('GRAPHHOPPER_EXITED')));
  const deadline = setTimeout(() => { abort.abort(new Error('BATCH_DEADLINE_EXCEEDED')); child.kill('SIGTERM'); }, maximumMs);
  try {
    const until = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < until) {
      abort.signal.throwIfAborted();
      if (await graphHealthy(abort.signal)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('GRAPHHOPPER_NOT_READY');
    abort.signal.throwIfAborted();
    return await work(abort.signal);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await stopGraph(child);
    await new Promise<void>(resolve => log.end(resolve));
  }
}
