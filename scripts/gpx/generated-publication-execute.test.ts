import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { MIME, type CanaryManifest, type PublicationEntry } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import {
  buildReceipt, expectedPublicationConfirmation, finalVerification, parseExecuteArgs, planExecuteBatch,
  publishRoute, runBatch, validateExecuteConfirmations, verifyCommittedRoute,
  type BatchRun, type ExecuteDatabase, type ExecuteDelivery, type ExecuteStorage, type MountainRouteRow, type PlannedPublication,
  type ObjectVerdict, type ProbeResult, type ProvenanceRow, type ReadResult, type RemoveVerdict,
  type RouteContext, type RoutePublicationResult, type UploadVerdict,
} from './generated-publication-execute.ts';
import { deploymentBlockers, LOCKED_MANIFEST_HASH, MANIFEST_PATH } from './generated-publication-validation.ts';
import { dryRunBlockers, executeBlockers } from './publish-generated-route-canary.ts';
import type { LiveSnapshot } from './generated-publication-live.ts';
import { fixtureBaseEvidence } from '../../Lib/gpxIngestion/baseAccessTestFixtures.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const root = 'data/gpx/generated-route-publication';
const manifest = JSON.parse(read(`${root}/generated-route-canary-v1.json`)) as CanaryManifest;
const live = JSON.parse(read(`${root}/deployment-read-only.json`)) as LiveSnapshot;
const expectedIds = manifest.entries.map((e) => e.request.publicationId);

function cleanLive(): LiveSnapshot {
  const next = structuredClone(live);
  next.generatedTableAvailable = true;
  next.generatedRpcAvailable = true;
  next.generatedApprovalTableAvailable = true;
  next.provenanceCount = 0;
  next.approvals = manifest.entries.map((e) => ({ publication_id: e.request.publicationId, request_hash: e.requestHash, manifest_hash: LOCKED_MANIFEST_HASH }));
  next.publications = [];
  return next;
}

function fakeEntry(index: number): PublicationEntry {
  // These are synthetic execution fixtures. The immutable live manifest stays v1.
  const request = structuredClone(manifest.entries[index].request);
  const { osmId, coordinate } = request.provenance.start;
  request.provenance.startRole = 'PRIMARY_BASE_ACCESS';
  request.provenance.accessEvidence = fixtureBaseEvidence(osmId, coordinate);
  request.provenance.start.kind = 'PARKING';
  request.provenance.startContext = 'BASE_START';
  request.provenance.routeCategory = 'STANDARD_ASCENT';
  const bytes = { gpx: new TextEncoder().encode(`gpx:${request.publicationId}`), geojson: new TextEncoder().encode(`geojson:${request.publicationId}`) };
  return {
    request,
    requestHash: sha256Stable(request),
    files: {
      gpx: { path: `preview/${request.publicationId}/route.gpx`, sha256: sha256Bytes(bytes.gpx), bytes: bytes.gpx.length, contentType: MIME.gpx },
      geojson: { path: `preview/${request.publicationId}/route.geojson`, sha256: sha256Bytes(bytes.geojson), bytes: bytes.geojson.length, contentType: MIME.geojson },
    },
  };
}

function contextFor(entry: PublicationEntry, action: 'CREATE' | 'RESUME', existing?: LiveSnapshot['publications'][number]): RouteContext {
  return {
    entry,
    requestHash: entry.requestHash,
    action,
    existing,
    bytes: { gpx: new TextEncoder().encode(`gpx:${entry.request.publicationId}`), geojson: new TextEncoder().encode(`geojson:${entry.request.publicationId}`) },
    contentType: { gpx: MIME.gpx, geojson: MIME.geojson },
    storagePaths: entry.request.provenance.storagePaths,
    urls: { gpx: entry.request.mountainRoute.gpx_url, geojson: entry.request.mountainRoute.geojson_url },
  };
}

function provenanceRowFor(entry: PublicationEntry, mountainRouteId: number): ProvenanceRow {
  const r = entry.request;
  return { mountain_route_id: mountainRouteId, mountain_id: r.mountainRoute.mountain_id, publication_contract_version: r.contract,
    publication_idempotency_key: r.publicationIdempotencyKey, publication_status: 'ACTIVE', publication_id: r.publicationId,
    request_hash: entry.requestHash, canonical_request: r, generated_route_identity: r.provenance.generatedRouteIdentity,
    dataset_fingerprint: r.provenance.datasetFingerprint };
}

function mountainRouteRowFor(entry: PublicationEntry, id: number, overrides: Partial<MountainRouteRow> = {}): MountainRouteRow {
  const m = entry.request.mountainRoute;
  return { id, mountain_id: m.mountain_id, name: m.name, start_location: m.start_location, route_type: m.route_type,
    distance_km: m.distance_km, source_name: m.source_name, source_url: m.source_url, is_verified: m.is_verified,
    geojson_url: m.geojson_url, gpx_url: m.gpx_url, ...overrides };
}

class FakeStorage implements ExecuteStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  uploadFailures = new Map<string, UploadVerdict>();
  probesFail = false;
  removed: string[] = [];
  async ensureAbsent(path: string): Promise<ProbeResult> {
    if (this.probesFail) return { status: 'PROBE_FAILED', detail: 'PROBE_ERROR' };
    return this.objects.has(path) ? { status: 'EXISTS' as const } : { status: 'ABSENT' as const };
  }
  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<UploadVerdict> {
    const failure = this.uploadFailures.get(path);
    if (failure) return failure;
    this.objects.set(path, { bytes, contentType });
    return { status: 'UPLOADED' as const };
  }
  async remove(paths: string[]): Promise<RemoveVerdict> {
    this.removed.push(...paths);
    for (const path of paths) this.objects.delete(path);
    return { status: 'REMOVED' as const };
  }
  async verifyObject(path: string, expectedBytes: number, expectedSha256: string): Promise<ObjectVerdict> {
    const object = this.objects.get(path);
    if (!object) return { status: 'ABSENT' as const };
    if (object.bytes.length !== expectedBytes) return { status: 'MISMATCH' as const, detail: `SIZE:${object.bytes.length}:${expectedBytes}` };
    if (sha256Bytes(object.bytes) !== expectedSha256) return { status: 'MISMATCH' as const, detail: 'HASH' };
    return { status: 'MATCH' as const, contentType: object.contentType };
  }
}

