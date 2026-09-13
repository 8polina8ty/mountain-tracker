/** Raw local PBF -> shared OSM blocks -> existing Base Access V2 routing engine. */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintInput } from '../osm-import/bulk-checkpoint.ts';
import { writeJsonAtomically } from '../osm-import/jsonl.ts';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { buildOsmTrailGraph, ADMITTED_CONNECTOR_HIGHWAYS, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { AdaptiveStartDiscoverySession, DEFAULT_ADAPTIVE_START_POLICY, type AdaptiveStartCandidate, type AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { BASE_ACCESS_START_POLICY, primaryBaseAccess, primaryStartPriority } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { DEFAULT_SUMMIT_ATTACHMENT_POLICY } from '../../Lib/gpxIngestion/summitAttachment.ts';
import { serializeGpx, serializeGeojson, SOURCE, type PublicationEvidence, type Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import type { RoadSafetySourceDatasetIdentity } from '../osm-import/phase11c9-road-safety.ts';
import { writeFile } from 'node:fs/promises';
import { resolvePbfOsmium } from './pbf-osmium.ts';
import { runOsmium } from '../osm-import/osmium-runner.ts';

export const PBF_VERSION = 'mountain-tracker/raw-pbf-routes/v3';
export const PBF_POLICY = { ...DEFAULT_ADAPTIVE_START_POLICY, radiusTiersMeters: [5000, 10000, 20000], seriousCandidatesPerTier: [8, 6, 4] };
export interface PbfOptions { input: string; limit: number; offset: number; minElevation: number | null; maxElevation: number | null; resume: boolean }
export interface Peak { osmType: 'node'; osmId: number; name: string; lon: number; lat: number; elevation: number | null; tags: Record<string, string>; block: string }
export const STATES = ['ROUTE_GENERATED', 'NO_SUMMIT_CONNECTION', 'NO_BASE_ACCESS', 'NO_ROUTE', 'REJECTED_ACCESS', 'FAILED'] as const;
export type PbfState = typeof STATES[number];
export function parsePbfArgs(args: readonly string[]): PbfOptions {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; assert(['--input', '--limit', '--offset', '--min-elevation', '--max-elevation', '--resume'].includes(key), `UNKNOWN_ARGUMENT:${key}`);
    assert(!(key in values), `DUPLICATE_ARGUMENT:${key}`);
    if (key === '--resume') values[key] = true;
    else { assert(args[i + 1] && !args[i + 1].startsWith('--'), `VALUE_REQUIRED:${key}`); values[key] = args[++i]; }
  }
  assert(typeof values['--input'] === 'string', 'INPUT_REQUIRED');
  const options = { input: resolve(values['--input']), limit: Number(values['--limit'] ?? 100), offset: Number(values['--offset'] ?? 0),
    minElevation: values['--min-elevation'] === undefined ? null : Number(values['--min-elevation']),
    maxElevation: values['--max-elevation'] === undefined ? null : Number(values['--max-elevation']), resume: values['--resume'] === true };
  assert(Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= 10000, 'LIMIT_RANGE_1_10000');
  assert(Number.isSafeInteger(options.offset) && options.offset >= 0, 'INVALID_OFFSET');
  assert([options.minElevation, options.maxElevation].every(v => v === null || Number.isFinite(v)), 'INVALID_ELEVATION');
  assert(options.minElevation === null || options.maxElevation === null || options.minElevation <= options.maxElevation, 'ELEVATION_RANGE_REVERSED');
  return options;
}
export function blockFor(lon: number, lat: number) { return `${Math.floor(lon / 0.25)}_${Math.floor(lat / 0.25)}`; }
export function checkpointValid(checkpoint: { identity: string; results: unknown[] }, identity: string) {
  assert.equal(checkpoint.identity, identity, 'STALE_CHECKPOINT'); assert(Array.isArray(checkpoint.results));
}
export function validPrimary(c: AdaptiveStartCandidate) {
  return c.startRole === 'PRIMARY_BASE_ACCESS' && primaryBaseAccess(c.accessEvidence) && !/HUT|REFUGE/.test(c.kind) && c.safety === 'SAFE'
    && c.safetyReasons.length === 0 && c.solverStatus === 'RECONSTRUCTED' && c.route?.reconstructionStatus === 'RECONSTRUCTED';
}
export function featureIndex(records: FeatureIndex['parking']): FeatureIndex {
  const select = (test: (t: Record<string, string>) => boolean) => records.filter(r => test(r.tags));
  return { alpineHuts: select(t => t.tourism === 'alpine_hut'), wildernessHuts: select(t => t.tourism === 'wilderness_hut'),
    mountainPasses: select(t => t.mountain_pass === 'yes'), saddles: select(t => t.natural === 'saddle'), ridges: select(t => t.natural === 'ridge'),
    peaks: select(t => t.natural === 'peak'), trailheads: select(t => t.highway === 'trailhead'), trailheadInfo: select(t => t.information === 'guidepost'),
    parking: select(t => t.amenity === 'parking'), villages: select(t => t.place === 'village'), hamlets: select(t => t.place === 'hamlet'),
    isolatedDwellings: select(t => t.place === 'isolated_dwelling'), farms: select(t => t.place === 'farm'), busStops: select(t => t.highway === 'bus_stop'),
    trainStations: select(t => t.railway === 'station'), halts: select(t => t.railway === 'halt'), eleNodes: select(t => Boolean(t.ele)) };
}
async function python(args: string[]) {
  await new Promise<void>((done, fail) => {
    const child = spawn('python', args, { shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], timeout: 5_400_000 });
    child.once('error', fail); child.once('close', code => code === 0 ? done() : fail(new Error(`OSMIUM_EXTRACTION_EXIT:${code}`)));
  });
}
async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
interface Result { osmId: number; name: string; state: PbfState; reasons: string[]; artifactHashes?: Record<string, string>; sample?: unknown }

export async function runPbf(options: PbfOptions) {
  const started = performance.now(); assert((await stat(options.input)).isFile(), 'INPUT_NOT_FILE');
  const osmium = await resolvePbfOsmium();
  await runOsmium([...osmium.prefix, 'fileinfo', options.input], undefined, { executable: osmium.executable });
  await python(['-c', 'import osmium; print("Local pyosmium available", flush=True)']);
  const input = await fingerprintInput(options.input), digest = createHash('sha256');
  for await (const chunk of createReadStream(options.input)) digest.update(chunk);
  assert.deepEqual(await fingerprintInput(options.input), input, 'PBF_CHANGED_DURING_FINGERPRINT');
  const pbfSha256 = digest.digest('hex');
  const { resume, ...parameters } = options; void resume;
  const adaptiveSubdivision = { maxWays: 150000, maxFeatures: 300000, minTileDegrees: 0.0625, strategy: 'recursive-2x2-complete_ways/v1' } as const;
  const identity = { version: PBF_VERSION, input, pbfSha256, parameters, routing: PBF_POLICY, baseAccess: BASE_ACCESS_START_POLICY,
    summitAttachment: DEFAULT_SUMMIT_ATTACHMENT_POLICY, tileDegrees: 0.25, haloDegrees: 0.25, adaptiveSubdivision, selection: 'named-peak-nodes-tile-xy-osmid/v1' };
  const fingerprint = sha256Stable(identity), runId = `pbf-${fingerprint.slice(0, 16)}`, directory = join('data/routes/pbf', runId);
  await mkdir(directory, { recursive: true });
  const checkpointPath = join(directory, 'checkpoint.json');
  const checkpoint = await readJson<{ identity: string; results: Result[] }>(checkpointPath) ?? { identity: fingerprint, results: [] };
  checkpointValid(checkpoint, fingerprint);
  const config = { ...parameters, directory: resolve(directory), identity, tileDegrees: 0.25, haloDegrees: 0.25, adaptiveSubdivision, osmium };
  const configPath = join(directory, 'extraction-config.json'); await writeJsonAtomically(configPath, config);
  await python(['scripts/routes/pbf-extract.py', '--config', configPath]);
  assert.deepEqual(await fingerprintInput(options.input), input, 'PBF_CHANGED_DURING_EXTRACTION');
  const selection = (await readJson<{ counts: Record<string, number>; eligible: number; selected: Peak[]; blocks: Record<string, number[]> }>(join(directory, 'selection.json')))!;
  const extractionReport = await readJson<{ peakPythonRssMb: number }>(join(directory, 'extraction-report.json'));
  const dataset = { datasetKey: 'local-osm-pbf', region: 'local', snapshotTimestamp: new Date(input.modifiedMilliseconds).toISOString(), pbfSha256 };
  const safetyIdentity: RoadSafetySourceDatasetIdentity = { pbfPath: options.input, pbfSizeBytes: input.sizeBytes, pbfModifiedMilliseconds: input.modifiedMilliseconds,
    pbfSha256, pipelineDatasetFingerprint: fingerprint, pipelineGeneratedAt: new Date(0).toISOString(), checkpointPath, checkpointManifestSha256: fingerprint, motorwayIndexContentHash: fingerprint };
  const ReadOnly = DatabaseSync as unknown as { new(p: string, o: { readOnly: true }): DatabaseSync };
  const db = new ReadOnly(join(directory, 'index.sqlite'), { readOnly: true });
  let session: AdaptiveStartDiscoverySession | null = null, activeBlock = '', blockError: string | null = null, peakRss = process.memoryUsage().rss;
  let graphBuilds = 0;
  try {
    for (let index = 0; index < selection.selected.length; index++) {
      const peak = selection.selected[index];
      if (index < checkpoint.results.length) {
        const saved = checkpoint.results[index]; assert.equal(saved.osmId, peak.osmId, 'CHECKPOINT_SELECTION_DRIFT');
        for (const [path, hash] of Object.entries(saved.artifactHashes ?? {})) assert.equal(sha256Bytes(await readFile(path)), hash, 'CHECKPOINT_ARTIFACT_DRIFT');
        continue;
      }
      let result: Result = { osmId: peak.osmId, name: peak.name, state: 'FAILED', reasons: [] };
      try {
        if (activeBlock !== peak.block) {
          session = null; activeBlock = peak.block; blockError = null;
          const records = db.prepare('SELECT w.payload FROM block_ways b JOIN ways w ON w.id=b.way WHERE b.block=? ORDER BY w.id LIMIT 150001').all(peak.block);
          if (records.length > 150000) throw new Error('BLOCK_WAY_MEMORY_LIMIT');
          const ways = records.map(r => JSON.parse(String(r.payload)) as OsmTrailWayInput);
          const featureRows = db.prepare('SELECT f.payload FROM block_features b JOIN features f ON f.identity=b.identity WHERE b.block=? ORDER BY f.identity LIMIT 300001').all(peak.block);
          assert(featureRows.length <= 300000, 'BLOCK_FEATURE_MEMORY_LIMIT');
          const graph = buildOsmTrailGraph(dataset, ways, { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS], maximumWays: 150000, maximumNodes: 800000 });
          session = new AdaptiveStartDiscoverySession({ graph, ways, features: new AdaptiveStartFeatureIndex(featureIndex(featureRows.map(r => JSON.parse(String(r.payload))))), safetyIdentity });
          graphBuilds++;
        }
        assert(session, blockError ?? 'BLOCK_GRAPH_UNAVAILABLE');
        const discovery: AdaptiveStartDiscoveryResult = session.discover({ summit: { id: `osm:node:${peak.osmId}`, osmId: peak.osmId, name: peak.name, coordinate: [peak.lon, peak.lat], elevationMeters: peak.elevation }, summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY }, PBF_POLICY);
        await writeJsonAtomically(join(directory, 'diagnostics', `${peak.osmId}.json`), { status: discovery.status, reasons: discovery.reasons,
          evaluated: discovery.evaluated.map(c => ({ id: c.id, kind: c.kind, safety: c.safety, reasons: c.reasons, accessEvidence: c.accessEvidence })), summitAttachment: discovery.summitAttachment });
        assert.equal(discovery.fabricatedGapCount, 0);
        const candidates = discovery.candidates.filter(validPrimary).sort((a, b) => primaryStartPriority(a.kind) - primaryStartPriority(b.kind) || a.route!.distanceM - b.route!.distanceM || a.id.localeCompare(b.id));
        const candidate = candidates[0];
        if (!candidate || !discovery.summitAttachment?.autoEligible) {
          result = { ...result, state: discovery.status === 'NO_SUMMIT_CONNECTION' ? 'NO_SUMMIT_CONNECTION' : discovery.rejections.footNo + discovery.rejections.privateForbidden > 0 ? 'REJECTED_ACCESS' : candidates.length ? 'NO_ROUTE' : 'NO_BASE_ACCESS',
            reasons: [...discovery.reasons, ...(!candidate ? ['NO_SAFE_PRIMARY_BASE_ACCESS'] : []), ...(!discovery.summitAttachment?.autoEligible ? ['SUMMIT_ATTACHMENT_NOT_ELIGIBLE'] : [])] };
        } else {
          const route = candidate.route!, geometry = route.geometry as Line, bbox = selection.blocks[peak.block];
          assert(geometry.coordinates.every(([x, y]) => x > bbox[0] + 0.0001 && y > bbox[1] + 0.0001 && x < bbox[2] - 0.0001 && y < bbox[3] - 0.0001), 'ROUTE_TOUCHES_EXTRACTION_BOUNDARY');
          assert.equal(route.osmNodeIds.length, geometry.coordinates.length);
          for (let i = 1; i < route.osmNodeIds.length; i++) assert(session.graph.neighbors(route.osmNodeIds[i - 1]).some(e => e.toNodeId === route.osmNodeIds[i]), 'FABRICATED_GAP');
          const evidence: PublicationEvidence = { startRole: 'PRIMARY_BASE_ACCESS', accessEvidence: candidate.accessEvidence!,
            generatedRouteIdentity: `osm:node:${peak.osmId}:${candidate.id}`, sourceCandidateHash: sha256Stable(candidate), resultHash: discovery.resultHash,
            sourceMountainIdentity: `osm:node:${peak.osmId}`, summit: { osmObjectType: 'node', osmId: peak.osmId, name: peak.name, coordinate: [peak.lon, peak.lat] },
            start: { ...candidate.osmIdentity, candidateId: candidate.id, kind: candidate.kind, name: candidate.name, coordinate: geometry.coordinates[0] },
            datasetFingerprint: sha256Stable(dataset), pilotCorpusHash: fingerprint, adaptivePolicyHash: discovery.policyHash, summitPolicyHash: sha256Stable(DEFAULT_SUMMIT_ATTACHMENT_POLICY),
            graphHash: session.graph.graphHash, graphCacheIdentityHash: sha256Stable({ fingerprint, block: peak.block }), extractionIdentityHash: fingerprint,
            reconstructionManifestHash: route.reconstructionManifestHash, solverVersion: route.solverVersion, routePathHash: sha256Stable({ nodes: route.osmNodeIds, ways: route.osmWayIds }),
            geometryHash: route.geometryHash, routeCategory: candidate.category as PublicationEvidence['routeCategory'], startContext: 'BASE_START', summitAttachment: discovery.summitAttachment,
            safety: { autoEligible: true, decision: 'SAFE', fabricatedGapCount: 0, boundaryLimited: false, connected: true, deterministic: true, solverStatus: 'RECONSTRUCTED', checkedEdges: route.osmNodeIds.length - 1 }, source: SOURCE };
          const name = `${candidate.name} → ${peak.name}`, gpx = serializeGpx(name, geometry), geojson = serializeGeojson(name, geometry, evidence);
          const artifactDirectory = join(directory, 'artifacts', String(peak.osmId)); await mkdir(artifactDirectory, { recursive: true });
          const sample = { summit: peak.name, startKind: candidate.kind, startElevation: candidate.accessEvidence!.startElevation, summitElevation: peak.elevation,
            distanceKm: route.distanceM / 1000, summitAttachment: discovery.summitAttachment.tier, fabricatedGaps: 0 };
          const metadata = { summit: peak, start: { lat: geometry.coordinates[0][1], lon: geometry.coordinates[0][0], role: candidate.startRole, candidateKind: candidate.kind, accessEvidence: candidate.accessEvidence },
            route: { distanceKm: route.distanceM / 1000, elevationGainMeters: candidate.elevationGainMeters, summitAttachmentTier: discovery.summitAttachment.tier, fabricatedGapCount: 0 },
            provenance: { datasetFingerprint: fingerprint, attribution: SOURCE, policyVersions: { routing: discovery.policyHash, baseAccess: BASE_ACCESS_START_POLICY.version },
              geometryHash: route.geometryHash, gpxSha256: sha256Bytes(Buffer.from(gpx)), geojsonSha256: sha256Bytes(Buffer.from(geojson)) } };
          const artifacts = { 'route.gpx': gpx, 'route.geojson': geojson, 'route.json': stableJson(metadata) + '\n' }, hashes: Record<string, string> = {};
          for (const [name, bytes] of Object.entries(artifacts)) { const path = join(artifactDirectory, name); await writeFile(path, bytes); hashes[path] = sha256Bytes(Buffer.from(bytes)); }
          result = { ...result, state: 'ROUTE_GENERATED', reasons: [], artifactHashes: hashes, sample };
        }
      } catch (error) { result.reasons = [error instanceof Error ? error.message : 'UNKNOWN_FAILURE']; if (!session) blockError = result.reasons[0]; }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await writeJsonAtomically(join(directory, 'results', `${peak.osmId}.json`), result);
      checkpoint.results.push(result); await writeJsonAtomically(checkpointPath, checkpoint);
      console.log(JSON.stringify({ progress: index + 1, total: selection.selected.length, osmId: peak.osmId, state: result.state, peakRssMb: Math.round(peakRss / 1048576) }));
    }
  } finally { db.close(); }
  const counts = Object.fromEntries(STATES.map(s => [s, checkpoint.results.filter(r => r.state === s).length]));
  const report = { runId, fingerprint, mountainsDiscovered: selection.counts, eligible: selection.eligible, mountainsAttempted: checkpoint.results.length, counts,
    runtimeSeconds: (performance.now() - started) / 1000, peakNodeRssMb: Math.max(peakRss / 1048576, process.resourceUsage().maxRSS / 1024),
    peakPythonRssMb: extractionReport?.peakPythonRssMb ?? null, graphBuilds,
    blocks: Object.keys(selection.blocks).length, samples: checkpoint.results.filter(r => r.state === 'ROUTE_GENERATED').slice(0, 10).map(r => r.sample),
    externalRequests: 0, productionWrites: 0, limitations: ['Named node peaks only; non-node peaks counted explicitly.', 'Bounded 0.25-degree tiles with 0.25-degree halo; unresolved routes outside the block remain unresolved.'] };
  await writeJsonAtomically(join(directory, 'report.json'), report); console.log(JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/routes/pbf.ts')) {
  try { await runPbf(parsePbfArgs(process.argv.slice(2))); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
