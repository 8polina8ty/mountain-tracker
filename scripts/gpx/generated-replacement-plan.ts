import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes, sha256GeometryHash, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { BASE_ACCESS_START_POLICY, primaryBaseAccess } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { preparePublication, serializeGpx, validateLine, validateRequest, type CanaryManifest, type Line, type PublicationEntry, type PublicationEvidence } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { ADMITTED_CONNECTOR_HIGHWAYS, buildOsmTrailGraph, type OsmTrailWayInput, type OsmTrailDatasetIdentity } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { SaxServerGpxParser } from '../../Lib/gpxIngestion/serverGpxParser.ts';
import { DEFAULT_SERVER_GPX_LIMITS } from '../../Lib/gpxIngestion/parserContract.ts';
import { REPLACEMENT_IDS, KEEP_ID, validateOldSnapshot, type JsonRow, type ReplacementSnapshot } from './generated-replacement-live.ts';

export const REPLACEMENT_CONTRACT = 'mountain-tracker/generated-route-replacement/v1';
export const REPLACEMENT_OUTPUT = 'data/gpx/base-access-v2-replacement';
export const REPLACEMENT_MANIFEST = `${REPLACEMENT_OUTPUT}/replacement-manifest.json`;
export const REVIEW_ROOT = 'data/gpx/base-access-start-v2';
export const CANARY_PATH = 'data/gpx/generated-route-publication/generated-route-canary-v1.json';
export const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
interface ReviewRow {
  mountainId: number; summitName: string; summitCoordinate: number[]; resultHash: string;
  deterministicReplayVerified: boolean; fabricatedGapCount: number;
  new: { startName: string; generatedName: string; candidateId: string; actualStartOsmNodeId: number;
    actualStartCoordinate: number[]; distanceMeters: number; startRole: string; safety: string; accessEvidence: unknown; summitAttachment: unknown };
}
interface Review { policy: typeof BASE_ACCESS_START_POLICY; protectedArtifactHashes: Record<string, string>; rows: ReviewRow[] }
export interface ReplacementRequest {
  contract: typeof REPLACEMENT_CONTRACT; humanApproval: 'APPROVE_NEW_V2'; policyVersion: string;
  mountainId: number; expectedCurrentMountainRouteId: number;
  expectedOldRoute: JsonRow; expectedOldProvenance: JsonRow;
  newPublication: PublicationEntry['request']; newPublicationRequestHash: string;
  preciseDistanceKm: number; productionDistanceKm: number;
  originalReviewedGpxTrackName: string; reviewResultHash: string;
}
export interface ReplacementEntry {
  request: ReplacementRequest; requestHash: string;
  files: PublicationEntry['files']; artifactHashes: Record<string, string>;
}
export interface ReplacementManifest {
  contract: typeof REPLACEMENT_CONTRACT; humanApproval: 'APPROVE_NEW_V2'; policyVersion: string;
  sourceHashes: Record<string, string>; entries: ReplacementEntry[];
  storagePolicy: { upsert: false; deleteOldObjects: false; verifyBytesHashSizeMimeBeforeRpc: true };
}