class FakeDatabase implements ExecuteDatabase {
  scriptedPublish: { status: 'OK'; rows: Array<{ action: string; mountain_route_id: number }> } | { status: 'ERROR'; detail: string } | undefined;
  autoCommit = false;
  /** Server-side commit even when the client-visible RPC response is an error/lost body. */
  commitDespiteScripted = false;
  /** Hide committed provenance rows for the first N reads to simulate PostgREST visibility lag. */
  provenanceEmptyRounds = 0;
  nextRouteId = 9001;
  provenanceByIdempotency = new Map<string, ProvenanceRow[]>();
  mountainRoutes = new Map<number, MountainRouteRow[]>();
  publishedEnvelopes: Array<{ canonicalRequest: string; requestHash: string }> = [];
  provenanceReadFails = false;
  routeReadFails = false;
  private commit(request: { canonicalRequest: string; requestHash: string }): number | null {
    const entry = manifest.entries.map((_, i) => fakeEntry(i)).find((e) => e.requestHash === request.requestHash);
    if (!entry) return null;
    const id = this.nextRouteId++;
    const idx = manifest.entries.findIndex(e => e.request.publicationId === entry.request.publicationId);
    this.provenanceByIdempotency.set(entry.request.publicationIdempotencyKey, [provenanceRowFor(fakeEntry(idx), id)]);
    this.mountainRoutes.set(id, [mountainRouteRowFor(fakeEntry(idx), id)]);
    return id;
  }
  async publish(request: { canonicalRequest: string; requestHash: string }):
    Promise<{ status: 'OK'; rows: Array<{ action: string; mountain_route_id: number }> } | { status: 'ERROR'; detail: string }> {
    this.publishedEnvelopes.push(request);
    if (this.scriptedPublish && this.publishedEnvelopes.length === 1) {
      if (this.commitDespiteScripted) this.commit(request);
      return this.scriptedPublish;
    }
    if (!this.autoCommit) return { status: 'ERROR' as const, detail: 'NO_SCRIPT' };
    const id = this.commit(request);
    if (id === null) return { status: 'ERROR' as const, detail: 'UNKNOWN_REQUEST' };
    return { status: 'OK' as const, rows: [{ action: 'CREATED', mountain_route_id: id }] };
  }
  async provenance(key: string): Promise<ReadResult<ProvenanceRow>> {
    if (this.provenanceReadFails) return { status: 'READ_FAILED', detail: 'READ_FAILED' };
    const rows = this.provenanceByIdempotency.get(key) ?? [];
    if (rows.length > 0 && this.provenanceEmptyRounds > 0) {
      this.provenanceEmptyRounds -= 1;
      return { status: 'READ', rows: [] };
    }
    return { status: 'READ', rows };
  }
  async mountainRoute(id: number): Promise<ReadResult<MountainRouteRow>> {
    if (this.routeReadFails) return { status: 'READ_FAILED', detail: 'READ_FAILED' };
    return { status: 'READ', rows: this.mountainRoutes.get(id) ?? [] };
  }
}

class FakeDelivery implements ExecuteDelivery {
  calls: Array<{ kind: 'gpx' | 'geojson'; url: string; expected: { bytes: number; sha256: string; contentType: string } }> = [];
  mismatchKinds = new Set<'gpx' | 'geojson'>();
  async check(kind: 'gpx' | 'geojson', url: string, expected: { bytes: number; sha256: string; contentType: string }) {
    this.calls.push({ kind, url, expected });
    if (this.mismatchKinds.has(kind)) return { status: 'MISMATCH' as const, detail: 'CONTENT_TYPE:application/octet-stream' };
    return { status: 'DELIVERABLE' as const, contentType: expected.contentType };
  }
}

const first = fakeEntry(0);
const createContext = () => contextFor(first, 'CREATE');

test('all ten legacy canaries fail primary execution before any Storage or database IO', async () => {
  for (const entry of manifest.entries) {
    const database = new FakeDatabase(), storage = new FakeStorage();
    const result = await publishRoute(contextFor(entry, 'CREATE'), storage, database, new FakeDelivery());
    assert.equal(result.outcome, 'FAILED');
    assert.match(result.outcome === 'FAILED' ? result.reason : '', /PRIMARY_BASE_ACCESS_REQUIRED/);
    assert.equal(database.publishedEnvelopes.length, 0);
    assert.equal(storage.objects.size, 0);
    assert.deepEqual(storage.removed, []);
  }
});

test('hut and refuge cannot borrow a forged primary role from otherwise safe evidence', async () => {
  for (const kind of ['ALPINE_HUT', 'WILDERNESS_HUT', 'REFUGE', 'INTERMEDIATE_TRAIL_JUNCTION', 'HIGH_ALPINE_NETWORK_ACCESS']) {
    const entry = fakeEntry(0);
    entry.request.provenance.start.kind = kind;
    entry.request.provenance.accessEvidence!.candidateKind = kind;
    const database = new FakeDatabase(), storage = new FakeStorage();
    const result = await publishRoute(contextFor(entry, 'CREATE'), storage, database, new FakeDelivery());
    assert.equal(result.outcome, 'FAILED');
    assert.equal(database.publishedEnvelopes.length, 0); assert.equal(storage.objects.size, 0);
  }
});

function okResult(result: RoutePublicationResult): asserts result is Extract<RoutePublicationResult, { outcome: 'CREATED' | 'UNCHANGED' }> {
  assert(['CREATED', 'UNCHANGED'].includes(result.outcome));
}

test('parseExecuteArgs rejects unknown flags and value-less arguments', () => {
  assert.throws(() => parseExecuteArgs(['--bogus']), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseExecuteArgs(['--confirm-manifest']), /ARGUMENT_VALUE_REQUIRED/);
  assert.throws(() => parseExecuteArgs(['--dry-run', '--confirm-manifest', LOCKED_MANIFEST_HASH]), /CONFIRMATION_FLAGS_REQUIRE_EXECUTE/);
  assert.throws(() => parseExecuteArgs(['--execute', '--dry-run']), /DRY_RUN_FLAG_CONFLICTS_WITH_EXECUTE/);
});

test('no flags or a plain --dry-run stay zero-write dry runs with the locked manifest', () => {
  for (const argv of [[], ['--dry-run']]) {
    const parsed = parseExecuteArgs(argv);
    assert.equal(parsed.mode, 'DRY_RUN_ONLY');
    assert.equal(parsed.confirmations, null);
    assert.equal(parsed.manifestPath, MANIFEST_PATH);
  }
  assert.throws(() => parseExecuteArgs(['--manifest', 'other.json']), /ONLY_LOCKED_CANARY_SUPPORTED/);
});

