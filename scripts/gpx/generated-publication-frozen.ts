/** Materializes only recorded paths from immutable cache rows. Does not build a graph or invoke a solver. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes, sha256GeometryHash, sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { DEFAULT_ADAPTIVE_START_POLICY } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { candidateEligible, distanceKm, SOURCE, type FrozenRow, type FrozenCandidate, type Line, type PublicationEvidence } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { AdaptivePilotCorpus } from './adaptive-start-pilot-prepare.ts';
import type { OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';

export const PILOT = 'data/gpx/adaptive-start-pilot';
export const OUTPUT = 'data/gpx/generated-route-publication';
export const FROZEN_RESULTS_SHA256 = 'a9bed56f9e0318356e3c2365a828fd1d8688c66023e83e52a65ffe80c2847d45';
// Repository Node type declarations predate the Node 24 readOnly option.
const ReadOnlyDatabase = DatabaseSync as unknown as { new(path: string, options: { readOnly: true }): DatabaseSync };
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export async function fileHash(path: string): Promise<string> { return sha256Bytes(await readFile(path)); }

export async function loadFrozen() {
  const rows = await readJson<FrozenRow[]>(`${PILOT}/adaptive-start-component-v2-results.json`);
  assert.equal(await fileHash(`${PILOT}/adaptive-start-component-v2-results.json`), FROZEN_RESULTS_SHA256, 'FROZEN_RESULT_DRIFT');
  const corpus = await readJson<AdaptivePilotCorpus>(`${PILOT}/adaptive-start-pilot-corpus.json`);
  const { corpusHash, ...content } = corpus;
  assert.equal(sha256Stable(content), corpusHash);
  const locks = await readJson<{ resultsSha256: string; reportSha256: string; diagnosticSha256: string; corpusHash: string }>(`${PILOT}/adaptive-start-component-v2-artifact-hashes.json`);
  assert.equal(locks.resultsSha256, FROZEN_RESULTS_SHA256); assert.equal(locks.corpusHash, corpusHash);
  assert.equal(await fileHash(`${PILOT}/ADAPTIVE_START_COMPONENT_V2_REPORT.md`), locks.reportSha256);
  assert.equal(await fileHash(`${PILOT}/oversized-component-diagnostic.json`), locks.diagnosticSha256);
  const policy = await readJson<{ policy: { directMeters: number; extendedMeters: number; reviewMeters: number }; adaptivePolicyHash: string; diagnosticSha256: string }>(`${PILOT}/adaptive-start-summit-snap-policy.json`);
  assert.equal(sha256Stable(DEFAULT_ADAPTIVE_START_POLICY), policy.adaptivePolicyHash);
  assert.equal(await fileHash(`${PILOT}/adaptive-start-summit-snap-diagnostic.json`), policy.diagnosticSha256);
  assert.equal(policy.policy.directMeters, 30); assert.equal(policy.policy.extendedMeters, 50);
  const checkpoint = { mountains: rows.length, autoEligible: rows.reduce((s,r)=>s+r.candidates.length,0),
    mountainsWithAuto: rows.filter(r=>r.candidates.length).length,
    normalSuccess: rows.filter(r=>r.stratum==='NORMAL' && r.candidates.length).length,
    sparseSuccess: rows.filter(r=>r.stratum==='SPARSE' && r.candidates.length).length,
    componentLimit: rows.filter(r=>r.graphStatus==='GRAPH_COMPONENT_LIMIT').length, falseAutoAccepts: 0, fabricatedGapCount: 0 };
  assert.deepEqual(checkpoint, { mountains:100, autoEligible:238, mountainsWithAuto:39, normalSuccess:32, sparseSuccess:7, componentLimit:0, falseAutoAccepts:0, fabricatedGapCount:0 });
  // These two aggregate values are explicitly attested by the hash-locked replay report.
  const report = await readFile(`${PILOT}/ADAPTIVE_START_COMPONENT_V2_REPORT.md`, 'utf8');
  assert.match(report, /false auto-accepts 0\./); assert.match(report, /fabricated gaps 0;/);
  assert(rows.every(r=>r.candidates.every(c=>c.autoEligible && c.safety==='SAFE')));
  assert.deepEqual(rows.map(r=>r.mountainId), corpus.mountains.map(m=>m.mountainId));
  return { rows, corpus, policy, checkpoint };
}

export class FrozenPathReader {
  private extraction: DatabaseSync;
  private cache: DatabaseSync;
  readonly graphCacheIdentityHash: string;
  readonly extractionIdentityHash: string;
  constructor(corpus: AdaptivePilotCorpus) {
    this.extraction = new ReadOnlyDatabase(`${PILOT}/cache/${corpus.corpusHash}.sqlite`, { readOnly: true });
    this.cache = new ReadOnlyDatabase(`${PILOT}/cache/${corpus.corpusHash}-graphs.sqlite`, { readOnly: true });
    try {
      const meta = (db: DatabaseSync, key: string) => JSON.parse(String(db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value));
      const identity = meta(this.cache, 'identity'), complete = meta(this.cache, 'complete'), extracted = meta(this.extraction, 'complete');
      assert.equal(identity.requestedIdentityHash, corpus.corpusHash);
      assert.deepEqual(identity.dataset, corpus.dataset);
      assert.equal(extracted.identity.datasetSha256, corpus.dataset.pbfSha256);
      assert.equal(extracted.identity.corpusHash, corpus.corpusHash);
      assert.equal(identity.extractionMetadataHash, sha256Stable(extracted));
      this.graphCacheIdentityHash = sha256Stable({ identity, complete });
      this.extractionIdentityHash = sha256Stable(extracted);
    } catch (error) { this.close(); throw error; }
  }
  close() { this.cache.close(); this.extraction.close(); }
  materialize(c: FrozenCandidate): Line {
    assert(c.route, 'MISSING_ROUTE');
    const nodes = new Map<number, [number, number]>(), edges = new Set<string>();
    const query = this.extraction.prepare('SELECT payload FROM ways WHERE id=?');
    for (const wayId of c.route.osmWayIds) {
      const row = query.get(wayId); assert(row, 'FROZEN_WAY_MISSING');
      const way = JSON.parse(String(row.payload)) as OsmTrailWayInput;
      assert.equal(way.id, wayId);
      for (let i = 0; i < way.nodes.length; i++) {
        const n = way.nodes[i]; assert(n.coordinate?.length === 2, 'MISSING_FROZEN_COORDINATE');
        const xy: [number,number] = [n.coordinate[0],n.coordinate[1]];
        if (nodes.has(n.nodeId)) assert.deepEqual(nodes.get(n.nodeId), xy, 'FROZEN_NODE_COORDINATE_CONFLICT');
        nodes.set(n.nodeId,xy);
        if (i > 0) { const from = way.nodes[i-1].nodeId; edges.add(`${from}:${n.nodeId}`); edges.add(`${n.nodeId}:${from}`); }
      }
    }
    const coordinates = c.route.osmNodeIds.map((id, i) => {
      const coordinate = nodes.get(id); assert(coordinate, 'FROZEN_NODE_MISSING');
      if (i) assert(edges.has(`${c.route!.osmNodeIds[i-1]}:${id}`), 'FABRICATED_GAP_REJECTED');
      return coordinate;
    });
    const geometry: Line = { type: 'LineString', coordinates };
    assert.equal(sha256GeometryHash(geometry), c.route.geometryHash, 'FROZEN_GEOMETRY_HASH_MISMATCH');
    assert.deepEqual(coordinates[0],c.route.startCoordinate); assert.deepEqual(coordinates.at(-1),c.route.terminalCoordinate);
    assert(Math.abs(distanceKm(geometry)*1000-c.route.distanceM)<1e-8, 'FROZEN_DISTANCE_MISMATCH');
    return geometry;
  }
}

export function evidenceFor(frozen: Awaited<ReturnType<typeof loadFrozen>>, reader: FrozenPathReader, row: FrozenRow, c: FrozenCandidate): PublicationEvidence {
  assert(candidateEligible(row,c)); assert(c.route && c.category && c.startContext && row.summitAttachment && row.resultHash);
  const mountain = frozen.corpus.mountains.find(m=>m.mountainId===row.mountainId); assert(mountain);
  assert.deepEqual(row.summitAttachment.targetCoordinate,mountain.summit.coordinate);
  assert.deepEqual(row.summitAttachment.routeTerminalCoordinate,c.route.terminalCoordinate);
  return { generatedRouteIdentity: `${row.mountainId}:${c.id}`, sourceCandidateHash: sha256Stable(c), resultHash: row.resultHash,
    sourceMountainIdentity: row.mountainId, summit: mountain.summit,
    start: { ...c.osmIdentity, name:(c.tags.name || c.name).trim(), kind:c.kind, coordinate:c.coordinate, candidateId:c.id },
    startRole: c.startRole ?? undefined, accessEvidence: c.accessEvidence ?? undefined,
    datasetFingerprint: sha256Stable(frozen.corpus.dataset), pilotCorpusHash:frozen.corpus.corpusHash,
    adaptivePolicyHash:frozen.policy.adaptivePolicyHash, summitPolicyHash:sha256Stable(frozen.policy.policy), graphHash:c.route.graphHash,
    graphCacheIdentityHash:reader.graphCacheIdentityHash, extractionIdentityHash:reader.extractionIdentityHash,
    reconstructionManifestHash:c.route.reconstructionManifestHash, solverVersion:c.route.solverVersion,
    routePathHash:sha256Stable({ nodes:c.route.osmNodeIds, ways:c.route.osmWayIds }), geometryHash:c.route.geometryHash,
    routeCategory:c.category as PublicationEvidence['routeCategory'], startContext:c.startRole === 'PRIMARY_BASE_ACCESS' ? 'BASE_START' : c.startContext.type as PublicationEvidence['startContext'],
    summitAttachment:row.summitAttachment, safety:{ autoEligible:true, decision:'SAFE', fabricatedGapCount:0, boundaryLimited:false,
      connected:true, deterministic:true, solverStatus:'RECONSTRUCTED', checkedEdges:c.route.osmNodeIds.length-1 }, source:SOURCE };
}
