/** Finite offline evaluation. Reads frozen SQLite caches; writes only a separate review directory. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveStartDiscoverySession, type AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { BASE_ACCESS_START_POLICY, publicApproachRoad } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { serializeGpx, assertInsideFrozenWindow, type CanaryManifest, type FrozenRow } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { DEFAULT_SUMMIT_ATTACHMENT_POLICY } from '../../Lib/gpxIngestion/summitAttachment.ts';
import { buildOsmTrailGraph, ADMITTED_CONNECTOR_HIGHWAYS, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { SummitAttachmentGraphProvider } from './adaptive-start-summit-graphs.ts';
import type { AdaptivePilotCorpus } from './adaptive-start-pilot-prepare.ts';

assert.equal(process.argv.length, 2, 'NO_ARGUMENTS_OR_EXECUTE_SUPPORTED');
const root = 'data/gpx/adaptive-start-pilot', out = 'data/gpx/base-access-start-v2';
const json = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const manifestPath = 'data/gpx/generated-route-publication/generated-route-canary-v1.json';
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString()) as CanaryManifest;
const corpus = await json<AdaptivePilotCorpus>(`${root}/adaptive-start-pilot-corpus.json`);
const { corpusHash, ...content } = corpus;
assert.equal(sha256Stable(content), corpusHash);
assert.equal(manifest.entries.length, 10);
const oldRows = await json<FrozenRow[]>(`${root}/adaptive-start-component-v2-results.json`);
for (const s of corpus.featureSources) assert.equal(sha256Bytes(await readFile(s.path)), s.sha256);
const features = new AdaptiveStartFeatureIndex(await loadPhase11f2FeatureIndex('data/osm/alps/staging/phase11f2-features'));
const provider = new SummitAttachmentGraphProvider({ extractionPath: `${root}/cache/${corpusHash}.sqlite`,
  cachePath: `${root}/cache/${corpusHash}-graphs.sqlite`, dataset: corpus.dataset, identityHash: corpusHash });
const ReadOnly = DatabaseSync as unknown as { new(p: string, o: { readOnly: true }): DatabaseSync };
const db = new ReadOnly(`${root}/cache/${corpusHash}.sqlite`, { readOnly: true });
const safetyIdentity = { pbfPath: corpus.datasetPath, pbfSizeBytes: corpus.datasetSizeBytes, pbfModifiedMilliseconds: 0,
  pbfSha256: corpus.dataset.pbfSha256, pipelineDatasetFingerprint: corpusHash, pipelineGeneratedAt: corpus.dataset.snapshotTimestamp,
  checkpointPath: `${root}/cache/${corpusHash}-graphs.sqlite`, checkpointManifestSha256: sha256Stable(provider.cacheIdentity),
  motorwayIndexContentHash: sha256Stable(provider.cacheIdentity) };
await mkdir(out, { recursive: true });
const rows = [];
let previousGraph: ReturnType<typeof provider.get>['graph'] = null;
let previousSession: AdaptiveStartDiscoverySession | null = null;
try {
  for (const entry of manifest.entries) {
    const id = entry.request.mountainRoute.mountain_id, p = entry.request.provenance;
    const mountain = corpus.mountains.find(m => m.mountainId === p.sourceMountainIdentity)!;
    assert(mountain);
    console.log(JSON.stringify({ mountainId: id, status: 'LOADING_FROZEN_GRAPH' }));
    const obtained = provider.get(mountain.blockId, mountain.summit.coordinate, DEFAULT_SUMMIT_ATTACHMENT_POLICY.reviewMeters);
    assert.equal(obtained.status, 'READY');
    console.log(JSON.stringify({ mountainId: id, status: 'READING_PUBLIC_ROADS', nodes: obtained.graph!.nodes.size }));
    // Frozen component loaders only retain roads incident to trails. Read the full
    // block road context to prove onward access, without changing either cache.
    let session: AdaptiveStartDiscoverySession | null = obtained.graph === previousGraph ? previousSession : null;
    if (!session) {
    const source = db.prepare(`SELECT w.payload FROM region_ways r JOIN ways w ON w.id=r.way WHERE r.region=?
      AND json_extract(w.payload,'$.tags.highway') IN ('residential','living_street','unclassified','tertiary','secondary','service','track') ORDER BY w.id`)
      .all(mountain.blockId) as { payload: string }[];
    const roads: OsmTrailWayInput[] = [];
    for (const r of source) { const w = JSON.parse(r.payload) as OsmTrailWayInput; if (publicApproachRoad(w)) roads.push(w); }
    const ways = [...new Map([...obtained.ways, ...roads].map(w => [w.id, w])).values()].sort((a, b) => a.id - b.id);
    const trailIds = new Set(obtained.graph!.edges.map(e => e.wayId));
    console.log(JSON.stringify({ mountainId: id, status: 'BUILDING_APPROACH_GRAPH', roads: roads.length }));
    const graph = buildOsmTrailGraph(corpus.dataset, ways.filter(w => trailIds.has(w.id) || publicApproachRoad(w)), {
      connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS], maximumNodes: 2_000_000, maximumWays: 150_000,
    });
    session = new AdaptiveStartDiscoverySession({ graph, ways, features, safetyIdentity });
    previousGraph = obtained.graph; previousSession = session;
    }
    const graph = session.graph;
    console.log(JSON.stringify({ mountainId: id, status: 'DISCOVERING_BASE_STARTS', nodes: graph.nodes.size }));
    const request = { summit: { id: mountain.mountainId, name: mountain.summit.name, coordinate: mountain.summit.coordinate,
      elevationMeters: mountain.summit.elevationMeters, osmId: mountain.summit.osmId }, summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY };
    const result: AdaptiveStartDiscoveryResult = session.discover(request);
    const repeated: AdaptiveStartDiscoveryResult = session.discover(request);
    assert.equal(result.resultHash, repeated.resultHash, 'NONDETERMINISTIC');
    const block = corpus.blocks.find(b => b.blockId === mountain.blockId)!;
    for (const c of result.candidates) {
      assert(c.route);
      assert.equal(c.route.geometry.type, 'LineString');
      if (c.route.geometry.type !== 'LineString') throw new Error('DISCONNECTED_GEOMETRY');
      assertInsideFrozenWindow({ type: 'LineString', coordinates: c.route.geometry.coordinates.map(x => [x[0], x[1]]) }, block.bbox);
      for (let i = 1; i < c.route.osmNodeIds.length; i++) assert(graph.neighbors(c.route.osmNodeIds[i - 1])
        .some(e => e.toNodeId === c.route!.osmNodeIds[i] && c.route!.osmWayIds.includes(e.wayId)), 'FABRICATED_GAP');
    }
    const chosen = result.candidates[0] ?? null;
    const old = oldRows.find(r => r.mountainId === mountain.mountainId)!.candidates.find(c => c.id === p.start.candidateId)!;
    const oldGeometry = JSON.parse(await readFile(`data/gpx/generated-route-publication/${entry.files.geojson.path}`, 'utf8')).features[0].geometry;
    const comparison = { mountainId: id, name: mountain.summit.name,
      old: { name: p.start.name, kind: p.start.kind, category: p.routeCategory, elevation: old.startContext?.startElevationMeters ?? null,
        distanceMeters: old.route!.distanceM, coordinate: old.route!.startCoordinate },
      new: chosen ? { name: chosen.name, kind: chosen.kind, elevation: chosen.accessEvidence?.startElevation,
        summitElevation: mountain.summit.elevationMeters, distanceMeters: chosen.routeDistanceMeters, accessEvidence: chosen.accessEvidence,
        passesOldStart: chosen.route!.osmNodeIds.includes(old.route!.osmNodeIds[0]),
        sharedOldNodeCount: chosen.route!.osmNodeIds.filter(n => old.route!.osmNodeIds.includes(n)).length,
        oldNodeCount: old.route!.osmNodeIds.length, startRole: chosen.startRole } : null,
      summitElevation: mountain.summit.elevationMeters, status: chosen ? 'AUTO_ELIGIBLE_AWAITING_VISUAL_REVIEW' : 'NEEDS_REVIEW',
      resultHash: result.resultHash, determinismVerified: true, fabricatedGapCount: result.fabricatedGapCount,
      reasons: result.reasons, rejected: result.evaluated.filter(c => !c.autoEligible).map(c => ({ name: c.name, kind: c.kind, reasons: c.reasons })) };
    rows.push(comparison);
    await writeFile(`${out}/${id}-evaluation.json`, JSON.stringify(result, null, 2) + '\n');
    await writeFile(`${out}/${id}-comparison.geojson`, JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { version: 'old', name: p.start.name }, geometry: oldGeometry },
      ...(chosen ? [{ type: 'Feature', properties: { version: 'v2', name: chosen.name }, geometry: chosen.route!.geometry }] : []),
    ] }) + '\n');
    if (chosen?.route?.geometry.type === 'LineString') await writeFile(`${out}/${id}.gpx`, serializeGpx(`${chosen.name} → ${mountain.summit.name}`,
      { type: 'LineString', coordinates: chosen.route.geometry.coordinates.map(x => [x[0], x[1]]) }));
    console.log(JSON.stringify(comparison));
  }
} finally { provider.close(); db.close(); }
assert.equal(sha256Bytes(await readFile(manifestPath)), sha256Bytes(manifestBytes));
await writeFile(`${out}/comparison.json`, JSON.stringify({ policy: BASE_ACCESS_START_POLICY,
  sourceManifestSha256: sha256Bytes(manifestBytes), corpusHash, productionWrites: 0, externalRequests: 0, rows }, null, 2) + '\n');
await writeFile(`${out}/comparison.sha256`, sha256Stable(rows) + '\n');
await writeFile(`${out}/policy.json`, stableJson(BASE_ACCESS_START_POLICY) + '\n');
console.log(JSON.stringify({ completed: rows.length, accepted: rows.filter(r => r.new).length, productionWrites: 0 }));
