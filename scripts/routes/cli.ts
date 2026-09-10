/** Route Factory CLI: offline generation, status, validation, review, and publication preparation. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import {
  RUN_DIR,
  buildRunManifest,
  checkpointFingerprint,
  classifyReviewedRow,
  emptyCounts,
  loadFrozenSource,
  loadRunCheckpoint,
  normalizeProductionDistanceKm,
  runIdFor,
  saveRunCheckpoint,
  validateSeed,
  type FactorySourceMeta,
  type LockedPublicationManifest,
} from './route-factory.ts';
import { CANDIDATE_STATE, REVIEW_DECISION, type CandidateState, type ReviewDecision, type RouteEntry } from './types.ts';
import { generateCurrentV2 } from './current-v2-generation.ts';

export type RootCommand = 'generate' | 'status' | 'validate' | 'review' | 'prepare-publication' | 'publish';

export interface ParsedCommand {
  readonly command: RootCommand;
  readonly options: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

const ROOT_COMMANDS: readonly RootCommand[] = ['generate', 'status', 'validate', 'review', 'prepare-publication', 'publish'];

export function parseArgv(argv: readonly string[]): ParsedCommand | { readonly error: string } {
  if (!argv.length) return { error: 'MISSING_COMMAND' };
  const command = argv[0] as RootCommand;
  if (!(ROOT_COMMANDS as readonly string[]).includes(command)) return { error: `UNKNOWN_COMMAND:${argv[0]}` };
  const options: Record<string, string | number | boolean | string[]> = {};
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) return { error: `UNKNOWN_ARGUMENT:${arg}` };
    if (arg === '--execute') {
      if (!allowedOptions(command).includes('execute')) return { error: `UNKNOWN_OPTION:--execute` };
      options.execute = true;
      continue;
    }
    const name = arg.slice(2);
    if (!allowedOptions(command).includes(name)) return { error: `UNKNOWN_OPTION:--${name}` };
    const next = rest[i + 1];
    if (typeof next !== 'string' || next.startsWith('--')) return { error: `MISSING_VALUE:--${name}` };
    options[name] = name === 'limit' ? Number(next) : next;
    i++;
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || Number(options.limit) <= 0)) return { error: 'LIMIT_MUST_BE_POSITIVE_INTEGER' };
  if (options.run !== undefined && String(options.run).trim() === '') return { error: 'RUN_REQUIRED' };
  return { command, options };
}

function allowedOptions(command: RootCommand): readonly string[] {
  switch (command) {
    case 'generate': return ['limit', 'mountains', 'source', 'region', 'selection'];
    case 'status': return ['run'];
    case 'validate': return ['run'];
    case 'review': return ['run', 'decide'];
    case 'prepare-publication': return ['run', 'out'];
    case 'publish': return ['manifest-sha256', 'execute'];
  }
}

export function summarizeStates(entries: readonly RouteEntry[]): Record<CandidateState, number> {
  const counts = emptyCounts();
  for (const e of entries) counts[e.state]++;
  return counts;
}

export interface FrozenRowLike {
  mountainId: string;
  name: string;
  stratum?: string;
  status: string;
  graphStatus: string;
  determinismVerified: boolean | null;
  reasons?: readonly string[];
  candidates: readonly import('../../Lib/gpxIngestion/generatedRoutePublication.ts').FrozenCandidate[];
}

function readSelection(value: unknown): Set<number> | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return new Set(value.split(',').filter(Boolean).map(Number));
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

interface ReviewedCheckpoint {
  version: string;
  policy: { version: string };
  sourceCheckpointSha256: string;
  protectedArtifactHashes: Record<string, string>;
  rows: readonly import('./route-factory.ts').ReviewedCheckpointRow[];
  ready: number;
  needsReview: number;
}

const FINAL_REVIEW_PATH = 'data/gpx/base-access-start-v2/final-review.json';

export async function generate(options: Readonly<Record<string, string | number | boolean | readonly string[]>>): Promise<string> {
  const sourceMode = typeof options.source === 'string' ? options.source : 'reviewed';
  if (sourceMode === 'current-v2' || sourceMode === 'v2-fresh') {
    return generateCurrentV2({
      limit: typeof options.limit === 'number' && options.limit > 0 ? options.limit : undefined,
      mountains: readSelection(options.mountains),
      region: typeof options.region === 'string' ? options.region : 'alps',
      selection: typeof options.selection === 'string' ? Number(options.selection) : undefined,
    });
  }
  if (sourceMode !== 'reviewed') return JSON.stringify({ error: `UNKNOWN_SOURCE:${sourceMode}` });
  const frozen = await loadFrozenSource();
  const checkpoint = JSON.parse(await readFile(FINAL_REVIEW_PATH, 'utf8')) as ReviewedCheckpoint;
  assert(checkpoint.version === 'mountain-tracker/base-access-canary-product-review/v1', 'FINAL_REVIEW_VERSION_DRIFT');
  assert(/^[a-f0-9]{64}$/.test(checkpoint.sourceCheckpointSha256), 'FINAL_REVIEW_UNPROVEN');
  assert(checkpoint.rows.length > 0, 'FINAL_REVIEW_EMPTY');
  const selection = readSelection(options.mountains);
  const selected = checkpoint.rows.filter((row) => selection === undefined || selection.has(row.mountainId));
  assert(selected.length > 0, 'EMPTY_MOUNTAIN_SELECTION');
  const processLimit = Math.min(selected.length, Number(options.limit ?? selected.length));
  const source: FactorySourceMeta = {
    datasetKey: frozen.corpus.dataset.datasetKey,
    region: frozen.corpus.dataset.region,
    snapshotTimestamp: frozen.corpus.dataset.snapshotTimestamp,
    pbfSha256: frozen.corpus.dataset.pbfSha256,
    policyHash: sha256Stable(checkpoint.policy),
    mountains: selected.map((r) => String(r.mountainId)),
  };
  const fingerprint = checkpointFingerprint(source);
  const runId = runIdFor(fingerprint);
  const runDir = join(RUN_DIR, runId);
  const existing = await loadRunCheckpoint(runDir, fingerprint);
  const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  const startedAt = manifestRaw ? (JSON.parse(manifestRaw) as { startedAt: string }).startedAt : new Date().toISOString();
  if (existing && existing.lastIndex >= processLimit) {
    return JSON.stringify({ runId, fingerprint, resumed: existing.lastIndex > 0, completed: existing.lastIndex >= selected.length, processed: existing.lastIndex, counts: existing.counts, manifestHash: manifestRaw ? (JSON.parse(manifestRaw) as { manifestHash: string }).manifestHash : null }, null, 2);
  }
  const counts = existing ? { ...existing.counts } : emptyCounts();

  const entries: RouteEntry[] = [];
  let processed = existing?.lastIndex ?? 0;
  for (let i = processed; i < processLimit; i++) {
    const entry = classifyReviewedRow(selected[i]);
    counts[entry.state]++;
    entries.push(entry);
    processed = i + 1;
    await saveRunCheckpoint(runDir, { schemaVersion: 'mountain-tracker/route-factory/checkpoint/v1', fingerprint, lastIndex: processed, counts, updatedAt: new Date().toISOString() });
  }

  const manifest = buildRunManifest({ runId, startedAt, limit: processLimit, source, counts, total: selected.length, processed });
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
  return JSON.stringify({ runId, fingerprint, processed, counts, manifestHash: manifest.manifestHash }, null, 2);
}

function stateFolder(state: CandidateState): string {
  switch (state) {
    case CANDIDATE_STATE.AUTO_APPROVED: return 'approved';
    case CANDIDATE_STATE.NEEDS_REVIEW: return 'needs-review';
    case CANDIDATE_STATE.REJECTED: return 'rejected';
    case CANDIDATE_STATE.FAILED: return 'failed';
  }
}

// ---------------------------------------------------------------------------
// status / validate
// ---------------------------------------------------------------------------

export async function status(runId: string): Promise<string> {
  const runDir = join(RUN_DIR, runId);
  const raw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  if (!raw) return JSON.stringify({ error: 'RUN_NOT_FOUND' });
  const manifest = JSON.parse(raw) as { summary: { total: number; processed: number; autoApproved: number; needsReview: number; rejected: number; failed: number }; inputFingerprint: string };
  const checkpoint = await loadRunCheckpoint(runDir, manifest.inputFingerprint);
  return JSON.stringify({
    total: manifest.summary.total,
    processed: manifest.summary.processed,
    remaining: manifest.summary.total - manifest.summary.processed,
    AUTO_APPROVED: manifest.summary.autoApproved,
    NEEDS_REVIEW: manifest.summary.needsReview,
    REJECTED: manifest.summary.rejected,
    FAILED: manifest.summary.failed,
    checkpoint: checkpoint ? { lastIndex: checkpoint.lastIndex, state: 'VALID' } : { state: 'STALE_OR_MISSING' },
  }, null, 2);
}

export async function validate(runId: string): Promise<string> {
  const runDir = join(RUN_DIR, runId);
  const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null);
  const summaryRaw = await readFile(join(runDir, 'summary.json'), 'utf8').catch(() => null);
  if (!manifestRaw || !summaryRaw) return JSON.stringify({ valid: false, errors: ['RUN_ARTIFACTS_MISSING'] });
  const manifest = JSON.parse(manifestRaw) as {
    manifestHash: string;
    inputFingerprint: string;
    summary: { total: number; processed: number; autoApproved: number; needsReview: number; rejected: number; failed: number };
  };
  const summary = JSON.parse(summaryRaw) as { entries: RouteEntry[] };
  const recomputedContent = { ...manifest } as Record<string, unknown>;
  delete recomputedContent.manifestHash;
  delete recomputedContent.startedAt;
  const digest = sha256Stable(recomputedContent);
  const counts = summarizeStates(summary.entries);
  const errors: string[] = [];
  if (digest !== manifest.manifestHash) errors.push('MANIFEST_HASH_DRIFT');
  if (counts.AUTO_APPROVED !== manifest.summary.autoApproved) errors.push('AUTO_APPROVED_COUNT_DRIFT');
  if (counts.NEEDS_REVIEW !== manifest.summary.needsReview) errors.push('NEEDS_REVIEW_COUNT_DRIFT');
  if (counts.REJECTED !== manifest.summary.rejected) errors.push('REJECTED_COUNT_DRIFT');
  if (counts.FAILED !== manifest.summary.failed) errors.push('FAILED_COUNT_DRIFT');
  const checkpoint = await loadRunCheckpoint(runDir, manifest.inputFingerprint);
  if (checkpoint === null) errors.push('STALE_OR_MISSING_CHECKPOINT');
  return JSON.stringify({ valid: errors.length === 0, errors, counts }, null, 2);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export async function review(options: Readonly<Record<string, string | number | boolean | readonly string[]>>): Promise<string> {
  const runId = String(options.run ?? '');
  const summaryJson = await readFile(join(RUN_DIR, runId, 'summary.json'), 'utf8').catch(() => null);
  if (!summaryJson) return JSON.stringify({ error: 'RUN_NOT_FOUND' });
  const summary = JSON.parse(summaryJson) as { entries: RouteEntry[] };
  const needsReview = summary.entries.filter((e) => e.state === CANDIDATE_STATE.NEEDS_REVIEW);
  const prep = needsReview.map((e) => ({
    mountainId: e.mountainId,
    name: e.name,
    warnings: e.warnings,
    candidateIds: e.starters.map((s) => s.candidateId),
  }));
  const decisions: Array<{ mountainId: number; decision: ReviewDecision; reviewer: string; note?: string }> = [];
  const decide = options.decide;
  if (typeof decide === 'string') {
    const [mnt, decision, ...noteParts] = decide.split(':');
    const mountainId = Number(mnt);
    if (!(Object.values(REVIEW_DECISION) as string[]).includes(decision)) return JSON.stringify({ error: `BAD_DECISION:${decision}` });
    decisions.push({ mountainId, decision: decision as ReviewDecision, reviewer: 'cli', note: noteParts.join(':') || undefined });
  }
  await mkdir(join(RUN_DIR, runId, 'review'), { recursive: true });
  await writeFile(join(RUN_DIR, runId, 'review', 'review-prep.json'), `${JSON.stringify({ runId, needsReview: prep, pending: needsReview.length }, null, 2)}\n`, 'utf8');
  if (decisions.length) {
    await writeFile(join(RUN_DIR, runId, 'review', 'decisions.json'), `${JSON.stringify({ runId, decisions }, null, 2)}\n`, 'utf8');
  }
  return JSON.stringify({ runId, pendingReview: needsReview.length, reviewPrep: `data/routes/runs/${runId}/review/review-prep.json`, decisions }, null, 2);
}

// ---------------------------------------------------------------------------
// prepare-publication
// ---------------------------------------------------------------------------

export interface PublicationSeed {
  mountainId: number;
  publicationId: string;
  requestHash: string;
  storagePath: string;
  gpxSha256: string;
  geojsonSha256: string;
  gpxBytes: number;
  geojsonBytes: number;
  distanceKm: number;
}

export async function preparePublication(options: Readonly<Record<string, string | number | boolean | readonly string[]>>): Promise<string> {
  const runId = String(options.run ?? '');
  const summaryJson = await readFile(join(RUN_DIR, runId, 'summary.json'), 'utf8').catch(() => null);
  if (!summaryJson) return JSON.stringify({ error: 'RUN_NOT_FOUND' });
  const summary = JSON.parse(summaryJson) as { entries: RouteEntry[] };
  const humanApproved = await loadHumanApprovals(runId);
  const included = summary.entries.filter((e) => e.state === CANDIDATE_STATE.AUTO_APPROVED || humanApproved.has(e.mountainId));
  const excluded: Array<{ mountainId: number; reason: string }> = [];
  const entries: PublicationSeed[] = [];
  for (const e of summary.entries) {
    if (!included.includes(e)) { excluded.push({ mountainId: e.mountainId, reason: `STATE_${e.state}` }); continue; }
    const seeded = await seedForMountain(runId, e.mountainId);
    if (!seeded) { excluded.push({ mountainId: e.mountainId, reason: 'UNSOURCED_ARTIFACTS' }); continue; }
    entries.push(seeded);
  }
  const { errors, manifestHash } = validateSeed(entries);
  if (errors.length) return JSON.stringify({ error: 'INVALID_SEED', errors });
  const locked: LockedPublicationManifest = {
    schemaVersion: 'mountain-tracker/route-factory/publication/v1',
    runId,
    lockedAt: new Date().toISOString(),
    manifestHash,
    entries,
    exclusions: excluded,
  };
  const outPath = typeof options.out === 'string' ? options.out : join(RUN_DIR, runId, 'publication', 'locked-manifest.json');
  await mkdir(join(RUN_DIR, runId, 'publication'), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(locked, null, 2)}\n`, 'utf8');
  await writeFile(`${outPath}.sha256`, `${manifestHash}\n`, 'utf8');
  return JSON.stringify({ runId, manifestHash, entries: entries.length, exclusions: excluded.length, out: outPath }, null, 2);
}

async function loadHumanApprovals(runId: string): Promise<Set<number>> {
  const raw = await readFile(join(RUN_DIR, runId, 'review', 'decisions.json'), 'utf8').catch(() => null);
  const approvals = new Set<number>();
  if (!raw) return approvals;
  const parsed = JSON.parse(raw) as { decisions: Array<{ mountainId: number; decision: string }> };
  for (const d of parsed.decisions) if (d.decision === 'APPROVE') approvals.add(d.mountainId);
  return approvals;
}

/** Deterministic source of publication seeds from the locally reviewed replacement manifest. */
export async function seedForMountain(runId: string, mountainId: number): Promise<PublicationSeed | null> {
  let manifestRaw: string;
  try {
    manifestRaw = await readFile('data/gpx/base-access-v2-replacement/replacement-manifest.json', 'utf8');
  } catch {
    return null;
  }
  const manifest = JSON.parse(manifestRaw) as {
    entries: Array<{
      request: {
        mountainId: number;
        newPublicationRequestHash?: string;
        newPublication?: { publicationId?: string; mountainRoute?: { distance_km?: number; source_url?: string } };
      };
      files: { gpx: { sha256: string; bytes: number }; geojson: { sha256: string; bytes: number } };
    }>;
  };
  const entry = manifest.entries.find((x) => Number(x.request.mountainId) === mountainId);
  if (!entry) return null;
  const publicationId = entry.request.newPublication?.publicationId;
  if (!publicationId) return null;
  const distanceKm = entry.request.newPublication?.mountainRoute?.distance_km;
  void runId;
  return {
    mountainId,
    publicationId,
    requestHash: entry.request.newPublicationRequestHash ?? '',
    storagePath: `generated/${publicationId}/route.geojson`,
    gpxSha256: entry.files.gpx.sha256,
    geojsonSha256: entry.files.geojson.sha256,
    gpxBytes: entry.files.gpx.bytes,
    geojsonBytes: entry.files.geojson.bytes,
    distanceKm: normalizeProductionDistanceKm(distanceKm ? distanceKm * 1000 : 0),
  };
}

