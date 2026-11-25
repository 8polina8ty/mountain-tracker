/** Controlled --execute bridge for the locked generated-route canary.
 *
 * The CLI stays GET-only by default. Every mutating capability lives behind
 * --execute AND exact locked confirmations. All per-route orchestration is
 * written against injected {@link ExecuteStorage} / {@link ExecuteDatabase} /
 * {@link ExecuteDelivery} interfaces so it can be unit tested with fakes; the
 * server-side factories at the bottom wrap a service-role-only Supabase client
 * (autoRefreshToken=false, persistSession=false). No service credentials are
 * ever written to reports or receipts.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import {
  compensationTargets,
  assertPrimaryPublication,
  existingPublicationAction,
  MIME,
  type CanaryManifest,
  type PublicationEntry,
} from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { LiveSnapshot } from './generated-publication-live.ts';
import { LOCKED_MANIFEST_HASH, MANIFEST_PATH } from './generated-publication-validation.ts';
import { OUTPUT } from './generated-publication-frozen.ts';

const MUTATION_TIMEOUT_LABEL = 'MUTATION_TIMEOUT';
const MUTATION_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PublishOptions {
  /** Bounded read-only reconciliation rounds after an ambiguous RPC outcome (default 4). */
  reconcileAttempts?: number;
  /** Delay between reconciliation rounds (default 150ms). */
  reconcileDelayMs?: number;
  /** Bounded retries for the anonymous public delivery check (default 3). */
  deliveryRetries?: number;
  /** Delay between delivery retries (default 150ms). */
  deliveryRetryDelayMs?: number;
}

export interface ExecuteArgParse {
  mode: 'DRY_RUN_ONLY' | 'EXECUTE';
  manifestPath: string;
  confirmations: { manifestHash: string; publicationIds: string[] } | null;
}

/** Structural argument parsing. Exact locked values are validated later against the manifest. */
export function parseExecuteArgs(argv: string[]): ExecuteArgParse {
  const allowed = new Set(['--dry-run', '--manifest', '--execute', '--confirm-manifest', '--confirm-publications']);
  let dryRunFlag = false;
  let execute = false;
  let manifestPath = MANIFEST_PATH;
  let confirmManifest: string | null = null;
  let confirmPublications: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    if (argument === '--dry-run') { dryRunFlag = true; continue; }
    if (argument === '--execute') { execute = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`ARGUMENT_VALUE_REQUIRED:${argument}`);
    index += 1;
    if (argument === '--manifest') manifestPath = value;
    if (argument === '--confirm-manifest') confirmManifest = value;
    if (argument === '--confirm-publications') confirmPublications = value;
  }
  if (!execute) {
    if (dryRunFlag && confirmManifest === null && confirmPublications === null) return { mode: 'DRY_RUN_ONLY', manifestPath, confirmations: null };
    if (dryRunFlag) throw new Error('CONFIRMATION_FLAGS_REQUIRE_EXECUTE');
    if (confirmManifest !== null || confirmPublications !== null) throw new Error('CONFIRMATION_FLAGS_REQUIRE_EXECUTE');
    if (manifestPath !== MANIFEST_PATH) throw new Error('ONLY_LOCKED_CANARY_SUPPORTED');
    return { mode: 'DRY_RUN_ONLY', manifestPath, confirmations: null };
  }
  if (dryRunFlag) throw new Error('DRY_RUN_FLAG_CONFLICTS_WITH_EXECUTE');
  if (manifestPath !== MANIFEST_PATH) throw new Error('EXECUTE_REQUIRES_LOCKED_DEFAULT_MANIFEST');
  if (confirmManifest === null) throw new Error('EXECUTE_REQUIRES_CONFIRM_MANIFEST');
  if (confirmManifest !== LOCKED_MANIFEST_HASH) throw new Error('EXECUTE_REQUIRES_EXACT_CONFIRM_MANIFEST');
  if (confirmPublications === null) throw new Error('EXECUTE_REQUIRES_CONFIRM_PUBLICATIONS');
  const publicationIds = confirmPublications.split(',').map((part) => part.trim());
  if (!publicationIds.length || publicationIds.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error('EXECUTE_CONFIRM_PUBLICATIONS_MALFORMED');
  }
  return { mode: 'EXECUTE', manifestPath, confirmations: { manifestHash: confirmManifest, publicationIds } };
}

/** The exact ordered publication-ID list frozen by the locked manifest. */
export function expectedPublicationConfirmation(manifest: CanaryManifest): string[] {
  return manifest.entries.map((entry) => entry.request.publicationId);
}

/** Exact confirmation binding: any partial, extra or changed value fails closed. */
export function validateExecuteConfirmations(
  confirmations: { manifestHash: string; publicationIds: string[] },
  manifest: CanaryManifest,
): void {
  if (confirmations.manifestHash !== LOCKED_MANIFEST_HASH) throw new Error('EXECUTE_CONFIRM_MANIFEST_MISMATCH');
  const expected = expectedPublicationConfirmation(manifest);
  if (confirmations.publicationIds.length !== expected.length ||
    confirmations.publicationIds.some((id, index) => id !== expected[index])) {
    throw new Error('EXECUTE_CONFIRM_PUBLICATIONS_MISMATCH');
  }
}

export interface ProvenanceRow {
  mountain_route_id: number;
  mountain_id: number;
  publication_contract_version: string;
  publication_idempotency_key: string;
  publication_status: string;
  publication_id: string;
  request_hash: string;
  canonical_request: unknown;
  generated_route_identity: string;
  dataset_fingerprint: string;
}

export interface MountainRouteRow {
  id: number;
  mountain_id: number;
  name: string;
  start_location: string | null;
  route_type: string;
  /** PostgreSQL numeric serialized by PostgREST as a JSON number or string. */
  distance_km: number | string;
  source_name: string | null;
  source_url: string | null;
  is_verified: boolean;
  geojson_url: string | null;
  gpx_url: string | null;
}

