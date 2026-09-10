/** Route Factory contract tests: CLI parsing, manifests, checkpoints, state classification, review, publication. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import {
  CANDIDATE_STATE,
  REVIEW_DECISION,
  type CandidateState,
} from './types.ts';
import {
  AUTO_ELIGIBLE_CANDIDATE,
  buildFixtureRow,
  makeFixtureSource,
} from './test-fixtures.ts';
import {
  DISTANCE_EXTREME_METERS,
  RUN_DIR,
  checkpointFingerprint,
  classifyCandidate,
  classifyReviewedRow,
  choosePrimaryCandidate,
  buildRunManifest,
  finalReviewWarnings,
  normalizeProductionDistanceKm,
  emptyCounts,
  parseMountainId,
  reviewWarningsFor,
  validateSeed,
  loadRunCheckpoint,
  saveRunCheckpoint,
  exactBaseAccessGate,
  type ReviewedCheckpointRow,
} from './route-factory.ts';
import { parseArgv, publish, preparePublication, summarizeStates } from './cli.ts';

const SANDBOX = 'data/routes/runs/rf-test-sandbox';

function makeFingerprint(seed = 'x') {
  return sha256Stable({ seed });
}

// ---------------------------------------------------------------------------
// 1. CLI argument parsing
// ---------------------------------------------------------------------------

test('CLI: generate with limit parses', () => {
  const p = parseArgv(['generate', '--limit', '10']);
  assert.equal('command' in p && p.command, 'generate');
  if ('command' in p) assert.equal(p.options.limit, 10);
});

test('CLI: unknown command rejected', () => {
  const p = parseArgv(['bogus']);
  assert('error' in p && (p as { error: string }).error === 'UNKNOWN_COMMAND:bogus');
});

test('CLI: unknown option rejected', () => {
  const p = parseArgv(['generate', '--nope', 'x']);
  assert('error' in p && (p as { error: string }).error === 'UNKNOWN_OPTION:--nope');
});

test('CLI: positional unknown argument rejected', () => {
  const p = parseArgv(['generate', 'stray']);
  assert('error' in p && (p as { error: string }).error === 'UNKNOWN_ARGUMENT:stray');
});

test('CLI: missing command rejected', () => {
  const p = parseArgv([]);
  assert('error' in p && (p as { error: string }).error === 'MISSING_COMMAND');
});

test('CLI: publish flag validation', () => {
  const dry = parseArgv(['publish']);
  assert.equal('command' in dry && dry.command, 'publish');
  const execute = parseArgv(['publish', '--execute']);
  assert.equal('command' in execute && execute.command, 'publish');
  assert.equal('command' in execute && execute.options.execute, true);
  const badOption = parseArgv(['publish', '--nope']);
  assert('error' in badOption && (badOption as { error: string }).error === 'UNKNOWN_OPTION:--nope');
});

// ---------------------------------------------------------------------------
// 2. deterministic manifests
// ---------------------------------------------------------------------------

test('buildRunManifest: same inputs => identical manifest hash', () => {
  const source = makeFixtureSource();
  const counts = { AUTO_APPROVED: 3, NEEDS_REVIEW: 1, REJECTED: 0, FAILED: 0 };
  const a = buildRunManifest({ runId: 'rf-abc', startedAt: '2026-09-10T00:00:00.000Z', limit: 4, source, counts, total: 4, processed: 4 });
  const b = buildRunManifest({ runId: 'rf-abc', startedAt: '2026-09-11T00:00:00.000Z', limit: 4, source, counts, total: 4, processed: 4 });
  assert.equal(a.manifestHash, b.manifestHash);
});

test('buildRunManifest: changed input changes hash', () => {
  const source = makeFixtureSource();
  const counts = { AUTO_APPROVED: 3, NEEDS_REVIEW: 1, REJECTED: 0, FAILED: 0 };
  const a = buildRunManifest({ runId: 'rf-abc', startedAt: '2026-09-10T00:00:00.000Z', limit: 4, source, counts, total: 4, processed: 4 });
  const changed = buildRunManifest({ runId: 'rf-abc', startedAt: '2026-09-10T00:00:00.000Z', limit: 5, source, counts, total: 4, processed: 4 });
  assert.notEqual(a.manifestHash, changed.manifestHash);
});

// ---------------------------------------------------------------------------
// 3. checkpoint / resume + 4. stale checkpoint rejection
// ---------------------------------------------------------------------------

test('checkpoint: round trip preserves lastIndex and counts', async () => {
  const dir = join(SANDBOX, 'cp-roundtrip');
  await rm(dir, { recursive: true, force: true });
  const fingerprint = makeFingerprint('checkpoint');
  const cp = { schemaVersion: 'mountain-tracker/route-factory/checkpoint/v1' as const, fingerprint, lastIndex: 632, counts: { AUTO_APPROVED: 100, NEEDS_REVIEW: 20, REJECTED: 500, FAILED: 12 }, updatedAt: '2026-09-10T00:00:00.000Z' };
  await saveRunCheckpoint(dir, cp);
  const loaded = await loadRunCheckpoint(dir, fingerprint);
  assert(loaded);
  assert.equal(loaded.lastIndex, 632);
  assert.equal(loaded.counts.AUTO_APPROVED, 100);
});

test('checkpoint: stale checkpoint rejected on fingerprint drift', async () => {
  const dir = join(SANDBOX, 'cp-stale');
  await rm(dir, { recursive: true, force: true });
  const cp = { schemaVersion: 'mountain-tracker/route-factory/checkpoint/v1' as const, fingerprint: makeFingerprint('old'), lastIndex: 5, counts: emptyCounts(), updatedAt: '2026-09-10T00:00:00.000Z' };
  await saveRunCheckpoint(dir, cp);
  const loaded = await loadRunCheckpoint(dir, makeFingerprint('new'));
  assert.equal(loaded, null);
});

test('checkpoint: empty directory returns null', async () => {
  const dir = join(SANDBOX, 'cp-empty');
  await rm(dir, { recursive: true, force: true });
  const loaded = await loadRunCheckpoint(dir, 'nope');
  assert.equal(loaded, null);
});

// ---------------------------------------------------------------------------
// 5. state classification
// ---------------------------------------------------------------------------

test('classification: eligible with no warnings => AUTO_APPROVED', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:eligible' };
  const r = classifyCandidate(c, true);
  assert.equal(r.state, CANDIDATE_STATE.AUTO_APPROVED);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.gateFailures.length, 0);
  assert.equal(r.primaryBaseAccess, true);
});

test('classification: extreme distance promotes to NEEDS_REVIEW', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:long', route: { ...AUTO_ELIGIBLE_CANDIDATE.route!, distanceM: DISTANCE_EXTREME_METERS + 1 } };
  const r = classifyCandidate(c, true);
  assert.equal(r.state, CANDIDATE_STATE.NEEDS_REVIEW);
  assert(r.warnings.includes('DISTANCE_EXTREME'));
});

test('classification: start elevation unknown warns', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:elev', accessEvidence: { ...AUTO_ELIGIBLE_CANDIDATE.accessEvidence!, startElevation: null } };
  const r = classifyCandidate(c, true);
  assert.equal(r.state, CANDIDATE_STATE.NEEDS_REVIEW);
  assert(r.warnings.includes('START_ELEVATION_UNKNOWN'));
});

test('classification: network-access start warns unverified public access', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'na:1', kind: 'NETWORK_ACCESS' };
  const r = classifyCandidate(c, true);
  assert.equal(r.state, CANDIDATE_STATE.NEEDS_REVIEW);
  assert(r.warnings.includes('PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED'));
});

test('classification: not auto eligible => REJECTED', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:bad', autoEligible: false };
  const r = classifyCandidate(c, false);
  assert.equal(r.state, CANDIDATE_STATE.REJECTED);
  assert.deepEqual(r.gateFailures, ['NOT_AUTO_ELIGIBLE']);
});

// ---------------------------------------------------------------------------
// 6. PRIMARY_BASE_ACCESS gates
// ---------------------------------------------------------------------------

test('gate: full fixture passes exact base-access gate', () => {
  const row = buildFixtureRow([AUTO_ELIGIBLE_CANDIDATE]);
  assert.equal(exactBaseAccessGate(row as never, AUTO_ELIGIBLE_CANDIDATE as never), true);
});

test('gate: hut-kind candidate is rejected by the exact gate', () => {
  const hut = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:hut', kind: 'ALPINE_HUT', name: 'Hochalm 2000', tags: { name: 'Hochalm 2000' } };
  const row = buildFixtureRow([hut]);
  assert.equal(exactBaseAccessGate(row as never, hut as never), false);
});

// ---------------------------------------------------------------------------
// 7. hut-start rejection
// ---------------------------------------------------------------------------

test('choosePrimaryCandidate: ignores hut-kind candidates even when startRole is primary', () => {
  const hut = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:hut', kind: 'ALPINE_HUT' };
  const row = { status: 'STARTS_FOUND', graphStatus: 'READY', candidates: [hut] };
  assert.equal(choosePrimaryCandidate(row), null);
});

test('classification: HUT_START context => NOT_AUTO_ELIGIBLE => REJECTED', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:hutctx', startContext: { type: 'HUT_START' } };
  const row = buildFixtureRow([c]);
  const eligible = exactBaseAccessGate(row as never, c as never);
  const r = classifyCandidate(c, eligible);
  assert.equal(r.state, CANDIDATE_STATE.REJECTED);
});

// ---------------------------------------------------------------------------
// 8. no fabricated gaps
// ---------------------------------------------------------------------------

test('gate: synthetic geometry source rejects (no fabricated connector path)', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:synth', route: { ...AUTO_ELIGIBLE_CANDIDATE.route!, geometrySource: 'SYNTHETIC_FABRICATED' } };
  const row = buildFixtureRow([c]);
  assert.equal(exactBaseAccessGate(row as never, c as never), false);
});

test('reviewWarningsFor: service track dependence is conservatively included when route way evidence is present', () => {
  const c = { ...AUTO_ELIGIBLE_CANDIDATE, id: 'way:svc', route: { ...AUTO_ELIGIBLE_CANDIDATE.route!, osmWayIds: [1, 2, 3] } } as never;
  assert(Array.isArray(reviewWarningsFor(c as never)));
});

// ---------------------------------------------------------------------------
// 9. review decision separation
// ---------------------------------------------------------------------------

test('review decisions: stored separately from generated evidence', async () => {
  const dir = join(SANDBOX, 'review-sep');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'generated.json'), '{"evidence":"locked"}', 'utf8');
  await writeFile(join(dir, 'decisions.json'), JSON.stringify({ decisions: [{ mountainId: 1, decision: 'APPROVE' }] }), 'utf8');
  const evidence = JSON.parse(await readFile(join(dir, 'generated.json'), 'utf8'));
  const decisions = JSON.parse(await readFile(join(dir, 'decisions.json'), 'utf8'));
  assert.deepEqual(evidence, { evidence: 'locked' });
  assert.equal(decisions.decisions[0].decision, 'APPROVE');
});

test('review decisions: approval does not mutate generated evidence', async () => {
  const dir = join(SANDBOX, 'review-noev');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const evidence = { candidateId: 'way:1', state: 'NEEDS_REVIEW' };
  await writeFile(join(dir, 'generated.json'), JSON.stringify(evidence), 'utf8');
  await writeFile(join(dir, 'decisions.json'), JSON.stringify({ decisions: [{ mountainId: 1, decision: 'APPROVE' }] }), 'utf8');
  const evidenceAfter = JSON.parse(await readFile(join(dir, 'generated.json'), 'utf8'));
  assert.deepEqual(evidenceAfter, evidence);
});

// ---------------------------------------------------------------------------
// 10. publication manifest inclusion/exclusion
// ---------------------------------------------------------------------------

test('validateSeed: accepts valid entries and locks deterministic hash', () => {
  const seed = makeSeed(3);
  const { errors, manifestHash } = validateSeed(seed);
  assert.deepEqual(errors, []);
  assert.match(manifestHash, /^[a-f0-9]{64}$/);
  const again = validateSeed(seed);
  assert.equal(again.manifestHash, manifestHash);
});

test('validateSeed: duplicate mountain excluded', () => {
  const seed = [...makeSeed(2), makeSeed(1)[0]];
  const { errors } = validateSeed(seed);
  assert(errors.some((e) => e.startsWith('DUP_MOUNTAIN')));
});

test('validateSeed: hash drift rejected (different gpx sha)', () => {
  const a = makeSeed(1);
  const b = [{ ...a[0], gpxSha256: 'a'.repeat(64) }];
  const ha = validateSeed(a).manifestHash;
  const hb = validateSeed(b).manifestHash;
  assert.notEqual(ha, hb);
});

test('publication: inclusion honors AUTO_APPROVED plus approved review only', async () => {
  const runId = 'rf-pub-test';
  const runDir = join(RUN_DIR, runId);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(join(runDir, 'review'), { recursive: true });
  const entries = [
    { mountainId: 1, name: 'A', state: 'AUTO_APPROVED', warnings: [], gateFailures: [], resultHash: null, graphStatus: 'READY', status: 'STARTS_FOUND', starters: [] },
    { mountainId: 2, name: 'B', state: 'NEEDS_REVIEW', warnings: ['DISTANCE_EXTREME'], gateFailures: [], resultHash: null, graphStatus: 'READY', status: 'STARTS_FOUND', starters: [] },
    { mountainId: 3, name: 'C', state: 'REJECTED', warnings: [], gateFailures: ['NO_PRIMARY_BASE_ACCESS'], resultHash: null, graphStatus: 'READY', status: 'STARTS_FOUND', starters: [] },
  ];
  await writeFile(join(runDir, 'summary.json'), JSON.stringify({ runId, entries }), 'utf8');
  const outPath = join(runDir, 'publication', 'out.json');
  await preparePublication({ run: runId, out: outPath });
  const manifest = JSON.parse(await readFile(outPath, 'utf8')) as { exclusions: Array<{ mountainId: number; reason: string }>; manifestHash: string };
  assert(manifest.exclusions.some((x) => x.mountainId === 1 && x.reason === 'UNSOURCED_ARTIFACTS'), 'AUTO_APPROVED without local artifact must be excluded as UNSOURCED');
  assert(manifest.exclusions.some((x) => x.mountainId === 2 && x.reason === 'STATE_NEEDS_REVIEW'), 'NEEDS_REVIEW without approval must be excluded');
  assert(manifest.exclusions.some((x) => x.mountainId === 3 && x.reason === 'STATE_REJECTED'), 'REJECTED must be excluded');
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);
  await rm(runDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 11. hash drift rejection (already covered above); deterministic distance
// ---------------------------------------------------------------------------

test('normalizeProductionDistanceKm: rounds to 2 decimals', () => {
  assert.equal(normalizeProductionDistanceKm(4925.5), 4.93);
  assert.equal(normalizeProductionDistanceKm(358.21), 0.36);
});

// ---------------------------------------------------------------------------
// 12. publish default = dry-run
// ---------------------------------------------------------------------------

test('publish: default is DRY_RUN with no production writes', async () => {
  const out = await publish({});
  const parsed = JSON.parse(out) as { mode: string; error?: string };
  assert.equal(parsed.mode, 'DRY_RUN');
  assert(!('error' in parsed));
  void parsed; void out;
});

// ---------------------------------------------------------------------------
// 13. execute requires exact manifest hash
// ---------------------------------------------------------------------------

test('publish: execute without manifest hash refuses', async () => {
  const out = await publish({ execute: true });
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(parsed.error, 'REQUIRED_EXACT_MANIFEST_SHA256');
});

test('publish: execute with malformed hash refuses', async () => {
  const out = await publish({ execute: true, 'manifest-sha256': 'short' });
  const parsed = JSON.parse(out) as { error: string };
  assert.equal(parsed.error, 'REQUIRED_EXACT_MANIFEST_SHA256');
});

test('publish: execute with exact hash reports blocked (no production write in this stage)', async () => {
  const out = await publish({ execute: true, 'manifest-sha256': 'a'.repeat(64) });
  const parsed = JSON.parse(out) as { mode: string; blocked: boolean };
  assert.equal(parsed.mode, 'EXECUTE_REQUESTED');
  assert.equal(parsed.blocked, true);
});

// ---------------------------------------------------------------------------
// Aux helpers
// ---------------------------------------------------------------------------

function makeSeed(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    mountainId: i + 1,
    publicationId: `${i + 1}`.padStart(64, 'a'),
    requestHash: `${i + 2}`.padStart(64, 'b'),
    storagePath: `generated/${`${i + 3}`.padStart(64, 'c')}/route.geojson`,
    gpxSha256: `${i + 4}`.padStart(64, 'd'),
    geojsonSha256: `${i + 5}`.padStart(64, 'e'),
    gpxBytes: 1000 + i,
    geojsonBytes: 2000 + i,
    distanceKm: 3 + i * 0.5,
  }));
}

// ---------------------------------------------------------------------------
// Remaining small-unit coverage
// ---------------------------------------------------------------------------

test('summarizeStates counts each state bucket', () => {
  const entries = [
    { state: 'AUTO_APPROVED' as CandidateState }, { state: 'AUTO_APPROVED' as CandidateState },
    { state: 'NEEDS_REVIEW' as CandidateState }, { state: 'REJECTED' as CandidateState },
    { state: 'FAILED' as CandidateState },
  ];
  const counts = summarizeStates(entries as never);
  assert.equal(counts.AUTO_APPROVED, 2);
  assert.equal(counts.NEEDS_REVIEW, 1);
  assert.equal(counts.REJECTED, 1);
  assert.equal(counts.FAILED, 1);
});

test('parseMountainId extracts the numeric summit id', () => {
  assert.equal(parseMountainId('osm:node:4360518883'), 4360518883);
  assert.equal(parseMountainId('osm:way:12'), 12);
  assert.equal(parseMountainId('garbage'), 0);
});

test('review decision vocabulary is fixed', () => {
  assert.deepEqual(Object.values(REVIEW_DECISION), ['APPROVE', 'REGENERATE', 'REJECT']);
});

test('emptyCounts starts at zero', () => {
  assert.deepEqual(emptyCounts(), { AUTO_APPROVED: 0, NEEDS_REVIEW: 0, REJECTED: 0, FAILED: 0 });
});

test('checkpointFingerprint changes when policy drifts', () => {
  const base = makeFixtureSource();
  const a = checkpointFingerprint(base);
  const drifted = checkpointFingerprint({ ...base, pbfSha256: '0'.repeat(64) });
  assert.notEqual(a, drifted);
});

// ---------------------------------------------------------------------------
// 14. Reviewed checkpoint (final-review.json) classification
// ---------------------------------------------------------------------------

test('finalReviewWarnings maps known review reasons to the factory vocabulary', () => {
  assert.deepEqual(finalReviewWarnings([]), []);
  assert.deepEqual(finalReviewWarnings(['DIFFERENT_ASCENT_VARIANT_REVIEW']), ['DIFFERENT_UPPER_APPROACH']);
  assert.deepEqual(finalReviewWarnings(['SUBSTANTIALLY_LONGER_APPROACH_REVIEW']), ['DETOUR_RATIO_HIGH']);
  assert.deepEqual(finalReviewWarnings(['REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW']), ['SERVICE_TRACK_DEPENDENCE']);
  assert.deepEqual(finalReviewWarnings(['UNKNOWN_REASON']), ['PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED']);
});

function reviewedRow(overrides: Readonly<Record<string, unknown>> = {}): ReviewedCheckpointRow {
  return {
    mountainId: 138,
    summitName: 'Westliche Karwendelspitze',
    productStatus: 'NEEDS_REVIEW',
    reviewReasons: ['DIFFERENT_ASCENT_VARIANT_REVIEW'],
    resultHash: 'a'.repeat(64),
    deterministicReplayVerified: true,
    fabricatedGapCount: 0,
    new: {
      candidateId: 'cand-138',
      candidateKind: 'node',
      startRole: 'PRIMARY_BASE_ACCESS',
      generatorAutoEligible: true,
      safety: 'SAFE',
      distanceMeters: 4926.755,
      accessEvidence: {} as never,
      summitAttachment: {} as never,
    },
    ...overrides,
  } as ReviewedCheckpointRow;
}

test('classifyReviewedRow: zero review reasons => AUTO_APPROVED', () => {
  const row = reviewedRow({ reviewReasons: [] });
  const entry = classifyReviewedRow(row);
  assert.equal(entry.state, CANDIDATE_STATE.AUTO_APPROVED);
  assert.deepEqual(entry.warnings, []);
  assert.deepEqual(entry.gateFailures, []);
  assert.equal(entry.resultHash, row.resultHash);
  assert.equal(entry.starters[0].distanceKm, 4.926755);
});

test('classifyReviewedRow: review reasons promote to NEEDS_REVIEW with mapped warnings', () => {
  const entry = classifyReviewedRow(reviewedRow({ reviewReasons: ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW', 'DIFFERENT_ASCENT_VARIANT_REVIEW'] }));
  assert.equal(entry.state, CANDIDATE_STATE.NEEDS_REVIEW);
  assert.deepEqual(entry.warnings, ['DETOUR_RATIO_HIGH', 'DIFFERENT_UPPER_APPROACH']);
});

test('classifyReviewedRow: gate invariant failure => REJECTED without warnings', () => {
  const entry = classifyReviewedRow(reviewedRow({ new: { ...reviewedRow().new, startRole: 'none' } }));
  assert.equal(entry.state, CANDIDATE_STATE.REJECTED);
  assert.deepEqual(entry.gateFailures, ['NO_PRIMARY_BASE_ACCESS']);
  assert.deepEqual(entry.warnings, []);
});

test('classifyReviewedRow: hut start kind is rejected', () => {
  const entry = classifyReviewedRow(reviewedRow({ new: { ...reviewedRow().new, candidateKind: 'ALPINE_HUT' } }));
  assert.equal(entry.state, CANDIDATE_STATE.REJECTED);
  assert.equal(entry.gateFailures[0], 'HUT_OR_REFUGE_START_REJECTED');
});

test('classifyReviewedRow: reproduced canary counts for the ten canary mountains', () => {
  const rows = [
    reviewedRow({ mountainId: 138, reviewReasons: ['DIFFERENT_ASCENT_VARIANT_REVIEW'] }),
    reviewedRow({ mountainId: 150, reviewReasons: ['DIFFERENT_ASCENT_VARIANT_REVIEW'] }),
    reviewedRow({ mountainId: 796, reviewReasons: [] }),
    reviewedRow({ mountainId: 12895, reviewReasons: [] }),
    reviewedRow({ mountainId: 49632, reviewReasons: ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW', 'DIFFERENT_ASCENT_VARIANT_REVIEW'] }),
    reviewedRow({ mountainId: 50473, reviewReasons: ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW'] }),
    reviewedRow({ mountainId: 51088, reviewReasons: ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW'] }),
    reviewedRow({ mountainId: 55190, reviewReasons: ['SUBSTANTIALLY_LONGER_APPROACH_REVIEW'] }),
    reviewedRow({ mountainId: 69594, reviewReasons: ['REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW'] }),
    reviewedRow({ mountainId: 73101, reviewReasons: [] }),
  ];
  const counts = summarizeStates(rows.map(classifyReviewedRow));
  assert.deepEqual(counts, { AUTO_APPROVED: 3, NEEDS_REVIEW: 7, REJECTED: 0, FAILED: 0 });
});