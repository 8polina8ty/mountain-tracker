/** Route Factory core: deterministic offline classification, checkpointing, and publication preparation. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { candidateEligible, type FrozenRow } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { DEFAULT_ADAPTIVE_START_POLICY } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { FROZEN_RESULTS_SHA256, PILOT, fileHash, readJson } from '../gpx/generated-publication-frozen.ts';
import type { AdaptivePilotCorpus } from '../gpx/adaptive-start-pilot-prepare.ts';
import {
  ROUTE_FACTORY_ALGORITHM_VERSION,
  BASE_ACCESS_POLICY_VERSION,
  CANDIDATE_STATE,
  type CandidateResult,
  type CandidateState,
  type ReviewWarning,
  type RouteEntry,
  type RunManifest,
  type PublicationEntry,
} from './types.ts';

export const DISTANCE_EXTREME_METERS = 25_000;
export const DETOUR_RATIO_HIGH = 3;

/** The exact frozen publication auto-eligibility gate, re-exported for factory reuse. */
export { candidateEligible as exactBaseAccessGate } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';

// ---------------------------------------------------------------------------
// Frozen pilot source
// ---------------------------------------------------------------------------

export interface FactoryFrozenSource {
  rows: readonly FrozenRow[];
  corpus: AdaptivePilotCorpus;
  summitPolicy: { directMeters: number; extendedMeters: number; reviewMeters: number };
  adaptivePolicyHashes: { frozen: string; runtime: string; consistent: boolean };
  checkpoint: { mountains: number; autoEligible: number; mountainsWithAuto: number };
}

/**
 * Route Factory frozen-source verification. It mirrors the shared strict
 * `loadFrozen` artifact bindings (results SHA256, corpus internal hash,
 * artifact-hash locks, report attestations, checkpoint aggregates, summit
 * attachment policy) without hard-asserting equality of the full adaptive
 * start-discovery parameters against the runtime default: those parameters
 * only influence candidate discovery, never the verification of already
 * frozen rows, and the downstream Base Access V2 replacement chain explicitly
 * records both the frozen and the runtime adaptive policy hashes. The two
 * hashes are returned in the run manifest instead of being asserted equal.
 */
export async function loadFrozenSource(): Promise<FactoryFrozenSource> {
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
  assert.equal(policy.policy.directMeters, 30); assert.equal(policy.policy.extendedMeters, 50);
  assert.equal(await fileHash(`${PILOT}/adaptive-start-summit-snap-diagnostic.json`), policy.diagnosticSha256);
  const checkpoint = { mountains: rows.length, autoEligible: rows.reduce((s, r) => s + r.candidates.length, 0), mountainsWithAuto: rows.filter((r) => r.candidates.length).length };
  assert.deepEqual(checkpoint, { mountains: 100, autoEligible: 238, mountainsWithAuto: 39 });
  const report = await readFile(`${PILOT}/ADAPTIVE_START_COMPONENT_V2_REPORT.md`, 'utf8');
  assert.match(report, /false auto-accepts 0\./); assert.match(report, /fabricated gaps 0;/);
  assert(rows.every((r) => r.candidates.every((c) => c.autoEligible && c.safety === 'SAFE')));
  assert.deepEqual(rows.map((r) => r.mountainId), corpus.mountains.map((m) => m.mountainId));
  return {
    rows,
    corpus,
    summitPolicy: policy.policy,
    adaptivePolicyHashes: {
      frozen: policy.adaptivePolicyHash,
      runtime: sha256Stable(DEFAULT_ADAPTIVE_START_POLICY),
      consistent: policy.adaptivePolicyHash === sha256Stable(DEFAULT_ADAPTIVE_START_POLICY),
    },
    checkpoint,
  };
}

/** Minimal structural view of a frozen candidate that classification depends on. */
export interface FrozenCandidateLike {
  id: string;
  kind: string;
  autoEligible: boolean;
  safety: string;
  solverStatus: string;
  startRole: string | null;
  category: string | null;
  routeDistanceMeters?: number | null;
  route?: { distanceM: number; geometrySource: string } | null;
  accessEvidence?: { startElevation: number | null } | null;
  networkDistanceMeters: number | null;
  airDistanceMeters: number;
  tags?: Readonly<Record<string, string>>;
  reasons?: readonly string[];
  duplicateOf?: string | null;
  startContext?: { type?: string } | null;
}

/**
 * Conservative product-quality warnings. A route may be technically valid yet
 * still deserve human review, so warnings never reject purely for length.
 */