test('--execute requires exact locked manifest and ordered publication confirmations', () => {
  const all = expectedIds.join(',');
  const valid = () => parseExecuteArgs(['--execute', '--confirm-manifest', LOCKED_MANIFEST_HASH, '--confirm-publications', all]);
  assert.equal(valid().mode, 'EXECUTE');
  assert.deepEqual(valid().confirmations!.publicationIds, expectedIds);
  assert.throws(() => parseExecuteArgs(['--execute']), /EXECUTE_REQUIRES_CONFIRM_MANIFEST/);
  assert.throws(() => parseExecuteArgs(['--execute', '--confirm-manifest', 'a'.repeat(64), '--confirm-publications', all]), /EXECUTE_REQUIRES_EXACT_CONFIRM_MANIFEST/);
  assert.throws(() => parseExecuteArgs(['--execute', '--confirm-manifest', LOCKED_MANIFEST_HASH]), /EXECUTE_REQUIRES_CONFIRM_PUBLICATIONS/);
  assert.throws(() => parseExecuteArgs(['--execute', '--confirm-manifest', LOCKED_MANIFEST_HASH, '--confirm-publications', 'nope']), /EXECUTE_CONFIRM_PUBLICATIONS_MALFORMED/);
  assert.throws(() => parseExecuteArgs(['--execute', '--manifest', 'other.json', '--confirm-manifest', LOCKED_MANIFEST_HASH, '--confirm-publications', all]), /EXECUTE_REQUIRES_LOCKED_DEFAULT_MANIFEST/);
});

test('confirmation binding is exact-ordered and fail-closed on any drift', () => {
  validateExecuteConfirmations({ manifestHash: LOCKED_MANIFEST_HASH, publicationIds: expectedIds }, manifest);
  validateExecuteConfirmations(parseExecuteArgs(['--execute', '--confirm-manifest', LOCKED_MANIFEST_HASH, '--confirm-publications', expectedIds.join(',')]).confirmations!, manifest);
  assert.throws(() => validateExecuteConfirmations({ manifestHash: LOCKED_MANIFEST_HASH, publicationIds: [expectedIds[1], ...expectedIds.slice(0, 1), ...expectedIds.slice(2)] }, manifest), /EXECUTE_CONFIRM_PUBLICATIONS_MISMATCH/);
  assert.throws(() => validateExecuteConfirmations({ manifestHash: LOCKED_MANIFEST_HASH, publicationIds: expectedIds.slice(0, 9) }, manifest), /EXECUTE_CONFIRM_PUBLICATIONS_MISMATCH/);
  assert.throws(() => validateExecuteConfirmations({ manifestHash: 'a'.repeat(64), publicationIds: expectedIds }, manifest), /EXECUTE_CONFIRM_MANIFEST_MISMATCH/);
});

test('planned order is the locked manifest order', () => {
  assert.equal(expectedPublicationConfirmation(manifest).length, 10);
  assert.deepEqual(expectedPublicationConfirmation(manifest), expectedIds);
  assert.equal(new Set(expectedIds).size, 10);
});

test('all production mutation primitives live in the gated execute bridge, never in the read-only CLI/live path', () => {
  const cli = read('scripts/gpx/publish-generated-route-canary.ts');
  const network = read('scripts/gpx/generated-publication-live.ts');
  const execute = read('scripts/gpx/generated-publication-execute.ts');
  assert.match(cli, /parseExecuteArgs/);
  assert.match(cli, /--execute/);
  assert.match(cli, /--confirm-manifest/);
  assert.match(cli, /--confirm-publications/);
  assert.match(execute, /upsert: false/);
  assert.match(execute, /\.rpc\('publish_generated_mountain_route'/);
  assert.match(execute, /autoRefreshToken: false/);
  assert.match(execute, /persistSession: false/);
  assert(!/\.upload\(|\.rpc\(|\.insert\(|\.remove\(|\.storage\.from|createClient\(/.test(cli + network));
});

test('planExecuteBatch partitions the locked baseline into ten unfettered CREATE routes', () => {
  const clean = cleanLive();
  const { planned, blockers } = planExecuteBatch(manifest, clean);
  assert.deepEqual(blockers, []);
  assert.equal(planned.length, 10);
  assert(planned.every((p) => p.action === 'CREATE' && p.blockers.length === 0));
});

test('planExecuteBatch turns exact committed rows into RESUME and blocks changed hashes', () => {
  const clean = cleanLive();
  clean.provenanceCount = 10;
  clean.publications = manifest.entries.map((e, i) => ({ publication_idempotency_key: e.request.publicationIdempotencyKey, request_hash: e.requestHash, publication_status: 'ACTIVE', mountain_route_id: 9000 + i }));
  const resumed = planExecuteBatch(manifest, clean);
  assert.equal(resumed.blockers.length, 0);
  assert(resumed.planned.every((p) => p.action === 'RESUME'));
  clean.publications[3] = { ...clean.publications[3], request_hash: 'a'.repeat(64) };
  const drifted = planExecuteBatch(manifest, clean).planned.find((p) => p.blockers.length > 0);
  assert(drifted);
  assert(drifted.blockers.some((b) => b.startsWith('CHANGED_HASH_FAIL_CLOSED')));
  clean.publications.push({ publication_idempotency_key: 'unexpected:key', request_hash: 'b'.repeat(64), publication_status: 'ACTIVE', mountain_route_id: 1 });
  const unexpected = planExecuteBatch(manifest, clean);
  assert(unexpected.blockers.includes('UNEXPECTED_GENERATED_PUBLICATION:unexpected:key'));
});

test('deployment blockers persist in dry run but allow exact resume under allowResume', () => {
  const clean = cleanLive();
  assert.deepEqual(deploymentBlockers(manifest, clean), []);
  clean.provenanceCount = 10;
  clean.publications = manifest.entries.map((e, i) => ({ publication_idempotency_key: e.request.publicationIdempotencyKey, request_hash: e.requestHash, publication_status: 'ACTIVE', mountain_route_id: 9000 + i }));
  assert(deploymentBlockers(manifest, clean).includes('PROVENANCE_COUNT_MISMATCH:10'));
  const resumed = deploymentBlockers(manifest, clean, { allowResume: true });
  assert(!resumed.some((b) => b.startsWith('PROVENANCE_COUNT_MISMATCH')));
  clean.publications.push({ publication_idempotency_key: 'unexpected:key', request_hash: 'b'.repeat(64), publication_status: 'ACTIVE', mountain_route_id: 1 });
  assert(deploymentBlockers(manifest, clean, { allowResume: true }).includes('UNEXPECTED_GENERATED_PUBLICATION:unexpected:key'));
});

test('publishRoute COLLISION on any existing storage object stops before uploads and RPC', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  const delivery = new FakeDelivery();
  storage.objects.set(first.request.provenance.storagePaths.geojson, { bytes: new Uint8Array([1]), contentType: 'application/geo+json' });
  const result = await publishRoute(createContext(), storage, database, delivery);
  assert.equal(result.outcome, 'STORAGE_OBJECT_COLLISION');
  assert.equal(database.publishedEnvelopes.length, 0);
  assert.deepEqual(storage.removed, []);
});

test('gpx upload rejection deletes the already-created geojson object', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  const delivery = new FakeDelivery();
  storage.uploadFailures.set(first.request.provenance.storagePaths.gpx, { status: 'UPLOAD_REJECTED', detail: 'HTTP_400' });
  const result = await publishRoute(createContext(), storage, database, delivery);
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') {
    assert.match(result.reason, /UPLOAD_FAILED:gpx/);
    assert.deepEqual(result.created, [first.request.provenance.storagePaths.geojson]);
    assert.deepEqual(result.compensated, [first.request.provenance.storagePaths.geojson]);
  }
  assert.deepEqual([...storage.objects.keys()], []);
  assert.deepEqual(database.publishedEnvelopes, []);
  assert.equal(delivery.calls.length, 0);
});

test('uncertain upload outcomes keep uploaded objects for manual reconciliation', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  storage.uploadFailures.set(first.request.provenance.storagePaths.gpx, { status: 'UPLOAD_OUTCOME_UNCERTAIN', detail: 'MUTATION_TIMEOUT:storage-upload:x' });
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery());
  assert.equal(result.outcome, 'UPLOAD_OUTCOME_UNCERTAIN');
  assert.deepEqual(result.created, [first.request.provenance.storagePaths.geojson]);
  assert.deepEqual([...storage.objects.keys()], [first.request.provenance.storagePaths.geojson]);
  assert.deepEqual(storage.removed, []);
  assert.equal(database.publishedEnvelopes.length, 0);
});

test('RPC rejection compensates created objects only after absence reconciliation', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'ERROR', detail: 'RPC_ERROR' };
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') {
    assert.match(result.reason, /RPC_FAILED:RPC_ERROR/);
    assert.deepEqual(result.compensated, Object.values(first.request.provenance.storagePaths));
  }
  assert.deepEqual([...storage.objects.keys()], []);
});

