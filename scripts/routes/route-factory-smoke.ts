/**
 * Route Factory deterministic multi-batch smoke over the frozen 100-mountain pilot.
 *
 * Drives the real pipeline primitives (checkpointFingerprint / runIdFor /
 * saveRunCheckpoint / loadRunCheckpoint / buildRunManifest / RUN_DIR) over every
 * frozen pilot row using the front-seat classifier classifyMountain, split into
 * several --limit-style batches that resume from the on-disk checkpoint between
 * invocations, then proves determinism by re-deriving the single-pass result.
 *
 * Expected outcome is the honest fail-closed classification of the integrity-only
 * frozen pilot: the frozen discovery rows predate Base Access V2 evidence
 * (startRole/accessEvidence), so every mountain is REJECTED with
 * NO_PRIMARY_BASE_ACCESS. This is NOT a classifier defect and is deliberately left
 * unchanged; the smoke verifies pipeline mechanics and determinism, not new
 * approvals. See scripts/routes/README.md and PHASE_12_PLAN.md.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RUN_DIR,
  buildRunManifest,
  checkpointFingerprint,
  classifyMountain,
  emptyCounts,
  loadFrozenSource,
  loadRunCheckpoint,
  runIdFor,
  saveRunCheckpoint,
  type FactoryFrozenSource,
  type FactorySourceMeta,
} from './route-factory.ts';
import { summarizeStates } from './cli.ts';
import { CANDIDATE_STATE, type RouteEntry } from './types.ts';

const CHECKPOINT_SCHEMA = 'mountain-tracker/route-factory/checkpoint/v1' as const;
const BATCH_LIMITS = [40, 75, 100];

function stateFolder(state: RouteEntry['state']): string {
  switch (state) {
    case CANDIDATE_STATE.AUTO_APPROVED: return 'approved';
    case CANDIDATE_STATE.NEEDS_REVIEW: return 'needs-review';
    case CANDIDATE_STATE.REJECTED: return 'rejected';
    case CANDIDATE_STATE.FAILED: return 'failed';
  }
}

/** One generate-style invocation capped at `limit`, resuming from the on-disk checkpoint. */
async function runInvocation(
  frozen: FactoryFrozenSource,
  source: FactorySourceMeta,
  limit: number,
): Promise<{ runDir: string; fingerprint: string; completed: boolean; processed: number; counts: ReturnType<typeof emptyCounts> }> {
  const fingerprint = checkpointFingerprint(source);
  const runId = runIdFor(fingerprint);
  const runDir = join(RUN_DIR, runId);
  const existing = await loadRunCheckpoint(runDir, fingerprint);
  const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  const startedAt = manifestRaw ? (JSON.parse(manifestRaw) as { startedAt: string }).startedAt : new Date().toISOString();
  const processLimit = Math.min(frozen.rows.length, limit);
  if (existing && existing.lastIndex >= processLimit) {
    return { runDir, fingerprint, completed: existing.lastIndex >= frozen.rows.length, processed: existing.lastIndex, counts: existing.counts };
  }
  const counts = existing ? { ...existing.counts } : emptyCounts();
  const entries: RouteEntry[] = [];
  let processed = existing?.lastIndex ?? 0;
  for (let i = processed; i < processLimit; i++) {
    const entry = classifyMountain(frozen.rows[i] as never);
    counts[entry.state]++;
    entries.push(entry);
    processed = i + 1;
    await saveRunCheckpoint(runDir, { schemaVersion: CHECKPOINT_SCHEMA, fingerprint, lastIndex: processed, counts, updatedAt: new Date().toISOString() });
  }
  const manifest = buildRunManifest({ runId, startedAt, limit: processLimit, source, counts, total: frozen.rows.length, processed });
  const existingEntriesRaw = await readFile(join(runDir, 'summary.json'), 'utf8').catch(() => null);
  const existingEntries = existingEntriesRaw ? (JSON.parse(existingEntriesRaw) as { entries: RouteEntry[] }).entries : [];
  const allEntries = [...existingEntries, ...entries];
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, 'candidates'), { recursive: true });
  await mkdir(join(runDir, 'approved'), { recursive: true });
  await mkdir(join(runDir, 'needs-review'), { recursive: true });
  await mkdir(join(runDir, 'rejected'), { recursive: true });
  await mkdir(join(runDir, 'failed'), { recursive: true });
  await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(runDir, 'summary.json'), `${JSON.stringify({ runId, entries: allEntries }, null, 2)}\n`, 'utf8');
  for (const e of entries) {
    await writeFile(join(runDir, 'candidates', `${e.mountainId}.json`), `${JSON.stringify(e, null, 2)}\n`, 'utf8');
    await writeFile(join(runDir, stateFolder(e.state), `${e.mountainId}.json`), `${JSON.stringify(e, null, 2)}\n`, 'utf8');
  }
  return { runDir, fingerprint, completed: processed >= frozen.rows.length, processed, counts };
}