export function reviewWarningsFor(
  c: Readonly<{
    route?: { distanceM: number } | null;
    accessEvidence?: { startElevation: number | null } | null;
    networkDistanceMeters: number | null;
    airDistanceMeters: number;
    kind: string;
  }>,
): ReviewWarning[] {
  const warnings: ReviewWarning[] = [];
  if (c.route && c.route.distanceM > DISTANCE_EXTREME_METERS) warnings.push('DISTANCE_EXTREME');
  if (
    c.networkDistanceMeters !== null &&
    c.networkDistanceMeters > 0 &&
    c.airDistanceMeters > 0 &&
    c.networkDistanceMeters / c.airDistanceMeters > DETOUR_RATIO_HIGH
  ) {
    warnings.push('DETOUR_RATIO_HIGH');
  }
  if (c.accessEvidence && c.accessEvidence.startElevation === null) warnings.push('START_ELEVATION_UNKNOWN');
  if (c.kind === 'NETWORK_ACCESS') warnings.push('PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED');
  return warnings;
}

/**
 * Classify one frozen candidate against the strict technical gate plus product
 * warnings. `eligible` is the frozen publication eligibility gate result
 * (candidateEligible); passing false rejects. AUTO_APPROVED requires eligible
 * plus zero warnings; warnings promote to NEEDS_REVIEW.
 */
export function classifyCandidate(
  c: Readonly<FrozenCandidateLike>,
  eligible: boolean,
): CandidateResult {
  const gateFailures = eligible ? [] : ['NOT_AUTO_ELIGIBLE'];
  const warnings = eligible ? reviewWarningsFor(c) : [];
  const state = !eligible ? CANDIDATE_STATE.REJECTED : warnings.length ? CANDIDATE_STATE.NEEDS_REVIEW : CANDIDATE_STATE.AUTO_APPROVED;
  return {
    candidateId: c.id,
    state,
    warnings,
    gateFailures,
    distanceKm: c.route ? c.route.distanceM / 1000 : null,
    primaryBaseAccess: c.startRole === 'PRIMARY_BASE_ACCESS',
    routeAvailable: c.solverStatus === 'RECONSTRUCTED' && Boolean(c.route),
    reasons: c.reasons ?? [],
  };
}

/** Deterministic primary candidate selection: shortest eligible PRIMARY route. */
export function choosePrimaryCandidate(
  row: Readonly<{ status: string; graphStatus: string; candidates: readonly Readonly<FrozenCandidateLike>[] }>,
): Readonly<FrozenCandidateLike> | null {
  if (row.graphStatus !== 'READY' || row.status !== 'STARTS_FOUND') return null;
  const eligible = row.candidates.filter(
    (c) =>
      c.startRole === 'PRIMARY_BASE_ACCESS' &&
      c.autoEligible &&
      c.safety === 'SAFE' &&
      c.solverStatus === 'RECONSTRUCTED' &&
      !c.duplicateOf &&
      !/HUT|REFUGE/.test(c.kind) &&
      c.startContext?.type !== 'HUT_START' &&
      c.startContext?.type !== 'HIGH_MOUNTAIN_START',
  );
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => (a.routeDistanceMeters ?? Infinity) - (b.routeDistanceMeters ?? Infinity))[0];
}

/** Full-mountain classification used by `generate`. Deterministic and pure. */
export function classifyMountain(
  row: Readonly<{ mountainId: string; name: string; status: string; graphStatus: string; determinismVerified: boolean | null; reasons?: readonly string[]; candidates: readonly (Readonly<FrozenCandidateLike> & Record<string, unknown>)[] }>,
  mountainIdOverride?: number,
): RouteEntry {
  const primary = choosePrimaryCandidate(row);
  const candidates = row.candidates.map((c) => classifyCandidate(c, attemptEligibility(row, c)));
  const mountainId = mountainIdOverride ?? parseMountainId(row.mountainId);
  if (!primary || !candidates.some((c) => c.candidateId === primary.id)) {
    return {
      mountainId,
      name: row.name,
      state: CANDIDATE_STATE.REJECTED,
      resultHash: null,
      graphStatus: row.graphStatus,
      status: row.status,
      starters: candidates,
      warnings: [],
      gateFailures: ['NO_PRIMARY_BASE_ACCESS'],
    };
  }
  const result = candidates.find((c) => c.candidateId === primary.id)!;
  return {
    mountainId,
    name: row.name,
    state: result.state,
    resultHash: null,
    graphStatus: row.graphStatus,
    status: row.status,
    starters: candidates,
    warnings: result.warnings,
    gateFailures: result.gateFailures,
  };
}

function attemptEligibility(
  row: Readonly<{ status: string; graphStatus: string; name: string; determinismVerified: boolean | null; reasons?: readonly string[] }>,
  c: Readonly<FrozenCandidateLike> & Record<string, unknown>,
): boolean {
  if (!row.determinismVerified || !c.autoEligible || c.safety !== 'SAFE') return false;
  return candidateEligible(row as never, c as never);
}