test('RPC rejection never deletes when the commit outcome is uncertain', async () => {
  for (const scenario of ['read-failed', 'row-exists'] as const) {
    const storage = new FakeStorage();
    const database = new FakeDatabase();
    database.scriptedPublish = { status: 'ERROR', detail: 'RPC_ERROR' };
    if (scenario === 'read-failed') database.provenanceReadFails = true;
    else database.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [provenanceRowFor(first, 9001)]);
    const result = await publishRoute(createContext(), storage, database, new FakeDelivery());
    assert.equal(result.outcome, 'RPC_OUTCOME_UNCERTAIN');
    assert.equal(storage.objects.size, 2);
    assert.deepEqual(storage.removed, []);
  }
});

test('successful CREATE verifies canonical request, rows, delivery, mime and commits exactly once', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const delivery = new FakeDelivery();
  const result = await publishRoute(createContext(), storage, database, delivery);
  okResult(result);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.mountainRouteId, 9001);
  assert.deepEqual(result.created, Object.values(first.request.provenance.storagePaths));
  assert.equal(database.publishedEnvelopes.length, 1);
  assert.deepEqual(database.publishedEnvelopes[0], { canonicalRequest: stableJson(first.request), requestHash: first.requestHash });
  assert.equal(delivery.calls.length, 2);
  assert.deepEqual(delivery.calls.map((c) => c.kind).sort(), ['geojson', 'gpx']);
  assert.equal(delivery.calls[0].expected.sha256, first.files[delivery.calls[0].kind].sha256);
  assert.equal(delivery.calls[0].expected.contentType, MIME[delivery.calls[0].kind]);
});

test('post-RPC verification failures never roll back committed objects', async () => {
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'OK', rows: [{ action: 'CREATED', mountain_route_id: 9001 }] };
  const storage = new FakeStorage();
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.match(result.reason, /POST_RPC_VERIFICATION_FAILED:PROVENANCE_ROW_COUNT/);
  assert.equal(storage.objects.size, 2);
  assert.deepEqual(storage.removed, []);
});

test('malformed RPC results fail closed, compensating only when absence is proven', async () => {
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'OK', rows: [{ action: 'WEIRD', mountain_route_id: 1 }] };
  const storage = new FakeStorage();
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.match(result.reason, /RPC_RESULT_INVALID:1:WEIRD/);
  assert.deepEqual([...storage.objects.keys()], []);
  database.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [provenanceRowFor(first, 9001)]);
  const storage2 = new FakeStorage();
  const uncertain = await publishRoute(createContext(), storage2, database, new FakeDelivery());
  assert.equal(uncertain.outcome, 'RPC_OUTCOME_UNCERTAIN');
  assert.equal(storage2.objects.size, 2);
});

test('public delivery mismatch fails closed but never deletes a committed route', async () => {
  const database = new FakeDatabase();
  database.autoCommit = true;
  const storage = new FakeStorage();
  const delivery = new FakeDelivery();
  delivery.mismatchKinds.add('gpx');
  const result = await publishRoute(createContext(), storage, database, delivery);
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.match(result.reason, /PUBLIC_DELIVERY_MISMATCH:gpx/);
  assert.equal(storage.objects.size, 2);
  assert.deepEqual(storage.removed, []);
});

test('RESUME reuses committed rows and storage objects without any write', async () => {
  const database = new FakeDatabase();
  database.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [provenanceRowFor(first, 9001)]);
  database.mountainRoutes.set(9001, [mountainRouteRowFor(first, 9001)]);
  const storage = new FakeStorage();
  const bytes = contextFor(first, 'RESUME').bytes;
  for (const kind of ['gpx', 'geojson'] as const) storage.objects.set(first.request.provenance.storagePaths[kind], { bytes: bytes[kind], contentType: MIME[kind] });
  const delivery = new FakeDelivery();
  const result = await publishRoute(contextFor(first, 'RESUME'), storage, database, delivery);
  okResult(result);
  assert.equal(result.outcome, 'UNCHANGED');
  assert.equal(result.mountainRouteId, 9001);
  assert.deepEqual(result.created, []);
  assert.equal(result.reused.length, 2);
  assert.equal(database.publishedEnvelopes.length, 0);
  assert.equal(delivery.calls.length, 0);
  assert.deepEqual(storage.removed, []);
});

test('RESUME fails closed on committed-row drift or missing objects', async () => {
  const base = provenanceRowFor(first, 9001);
  const database = new FakeDatabase();
  database.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [{ ...base, request_hash: 'a'.repeat(64) }]);
  database.mountainRoutes.set(9001, [mountainRouteRowFor(first, 9001)]);
  const storage = new FakeStorage();
  const result = await publishRoute(contextFor(first, 'RESUME'), storage, database, new FakeDelivery());
  assert.equal(result.outcome, 'FAILED');
  if (result.outcome === 'FAILED') assert.match(result.reason, /RESUME_VERIFICATION_FAILED:PROVENANCE_REQUEST_HASH/);
  const database2 = new FakeDatabase();
  database2.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [provenanceRowFor(first, 9001)]);
  database2.mountainRoutes.set(9001, [mountainRouteRowFor(first, 9001)]);
  const storage2 = new FakeStorage();
  const missing = await publishRoute(contextFor(first, 'RESUME'), storage2, database2, new FakeDelivery());
  assert.equal(missing.outcome, 'FAILED');
  if (missing.outcome === 'FAILED') assert.match(missing.reason, /ACTIVE_PUBLICATION_OBJECT_MISSING/);
  const storage3 = new FakeStorage();
  const bytes3 = contextFor(first, 'RESUME').bytes;
  for (const kind of ['gpx', 'geojson'] as const) storage3.objects.set(first.request.provenance.storagePaths[kind], { bytes: bytes3[kind], contentType: 'text/plain' });
  const database3 = new FakeDatabase();
  database3.provenanceByIdempotency.set(first.request.publicationIdempotencyKey, [provenanceRowFor(first, 9001)]);
  database3.mountainRoutes.set(9001, [mountainRouteRowFor(first, 9001)]);
  const wrongType = await publishRoute(contextFor(first, 'RESUME'), storage3, database3, new FakeDelivery());
  assert.equal(wrongType.outcome, 'FAILED');
  if (wrongType.outcome === 'FAILED') assert.match(wrongType.reason, /STORAGE_CONTENT_MISMATCH:[^:]+:CONTENT_TYPE/);
});