/**
 * Deployed mountain_routes.distance_km is PostgreSQL numeric with scale 2:
 * every committed row stores exactly two decimals (verified live across the
 * table, and the Phase11 publication path already normalizes with
 * Math.round(distance_km * 100) / 100 before comparison). The canary RPC
 * pushes frozen 6-decimal manifest values which the column silently coerces to
 * two decimals at write time (3.462517 -> 3.46). Resume/reconcile verification
 * therefore compares exact equality after canonical 2-decimal normalization of
 * both sides, mirroring that reviewed existing contract. Differences of less
 * than 0.005 km fall below the deployed column's representational quantum and
 * are not meaningful drift; the gate is never weakened below that.
 */
export const ROUTE_DISTANCE_SCALE = 100;

export interface PlannedPublication {
  entry: PublicationEntry;
  requestHash: string;
  action: 'CREATE' | 'RESUME';
  existing: LiveSnapshot['publications'][number] | undefined;
  blockers: string[];
}

/** Partitions the locked manifest into CREATE / exact-idempotent RESUME. Changed rows fail closed. */
export function planExecuteBatch(manifest: CanaryManifest, live: LiveSnapshot): {
  planned: PlannedPublication[];
  blockers: string[];
} {
  const blockers: string[] = [];
  const knownKeys = new Set(manifest.entries.map((entry) => entry.request.publicationIdempotencyKey));
  for (const publication of live.publications) {
    if (!knownKeys.has(publication.publication_idempotency_key)) {
      blockers.push(`UNEXPECTED_GENERATED_PUBLICATION:${publication.publication_idempotency_key}`);
    }
  }
  const planned = manifest.entries.map<PlannedPublication>((entry) => {
    const existing = live.publications.find((p) => p.publication_idempotency_key === entry.request.publicationIdempotencyKey);
    try {
      const action = existingPublicationAction(entry.request, existing);
      return { entry, requestHash: entry.requestHash, action: action === 'UNCHANGED' ? 'RESUME' : 'CREATE', existing, blockers: [] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { entry, requestHash: entry.requestHash, action: 'CREATE', existing, blockers: [reason] };
    }
  });
  return { planned, blockers: [...new Set(blockers)].sort() };
}

export interface RouteContext {
  entry: PublicationEntry;
  requestHash: string;
  action: 'CREATE' | 'RESUME';
  existing: LiveSnapshot['publications'][number] | undefined;
  bytes: Record<'gpx' | 'geojson', Uint8Array>;
  contentType: Record<'gpx' | 'geojson', string>;
  storagePaths: Record<'gpx' | 'geojson', string>;
  urls: Record<'gpx' | 'geojson', string>;
}

export async function buildRouteContext(planned: PlannedPublication): Promise<RouteContext> {
  assert.equal(sha256Stable(planned.entry.request), planned.requestHash, 'PER_ROUTE_REQUEST_HASH_BROKEN');
  const bytes = { gpx: new Uint8Array(0), geojson: new Uint8Array(0) } as Record<'gpx' | 'geojson', Uint8Array>;
  const contentType = {} as Record<'gpx' | 'geojson', string>;
  const storagePaths = {} as Record<'gpx' | 'geojson', string>;
  const urls = {} as Record<'gpx' | 'geojson', string>;
  for (const kind of ['gpx', 'geojson'] as const) {
    contentType[kind] = planned.entry.files[kind].contentType;
    storagePaths[kind] = planned.entry.request.provenance.storagePaths[kind];
    urls[kind] = planned.entry.request.mountainRoute[`${kind}_url`];
    const data = new Uint8Array(await readFile(`${OUTPUT}/${planned.entry.files[kind].path}`));
    if (data.length !== planned.entry.files[kind].bytes || sha256Bytes(data) !== planned.entry.files[kind].sha256) {
      throw new Error(`LOCAL_FILE_INTEGRITY:${kind}`);
    }
    bytes[kind] = data;
  }
  return { entry: planned.entry, requestHash: planned.requestHash, action: planned.action, existing: planned.existing, bytes, contentType, storagePaths, urls };
}

export type ReadResult<T> = { status: 'READ'; rows: T[] } | { status: 'READ_FAILED'; detail: string };

export interface ExecuteDatabase {
  publish(request: { canonicalRequest: string; requestHash: string }):
    Promise<{ status: 'OK'; rows: Array<{ action: string; mountain_route_id: number }> } | { status: 'ERROR'; detail: string }>;
  provenance(publicationIdempotencyKey: string): Promise<ReadResult<ProvenanceRow>>;
  mountainRoute(id: number): Promise<ReadResult<MountainRouteRow>>;
}

export type ProbeResult = { status: 'ABSENT' } | { status: 'EXISTS' } | { status: 'PROBE_FAILED'; detail: string };
export type UploadVerdict =
  | { status: 'UPLOADED' }
  | { status: 'UPLOAD_OUTCOME_UNCERTAIN'; detail: string }
  | { status: 'UPLOAD_REJECTED'; detail: string };
export type RemoveVerdict = { status: 'REMOVED' } | { status: 'REMOVE_FAILED'; detail: string };
export type ObjectVerdict =
  | { status: 'MATCH'; contentType: string | null }
  | { status: 'ABSENT' }
  | { status: 'MISMATCH'; detail: string };

export interface ExecuteStorage {
  ensureAbsent(path: string): Promise<ProbeResult>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<UploadVerdict>;
  remove(paths: string[]): Promise<RemoveVerdict>;
  verifyObject(path: string, expectedBytes: number, expectedSha256: string): Promise<ObjectVerdict>;
}

export interface ExecuteDelivery {
  check(kind: 'gpx' | 'geojson', url: string, expected: { bytes: number; sha256: string; contentType: string }):
    Promise<{ status: 'DELIVERABLE'; contentType: string } | { status: 'MISMATCH'; detail: string }>;
}

export type RoutePublicationResult =
  | { outcome: 'UNCHANGED'; mountainRouteId: number; created: string[]; reused: string[] }
  | { outcome: 'CREATED'; mountainRouteId: number; created: string[]; reused: string[] }
  | { outcome: 'RECONCILED_CREATED'; mountainRouteId: number; created: string[]; reused: string[]; reconciliationAttempts: number }
  | { outcome: 'STORAGE_OBJECT_COLLISION'; path: string; created: string[] }
  | { outcome: 'UPLOAD_OUTCOME_UNCERTAIN'; kind: 'gpx' | 'geojson'; created: string[] }
  | { outcome: 'RPC_OUTCOME_UNCERTAIN'; created: string[]; reconciliationAttempts?: number }
  | { outcome: 'FAILED'; reason: string; created: string[]; compensated: string[]; removeError?: string };

/** Verifies provenance + mountain_routes rows against the locked request (requirement 10 / 14). */
export function verifyCommittedRoute(entry: PublicationEntry, provenanceRows: ProvenanceRow[], mountainRows: MountainRouteRow[]): string[] {
  const request = entry.request;
  if (provenanceRows.length !== 1) return ['PROVENANCE_ROW_COUNT'];
  const p = provenanceRows[0];
  const errors: string[] = [];
  if (p.publication_contract_version !== request.contract) errors.push('PROVENANCE_CONTRACT_VERSION');
  if (p.publication_idempotency_key !== request.publicationIdempotencyKey) errors.push('PROVENANCE_IDEMPOTENCY_KEY');
  if (p.publication_status !== 'ACTIVE') errors.push(`PROVENANCE_STATUS:${p.publication_status}`);
  if (p.publication_id !== request.publicationId) errors.push('PROVENANCE_PUBLICATION_ID');
  if (p.request_hash !== entry.requestHash) errors.push('PROVENANCE_REQUEST_HASH');
  if (p.mountain_id !== request.mountainRoute.mountain_id) errors.push('PROVENANCE_MOUNTAIN_ID');
  if (stableJson(p.canonical_request) !== stableJson(request)) errors.push('PROVENANCE_CANONICAL_REQUEST');
  const route = mountainRows.find((row) => row.id === p.mountain_route_id);
  if (!route) { errors.push('MOUNTAIN_ROUTE_ROW_MISSING'); return errors; }
  if (route.mountain_id !== request.mountainRoute.mountain_id) errors.push('ROUTE_MOUNTAIN_ID');
  if (!route.is_verified) errors.push('ROUTE_NOT_VERIFIED');
  if (route.name !== request.mountainRoute.name) errors.push('ROUTE_NAME');
  if (route.start_location !== request.mountainRoute.start_location) errors.push('ROUTE_START_LOCATION');
  if (route.route_type !== 'hiking') errors.push(`ROUTE_TYPE:${route.route_type}`);
  const actualDistance = route.distance_km == null || route.distance_km === '' ? NaN : Number(route.distance_km);
  const expectedDistance = request.mountainRoute.distance_km == null ? NaN : Number(request.mountainRoute.distance_km);
  if (!Number.isFinite(actualDistance) || !Number.isFinite(expectedDistance)) errors.push('ROUTE_DISTANCE_NON_FINITE');
  else if (Math.round(actualDistance * ROUTE_DISTANCE_SCALE) !== Math.round(expectedDistance * ROUTE_DISTANCE_SCALE)) errors.push('ROUTE_DISTANCE');
  if (route.source_name !== 'OpenStreetMap') errors.push('ROUTE_SOURCE_NAME');
  if (route.source_url !== request.mountainRoute.source_url) errors.push('ROUTE_SOURCE_URL');
  if (route.geojson_url !== request.mountainRoute.geojson_url) errors.push('ROUTE_GEOJSON_URL');
  if (route.gpx_url !== request.mountainRoute.gpx_url) errors.push('ROUTE_GPX_URL');
  for (const kind of ['geojson', 'gpx'] as const) {
    const url = route[`${kind}_url`];
    if (url === null) errors.push(`MOUNTAIN_PAGE_CONTRACT:${kind}`);
    else if (new URL(url).protocol !== 'https:') errors.push(`MOUNTAIN_PAGE_CONTRACT_ABSOLUTE:${kind}`);
  }
  return errors;
}

export interface RouteReconciliation {
  outcome: 'COMMITTED' | 'ABSENT' | 'UNCERTAIN';
  mountainRouteId: number | null;
  attempts: number;
}

/** Read-only, bounded reconciliation of an ambiguous RPC outcome. Polls provenance +
 *  mountain_routes until it can either prove an exact committed row or prove absence;
 *  never mutates Storage or the database. */
export async function reconcileCommittedOutcome(
  entry: PublicationEntry,
  database: ExecuteDatabase,
  options: { attempts: number; delayMs: number },
): Promise<RouteReconciliation> {
  const key = entry.request.publicationIdempotencyKey;
  let attempts = 0;
  let sawRows = false;
  let cleanAbsence = false;
  for (let round = 0; round < options.attempts; round += 1) {
    attempts += 1;
    const proof = await database.provenance(key);
    if (proof.status === 'READ_FAILED') continue;
    if (proof.rows.length === 0) {
      cleanAbsence = true;
      if (round + 1 < options.attempts) await sleep(options.delayMs);
      continue;
    }
    sawRows = true;
    cleanAbsence = false;
    const row = proof.rows[0];
    const routeRead = await database.mountainRoute(row.mountain_route_id);
    if (routeRead.status !== 'READ') {
      if (round + 1 < options.attempts) await sleep(options.delayMs);
      continue;
    }
    if (verifyCommittedRoute(entry, proof.rows, routeRead.rows).length === 0) {
      return { outcome: 'COMMITTED', mountainRouteId: row.mountain_route_id, attempts };
    }
    if (round + 1 < options.attempts) await sleep(options.delayMs);
  }
  if (!sawRows && cleanAbsence) return { outcome: 'ABSENT', mountainRouteId: null, attempts };
  return { outcome: 'UNCERTAIN', mountainRouteId: null, attempts };
}

/** Bounded anonymous delivery verification shared by the CREATE and reconciled paths. */
async function verifyPublicDelivery(
  context: RouteContext,
  delivery: ExecuteDelivery,
  entry: PublicationEntry,
  options: { retries: number; delayMs: number },
): Promise<{ kind: 'gpx' | 'geojson'; detail: string } | null> {
  for (const kind of ['gpx', 'geojson'] as const) {
    let mismatch: { detail: string } | null = null;
    for (let attempt = 0; attempt < options.retries; attempt += 1) {
      const check = await delivery.check(kind, context.urls[kind], {
        bytes: context.bytes[kind].length,
        sha256: entry.files[kind].sha256,
        contentType: MIME[kind],
      });
      if (check.status === 'DELIVERABLE') { mismatch = null; break; }
      mismatch = { detail: check.detail };
      if (attempt + 1 < options.retries) await sleep(options.delayMs);
    }
    if (mismatch) return { kind, detail: mismatch.detail };
  }
  return null;
}

/** A recovered commit keeps the objects created this run and reports its reconciliation attempts. */
async function reconciledCreatedResult(
  reconciliation: RouteReconciliation,
  context: RouteContext,
  delivery: ExecuteDelivery,
  entry: PublicationEntry,
  options: { retries: number; delayMs: number },
  created: string[],
): Promise<RoutePublicationResult> {
  const mismatch = await verifyPublicDelivery(context, delivery, entry, options);
  if (mismatch) return { outcome: 'FAILED', reason: `PUBLIC_DELIVERY_MISMATCH:${mismatch.kind}:${mismatch.detail}`, created, compensated: [] };
  return { outcome: 'RECONCILED_CREATED', mountainRouteId: reconciliation.mountainRouteId!, created, reused: [], reconciliationAttempts: reconciliation.attempts };
}

/**
 * Per-route saga (requirements 7-13). One publication at a time; bounded uploads,
 * exact Storage paths, upsert=false, compensation, and post-RPC reconciliation.
 */
export async function publishRoute(
  context: RouteContext,
  storage: ExecuteStorage,
  database: ExecuteDatabase,
  delivery: ExecuteDelivery,
  options: PublishOptions = {},
): Promise<RoutePublicationResult> {
  const { entry, requestHash } = context;
  const request = entry.request;
  try { assertPrimaryPublication(request.provenance); } catch (error) {
    return { outcome: 'FAILED', reason: error instanceof Error ? error.message : 'PRIMARY_BASE_ACCESS_REQUIRED', created: [], compensated: [] };
  }
  const plannedPaths = [context.storagePaths.geojson, context.storagePaths.gpx];
  const reconcile = { attempts: options.reconcileAttempts ?? 4, delayMs: options.reconcileDelayMs ?? 150 };
  const deliveryRetry = { retries: options.deliveryRetries ?? 3, delayMs: options.deliveryRetryDelayMs ?? 150 };

  if (context.action === 'RESUME') {
    const proof = await database.provenance(request.publicationIdempotencyKey);
    let mountainRouteId: number;
    if (proof.status === 'READ' && proof.rows.length === 1) {
      const routeRead = await database.mountainRoute(proof.rows[0].mountain_route_id);
      const verifyErrors = verifyCommittedRoute(entry, proof.rows, routeRead.status === 'READ' ? routeRead.rows : []);
      if (verifyErrors.length) {
        return { outcome: 'FAILED', reason: `RESUME_VERIFICATION_FAILED:${verifyErrors.join(',')}`, created: [], compensated: [] };
      }
      mountainRouteId = proof.rows[0].mountain_route_id;
    } else if (proof.status === 'READ' && proof.rows.length !== 1) {
      return { outcome: 'FAILED', reason: `RESUME_VERIFICATION_FAILED:PROVENANCE_ROW_COUNT:${proof.rows.length}`, created: [], compensated: [] };
    } else {
      // Transient read failure on a planned resume: bounded read-only reconciliation before failing.
      const reconciliation = await reconcileCommittedOutcome(entry, database, reconcile);
      if (reconciliation.outcome === 'UNCERTAIN') {
        return { outcome: 'FAILED', reason: `RESUME_VERIFICATION_FAILED:PROVENANCE_READ_FAILED:${proof.status === 'READ_FAILED' ? proof.detail : 'UNCERTAIN'}`, created: [], compensated: [] };
      }
      if (reconciliation.outcome === 'ABSENT' || reconciliation.mountainRouteId === null) {
        return { outcome: 'FAILED', reason: 'RESUME_VERIFICATION_FAILED:PROVENANCE_ROW_COUNT:0', created: [], compensated: [] };
      }
      mountainRouteId = reconciliation.mountainRouteId;
    }
    const reused: string[] = [];
    for (const kind of ['gpx', 'geojson'] as const) {
      const verdict = await storage.verifyObject(context.storagePaths[kind], context.bytes[kind].length, entry.files[kind].sha256);
      if (verdict.status !== 'MATCH') {
        const reason = verdict.status === 'ABSENT'
          ? `ACTIVE_PUBLICATION_OBJECT_MISSING:${context.storagePaths[kind]}`
          : `STORAGE_CONTENT_MISMATCH:${context.storagePaths[kind]}:${verdict.detail}`;
        return { outcome: 'FAILED', reason, created: [], compensated: [] };
      }
      if (verdict.contentType !== context.contentType[kind]) {
        return { outcome: 'FAILED', reason: `STORAGE_CONTENT_MISMATCH:${context.storagePaths[kind]}:CONTENT_TYPE:${String(verdict.contentType)}`, created: [], compensated: [] };
      }
      reused.push(context.storagePaths[kind]);
    }
    return { outcome: 'UNCHANGED', mountainRouteId, created: [], reused };
  }

  for (const kind of ['gpx', 'geojson'] as const) {
    const probe = await storage.ensureAbsent(context.storagePaths[kind]);
    if (probe.status === 'EXISTS') return { outcome: 'STORAGE_OBJECT_COLLISION', path: context.storagePaths[kind], created: [] };
    if (probe.status === 'PROBE_FAILED') {
      return { outcome: 'FAILED', reason: `STORAGE_PROBE_FAILED:${context.storagePaths[kind]}:${probe.detail}`, created: [], compensated: [] };
    }
  }

  const created: string[] = [];
  for (const kind of ['geojson', 'gpx'] as const) {
    const verdict = await storage.upload(context.storagePaths[kind], context.bytes[kind], context.contentType[kind]);
    if (verdict.status !== 'UPLOADED') {
      if (verdict.status === 'UPLOAD_OUTCOME_UNCERTAIN') {
        return { outcome: 'UPLOAD_OUTCOME_UNCERTAIN', kind, created };
      }
      const targets = compensationTargets(plannedPaths, created, 'ABSENT');
      const removeResult = await storage.remove(targets);
      return {
        outcome: 'FAILED',
        reason: `UPLOAD_FAILED:${kind}:${verdict.detail}`,
        created,
        compensated: targets,
        removeError: removeResult.status === 'REMOVE_FAILED' ? removeResult.detail : undefined,
      };
    }
    created.push(context.storagePaths[kind]);
  }

  for (const kind of ['geojson', 'gpx'] as const) {
    const verdict = await storage.verifyObject(context.storagePaths[kind], context.bytes[kind].length, entry.files[kind].sha256);
    if (verdict.status !== 'MATCH') {
      const targets = compensationTargets(plannedPaths, created, 'ABSENT');
      const removeResult = await storage.remove(targets);
      return {
        outcome: 'FAILED',
        reason: `STORAGE_VERIFY_FAILED:${kind}:${verdict.status === 'ABSENT' ? 'ABSENT' : verdict.detail}`,
        created,
        compensated: targets,
        removeError: removeResult.status === 'REMOVE_FAILED' ? removeResult.detail : undefined,
      };
    }
  }

  const rpc = await database.publish({ canonicalRequest: stableJson(entry.request), requestHash });
  if (rpc.status === 'ERROR') {
    const reconciliation = await reconcileCommittedOutcome(entry, database, reconcile);
    if (reconciliation.outcome === 'COMMITTED') return reconciledCreatedResult(reconciliation, context, delivery, entry, deliveryRetry, created);
    if (reconciliation.outcome === 'UNCERTAIN') return { outcome: 'RPC_OUTCOME_UNCERTAIN', created, reconciliationAttempts: reconciliation.attempts };
    const targets = compensationTargets(plannedPaths, created, 'ABSENT');
    const removeResult = await storage.remove(targets);
    return {
      outcome: 'FAILED',
      reason: `RPC_FAILED:${rpc.detail}`,
      created,
      compensated: targets,
      removeError: removeResult.status === 'REMOVE_FAILED' ? removeResult.detail : undefined,
    };
  }
  const rows = rpc.rows;
  const first = rows[0];
  const invalidShape = rows.length !== 1 ||
    (first?.action !== 'CREATED' && first?.action !== 'UNCHANGED') ||
    !Number.isSafeInteger(first?.mountain_route_id) ||
    (first?.mountain_route_id ?? 0) <= 0;
  if (invalidShape) {
    const reconciliation = await reconcileCommittedOutcome(entry, database, reconcile);
    if (reconciliation.outcome === 'COMMITTED') return reconciledCreatedResult(reconciliation, context, delivery, entry, deliveryRetry, created);
    if (reconciliation.outcome === 'UNCERTAIN') return { outcome: 'RPC_OUTCOME_UNCERTAIN', created, reconciliationAttempts: reconciliation.attempts };
    const targets = compensationTargets(plannedPaths, created, 'ABSENT');
    const removeResult = await storage.remove(targets);
    return {
      outcome: 'FAILED',
      reason: `RPC_RESULT_INVALID:${rows.length}:${String(first?.action ?? 'MISSING')}`,
      created,
      compensated: targets,
      removeError: removeResult.status === 'REMOVE_FAILED' ? removeResult.detail : undefined,
    };
  }
  const committed = rows[0] as { action: 'CREATED' | 'UNCHANGED'; mountain_route_id: number };
  const proof = await database.provenance(request.publicationIdempotencyKey);
  if (proof.status === 'READ' && proof.rows.length === 1) {
    const routeRead = await database.mountainRoute(proof.rows[0].mountain_route_id);
    const verifyErrors = verifyCommittedRoute(entry, proof.rows, routeRead.status === 'READ' ? routeRead.rows : []);
    if (verifyErrors.length === 0) {
      const mismatch = await verifyPublicDelivery(context, delivery, entry, deliveryRetry);
      if (mismatch) return { outcome: 'FAILED', reason: `PUBLIC_DELIVERY_MISMATCH:${mismatch.kind}:${mismatch.detail}`, created, compensated: [] };
      return { outcome: committed.action, mountainRouteId: proof.rows[0].mountain_route_id, created, reused: [] };
    }
  }
  // The immediate post-RPC read disagreed (transient failure, stale/incomplete rows, or a lost response):
  // reconcile read-only before ever concluding, and never delete Storage for an outcome that may have committed.
  const reconciliation = await reconcileCommittedOutcome(entry, database, reconcile);
  if (reconciliation.outcome === 'COMMITTED') return reconciledCreatedResult(reconciliation, context, delivery, entry, deliveryRetry, created);
  if (reconciliation.outcome === 'ABSENT') {
    return { outcome: 'FAILED', reason: `POST_RPC_VERIFICATION_FAILED:${verifyCommittedRoute(entry, [], []).join(',')}`, created, compensated: [] };
  }
  return { outcome: 'RPC_OUTCOME_UNCERTAIN', created, reconciliationAttempts: reconciliation.attempts };
}

export interface PublicationAttempt {
  index: number;
  publicationId: string;
  result: RoutePublicationResult;
}

export interface BatchSummary {
  createdRoutes: number;
  reconciledCreatedRoutes: number;
  unchangedRoutes: number;
  storageObjectsCreated: number;
  storageObjectsReused: number;
  compensations: number;
  compensationDeleteFailures: number;
  dbWrites: number;
  storageWrites: number;
  publicationWrites: number;
}

export interface BatchRun {
  publications: PublicationAttempt[];
  failedIndex: number | null;
  unattempted: number;
  summary: BatchSummary;
}

function zeroSummary(): BatchSummary {
  return { createdRoutes: 0, reconciledCreatedRoutes: 0, unchangedRoutes: 0, storageObjectsCreated: 0, storageObjectsReused: 0, compensations: 0, compensationDeleteFailures: 0, dbWrites: 0, storageWrites: 0, publicationWrites: 0 };
}

function summarize(publications: PublicationAttempt[]): BatchSummary {
  const summary = zeroSummary();
  for (const { result } of publications) {
    summary.storageObjectsCreated += result.created.length;
    if (result.outcome === 'CREATED' || result.outcome === 'RECONCILED_CREATED') {
      if (result.outcome === 'CREATED') summary.createdRoutes += 1;
      else summary.reconciledCreatedRoutes += 1;
      summary.dbWrites += 1;
      summary.publicationWrites += 1;
      summary.storageWrites += result.created.length;
    } else if (result.outcome === 'UNCHANGED') {
      summary.unchangedRoutes += 1;
      summary.storageObjectsReused += result.reused.length;
    }
    if (result.outcome === 'FAILED') {
      summary.compensations += result.compensated.length;
      if (result.removeError) summary.compensationDeleteFailures += 1;
    }
  }
  return summary;
}

export async function runBatch(
  planned: PlannedPublication[],
  storage: ExecuteStorage,
  database: ExecuteDatabase,
  delivery: ExecuteDelivery,
  options: { buildContext?: (item: PlannedPublication) => Promise<RouteContext>; publish?: PublishOptions } = {},
): Promise<BatchRun> {
  const buildContext = options.buildContext ?? buildRouteContext;
  const blocked = planned.findIndex((item) => item.blockers.length > 0);
  if (blocked !== -1) return { publications: [], failedIndex: blocked, unattempted: planned.length, summary: zeroSummary() };
  const publications: PublicationAttempt[] = [];
  let failedIndex: number | null = null;
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    let context: RouteContext;
    try {
      context = await buildContext(item);
    } catch (error) {
      publications.push({
        index,
        publicationId: item.entry.request.publicationId,
        result: { outcome: 'FAILED', reason: `LOCAL_PREP_FAILED:${error instanceof Error ? error.message : String(error)}`, created: [], compensated: [] },
      });
      failedIndex = index;
      break;
    }
    const result = await publishRoute(context, storage, database, delivery, options.publish);
    publications.push({ index, publicationId: item.entry.request.publicationId, result });
    if (result.outcome !== 'CREATED' && result.outcome !== 'UNCHANGED' && result.outcome !== 'RECONCILED_CREATED') {
      failedIndex = index;
      break;
    }
  }
  const unattempted = failedIndex === null ? 0 : planned.length - failedIndex - 1;
  return { publications, failedIndex, unattempted, summary: summarize(publications) };
}