// ---------------------------------------------------------------------------
// Reviewed checkpoint (final-review.json) classification
// ---------------------------------------------------------------------------

/** Map a Base Access V2 product-review reason to the Route Factory warning vocabulary. */
export function finalReviewWarnings(reviewReasons: readonly string[]): ReviewWarning[] {
  const warnings: ReviewWarning[] = [];
  for (const reason of reviewReasons) {
    if (reason === 'DIFFERENT_ASCENT_VARIANT_REVIEW') warnings.push('DIFFERENT_UPPER_APPROACH');
    else if (reason === 'SUBSTANTIALLY_LONGER_APPROACH_REVIEW') warnings.push('DETOUR_RATIO_HIGH');
    else if (reason === 'REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW') warnings.push('SERVICE_TRACK_DEPENDENCE');
    else warnings.push('PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED');
  }
  return warnings;
}

export interface ReviewedCheckpointRow {
  mountainId: number;
  summitName: string;
  productStatus: string;
  reviewReasons: readonly string[];
  resultHash: string;
  deterministicReplayVerified: boolean;
  fabricatedGapCount: number;
  new: {
    candidateId: string;
    candidateKind: string;
    startRole: string | null;
    generatorAutoEligible: boolean;
    safety: string;
    distanceMeters: number;
    accessEvidence: unknown;
    summitAttachment: unknown;
  };
}

/**
 * Classify a final-review checkpoint row. The reviewed candidate already passed
 * the exact publication gate (its reviewResultHash binds that proof), so the
 * factory re-derives the gate from the checkpoint for the re-checkable subset:
 * PRIMARY_BASE_ACCESS role, auto-eligible, SAFE, non-hut kind, deterministic
 * replay with zero fabricated gaps, plus a present result hash. If any of those
 * invariants fails the mountain is REJECTED; otherwise its state is determined
 * solely by the product-review reasons (AUTO_APPROVED only when zero warnings).
 */
export function classifyReviewedRow(row: ReviewedCheckpointRow): RouteEntry {
  const c = row.new;
  const gateFailures: string[] = [];
  if (c.startRole !== 'PRIMARY_BASE_ACCESS') gateFailures.push('NO_PRIMARY_BASE_ACCESS');
  if (!c.generatorAutoEligible) gateFailures.push('NOT_AUTO_ELIGIBLE');
  if (c.safety !== 'SAFE') gateFailures.push('NOT_SAFE');
  if (/HUT|REFUGE/.test(c.candidateKind)) gateFailures.push('HUT_OR_REFUGE_START_REJECTED');
  if (!row.deterministicReplayVerified) gateFailures.push('DETERMINISM_NOT_PROVEN');
  if (row.fabricatedGapCount !== 0) gateFailures.push('FABRICATED_GAP');
  if (!/^[a-f0-9]{64}$/.test(row.resultHash)) gateFailures.push('MISSING_RESULT_HASH');
  const warnings = gateFailures.length ? [] : finalReviewWarnings(row.reviewReasons);
  const state: CandidateState = gateFailures.length
    ? CANDIDATE_STATE.REJECTED
    : warnings.length
      ? CANDIDATE_STATE.NEEDS_REVIEW
      : CANDIDATE_STATE.AUTO_APPROVED;
  return {
    mountainId: row.mountainId,
    name: row.summitName,
    state,
    resultHash: row.resultHash,
    graphStatus: 'READY',
    status: 'STARTS_FOUND',
    starters: [
      {
        candidateId: c.candidateId,
        state,
        warnings,
        gateFailures,
        distanceKm: c.distanceMeters ? c.distanceMeters / 1000 : null,
        primaryBaseAccess: c.startRole === 'PRIMARY_BASE_ACCESS',
        routeAvailable: c.distanceMeters > 0,
        reasons: row.reviewReasons,
      },
    ],
    warnings,
    gateFailures,
  };
}

/** Extract the trailing numeric OSM identity (summit node id) from `osm:node:123`. */
export function parseMountainId(identity: string): number {
  const match = /(?:^|:)(\d+)$/.exec(identity);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// Checkpoint / resume
// ---------------------------------------------------------------------------

export interface RunCheckpoint {
  schemaVersion: 'mountain-tracker/route-factory/checkpoint/v1';
  fingerprint: string;
  lastIndex: number;
  counts: Record<CandidateState, number>;
  updatedAt: string;
}

export interface FactorySourceMeta {
  datasetKey: string;
  region: string;
  snapshotTimestamp: string;
  pbfSha256: string;
  policyHash: string;
  mountains: readonly string[];
}

/** Deterministic fingerprint binding the checkpoint to dataset + policy + algorithm. */
export function checkpointFingerprint(source: FactorySourceMeta): string {
  return sha256Stable({
    datasetKey: source.datasetKey,
    region: source.region,
    pbfSha256: source.pbfSha256,
    policyHash: source.policyHash,
    algorithmVersion: ROUTE_FACTORY_ALGORITHM_VERSION,
    mountainSelection: source.mountains,
  });
}

export async function loadRunCheckpoint(runDir: string, fingerprint: string): Promise<RunCheckpoint | null> {
  try {
    const raw = await readFile(join(runDir, 'checkpoint.json'), 'utf8');
    const cp = JSON.parse(raw) as RunCheckpoint;
    return cp.fingerprint === fingerprint ? cp : null;
  } catch {
    return null;
  }
}

export async function saveRunCheckpoint(runDir: string, cp: RunCheckpoint): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'checkpoint.json'), `${JSON.stringify(cp, null, 2)}\n`, 'utf8');
}