test('distance_km comparison normalizes PostgreSQL numeric serialization', async () => {
  const unit = (distanceKm: number | string): string[] => verifyCommittedRoute(first, [provenanceRowFor(first, 9001)], [mountainRouteRowFor(first, 9001, { distance_km: distanceKm })]);
  assert.deepEqual(unit(first.request.mountainRoute.distance_km), [], 'number as returned');
  assert.deepEqual(unit(String(first.request.mountainRoute.distance_km)), [], 'string as PostgREST serializes numeric');
  assert.deepEqual(unit(`${first.request.mountainRoute.distance_km}000`), [], 'harmless representation trailing digits');
  const coerced = Math.round((first.request.mountainRoute.distance_km as number) * 100) / 100;
  assert.deepEqual(unit(coerced), [], 'deployed numeric scale 2 coercion (3.462517 -> 3.46)');
  assert.deepEqual(unit(String(coerced)), [], 'deployed scale-2 value returned as string');
  assert.deepEqual(unit((first.request.mountainRoute.distance_km as number) + 1e-10), [], 'sub-representation noise');
});

test('distance_km drift, non-finite and blank values fail closed', async () => {
  const unit = (distanceKm: number | string | null | undefined): string[] => verifyCommittedRoute(first, [provenanceRowFor(first, 9001)], [mountainRouteRowFor(first, 9001, { distance_km: distanceKm as never })]);
  assert.ok(unit((first.request.mountainRoute.distance_km as number) + 0.005).includes('ROUTE_DISTANCE'), 'drift crossing the 2-decimal quantum');
  assert.ok(unit(0).includes('ROUTE_DISTANCE'), 'zero distance');
  assert.ok(unit('-1').includes('ROUTE_DISTANCE'), 'negative distance');
  assert.ok(unit('NaN').includes('ROUTE_DISTANCE_NON_FINITE'), 'NaN');
  assert.ok(unit('not-a-distance').includes('ROUTE_DISTANCE_NON_FINITE'), 'non-numeric');
  assert.ok(unit(null).includes('ROUTE_DISTANCE_NON_FINITE'), 'null');
  assert.ok(unit(undefined).includes('ROUTE_DISTANCE_NON_FINITE'), 'undefined');
});

test('RESUME fixture route 120 passes with string numeric distance, no duplicate and no overwrite', async () => {
  const entry = fakeEntry(0);
  const database = new FakeDatabase();
  database.provenanceByIdempotency.set(entry.request.publicationIdempotencyKey, [provenanceRowFor(entry, 120)]);
  database.mountainRoutes.set(120, [mountainRouteRowFor(fakeEntry(0), 120, { distance_km: '3.46' })]);
  const storage = new FakeStorage();
  const bytes = contextFor(fakeEntry(0), 'RESUME').bytes;
  const priorGpx = bytes.gpx, priorGeojson = bytes.geojson;
  for (const kind of ['gpx', 'geojson'] as const) storage.objects.set(entry.request.provenance.storagePaths[kind], { bytes: bytes[kind], contentType: MIME[kind] });
  const delivery = new FakeDelivery();
  const result = await publishRoute(contextFor(fakeEntry(0), 'RESUME'), storage, database, delivery);
  okResult(result);
  assert.equal(result.outcome, 'UNCHANGED');
  assert.equal(result.mountainRouteId, 120);
  assert.equal(result.reused.length, 2);
  assert.equal(result.created.length, 0);
  assert.equal(database.publishedEnvelopes.length, 0, 'no duplicate RPC');
  assert.deepEqual(database.mountainRoutes.get(120), [mountainRouteRowFor(fakeEntry(0), 120, { distance_km: '3.46' })], 'row untouched');
  assert.equal(storage.objects.get(entry.request.provenance.storagePaths.gpx)!.bytes, priorGpx, 'gpx bytes untouched');
  assert.equal(storage.objects.get(entry.request.provenance.storagePaths.geojson)!.bytes, priorGeojson, 'geojson bytes untouched');
  assert.deepEqual(delivery.calls, [], 'no delivery re-check');
  assert.deepEqual(storage.removed, []);
});

test('runBatch stops at the first failing publication and never touches later routes', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const planned = manifest.entries.slice(0, 3).map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  storage.uploadFailures.set(planned[0].entry.request.provenance.storagePaths.gpx, { status: 'UPLOAD_REJECTED', detail: 'HTTP_400' });
  const run = await runBatch(planned, storage, database, new FakeDelivery(), { buildContext: async (p) => contextFor(p.entry, p.action, p.existing) });
  assert.equal(run.publications.length, 1);
  assert.equal(run.failedIndex, 0);
  assert.equal(run.unattempted, 2);
  assert.equal(run.summary.compensations, 1);
  assert.equal(database.publishedEnvelopes.length, 0);
});

test('runBatch resumes a partial previous success without rewriting committed rows', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const planned: PlannedPublication[] = manifest.entries.map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  const resumed = planned[0];
  database.provenanceByIdempotency.set(resumed.entry.request.publicationIdempotencyKey, [provenanceRowFor(resumed.entry, 7001)]);
  database.mountainRoutes.set(7001, [mountainRouteRowFor(resumed.entry, 7001)]);
  const bytes = contextFor(resumed.entry, 'RESUME').bytes;
  for (const kind of ['gpx', 'geojson'] as const) storage.objects.set(resumed.entry.request.provenance.storagePaths[kind], { bytes: bytes[kind], contentType: MIME[kind] });
  planned[0] = { ...resumed, action: 'RESUME', existing: { publication_idempotency_key: resumed.entry.request.publicationIdempotencyKey, request_hash: resumed.entry.requestHash, publication_status: 'ACTIVE', mountain_route_id: 7001 } };
  const run = await runBatch(planned, storage, database, new FakeDelivery(), { buildContext: async (p) => contextFor(p.entry, p.action, p.existing) });
  assert.equal(run.failedIndex, null);
  assert.equal(run.publications.length, 10);
  assert.equal(run.summary.createdRoutes, 9);
  assert.equal(run.summary.unchangedRoutes, 1);
  assert.equal(run.summary.storageObjectsCreated, 18);
  assert.equal(run.summary.storageObjectsReused, 2);
  assert.equal(run.summary.dbWrites, 9);
});

