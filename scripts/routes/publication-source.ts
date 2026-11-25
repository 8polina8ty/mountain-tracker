/** Reads existing run artifacts; never searches for or regenerates a route. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes, sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { candidateEligible, type FrozenRow, type Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { buildOsmTrailGraph, ADMITTED_CONNECTOR_HIGHWAYS, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import type { AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { FrozenPathReader } from '../gpx/generated-publication-frozen.ts';
import type { AdaptivePilotCorpus } from '../gpx/adaptive-start-pilot-prepare.ts';
import { buildFreshEvidence, classifyFreshRow, type FreshMountain, type FreshMountainResult, type FreshEvidenceContext } from './current-v2-generation.ts';
import { classifyReviewedRow, type ReviewedCheckpointRow } from './route-factory.ts';
import { replacementReadClient } from '../gpx/generated-replacement-live.ts';
import { FACTORY_PUBLICATION_VERSION, loadPublicationRun, lockFactoryManifest, optionalBytes, prepareFactoryEntry, publicationEligible, writeImmutable, type FactoryPublicationManifest } from './publication-manifest.ts';

export async function prepareRunPublication(runId: string) {
  const run = await loadPublicationRun(runId), reader = replacementReadClient();
  const sourceHashes: Record<string, string | null> = {};
  async function source<T>(path: string): Promise<T> { const bytes = await readFile(path); sourceHashes[path] = sha256Bytes(bytes); return JSON.parse(bytes.toString('utf8')) as T; }
  for (const path of [join(run.dir, 'manifest.json'), join(run.dir, 'summary.json'), run.decisionPath]) {
    const bytes = await optionalBytes(path); sourceHashes[path] = bytes ? sha256Bytes(bytes) : null;
  }
  const manifest: FactoryPublicationManifest = { schemaVersion: FACTORY_PUBLICATION_VERSION, runId, origin: reader.origin, sourceHashes, entries: [], exclusions: [] };
  for (const entry of run.entries) {
    const decision = run.decisions.find(d => d.mountainId === entry.mountainId);
    if (!publicationEligible(entry, decision)) { manifest.exclusions.push({ mountainId: entry.mountainId, reason: decision ? `HUMAN_${decision.decision}` : `STATE_${entry.state}` }); continue; }
    await source(join(run.dir, 'candidates', `${entry.mountainId}.json`));
    let mountain: FreshMountain, row: FreshMountainResult['row'], context: FreshEvidenceContext, gpxPath: string;
    const fresh = await optionalBytes(join(run.dir, 'source.json'));
    if (fresh) {
      const mode = await source<{ source: string }>(join(run.dir, 'source.json')); assert.equal(mode.source, 'current-v2');
      const result = await source<{ summit: FreshMountain['summit']; row: FreshMountainResult['row']; blockId: string; fabricatedGapCount: number }>(join(run.dir, 'fresh-results', `${entry.mountainId}.json`));
      assert.equal(result.fabricatedGapCount, 0); row = result.row;
      assert.deepEqual(classifyFreshRow(row), entry, 'FRESH_CLASSIFICATION_DRIFT');
      mountain = { mountainId: row.mountainId, name: row.name, summit: result.summit, blockId: result.blockId };
      const report = await source<{ datasetFingerprint: string; policyHash: string; summitPolicyHash: string; extractionIdentityHash: string; graphCacheIdentityHash: string }>(join(run.dir, 'generation-report.json'));
      const selection = await source<{ corpusHash: string }>(join(run.dir, 'selection.json'));
      context = { ...report, adaptivePolicyHash: report.policyHash, pilotCorpusHash: selection.corpusHash };
      gpxPath = join(run.dir, 'artifacts', `${entry.mountainId}`, 'route.gpx');
      const geo = await source<{ features: { geometry: Line }[]; mountainTracker: { provenance: { sourceCandidateHash: string } } }>(join(run.dir, 'artifacts', `${entry.mountainId}`, 'route.geojson'));
      assert.equal(geo.features.length, 1);
      const artifact = await source<{ candidateId: string }>(join(run.dir, 'artifacts', `${entry.mountainId}`, 'route.json'));
      const selected = (row.candidates as AdaptiveStartDiscoveryResult['candidates']).find(c => c.id === artifact.candidateId);
      assert(selected?.route); assert.deepEqual(geo.features[0].geometry, selected.route.geometry);
      assert.equal(sha256Stable(selected), geo.mountainTracker.provenance.sourceCandidateHash);
    } else {
      sourceHashes[join(run.dir, 'source.json')] = null;
      const review = await source<{ rows: (ReviewedCheckpointRow & { summitCoordinate: [number, number] })[] }>('data/gpx/base-access-start-v2/final-review.json');
      const reviewed = review.rows.find(r => r.mountainId === entry.mountainId); assert(reviewed);
      assert.deepEqual(classifyReviewedRow(reviewed), entry, 'REVIEWED_CLASSIFICATION_DRIFT');
      const result = await source<AdaptiveStartDiscoveryResult>(`data/gpx/base-access-start-v2/${entry.mountainId}-evaluation.json`);
      const { resultHash, timings, componentCacheHit, ...content } = result; void [timings, componentCacheHit];
      assert.equal(sha256Stable(content), resultHash); assert.equal(resultHash, reviewed.resultHash);
      assert.equal(result.fabricatedGapCount, 0);
      row = { mountainId: result.request.summit.id, name: result.request.summit.name, blockId: 'reviewed', stratum: 'NORMAL', status: result.status,
        graphStatus: 'READY', reasons: result.reasons, summitAttachment: result.summitAttachment, candidates: result.candidates,
        resultHash, determinismVerified: reviewed.deterministicReplayVerified };
      mountain = { mountainId: row.mountainId, name: row.name, blockId: 'reviewed', summit: { osmObjectType: 'node', osmId: result.request.summit.osmId!, name: row.name,
        coordinate: [...result.request.summit.coordinate] as [number, number], elevationMeters: result.request.summit.elevationMeters! } };
      const corpus = await source<AdaptivePilotCorpus>('data/gpx/adaptive-start-pilot/adaptive-start-pilot-corpus.json');
      const frozen = new FrozenPathReader(corpus);
      try { context = { datasetFingerprint: sha256Stable(corpus.dataset), pilotCorpusHash: corpus.corpusHash, adaptivePolicyHash: result.policyHash,
        summitPolicyHash: sha256Stable(result.request.summitAttachmentPolicy), extractionIdentityHash: frozen.extractionIdentityHash, graphCacheIdentityHash: frozen.graphCacheIdentityHash }; }
      finally { frozen.close(); }
      gpxPath = `data/gpx/base-access-start-v2/${entry.mountainId}.gpx`;
    }
    const candidates = row.candidates as AdaptiveStartDiscoveryResult['candidates'];
    const selected = candidates.filter(c => entry.starters.some(s => s.candidateId === c.id && s.state === entry.state && s.primaryBaseAccess && s.routeAvailable));
    assert.equal(selected.length, 1, 'AMBIGUOUS_PUBLICATION_CANDIDATE'); const candidate = selected[0];
    assert(candidate.route && candidateEligible(row as unknown as FrozenRow, candidate as never), 'EXACT_PUBLICATION_GATE_FAILED');
    const route = candidate.route, geometry = route.geometry as Line;
    // Check actual path adjacency and coordinates against admitted frozen OSM ways.
    const corpus = await source<AdaptivePilotCorpus>('data/gpx/adaptive-start-pilot/adaptive-start-pilot-corpus.json');
    assert.equal(sha256Stable(corpus.dataset), context.datasetFingerprint);
    const ReadOnly = DatabaseSync as unknown as { new(p: string, o: { readOnly: true }): DatabaseSync };
    const db = new ReadOnly(`data/gpx/adaptive-start-pilot/cache/${corpus.corpusHash}.sqlite`, { readOnly: true });
    try {
      const query = db.prepare('SELECT payload FROM ways WHERE id=?');
      const ways = route.osmWayIds.map(id => { const way = query.get(id); assert(way); return JSON.parse(String(way.payload)) as OsmTrailWayInput; });
      const graph = buildOsmTrailGraph(corpus.dataset, ways, { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS] });
      assert.equal(route.osmNodeIds.length, geometry.coordinates.length);
      for (let i = 0; i < route.osmNodeIds.length; i++) {
        const id: number = route.osmNodeIds[i]; assert.deepEqual(graph.node(id)?.coordinate, geometry.coordinates[i]);
        if (i) assert(graph.neighbors(route.osmNodeIds[i - 1]).some(e => e.toNodeId === id), 'FABRICATED_OR_FORBIDDEN_EDGE');
      }
    } finally { db.close(); }
    const evidence = buildFreshEvidence({ mountain, row, candidate, context, geometryHash: route.geometryHash });
    assert.deepEqual(geometry.coordinates.at(-1), evidence.summitAttachment.routeTerminalCoordinate);
    const matches = await reader.get(`/rest/v1/mountains?select=id,osm_id,latitude,longitude&osm_id=eq.${mountain.summit.osmId}&limit=2`) as { id: number; latitude: number; longitude: number }[];
    assert.equal(matches.length, 1, 'PRODUCTION_MOUNTAIN_MAPPING_REQUIRED');
    assert(Math.abs(matches[0].longitude - mountain.summit.coordinate[0]) < 0.00005 && Math.abs(matches[0].latitude - mountain.summit.coordinate[1]) < 0.00005, 'SUMMIT_IDENTITY_DRIFT');
    if (!fresh) assert.equal(matches[0].id, entry.mountainId);
    const gpx = await readFile(gpxPath); sourceHashes[gpxPath] = sha256Bytes(gpx);
    const prepared = await prepareFactoryEntry({ runId, entry, decision, mountainId: matches[0].id, origin: reader.origin, geometry, evidence, gpx });
    manifest.entries.push(prepared.entry);
    for (const kind of ['gpx', 'geojson'] as const) {
      await mkdir(dirname(prepared.entry.files[kind].path), { recursive: true });
      await writeImmutable(prepared.entry.files[kind].path, prepared[kind]);
    }
  }
  const lock = await lockFactoryManifest(manifest);
  // Same approval table as the canary; only a human DBA can install these rows.
  const sql = ['-- MANUAL REVIEW / MANUAL DEPLOYMENT ONLY. Zero route publication calls.', `-- Exact manifest SHA256: ${lock.hash}`, 'begin;',
    ...(manifest.entries.length ? ['insert into public.generated_route_publication_approvals (publication_id,request_hash,manifest_hash) values',
      manifest.entries.map(e => `('${e.request.publicationId}','${e.requestHash}','${lock.hash}')`).join(',\n') + ';'] : ['-- Empty eligible set: no approval rows.']), 'commit;', ''].join('\n');
  await writeImmutable(join(run.dir, 'publication', 'manual-approvals.sql'), sql);
  return { runId, manifestHash: lock.hash, entries: manifest.entries.length, exclusions: manifest.exclusions.length, out: lock.path };
}