export interface FinalVerificationResult {
  status: 'PASS' | 'FAIL';
  completed: boolean;
  attempted: number;
  unattempted: number;
  errors: string[];
  notes: string[];
}

export function finalVerification(
  manifest: CanaryManifest,
  liveBefore: LiveSnapshot,
  liveAfter: LiveSnapshot,
  objects: Array<{ publicationId: string; kind: 'gpx' | 'geojson'; status: string }>,
  run: BatchRun,
): FinalVerificationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const createdThisRun = run.summary.createdRoutes + run.summary.reconciledCreatedRoutes;
  if (liveAfter.provenanceCount !== liveBefore.provenanceCount + createdThisRun) {
    errors.push(`PROVENANCE_COUNT_DELTA:${liveBefore.provenanceCount}+${createdThisRun}!==${liveAfter.provenanceCount}`);
  }
  const byKey = new Map(manifest.entries.map((entry) => [entry.request.publicationIdempotencyKey, entry] as const));
  for (const publication of liveAfter.publications) {
    const entry = byKey.get(publication.publication_idempotency_key);
    if (!entry) { errors.push(`UNEXPECTED_GENERATED_PUBLICATION:${publication.publication_idempotency_key}`); continue; }
    const request = entry.request;
    if (publication.publication_status !== 'ACTIVE') errors.push(`PUBLICATION_NOT_ACTIVE:${request.publicationId}`);
    if (publication.request_hash !== entry.requestHash) errors.push(`PUBLICATION_REQUEST_HASH:${request.publicationId}`);
    if (!Number.isSafeInteger(publication.mountain_route_id) || publication.mountain_route_id <= 0) {
      errors.push(`PUBLICATION_ROUTE_ID:${request.publicationId}`);
      continue;
    }
    const route = liveAfter.routes.find((row) => row.id === publication.mountain_route_id);
    if (!route) { errors.push(`MOUNTAIN_ROUTE_ROW_MISSING:${request.publicationId}`); continue; }
    if (!route.is_verified) errors.push(`ROUTE_NOT_VERIFIED:${request.publicationId}`);
    if (route.mountain_id !== request.mountainRoute.mountain_id) errors.push(`ROUTE_MOUNTAIN_ID:${request.publicationId}`);
    if (route.geojson_url !== request.mountainRoute.geojson_url || route.gpx_url !== request.mountainRoute.gpx_url) {
      errors.push(`ROUTE_URL_DRIFT:${request.publicationId}`);
    }
    const anonymous = liveAfter.anonymousRoutes.some((row) =>
      row.id === publication.mountain_route_id && row.is_verified &&
      row.mountain_id === request.mountainRoute.mountain_id &&
      row.geojson_url === request.mountainRoute.geojson_url &&
      row.gpx_url === request.mountainRoute.gpx_url);
    if (!anonymous) errors.push(`PUBLIC_ROUTE_NOT_VISIBLE:${request.publicationId}`);
  }
  // Only routes this run committed (or the whole manifest in full-completion mode) are required to
  // be present and byte-exact. Routes beyond an early batch stop are UNATTEMPTED, never failures.
  const completed = run.failedIndex === null && run.unattempted === 0;
  const attempted = manifest.entries.length - run.unattempted;
  const resultByIndex = new Map(run.publications.map((attempt) => [attempt.index, attempt.result] as const));
  const committed = (result: RoutePublicationResult) =>
    result.outcome === 'CREATED' || result.outcome === 'UNCHANGED' || result.outcome === 'RECONCILED_CREATED';
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const key = entry.request.publicationIdempotencyKey;
    const present = liveAfter.publications.some((p) => p.publication_idempotency_key === key);
    const result = resultByIndex.get(index);
    const required = result !== undefined ? committed(result) : completed;
    if (required) {
      if (!present) errors.push(`PUBLICATION_MISSING:${entry.request.publicationId}`);
      for (const kind of ['gpx', 'geojson'] as const) {
        if (!objects.some((o) => o.publicationId === entry.request.publicationId && o.kind === kind && o.status === 'MATCH')) {
          errors.push(`STORAGE_OBJECT_MISSING_OR_MISMATCH:${entry.request.publicationId}:${kind}`);
        }
      }
    } else if (result !== undefined) {
      if (present) errors.push(`COMMITTED_BUT_RECORDED_FAILED:${entry.request.publicationId}`);
    } else if (!present) {
      notes.push(`UNATTEMPTED:${entry.request.publicationId}`);
    }
  }
  if (!completed) errors.push('BATCH_INCOMPLETE');
  return {
    status: errors.length ? 'FAIL' : 'PASS',
    completed,
    attempted,
    unattempted: run.unattempted,
    errors: [...new Set(errors)].sort(),
    notes: [...new Set(notes)].sort(),
  };
}