test('runBatch fails closed before any write when a planned route is blocked', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const planned = manifest.entries.slice(0, 3).map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  planned[1] = { ...planned[1], blockers: ['CHANGED_HASH_FAIL_CLOSED'] };
  const run = await runBatch(planned, storage, database, new FakeDelivery(), { buildContext: async (p) => contextFor(p.entry, p.action, p.existing) });
  assert.deepEqual(run.publications, []);
  assert.equal(run.failedIndex, 1);
  assert.equal(run.unattempted, 3);
  assert.equal(database.publishedEnvelopes.length, 0);
  assert.equal(storage.objects.size, 0);
});

test('runBatch surfaces local file preparation failures without writes', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const planned = manifest.entries.slice(0, 2).map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  const run = await runBatch(planned, storage, database, new FakeDelivery(), {
    buildContext: async () => { throw new Error('LOCAL_FILE_INTEGRITY:gpx'); },
  });
  assert.equal(run.failedIndex, 0);
  const failure = run.publications[0].result;
  assert.equal(failure.outcome, 'FAILED');
  if (failure.outcome === 'FAILED') assert.match(failure.reason, /LOCAL_PREP_FAILED:LOCAL_FILE_INTEGRITY:gpx/);
  assert.equal(storage.objects.size, 0);
  assert.equal(database.publishedEnvelopes.length, 0);
});

test('verifyCommittedRoute catches canonical and URL drift directly', () => {
  assert.deepEqual(verifyCommittedRoute(first, [provenanceRowFor(first, 9001)], [mountainRouteRowFor(first, 9001)]), []);
  const drifted = provenanceRowFor(first, 9001);
  assert(verifyCommittedRoute(first, [{ ...drifted, canonical_request: { hacked: true } }], [mountainRouteRowFor(first, 9001)]).includes('PROVENANCE_CANONICAL_REQUEST'));
  assert(verifyCommittedRoute(first, [provenanceRowFor(first, 9001)], [mountainRouteRowFor(first, 9001, { name: 'Different' })]).includes('ROUTE_NAME'));
  assert(verifyCommittedRoute(first, [provenanceRowFor(first, 9001)], [mountainRouteRowFor(first, 9001, { geojson_url: 'http://insecure/route.geojson' })]).includes('MOUNTAIN_PAGE_CONTRACT_ABSOLUTE:geojson'));
});

function matchObjects(liveAfter: LiveSnapshot) {
  return liveAfter.publications.flatMap((p) => {
    const entry = manifest.entries.find((e) => e.request.publicationIdempotencyKey === p.publication_idempotency_key)!;
    return ([{ publicationId: entry.request.publicationId, kind: 'geojson' as const, status: 'MATCH' }, { publicationId: entry.request.publicationId, kind: 'gpx' as const, status: 'MATCH' }]);
  });
}

function afterState(): LiveSnapshot {
  const next = cleanLive();
  next.provenanceCount = manifest.entries.length;
  next.publications = manifest.entries.map((e, i) => ({ publication_idempotency_key: e.request.publicationIdempotencyKey, request_hash: e.requestHash, publication_status: 'ACTIVE', mountain_route_id: 3000 + i }));
  next.routes = manifest.entries.map((e, i) => ({ id: 3000 + i, mountain_id: e.request.mountainRoute.mountain_id, name: e.request.mountainRoute.name, start_location: e.request.mountainRoute.start_location, geojson_url: e.request.mountainRoute.geojson_url, gpx_url: e.request.mountainRoute.gpx_url, source_name: e.request.mountainRoute.source_name, source_url: e.request.mountainRoute.source_url, is_verified: true }));
  next.anonymousRoutes = next.routes.map((r) => ({ ...r }));
  return next;
}

function fullRun(): Parameters<typeof finalVerification>[4] {
  return { publications: [], failedIndex: null, unattempted: 0, summary: { createdRoutes: 10, reconciledCreatedRoutes: 0, unchangedRoutes: 0, storageObjectsCreated: 20, storageObjectsReused: 0, compensations: 0, compensationDeleteFailures: 0, dbWrites: 10, storageWrites: 20, publicationWrites: 10 } };
}

test('finalVerification passes only when all ten routes are committed, visible and byte-exact', () => {
  const before = cleanLive();
  const after = afterState();
  const pass = finalVerification(manifest, before, after, matchObjects(after), fullRun());
  assert.equal(pass.status, 'PASS');
  assert.deepEqual(pass.errors, []);
  const missingPublish = structuredClone(after);
  missingPublish.publications = missingPublish.publications.slice(0, 9);
  assert(finalVerification(manifest, before, missingPublish, matchObjects(missingPublish), fullRun()).errors.includes(`PUBLICATION_MISSING:${manifest.entries[9].request.publicationId}`));
  const brokenVisibility = structuredClone(after);
  brokenVisibility.anonymousRoutes = brokenVisibility.anonymousRoutes.slice(0, 9);
  assert(finalVerification(manifest, before, brokenVisibility, matchObjects(after), fullRun()).errors.includes(`PUBLIC_ROUTE_NOT_VISIBLE:${manifest.entries[9].request.publicationId}`));
  const brokenStorage = structuredClone(after);
  const objects = matchObjects(after).filter((o) => !(o.publicationId === manifest.entries[5].request.publicationId && o.kind === 'gpx'));
  assert(finalVerification(manifest, before, brokenStorage, objects, fullRun()).errors.includes(`STORAGE_OBJECT_MISSING_OR_MISMATCH:${manifest.entries[5].request.publicationId}:gpx`));
  const brokenDelta = structuredClone(after);
  brokenDelta.provenanceCount = 9;
  assert(finalVerification(manifest, before, brokenDelta, matchObjects(after), fullRun()).errors.includes(`PROVENANCE_COUNT_DELTA:0+10!==9`));
  const brokenRoute = structuredClone(after);
  brokenRoute.routes = brokenRoute.routes.map((r, i) => (i === 0 ? { ...r, is_verified: false } : r));
  assert(finalVerification(manifest, before, brokenRoute, matchObjects(after), fullRun()).errors.includes(`ROUTE_NOT_VERIFIED:${manifest.entries[0].request.publicationId}`));
});