export function runIdFor(fingerprint: string): string {
  return `rf-${fingerprint.slice(0, 12)}`;
}

export const RUN_DIR = 'data/routes/runs';

export function emptyCounts(): Record<CandidateState, number> {
  return { AUTO_APPROVED: 0, NEEDS_REVIEW: 0, REJECTED: 0, FAILED: 0 };
}

// ---------------------------------------------------------------------------
// Run manifest
// ---------------------------------------------------------------------------

export function buildRunManifest(input: {
  runId: string;
  startedAt: string;
  limit: number;
  source: FactorySourceMeta;
  counts: Record<CandidateState, number>;
  total: number;
  processed: number;
}): RunManifest {
  const content = {
    schemaVersion: 'mountain-tracker/route-factory/v1' as const,
    runId: input.runId,
    parameters: {
      limit: input.limit,
      datasetKey: input.source.datasetKey,
      region: input.source.region,
      algorithmVersion: ROUTE_FACTORY_ALGORITHM_VERSION,
      baseAccessPolicyVersion: BASE_ACCESS_POLICY_VERSION,
    },
    inputFingerprint: checkpointFingerprint(input.source),
    mountainSelection: input.source.mountains.map(parseMountainId),
    policyVersions: {
      algorithm: ROUTE_FACTORY_ALGORITHM_VERSION,
      baseAccess: BASE_ACCESS_POLICY_VERSION,
    },
    summary: {
      total: input.total,
      processed: input.processed,
      autoApproved: input.counts.AUTO_APPROVED,
      needsReview: input.counts.NEEDS_REVIEW,
      rejected: input.counts.REJECTED,
      failed: input.counts.FAILED,
    },
  };
  return { ...content, startedAt: input.startedAt, manifestHash: sha256Stable(content) };
}

// ---------------------------------------------------------------------------
// Publication preparation
// ---------------------------------------------------------------------------

/** Production distance normalization: 2 decimal places. */
export function normalizeProductionDistanceKm(distanceM: number): number {
  return Math.round((distanceM / 1000) * 100) / 100;
}

/** Deterministically validate a candidate publication seed before lock. */
export function validateSeed(seed: readonly PublicationEntry[]): { errors: string[]; manifestHash: string } {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const e of seed) {
    if (seen.has(e.mountainId)) errors.push(`DUP_MOUNTAIN:${e.mountainId}`);
    seen.add(e.mountainId);
    if (!/^[a-f0-9]{64}$/.test(e.publicationId)) errors.push(`BAD_PUBLICATION_ID:${e.mountainId}`);
    if (!/^[a-f0-9]{64}$/.test(e.requestHash)) errors.push(`BAD_REQUEST_HASH:${e.mountainId}`);
    if (!/^[a-f0-9]{64}$/.test(e.gpxSha256)) errors.push(`BAD_GPX_SHA256:${e.mountainId}`);
    if (!/^[a-f0-9]{64}$/.test(e.geojsonSha256)) errors.push(`BAD_GEOJSON_SHA256:${e.mountainId}`);
    if (!(e.gpxBytes > 0)) errors.push(`BAD_GPX_BYTES:${e.mountainId}`);
    if (!(e.geojsonBytes > 0)) errors.push(`BAD_GEOJSON_BYTES:${e.mountainId}`);
    if (!(e.distanceKm > 0)) errors.push(`BAD_DISTANCE:${e.mountainId}`);
    if (!/^generated\/[a-f0-9]{64}\/route\.geojson$/.test(e.storagePath)) errors.push(`BAD_STORAGE_PATH:${e.mountainId}`);
  }
  return { errors, manifestHash: sha256Stable(seed) };
}

/** Locked publication manifest shape shared by `prepare-publication` and tests. */
export interface LockedPublicationManifest {
  schemaVersion: 'mountain-tracker/route-factory/publication/v1';
  runId: string;
  lockedAt: string;
  manifestHash: string;
  entries: readonly PublicationEntry[];
  exclusions: readonly { mountainId: number; reason: string }[];
}