export interface ReceiptPublication {
  index: number;
  publicationId: string;
  outcome: string;
  rpcAction: string | null;
  mountainRouteId: number | null;
  reconciled: boolean;
  reconciliationAttempts: number | null;
  storageCreated: string[];
  storageReused: string[];
  postVerification: string;
  reason: string | null;
}

export interface ExecutionReceipt {
  mode: 'EXECUTE';
  startedAt: string;
  completedAt: string;
  manifestHash: string;
  manifestPath: string;
  publications: ReceiptPublication[];
  summary: {
    dbWrites: number;
    storageWrites: number;
    compensationCount: number;
    createdRoutes: number;
    unchangedRoutes: number;
    storageObjectsCreated: number;
    storageObjectsReused: number;
    compensations: number;
    postVerification: string;
    createdThisRun: number;
    reconciledCreatedThisRun: number;
    unchangedExisting: number;
    storageCreatedThisRun: number;
    storageReusedExisting: number;
    unattempted: number;
  };
  finalVerification: FinalVerificationResult;
}

export function buildReceipt(
  run: BatchRun,
  final: FinalVerificationResult,
  startedAt: string,
  completedAt: string,
): ExecutionReceipt {
  const publications: ReceiptPublication[] = run.publications.map(({ index, publicationId, result }) => {
    const committed = result.outcome === 'CREATED' || result.outcome === 'UNCHANGED' || result.outcome === 'RECONCILED_CREATED';
    return {
      index: index + 1,
      publicationId,
      outcome: result.outcome,
      rpcAction: committed ? result.outcome : null,
      mountainRouteId: committed ? result.mountainRouteId : null,
      reconciled: result.outcome === 'RECONCILED_CREATED',
      reconciliationAttempts: 'reconciliationAttempts' in result ? result.reconciliationAttempts ?? null : null,
      storageCreated: result.created,
      storageReused: 'reused' in result ? result.reused : [],
      postVerification: committed ? 'PASS' : result.outcome,
      reason: result.outcome === 'FAILED' ? result.reason : null,
    };
  });
  return {
    mode: 'EXECUTE',
    startedAt,
    completedAt,
    manifestHash: LOCKED_MANIFEST_HASH,
    manifestPath: MANIFEST_PATH,
    publications,
    summary: {
      dbWrites: run.summary.dbWrites,
      storageWrites: run.summary.storageWrites,
      compensationCount: run.summary.compensations,
      createdRoutes: run.summary.createdRoutes,
      unchangedRoutes: run.summary.unchangedRoutes,
      storageObjectsCreated: run.summary.storageObjectsCreated,
      storageObjectsReused: run.summary.storageObjectsReused,
      compensations: run.summary.compensations,
      postVerification: final.status,
      createdThisRun: run.summary.createdRoutes,
      reconciledCreatedThisRun: run.summary.reconciledCreatedRoutes,
      unchangedExisting: run.summary.unchangedRoutes,
      storageCreatedThisRun: run.summary.storageObjectsCreated,
      storageReusedExisting: run.summary.storageObjectsReused,
      unattempted: run.unattempted,
    },
    finalVerification: final,
  };
}