test('buildReceipt records committed outcomes only and never contains credentials', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  const planned = manifest.entries.map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  const run = await runBatch(planned, storage, database, new FakeDelivery(), { buildContext: async (p) => contextFor(p.entry, p.action, p.existing) });
  const after = afterState();
  const final = finalVerification(manifest, cleanLive(), after, matchObjects(after), run);
  assert.equal(final.status, 'PASS');
  const receipt = buildReceipt(run, final, 't-0', 't-1');
  assert.equal(receipt.mode, 'EXECUTE');
  assert.equal(receipt.manifestHash, LOCKED_MANIFEST_HASH);
  assert.equal(receipt.summary.createdRoutes, 10);
  assert.equal(receipt.summary.postVerification, 'PASS');
  assert(receipt.publications.every((p) => p.rpcAction === 'CREATED' && p.storageCreated.length === 2));
  const text = stableJson(receipt);
  assert(!/Authorization|Bearer|SUPABASE_|authentication|jwt/im.test(text));
  assert.deepEqual(receipt.publications.map((p) => p.publicationId), expectedIds);
});

test('manifest identities are exactly reproducible for a future manual run', () => {
  assert.equal(sha256Stable(manifest), LOCKED_MANIFEST_HASH);
  assert.equal(stableJson(manifest), read(`${root}/generated-route-canary-v1.json`));
});

test('RPC server commits while the client times out: reconciliation recovers the committed route', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'ERROR', detail: 'MUTATION_TIMEOUT:rpc:publish_generated_mountain_route' };
  database.commitDespiteScripted = true;
  const delivery = new FakeDelivery();
  const result = await publishRoute(createContext(), storage, database, delivery, { reconcileAttempts: 3, reconcileDelayMs: 1, deliveryRetries: 1 });
  assert.equal(result.outcome, 'RECONCILED_CREATED');
  if (result.outcome === 'RECONCILED_CREATED') {
    assert.equal(result.mountainRouteId, 9001);
    assert.equal(result.reconciliationAttempts, 1);
    assert.deepEqual(result.created, Object.values(first.request.provenance.storagePaths));
  }
  assert.equal(storage.objects.size, 2);
  assert.deepEqual(storage.removed, []);
  assert.equal(database.publishedEnvelopes.length, 1);
  assert.equal(delivery.calls.length, 2);
});

test('incident batch: timeout on publication 1 plus committed DB reconciles, completes all ten and passes final verification', async () => {
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'ERROR', detail: 'MUTATION_TIMEOUT:rpc:publish_generated_mountain_route' };
  database.commitDespiteScripted = true;
  database.autoCommit = true;
  const planned = manifest.entries.map((_, i) => ({ entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash, action: 'CREATE' as const, existing: undefined, blockers: [] as string[] }));
  const run = await runBatch(planned, storage, database, new FakeDelivery(), {
    buildContext: async (p) => contextFor(p.entry, p.action, p.existing),
    publish: { reconcileAttempts: 2, reconcileDelayMs: 1, deliveryRetries: 1, deliveryRetryDelayMs: 1 },
  });
  assert.equal(run.failedIndex, null);
  assert.equal(run.publications.length, 10);
  assert.equal(run.summary.createdRoutes, 9);
  assert.equal(run.summary.reconciledCreatedRoutes, 1);
  assert.equal(run.summary.dbWrites, 10);
  assert.equal(run.summary.storageObjectsCreated, 20);
  const after = afterState();
  const final = finalVerification(manifest, cleanLive(), after, matchObjects(after), run);
  assert.equal(final.status, 'PASS');
  assert.equal(final.completed, true);
  assert.equal(final.unattempted, 0);
  const receipt = buildReceipt(run, final, 't-0', 't-1');
  assert.equal(receipt.publications[0].outcome, 'RECONCILED_CREATED');
  assert.equal(receipt.publications[0].rpcAction, 'RECONCILED_CREATED');
  assert.equal(receipt.publications[0].mountainRouteId, 9001);
  assert.equal(receipt.publications[0].reconciled, true);
  assert.equal(receipt.publications[0].postVerification, 'PASS');
  assert.equal(receipt.summary.reconciledCreatedThisRun, 1);
  assert.equal(receipt.summary.createdThisRun, 9);
  assert.equal(receipt.summary.dbWrites, 10);
  assert.equal(receipt.summary.unattempted, 0);
  assert.equal(database.mountainRoutes.size, 10);
});

test('empty or unexpected RPC body with a committed row reconciles to RECONCILED_CREATED', async () => {
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'OK', rows: [{}] as unknown as Array<{ action: string; mountain_route_id: number }> };
  database.commitDespiteScripted = true;
  const storage = new FakeStorage();
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery(), { reconcileAttempts: 2, reconcileDelayMs: 1, deliveryRetries: 1 });
  assert.equal(result.outcome, 'RECONCILED_CREATED');
  if (result.outcome === 'RECONCILED_CREATED') assert.equal(result.mountainRouteId, 9001);
  assert.equal(storage.objects.size, 2);
  assert.deepEqual(storage.removed, []);
});

test('reconciliation tolerates bounded PostgREST visibility lag before the committed row appears', async () => {
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'ERROR', detail: 'MUTATION_TIMEOUT:rpc:publish_generated_mountain_route' };
  database.commitDespiteScripted = true;
  database.provenanceEmptyRounds = 2;
  const storage = new FakeStorage();
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery(), { reconcileAttempts: 5, reconcileDelayMs: 1, deliveryRetries: 1 });
  assert.equal(result.outcome, 'RECONCILED_CREATED');
  if (result.outcome === 'RECONCILED_CREATED') {
    assert.equal(result.mountainRouteId, 9001);
    assert(result.reconciliationAttempts > 1, `expected lagged reconciliation, got attempts=${result.reconciliationAttempts}`);
  }
  assert.deepEqual(storage.removed, []);
});

test('persistently unreadable RPC outcome stays fail-closed without deleting storage', async () => {
  const database = new FakeDatabase();
  database.scriptedPublish = { status: 'ERROR', detail: 'MUTATION_TIMEOUT:rpc:publish_generated_mountain_route' };
  database.provenanceReadFails = true;
  const storage = new FakeStorage();
  const result = await publishRoute(createContext(), storage, database, new FakeDelivery(), { reconcileAttempts: 3, reconcileDelayMs: 1 });
  assert.equal(result.outcome, 'RPC_OUTCOME_UNCERTAIN');
  assert.equal(storage.objects.size, 2);
  assert.deepEqual(storage.removed, []);
});

