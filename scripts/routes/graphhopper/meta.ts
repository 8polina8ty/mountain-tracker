import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { sha256Stable } from '../../../Lib/gpxIngestion/hashing.ts';

export const GRAPH_HOPPER_VERSION = '10.2';
export const GRAPH_META_VERSION = 'mountain-tracker/graphhopper-graph-meta/v1';
export const GRAPH_DIR = 'data/routes/graphhopper/alps-hike';
export const GRAPH_CACHE_DIR = 'data/routes/graphhopper/alps-hike/graph-cache';
export const CONFIG_PATH = 'data/routes/graphhopper/alps-hike/config.yml';
export const META_PATH = 'data/routes/graphhopper/alps-hike/graph-meta.json';

export interface GraphMeta {
  readonly version: typeof GRAPH_META_VERSION;
  readonly pbfSha256: string;
  readonly pbfSizeBytes: number;
  readonly pbfModifiedMs: number;
  readonly graphHopperVersion: typeof GRAPH_HOPPER_VERSION;
  readonly profile: 'foot';
  readonly profileConfig: { name: string; custom_model: { priority: readonly { if: string; multiply_by: string }[]; speed: readonly { if: string; limit_to: string }[] } };
  readonly profileConfigHash: string;
  readonly graphHopperConfigHash: string;
  readonly graphId: string;
  readonly createdAt: string;
  readonly graphLocation: string;
  readonly configPath: string;
}

const PROFILE_CONFIG = {
  name: 'foot',
  custom_model: {
    priority: [{ if: '!foot_access', multiply_by: '0' }],
    speed: [{ if: 'true', limit_to: 'foot_average_speed' }],
  },
} as const;

export async function computePbfFingerprint(pbfPath: string): Promise<{ sha256: string; size: number; modified: number }> {
  const st = await stat(pbfPath);
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(pbfPath)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), size: st.size, modified: st.mtimeMs };
}

export async function computeConfigHash(configPath: string): Promise<string> {
  const bytes = await readFile(configPath);
  return createHash('sha256').update(bytes).digest('hex');
}

export function profileConfigHash(): string {
  return sha256Stable(PROFILE_CONFIG);
}

export function graphIdFor(args: { pbfSha256: string; profileConfigHash: string; configHash: string }): string {
  return sha256Stable({
    version: GRAPH_META_VERSION,
    graphHopperVersion: GRAPH_HOPPER_VERSION,
    profile: 'foot',
    pbfSha256: args.pbfSha256,
    profileConfigHash: args.profileConfigHash,
    configHash: args.configHash,
  }).slice(0, 16);
}

export async function currentMeta(pbfPath: string, configPath: string = CONFIG_PATH): Promise<GraphMeta> {
  const pbf = await computePbfFingerprint(pbfPath);
  const configHash = await computeConfigHash(configPath);
  const pHash = profileConfigHash();
  const gid = graphIdFor({ pbfSha256: pbf.sha256, profileConfigHash: pHash, configHash });
  return {
    version: GRAPH_META_VERSION,
    pbfSha256: pbf.sha256,
    pbfSizeBytes: pbf.size,
    pbfModifiedMs: pbf.modified,
    graphHopperVersion: GRAPH_HOPPER_VERSION,
    profile: 'foot',
    profileConfig: { name: 'foot', custom_model: PROFILE_CONFIG.custom_model },
    profileConfigHash: pHash,
    graphHopperConfigHash: configHash,
    graphId: gid,
    createdAt: new Date().toISOString(),
    graphLocation: GRAPH_CACHE_DIR,
    configPath,
  };
}

export async function readMeta(): Promise<GraphMeta | null> {
  try {
    const raw = await readFile(META_PATH, 'utf8');
    return JSON.parse(raw) as GraphMeta;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeMeta(meta: GraphMeta): Promise<void> {
  await writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export function isCompatible(existing: GraphMeta, expected: GraphMeta): boolean {
  return (
    existing.version === expected.version &&
    existing.pbfSha256 === expected.pbfSha256 &&
    existing.pbfSizeBytes === expected.pbfSizeBytes &&
    existing.graphHopperVersion === expected.graphHopperVersion &&
    existing.profile === expected.profile &&
    existing.profileConfigHash === expected.profileConfigHash &&
    existing.graphHopperConfigHash === expected.graphHopperConfigHash &&
    existing.graphId === expected.graphId
  );
}