async function main(): Promise<void> {
  const frozen = await loadFrozenSource();
  assert.equal(frozen.checkpoint.mountains, 100);
  assert.equal(frozen.checkpoint.autoEligible, 238);
  assert.equal(frozen.checkpoint.mountainsWithAuto, 39);

  const source: FactorySourceMeta = {
    datasetKey: frozen.corpus.dataset.datasetKey,
    region: frozen.corpus.dataset.region,
    snapshotTimestamp: frozen.corpus.dataset.snapshotTimestamp,
    pbfSha256: frozen.corpus.dataset.pbfSha256,
    policyHash: frozen.adaptivePolicyHashes.frozen,
    mountains: frozen.rows.map((r) => r.mountainId),
  };

  const fingerprint = checkpointFingerprint(source);
  const runId = runIdFor(fingerprint);

  const stages: Array<{ limit: number; processed: number; completed: boolean }> = [];
  let runDir = '';
  for (const limit of BATCH_LIMITS) {
    const r = await runInvocation(frozen, source, limit);
    runDir = r.runDir;
    stages.push({ limit, processed: r.processed, completed: r.completed });
    const cp = await loadRunCheckpoint(runDir, fingerprint);
    assert(cp, 'CHECKPOINT_MISSING_AFTER_BATCH');
    assert.equal(cp.lastIndex, r.processed);
    assert.equal(cp.fingerprint, fingerprint);
  }
  const final = stages[BATCH_LIMITS.length - 1];
  assert.equal(final.processed, 100, 'BATCHED_RUN_INCOMPLETE');
  assert.equal(final.completed, true, 'BATCHED_RUN_NOT_COMPLETED');

  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as { manifestHash: string; startedAt: string; summary: Record<string, number> };
  const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8')) as { entries: RouteEntry[] };

  const fresh = frozen.rows.map((r) => classifyMountain(r as never));
  const freshCounts = summarizeStates(fresh);
  assert.deepEqual(freshCounts, { AUTO_APPROVED: 0, NEEDS_REVIEW: 0, REJECTED: 100, FAILED: 0 });
  assert.deepEqual(summarizeStates(summary.entries), freshCounts);
  assert.deepEqual(summary.entries, fresh, 'MULTI_BATCH_ENTRY_DRIFT');

  for (const e of summary.entries) {
    assert.equal(e.state, CANDIDATE_STATE.REJECTED);
    assert.deepEqual(e.gateFailures, ['NO_PRIMARY_BASE_ACCESS']);
    for (const s of e.starters) assert.equal(s.state, CANDIDATE_STATE.REJECTED);
  }

  const rebuilt = buildRunManifest({ runId, startedAt: manifest.startedAt, limit: 100, source, counts: freshCounts, total: frozen.rows.length, processed: 100 });
  assert.equal(rebuilt.manifestHash, manifest.manifestHash, 'MANIFEST_HASH_DRIFT');

  const idempotent = await runInvocation(frozen, source, 100);
  assert.equal(idempotent.processed, 100);
  assert.deepEqual(idempotent.counts, freshCounts);

  const publicationExists = await readFile(join(runDir, 'publication', 'locked-manifest.json'), 'utf8').then(() => true, () => false);
  assert.equal(publicationExists, false, 'UNEXPECTED_PUBLICATION_ARTIFACT');

  process.stdout.write(
    `${JSON.stringify(
      {
        runId,
        fingerprint,
        batches: stages,
        counts: freshCounts,
        determinism: { multiBatchEqualsSinglePass: true, manifestHashStable: true, idempotentResume: true },
        productionWrites: 'NONE',
        publication: 'NOT_PREPARED',
        note: 'Honest fail-closed front-seat classification of the integrity-only frozen pilot (no Base Access V2 evidence in frozen rows). Reviewed path (final-review.json) untouched.',
      },
      null,
      2,
    )}\n`,
  );
}

await main();