test('a stopped batch records the remaining routes as UNATTEMPTED, never as missing failures', () => {
  const before = cleanLive();
  const after = cleanLive();
  const run: BatchRun = {
    publications: [{ index: 0, publicationId: manifest.entries[0].request.publicationId, result: { outcome: 'FAILED', reason: 'RPC_FAILED:RPC_ERROR', created: [], compensated: [] } }],
    failedIndex: 0, unattempted: 9,
    summary: { createdRoutes: 0, reconciledCreatedRoutes: 0, unchangedRoutes: 0, storageObjectsCreated: 0, storageObjectsReused: 0, compensations: 0, compensationDeleteFailures: 0, dbWrites: 0, storageWrites: 0, publicationWrites: 0 },
  };
  const final = finalVerification(manifest, before, after, [], run);
  assert.equal(final.status, 'FAIL');
  assert.equal(final.completed, false);
  assert.equal(final.attempted, 1);
  assert.equal(final.unattempted, 9);
  assert(final.errors.includes('BATCH_INCOMPLETE'));
  assert(!final.errors.some((e) => e.startsWith('PUBLICATION_MISSING')));
  assert(!final.errors.some((e) => e.startsWith('STORAGE_OBJECT_MISSING_OR_MISMATCH')));
  assert.equal(final.notes.length, 9);
  assert(final.notes.includes(`UNATTEMPTED:${manifest.entries[1].request.publicationId}`));
});

function productionStateFixture(): { live: LiveSnapshot; objects: Array<{ publicationId: string; kind: 'gpx' | 'geojson'; status: string }> } {
  const state = cleanLive();
  const firstEntry = manifest.entries[0];
  const routeId = 120;
  state.provenanceCount = 1;
  state.publications = [{ publication_idempotency_key: firstEntry.request.publicationIdempotencyKey, request_hash: firstEntry.requestHash, publication_status: 'ACTIVE', mountain_route_id: routeId }];
  const route = { id: routeId, mountain_id: firstEntry.request.mountainRoute.mountain_id, name: firstEntry.request.mountainRoute.name, start_location: firstEntry.request.mountainRoute.start_location, geojson_url: firstEntry.request.mountainRoute.geojson_url, gpx_url: firstEntry.request.mountainRoute.gpx_url, source_name: firstEntry.request.mountainRoute.source_name, source_url: firstEntry.request.mountainRoute.source_url, is_verified: true };
  state.routes = [route];
  state.anonymousRoutes = [{ ...route }];
  const objects = manifest.entries.flatMap((entry) => {
    const isCommitted = entry.request.publicationIdempotencyKey === firstEntry.request.publicationIdempotencyKey;
    return ([{ publicationId: entry.request.publicationId, kind: 'geojson' as const, status: isCommitted ? 'MATCH' as const : 'ABSENT' as const },
      { publicationId: entry.request.publicationId, kind: 'gpx' as const, status: isCommitted ? 'MATCH' as const : 'ABSENT' as const }]);
  });
  return { live: state, objects };
}

test('production fixture: 1/10 committed plans as one exact resume plus nine creates with zero blockers', () => {
  const { live, objects } = productionStateFixture();
  const expected = deploymentBlockers(manifest, live, { allowResume: true });
  assert.deepEqual(expected, []);
  assert.deepEqual(dryRunBlockers(manifest, live, objects), []);
  const planned = planExecuteBatch(manifest, live);
  assert.deepEqual(planned.blockers, []);
  assert.equal(planned.planned[0].action, 'RESUME');
  assert.equal(planned.planned[0].existing?.mountain_route_id, 120);
  assert(planned.planned.slice(1).every((item) => item.action === 'CREATE'));
  assert.deepEqual(executeBlockers(manifest, live, objects, planned.planned), []);
  assert.equal(objects.filter((o) => o.status === 'MATCH').length, 2);
  assert.equal(objects.filter((o) => o.status === 'ABSENT').length, 18);
});

test('resume against the 1/10 production state reuses route 120, never duplicates and finishes the remaining nine', async () => {
  const { live } = productionStateFixture();
  const planned = planExecuteBatch(manifest, live).planned.map((p, i) => ({ ...p, entry: fakeEntry(i), requestHash: fakeEntry(i).requestHash }));
  const storage = new FakeStorage();
  const database = new FakeDatabase();
  database.autoCommit = true;
  database.provenanceByIdempotency.set(manifest.entries[0].request.publicationIdempotencyKey, [provenanceRowFor(fakeEntry(0), 120)]);
  database.mountainRoutes.set(120, [mountainRouteRowFor(fakeEntry(0), 120)]);
  const bytes = contextFor(fakeEntry(0), 'RESUME').bytes;
  for (const kind of ['gpx', 'geojson'] as const) {
    const path = fakeEntry(0).request.provenance.storagePaths[kind];
    storage.objects.set(path, { bytes: bytes[kind], contentType: MIME[kind] });
  }
  const run = await runBatch(planned, storage, database, new FakeDelivery(), {
    buildContext: async (p) => contextFor(p.entry, p.action, p.existing),
    publish: { reconcileAttempts: 2, reconcileDelayMs: 1, deliveryRetries: 1 },
  });
  assert.equal(run.failedIndex, null);
  assert.equal(run.publications[0].result.outcome, 'UNCHANGED');
  assert.equal(run.publications[0].result.mountainRouteId, 120);
  assert.equal(run.summary.unchangedRoutes, 1);
  assert.equal(run.summary.createdRoutes, 9);
  assert.equal(run.summary.storageObjectsReused, 2);
  assert.equal(run.summary.storageObjectsCreated, 18);
  assert.equal(run.summary.dbWrites, 9);
  const ids = [...database.mountainRoutes.keys()];
  assert.equal(new Set(ids).size, 10);
  assert.equal(database.mountainRoutes.has(120), true);
  assert.equal(database.publishedEnvelopes.length, 9);
  const after = productionStateFixture().live;
  after.provenanceCount = 10;
  const routeIds = [120, ...ids.slice(1)];
  after.publications = manifest.entries.map((e, i) => ({ publication_idempotency_key: e.request.publicationIdempotencyKey, request_hash: e.requestHash, publication_status: 'ACTIVE', mountain_route_id: routeIds[i] }));
  const routeFor = (entry: PublicationEntry, id: number) => ({ id, mountain_id: entry.request.mountainRoute.mountain_id, name: entry.request.mountainRoute.name, start_location: entry.request.mountainRoute.start_location, geojson_url: entry.request.mountainRoute.geojson_url, gpx_url: entry.request.mountainRoute.gpx_url, source_name: entry.request.mountainRoute.source_name, source_url: entry.request.mountainRoute.source_url, is_verified: true });
  after.routes = manifest.entries.map((e, i) => routeFor(e, routeIds[i]));
  after.anonymousRoutes = [...after.routes];
  const final = finalVerification(manifest, productionStateFixture().live, after, matchObjects(after), run);
  assert.equal(final.status, 'PASS');
  assert.equal(final.completed, true);
  const receipt = buildReceipt(run, final, 't-0', 't-1');
  assert.equal(receipt.publications[0].rpcAction, 'UNCHANGED');
  assert.equal(receipt.publications[0].mountainRouteId, 120);
  assert.equal(receipt.summary.unchangedExisting, 1);
  assert.equal(receipt.summary.storageReusedExisting, 2);
});