/** Bounded wrapper: a timed-out operation is nondeterministic and becomes an uncertain outcome, never a proof of rollback. */
async function bounded<T>(operation: () => Promise<T>, label: string): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${MUTATION_TIMEOUT_LABEL}:${label}`)), MUTATION_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createSupabaseClient(origin: string, key: string): SupabaseClient {
  return createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Service-role-only Storage wrapper: exact paths, upsert=false, never overwrite. */
export function createExecuteStorage(
  client: SupabaseClient,
  options: { origin: string; key: string; bucket?: string },
): ExecuteStorage {
  const bucket = options.bucket ?? 'route-gpx';
  return {
    async ensureAbsent(path) {
      // Object-info HEAD/GET proves absence before any mutation (TOCTOU guard).
      const outcome = await bounded(async () => {
        const response = await fetch(`${options.origin}/storage/v1/object/info/public/${bucket}/${path}`, {
          method: 'GET',
          headers: { apikey: options.key, Authorization: `Bearer ${options.key}` },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        });
        if (response.ok) return { status: 'EXISTS' as const };
        const body = await response.json().catch(() => null) as { statusCode?: string | number; message?: string } | null;
        if (response.status === 404) return { status: 'ABSENT' as const };
        if (response.status === 400 && String(body?.statusCode) === '404' && /not found/i.test(String(body?.message ?? ''))) {
          return { status: 'ABSENT' as const };
        }
        return { status: 'PROBE_FAILED' as const, detail: `HTTP_${response.status}:${String(body?.message ?? '')}` };
      }, `storage-info:${path}`);
      return outcome.ok ? outcome.value : { status: 'PROBE_FAILED', detail: outcome.message };
    },
    async upload(path, bytes, contentType) {
      const outcome = await bounded(async () => {
        const { data, error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false, cacheControl: '3600' });
        return { data, error: error as { message?: string; statusCode?: string | number } | null };
      }, `storage-upload:${path}`);
      if (!outcome.ok) return { status: 'UPLOAD_OUTCOME_UNCERTAIN', detail: outcome.message };
      const { error } = outcome.value;
      if (error) return { status: 'UPLOAD_REJECTED', detail: `${String(error.message ?? 'UPLOAD_ERROR')}:${String(error.statusCode ?? '')}` };
      return { status: 'UPLOADED' };
    },
    async remove(paths) {
      const outcome = await bounded(async () => {
        const { error } = await client.storage.from(bucket).remove(paths);
        return error as { message?: string } | null;
      }, `storage-remove:${paths.length}`);
      if (!outcome.ok) return { status: 'REMOVE_FAILED', detail: outcome.message };
      if (outcome.value) return { status: 'REMOVE_FAILED', detail: String(outcome.value.message ?? 'REMOVE_ERROR') };
      return { status: 'REMOVED' };
    },
    async verifyObject(path, expectedBytes, expectedSha256) {
      const outcome = await bounded(async () => {
        const { data, error } = await client.storage.from(bucket).download(path);
        if (error || !data) throw new Error(`DOWNLOAD_ERROR:${String(error?.message ?? '')}`);
        return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || null };
      }, `storage-download:${path}`);
      if (!outcome.ok) return { status: 'MISMATCH', detail: outcome.message };
      const { bytes, contentType } = outcome.value;
      if (bytes.length !== expectedBytes) return { status: 'MISMATCH', detail: `SIZE:${bytes.length}:${expectedBytes}` };
      if (sha256Bytes(bytes) !== expectedSha256) return { status: 'MISMATCH', detail: 'HASH' };
      return { status: 'MATCH', contentType };
    },
  };
}

/** Service-role-only RPC + read wrapper. `publish` submits the exact canonical request envelope. */
export function createExecuteDatabase(client: SupabaseClient): ExecuteDatabase {
  return {
    async publish(request) {
      const outcome = await bounded(async () => {
        const { data, error } = await client.rpc('publish_generated_mountain_route', { p_request: request });
        return { data, error: error as { message?: string } | null };
      }, 'rpc:publish_generated_mountain_route');
      if (!outcome.ok) return { status: 'ERROR', detail: outcome.message };
      const { error, data } = outcome.value;
      if (error) return { status: 'ERROR', detail: String(error.message ?? 'RPC_ERROR') };
      return { status: 'OK', rows: (data ?? []) as Array<{ action: string; mountain_route_id: number }> };
    },
    async provenance(publicationIdempotencyKey) {
      const outcome = await bounded(async () => {
        const { data, error } = await client.from('generated_route_publication_provenance')
          .select('mountain_route_id,mountain_id,publication_contract_version,publication_idempotency_key,publication_status,publication_id,request_hash,canonical_request,generated_route_identity,dataset_fingerprint')
          .eq('publication_idempotency_key', publicationIdempotencyKey);
        return { data, error: error as { message?: string } | null };
      }, `provenance:${publicationIdempotencyKey}`);
      if (!outcome.ok) return { status: 'READ_FAILED', detail: outcome.message };
      if (outcome.value.error) return { status: 'READ_FAILED', detail: String(outcome.value.error.message ?? 'READ_ERROR') };
      return { status: 'READ', rows: (outcome.value.data ?? []) as unknown as ProvenanceRow[] };
    },
    async mountainRoute(id) {
      const outcome = await bounded(async () => {
        const { data, error } = await client.from('mountain_routes')
          .select('id,mountain_id,name,start_location,route_type,distance_km,source_name,source_url,is_verified,geojson_url,gpx_url')
          .eq('id', id);
        return { data, error: error as { message?: string } | null };
      }, `mountain-route:${id}`);
      if (!outcome.ok) return { status: 'READ_FAILED', detail: outcome.message };
      if (outcome.value.error) return { status: 'READ_FAILED', detail: String(outcome.value.error.message ?? 'READ_ERROR') };
      return { status: 'READ', rows: (outcome.value.data ?? []) as unknown as MountainRouteRow[] };
    },
  };
}

export function createExecuteDelivery(): ExecuteDelivery {
  return {
    async check(kind, url, expected) {
      const outcome = await bounded(async () => {
        const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
        const stream = response.body?.getReader();
        if (!stream) throw new Error('NO_STREAM');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await stream.read();
          if (next.done) break;
          size += next.value.length;
          if (size > expected.bytes) { await stream.cancel(); throw new Error('SIZE_OVERFLOW'); }
          chunks.push(next.value);
        }
        if (size !== expected.bytes) throw new Error(`SIZE:${size}:${expected.bytes}`);
        if (sha256Bytes(Buffer.concat(chunks)) !== expected.sha256) throw new Error('HASH');
        if (contentType !== expected.contentType) throw new Error(`CONTENT_TYPE:${contentType}`);
        return contentType;
      }, `delivery:${kind}`);
      if (!outcome.ok) return { status: 'MISMATCH', detail: outcome.message };
      return { status: 'DELIVERABLE', contentType: outcome.value };
    },
  };
}