// ---------------------------------------------------------------------------
// publish (future production path; this task only plans, never writes)
// ---------------------------------------------------------------------------

export async function publish(options: Readonly<Record<string, string | number | boolean | readonly string[]>>): Promise<string> {
  const hash = typeof options['manifest-sha256'] === 'string' ? options['manifest-sha256'] : '';
  if (options.execute !== true) {
    return JSON.stringify({
      mode: 'DRY_RUN',
      manifestSha256: hash || null,
      note: 'No production write performed. Execute requires --execute plus an exact locked manifest SHA256.',
    });
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) return JSON.stringify({ error: 'REQUIRED_EXACT_MANIFEST_SHA256' });
  return JSON.stringify({
    mode: 'EXECUTE_REQUESTED',
    manifestSha256: hash,
    blocked: true,
    error: 'PUBLISH_EXECUTE_NOT_ENABLED_THIS_TASK',
    note: 'Production publication is out of scope for the Route Factory stage; the gated generate → review → prepare-publication pipeline is the offline source of truth.',
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return parsed.error.startsWith('UNKNOWN') ? 2 : 1;
  }
  let out: string;
  switch (parsed.command) {
    case 'generate': out = await generate(parsed.options); break;
    case 'status': out = await status(String(parsed.options.run ?? '')); break;
    case 'validate': out = await validate(String(parsed.options.run ?? '')); break;
    case 'review': out = await review(parsed.options); break;
    case 'prepare-publication': out = await preparePublication(parsed.options); break;
    case 'publish': out = await publish(parsed.options); break;
  }
  process.stdout.write(`${out}\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/routes/cli.ts')) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}