export function validateReplacementManifest(m: ReplacementManifest) {
  assert.equal(m.contract, REPLACEMENT_CONTRACT); assert.equal(m.humanApproval, 'APPROVE_NEW_V2');
  assert.equal(m.policyVersion, BASE_ACCESS_START_POLICY.version);
  assert.deepEqual(m.entries.map(e => e.request.mountainId), [...REPLACEMENT_IDS], 'EXACT_NINE_REPLACEMENTS_REQUIRED');
  assert.deepEqual(m.storagePolicy, { upsert: false, deleteOldObjects: false, verifyBytesHashSizeMimeBeforeRpc: true });
  const rowIds = new Set<number>(), paths = new Set<string>(), publicationIds = new Set<string>();
  for (const entry of m.entries) {
    const r = entry.request, n = r.newPublication, old = r.expectedOldRoute, p = r.expectedOldProvenance;
    assert.notEqual(r.mountainId, KEEP_ID, 'KEEP_50473_EXCLUDED');
    assert.equal(r.contract, m.contract); assert.equal(r.policyVersion, m.policyVersion); assert.equal(r.humanApproval, m.humanApproval);
    assert.equal(sha256Stable(r), entry.requestHash, 'REPLACEMENT_REQUEST_HASH');
    assert.equal(r.expectedCurrentMountainRouteId, old.id); assert.equal(old.mountain_id, r.mountainId);
    assert.equal(p.mountain_route_id, old.id); assert.equal(p.mountain_id, r.mountainId); assert.equal(p.publication_status, 'ACTIVE');
    assert(!rowIds.has(r.expectedCurrentMountainRouteId)); rowIds.add(r.expectedCurrentMountainRouteId);
    assert(!publicationIds.has(n.publicationId)); publicationIds.add(n.publicationId);
    validateRequest(n); assert.equal(n.mountainRoute.mountain_id, r.mountainId);
    assert.equal(sha256Stable(n), r.newPublicationRequestHash);
    assert.equal(r.preciseDistanceKm, n.mountainRoute.distance_km);
    assert.equal(r.productionDistanceKm, Math.round(r.preciseDistanceKm * 100) / 100);
    assert.notEqual(n.publicationId, p.publication_id);
    for (const kind of ['gpx', 'geojson'] as const) {
      const path = n.provenance.storagePaths[kind], file = entry.files[kind];
      assert(!paths.has(path), 'DUPLICATE_STORAGE_PATH'); paths.add(path);
      assert.notEqual(n.mountainRoute[`${kind}_url`], old[`${kind}_url`], 'OLD_OBJECT_OVERWRITE');
      assert.equal(file.sha256, n.provenance[`${kind}Sha256`]); assert.equal(file.bytes, n.provenance[`${kind}Bytes`]);
      assert.match(file.path, /^data\/gpx\/(?:base-access-start-v2\/\d+\.gpx|base-access-v2-replacement\/objects\/[a-f0-9]{64}\/route\.geojson)$/);
    }
  }
}

export async function verifyReplacementFiles(m: ReplacementManifest) {
  validateReplacementManifest(m);
  for (const [path, hash] of Object.entries(m.sourceHashes)) assert.equal(sha256Bytes(await readFile(path)), hash, `SOURCE_CHANGED:${path}`);
  for (const e of m.entries) {
    for (const [path, hash] of Object.entries(e.artifactHashes)) assert.equal(sha256Bytes(await readFile(path)), hash, `REVIEW_ARTIFACT_CHANGED:${path}`);
    for (const file of Object.values(e.files)) {
      const bytes = await readFile(file.path); assert.equal(bytes.length, file.bytes); assert.equal(sha256Bytes(bytes), file.sha256, 'UPLOAD_BYTES_CHANGED');
    }
  }
}

