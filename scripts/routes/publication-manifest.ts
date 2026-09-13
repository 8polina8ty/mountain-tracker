/** Route Factory adapter to the existing generated-route publication contract. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { assertPrimaryPublication, preparePublication, validateRequest, validateLine, serializeGpx, type PublicationEntry, type PublicationEvidence, type Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { SaxServerGpxParser } from '../../Lib/gpxIngestion/serverGpxParser.ts';
import { DEFAULT_SERVER_GPX_LIMITS } from '../../Lib/gpxIngestion/parserContract.ts';
import { BASE_ACCESS_POLICY_VERSION, type RouteEntry, type ReviewDecisionRecord, type RunManifest } from './types.ts';
import { RUN_DIR, emptyCounts, loadRunCheckpoint } from './route-factory.ts';

export const FACTORY_PUBLICATION_VERSION = 'mountain-tracker/route-factory/publication/v2';
export const FACTORY_DB_CAPABILITY = 'route-factory-generated-publication/v1';
export interface FactoryPublicationEntry extends PublicationEntry {
  runId: string; factoryMountainId: number; classification: 'AUTO_APPROVED' | 'NEEDS_REVIEW';
  humanApproval: ReviewDecisionRecord | null; policyVersion: string; sourceEntryHash: string;
  distancePreciseKm: number; distanceProductionKm: number;
}
export interface FactoryPublicationManifest {
  schemaVersion: typeof FACTORY_PUBLICATION_VERSION; runId: string; origin: string;
  sourceHashes: Record<string, string | null>; entries: FactoryPublicationEntry[];
  exclusions: { mountainId: number; reason: string }[];
}
export type HumanDecision = ReviewDecisionRecord & { entryHash: string };
export function runDirectory(runId: string) {
  assert.match(runId, /^rf-[a-f0-9]{12}$/, 'INVALID_RUN_ID'); return join(RUN_DIR, runId);
}
export const manifestPath = (runId: string) => join(runDirectory(runId), 'publication', 'locked-manifest.json');
export const jsonFile = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
export async function optionalBytes(path: string) {
  try { return await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function writeImmutable(path: string, bytes: string) {
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.equal(await readFile(path, 'utf8'), bytes, `LOCKED_MANIFEST_DRIFT:${path}`);
  }
}
export async function loadPublicationRun(runId: string) {
  const dir = runDirectory(runId), manifest = await jsonFile<RunManifest>(join(dir, 'manifest.json'));
  const summary = await jsonFile<{ runId: string; entries: RouteEntry[] }>(join(dir, 'summary.json'));
  assert.equal(manifest.runId, runId); assert.equal(summary.runId, runId);
  const { manifestHash, startedAt, ...content } = manifest; void startedAt;
  assert.equal(sha256Stable(content), manifestHash, 'RUN_MANIFEST_DRIFT');
  const counts = emptyCounts(), ids = new Set<number>();
  for (const e of summary.entries) {
    assert(e.state in counts); assert(!ids.has(e.mountainId)); ids.add(e.mountainId); counts[e.state]++;
    assert.deepEqual(await jsonFile(join(dir, 'candidates', `${e.mountainId}.json`)), e, 'CANDIDATE_SUMMARY_DRIFT');
  }
  assert.equal(summary.entries.length, manifest.summary.processed);
  assert.deepEqual(counts, { AUTO_APPROVED: manifest.summary.autoApproved, NEEDS_REVIEW: manifest.summary.needsReview, REJECTED: manifest.summary.rejected, FAILED: manifest.summary.failed });
  const cp = await loadRunCheckpoint(dir, manifest.inputFingerprint); assert(cp && cp.lastIndex === summary.entries.length, 'RUN_CHECKPOINT_DRIFT');
  const decisionPath = join(dir, 'review', 'decisions.json'), decisionBytes = await optionalBytes(decisionPath);
  const decisions = decisionBytes ? JSON.parse(decisionBytes.toString('utf8')) as { runId: string; decisions: HumanDecision[] } : { runId, decisions: [] };
  assert.equal(decisions.runId, runId);
  const seen = new Set<number>();
  for (const d of decisions.decisions) {
    assert(!seen.has(d.mountainId), 'DUPLICATE_HUMAN_DECISION'); seen.add(d.mountainId);
    const e = summary.entries.find(e => e.mountainId === d.mountainId);
    assert(e && e.state === 'NEEDS_REVIEW', 'HUMAN_DECISION_REQUIRES_NEEDS_REVIEW');
    assert.equal(d.entryHash, sha256Stable(e), 'STALE_HUMAN_DECISION');
    assert.deepEqual(d.candidateIds, e.starters.map(s => s.candidateId));
    assert(['APPROVE', 'REGENERATE', 'REJECT'].includes(d.decision));
  }
  return { dir, manifest, entries: summary.entries, decisions: decisions.decisions, decisionPath };
}
export function publicationEligible(entry: RouteEntry, decision?: HumanDecision) {
  return entry.state === 'AUTO_APPROVED' || entry.state === 'NEEDS_REVIEW' && decision?.decision === 'APPROVE' && decision.entryHash === sha256Stable(entry);
}
export function validateFactoryManifest(manifest: FactoryPublicationManifest) {
  assert.equal(manifest.schemaVersion, FACTORY_PUBLICATION_VERSION); runDirectory(manifest.runId);
  const origin = new URL(manifest.origin); assert.equal(origin.origin, manifest.origin); assert.equal(origin.protocol, 'https:');
  const ids = new Set<number>(), publications = new Set<string>();
  for (const e of manifest.entries) {
    assert.equal(e.runId, manifest.runId); assert.equal(e.policyVersion, BASE_ACCESS_POLICY_VERSION);
    assert(e.classification === 'AUTO_APPROVED' || e.classification === 'NEEDS_REVIEW' && e.humanApproval?.decision === 'APPROVE');
    assert(!ids.has(e.request.mountainRoute.mountain_id)); ids.add(e.request.mountainRoute.mountain_id);
    assert(!publications.has(e.request.publicationId)); publications.add(e.request.publicationId);
    validateRequest(e.request); assertPrimaryPublication(e.request.provenance);
    assert.equal(sha256Stable(e.request), e.requestHash, 'REQUEST_HASH_DRIFT');
    assert.equal(e.distancePreciseKm, e.request.mountainRoute.distance_km);
    assert.equal(e.distanceProductionKm, Math.round(e.distancePreciseKm * 100) / 100);
    assert.equal(new URL(e.request.mountainRoute.gpx_url).origin, manifest.origin);
    assert.equal(new URL(e.request.mountainRoute.geojson_url).origin, manifest.origin);
    for (const kind of ['gpx', 'geojson'] as const) {
      assert.equal(e.files[kind].sha256, e.request.provenance[`${kind}Sha256`]);
      assert.equal(e.files[kind].bytes, e.request.provenance[`${kind}Bytes`]);
      assert.equal(e.files[kind].path, join(runDirectory(manifest.runId), 'publication', e.request.publicationId, `route.${kind}`));
    }
  }
}
export async function verifyFactoryFiles(manifest: FactoryPublicationManifest) {
  validateFactoryManifest(manifest);
  for (const [path, hash] of Object.entries(manifest.sourceHashes)) {
    const bytes = await optionalBytes(path); assert.equal(bytes ? sha256Bytes(bytes) : null, hash, `SOURCE_ARTIFACT_DRIFT:${path}`);
  }
  for (const e of manifest.entries) for (const f of Object.values(e.files)) {
    const bytes = await readFile(f.path); assert.equal(bytes.length, f.bytes); assert.equal(sha256Bytes(bytes), f.sha256, 'PUBLICATION_FILE_HASH_DRIFT');
  }
}
export async function loadLockedFactoryManifest(runId: string, suppliedHash?: string) {
  const path = manifestPath(runId), bytes = await readFile(path), hash = sha256Bytes(bytes);
  assert.equal((await readFile(`${path}.sha256`, 'utf8')).trim(), hash, 'MANIFEST_DRIFT');
  if (suppliedHash !== undefined) assert.equal(hash, suppliedHash, 'WRONG_MANIFEST_SHA256');
  const manifest = JSON.parse(bytes.toString('utf8')) as FactoryPublicationManifest;
  assert.equal(manifest.runId, runId); await verifyFactoryFiles(manifest);
  return { manifest, hash };
}

export async function prepareFactoryEntry(input: { runId: string; entry: RouteEntry; decision?: HumanDecision;
  mountainId: number; origin: string; geometry: Line; evidence: PublicationEvidence; gpx: Uint8Array }) {
  assert(publicationEligible(input.entry, input.decision), 'INELIGIBLE_CANDIDATE');
  assertPrimaryPublication(input.evidence); validateLine(input.geometry);
  assert(input.evidence.start.kind !== 'NETWORK_ACCESS' || input.entry.state === 'NEEDS_REVIEW' && input.decision?.decision === 'APPROVE', 'NETWORK_ACCESS_REQUIRES_HUMAN_REVIEW');
  const prepared = preparePublication(input.mountainId, input.origin, input.geometry, input.evidence);
  const parsed = await new SaxServerGpxParser().parse(input.gpx, DEFAULT_SERVER_GPX_LIMITS);
  assert.equal(parsed.segments.length, 1); assert.deepEqual(parsed.segments[0].points.map(p => p.coordinate), input.geometry.coordinates);
  assert.equal(Buffer.from(input.gpx).toString('utf8'), serializeGpx(parsed.trackName!, input.geometry), 'GPX_NOT_RECONSTRUCTED_SERIALIZATION');
  prepared.entry.request.provenance.gpxSha256 = sha256Bytes(input.gpx); prepared.entry.request.provenance.gpxBytes = input.gpx.length;
  prepared.entry.requestHash = sha256Stable(prepared.entry.request);
  prepared.entry.files.gpx.sha256 = sha256Bytes(input.gpx); prepared.entry.files.gpx.bytes = input.gpx.length;
  for (const kind of ['gpx', 'geojson'] as const) prepared.entry.files[kind].path = join(runDirectory(input.runId), 'publication', prepared.entry.request.publicationId, `route.${kind}`);
  const entry: FactoryPublicationEntry = { ...prepared.entry, runId: input.runId, factoryMountainId: input.entry.mountainId,
    classification: input.entry.state as FactoryPublicationEntry['classification'], humanApproval: input.decision ?? null,
    policyVersion: BASE_ACCESS_POLICY_VERSION, sourceEntryHash: sha256Stable(input.entry),
    distancePreciseKm: prepared.entry.request.mountainRoute.distance_km, distanceProductionKm: Math.round(prepared.entry.request.mountainRoute.distance_km * 100) / 100 };
  return { entry, gpx: Buffer.from(input.gpx).toString('utf8'), geojson: prepared.geojson };
}
export async function lockFactoryManifest(manifest: FactoryPublicationManifest) {
  await verifyFactoryFiles(manifest);
  const path = manifestPath(manifest.runId), bytes = stableJson(manifest) + '\n', hash = sha256Bytes(Buffer.from(bytes));
  await mkdir(join(runDirectory(manifest.runId), 'publication'), { recursive: true });
  await writeImmutable(path, bytes); await writeImmutable(`${path}.sha256`, hash + '\n');
  return { path, hash };
}
