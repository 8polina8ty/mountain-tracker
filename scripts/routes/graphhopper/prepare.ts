/** One-time GraphHopper import: persistent graph cache with reuse binding.
 * Implements graph-meta.json contract: if compatible graph exists -> reuse, else fail closed.
 * Usage: npm run routes:graphhopper:prepare -- --input data/osm/source/alps-latest.osm.pbf
 */
import { mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { currentMeta, readMeta, writeMeta, isCompatible, GRAPH_CACHE_DIR, CONFIG_PATH } from './meta.ts';

function parseArgs(argv: readonly string[]): { input: string } {
  let input: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) input = argv[++i];
    else throw new Error(`UNKNOWN_ARGUMENT:${argv[i]}`);
  }
  if (!input) throw new Error('INPUT_REQUIRED');
  return { input };
}

async function dirSizeBytes(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  async function walk(p: string) {
    try {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          try { total += (await stat(full)).size; } catch {}
        }
      }
    } catch {}
  }
  await walk(dir);
  return total;
}

async function runImport(configPath: string): Promise<{ ms: number; rssPeakMb: number | null }> {
  const start = performance.now();
  let peak = process.memoryUsage().rss;
  const rssInterval = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 500);
  const child = spawn('java', ['-Xmx6g', '-jar', 'tools/graphhopper/graphhopper-web.jar', 'import', configPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const code: number = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (c) => resolve(c ?? 1));
  });
  clearInterval(rssInterval);
  if (code !== 0) throw new Error(`GRAPHHOPPER_IMPORT_EXIT:${code}`);
  const ms = performance.now() - start;
  // Try to read OS peak? approximate
  return { ms, rssPeakMb: Math.round(peak / 1048576) };
}

export async function prepare(input: string): Promise<void> {
  const expected = await currentMeta(input, CONFIG_PATH);
  const existing = await readMeta();
  const cacheExists = await stat(GRAPH_CACHE_DIR).then((s) => s.isDirectory()).catch(() => false);
  const hasGraphFiles = cacheExists ? (await dirSizeBytes(GRAPH_CACHE_DIR)) > 1024 : false;

  if (existing && isCompatible(existing, expected) && hasGraphFiles) {
    const size = await dirSizeBytes(GRAPH_CACHE_DIR);
    console.log(JSON.stringify({ status: 'REUSE', graphId: existing.graphId, pbfSha256: existing.pbfSha256, pbfSizeBytes: existing.pbfSizeBytes, graphHopperVersion: existing.graphHopperVersion, profile: existing.profile, configHash: existing.graphHopperConfigHash, graphCacheBytes: size, importSkipped: true }, null, 2));
    return;
  }
  if (existing && !isCompatible(existing, expected)) {
    console.error(JSON.stringify({ error: 'INCOMPATIBLE_GRAPH', existing, expected, hint: 'Graph cache incompatible - requires rebuild. Remove data/routes/graphhopper/alps-hike/graph-cache manually if rebuild intended. Refusing to silently delete.' }, null, 2));
    process.exitCode = 2;
    throw new Error('INCOMPATIBLE_GRAPH_NEEDS_REBUILD');
  }
  // Fresh import
  await mkdir(GRAPH_CACHE_DIR, { recursive: true });
  console.log(JSON.stringify({ status: 'IMPORT_START', graphId: expected.graphId, pbfSha256: expected.pbfSha256, input }, null, 2));
  const { ms, rssPeakMb } = await runImport(CONFIG_PATH);
  const size = await dirSizeBytes(GRAPH_CACHE_DIR);
  const meta = { ...expected, createdAt: new Date().toISOString() };
  await writeMeta(meta);
  console.log(JSON.stringify({ status: 'IMPORT_DONE', graphId: meta.graphId, importTimeMs: Math.round(ms), importTimeSec: Math.round(ms / 1000), graphCacheBytes: size, graphCacheMb: Math.round(size / 1048576), peakRssMb: rssPeakMb, configHash: meta.graphHopperConfigHash }, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/prepare.ts')) {
  try {
    const { input } = parseArgs(process.argv.slice(2));
    await prepare(input);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