/** Validate the recorded, reviewed path, without running route search or modifying a cache. */
export async function buildReplacementPlan(snapshot: ReplacementSnapshot) {
  const canary = await readJson<CanaryManifest>(CANARY_PATH); validateOldSnapshot(snapshot, canary);
  const reviewPath = `${REVIEW_ROOT}/final-review.json`, review = await readJson<Review>(reviewPath);
  assert.deepEqual(review.policy, BASE_ACCESS_START_POLICY);
  const checkpoint = await readJson<{ corpusHash: string; rows: { mountainId: number; resultHash: string; determinismVerified: boolean }[] }>(`${REVIEW_ROOT}/comparison.json`);
  const corpusPath = 'data/gpx/adaptive-start-pilot/adaptive-start-pilot-corpus.json';
  const corpus = await readJson<{ corpusHash: string; dataset: OsmTrailDatasetIdentity }>(corpusPath);
  assert.equal(checkpoint.corpusHash, corpus.corpusHash);
  const ReadOnly = DatabaseSync as unknown as { new(p: string, o: { readOnly: true }): DatabaseSync };
  const db = new ReadOnly(`data/gpx/adaptive-start-pilot/cache/${corpus.corpusHash}.sqlite`, { readOnly: true });
  const entries: ReplacementEntry[] = [], localObjects: { path: string; bytes: string }[] = [];
  try {
    const extraction = JSON.parse(String(db.prepare('SELECT value FROM metadata WHERE key=?').get('complete')?.value));
    assert.equal(extraction.identity.corpusHash, corpus.corpusHash); assert.equal(extraction.identity.datasetSha256, corpus.dataset.pbfSha256);
    const query = db.prepare('SELECT payload FROM ways WHERE id=?');
    for (const mountainId of REPLACEMENT_IDS) {
      const r = review.rows.filter(r => r.mountainId === mountainId); assert.equal(r.length, 1);
      const rr = r[0], evaluationPath = `${REVIEW_ROOT}/${mountainId}-evaluation.json`;
      const artifactPaths = [evaluationPath, `${REVIEW_ROOT}/${mountainId}.gpx`, `${REVIEW_ROOT}/${mountainId}-comparison.geojson`, `${REVIEW_ROOT}/${mountainId}-review.geojson`];
      const artifactHashes: Record<string, string> = {};
      for (const path of artifactPaths) {
        const hash = sha256Bytes(await readFile(path)); artifactHashes[path] = hash;
        if (!path.endsWith('-review.geojson')) assert.equal(hash, review.protectedArtifactHashes[path], 'PROTECTED_ARTIFACT_HASH');
      }
      const result = await readJson<AdaptiveStartDiscoveryResult>(evaluationPath);
      const { resultHash, timings, componentCacheHit, ...hashContent } = result; void [timings, componentCacheHit];
      assert.equal(sha256Stable(hashContent), resultHash); assert.equal(rr.resultHash, resultHash);
      assert(rr.deterministicReplayVerified && checkpoint.rows.find(r => r.mountainId === mountainId && r.resultHash === resultHash)?.determinismVerified);
      assert.equal(result.fabricatedGapCount, 0); assert.equal(rr.fabricatedGapCount, 0);
      const c = result.candidates[0], route = c?.route; assert(c && route && c.accessEvidence && result.summitAttachment);
      assert.equal(c.safety, 'SAFE'); assert.deepEqual(c.safetyReasons, []); assert.equal(c.startRole, 'PRIMARY_BASE_ACCESS');
      assert(primaryBaseAccess(c.accessEvidence)); assert.equal(c.solverStatus, 'RECONSTRUCTED'); assert.equal(route.reconstructionStatus, 'RECONSTRUCTED');
      assert.equal(c.id, rr.new.candidateId); assert.equal(c.name, rr.new.generatedName); assert.equal(route.distanceM, rr.new.distanceMeters);
      assert.deepEqual(c.accessEvidence, rr.new.accessEvidence); assert.deepEqual(result.summitAttachment, rr.new.summitAttachment);
      const old = canary.entries.find(e => e.request.mountainRoute.mountain_id === mountainId)!;
      assert.equal(result.request.summit.id, old.request.provenance.sourceMountainIdentity);
      assert.deepEqual(result.request.summit.coordinate, rr.summitCoordinate); assert.equal(result.request.summit.name, rr.summitName);
      assert.deepEqual(result.request.summit.coordinate, old.request.provenance.summit.coordinate);
      validateLine(route.geometry); const geometry: Line = route.geometry;
      assert.equal(sha256GeometryHash(geometry), route.geometryHash);
      assert.equal(geometry.coordinates.length, route.osmNodeIds.length);
      assert.deepEqual(geometry.coordinates[0], rr.new.actualStartCoordinate); assert.equal(route.osmNodeIds[0], rr.new.actualStartOsmNodeId);
      assert.deepEqual(geometry.coordinates.at(-1), result.summitAttachment.routeTerminalCoordinate);
      const ways = route.osmWayIds.map(id => { const row = query.get(id); assert(row, 'MISSING_FROZEN_WAY'); return JSON.parse(String(row.payload)) as OsmTrailWayInput; });
      const graph = buildOsmTrailGraph(corpus.dataset, ways, { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS] });
      for (let i = 0; i < route.osmNodeIds.length; i++) {
        const nodeId: number = route.osmNodeIds[i]; assert.deepEqual(graph.node(nodeId)?.coordinate, geometry.coordinates[i], 'OSM_COORDINATE_MISMATCH');
        if (i) assert(graph.neighbors(route.osmNodeIds[i - 1]).some(e => e.toNodeId === nodeId), 'FABRICATED_OR_FORBIDDEN_DIRECTED_EDGE');
      }
      const gpx = await readFile(artifactPaths[1]);
      const trackName = `${c.name} → ${result.request.summit.name}`;
      assert.equal(gpx.toString('utf8'), serializeGpx(trackName, geometry));
      const parsed = await new SaxServerGpxParser().parse(gpx, DEFAULT_SERVER_GPX_LIMITS);
      assert.equal(parsed.segments.length, 1); assert.deepEqual(parsed.segments[0].points.map(p => p.coordinate), geometry.coordinates);
      const comparison = await readJson<{ features: { properties: { role: string }; geometry: Line }[] }>(artifactPaths[3]);
      const selected = comparison.features.filter(f => f.properties.role === 'V2_ROUTE'); assert.equal(selected.length, 1); assert.deepEqual(selected[0].geometry, geometry);
      const evidence: PublicationEvidence = {
        generatedRouteIdentity: `${result.request.summit.id}:${c.id}`, sourceCandidateHash: sha256Stable(c), resultHash,
        sourceMountainIdentity: result.request.summit.id, summit: old.request.provenance.summit,
        start: { ...c.osmIdentity, name: rr.new.startName, kind: c.kind, coordinate: geometry.coordinates[0], candidateId: c.id },
        startRole: 'PRIMARY_BASE_ACCESS', accessEvidence: c.accessEvidence, datasetFingerprint: sha256Stable(corpus.dataset),
        pilotCorpusHash: corpus.corpusHash, adaptivePolicyHash: result.policyHash, summitPolicyHash: sha256Stable(result.request.summitAttachmentPolicy),
        graphHash: route.geometryProvenance.graphHash, graphCacheIdentityHash: old.request.provenance.graphCacheIdentityHash,
        extractionIdentityHash: sha256Stable(extraction), reconstructionManifestHash: route.reconstructionManifestHash,
        solverVersion: route.solverVersion, routePathHash: sha256Stable({ nodes: route.osmNodeIds, ways: route.osmWayIds }),
        geometryHash: route.geometryHash, routeCategory: c.category as PublicationEvidence['routeCategory'], startContext: 'BASE_START',
        summitAttachment: result.summitAttachment, safety: { autoEligible: true, decision: 'SAFE', fabricatedGapCount: 0, boundaryLimited: false,
          connected: true, deterministic: true, solverStatus: 'RECONSTRUCTED', checkedEdges: route.osmNodeIds.length - 1 }, source: old.request.provenance.source,
      };
      const prepared = preparePublication(mountainId, snapshot.origin, geometry, evidence), publication = prepared.entry;
      // Preserve the exact human-reviewed GPX bytes, including its original track name.
      publication.request.provenance.gpxSha256 = sha256Bytes(gpx); publication.request.provenance.gpxBytes = gpx.length;
      publication.files.gpx = { ...publication.files.gpx, path: artifactPaths[1], sha256: sha256Bytes(gpx), bytes: gpx.length };
      publication.files.geojson.path = `${REPLACEMENT_OUTPUT}/objects/${publication.request.publicationId}/route.geojson`;
      publication.requestHash = sha256Stable(publication.request); validateRequest(publication.request);
      assert.equal(publication.request.mountainRoute.distance_km, Math.round(route.distanceM * 1000) / 1_000_000);
      const request: ReplacementRequest = { contract: REPLACEMENT_CONTRACT, humanApproval: 'APPROVE_NEW_V2', policyVersion: BASE_ACCESS_START_POLICY.version,
        mountainId, expectedCurrentMountainRouteId: Number(snapshot.provenance.find(p => p.mountain_id === mountainId)!.mountain_route_id),
        expectedOldRoute: snapshot.routes.find(r => r.mountain_id === mountainId && r.is_verified === true)!,
        expectedOldProvenance: snapshot.provenance.find(p => p.mountain_id === mountainId)!,
        newPublication: publication.request, newPublicationRequestHash: publication.requestHash,
        preciseDistanceKm: publication.request.mountainRoute.distance_km, productionDistanceKm: Math.round(publication.request.mountainRoute.distance_km * 100) / 100,
        originalReviewedGpxTrackName: trackName, reviewResultHash: resultHash };
      entries.push({ request, requestHash: sha256Stable(request), files: publication.files, artifactHashes });
      localObjects.push({ path: publication.files.geojson.path, bytes: prepared.geojson });
    }
  } finally { db.close(); }
  const sourceHashes = Object.fromEntries(await Promise.all([CANARY_PATH, reviewPath, `${REVIEW_ROOT}/comparison.json`, corpusPath].map(async p => [p, sha256Bytes(await readFile(p))])));
  const manifest: ReplacementManifest = { contract: REPLACEMENT_CONTRACT, humanApproval: 'APPROVE_NEW_V2', policyVersion: BASE_ACCESS_START_POLICY.version,
    sourceHashes, entries, storagePolicy: { upsert: false, deleteOldObjects: false, verifyBytesHashSizeMimeBeforeRpc: true } };
  validateReplacementManifest(manifest);
  return { manifest, localObjects, manifestBytes: stableJson(manifest) + '\n' };
}
