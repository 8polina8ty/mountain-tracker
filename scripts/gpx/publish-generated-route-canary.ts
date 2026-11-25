/** Going live is a separate gated step. Zero-write by default.
 *
 * Default invocation (or `--dry-run`) runs a GET-only preflight and writes
 * `canary-dry-run.json`. Production changes require
 * `--execute --confirm-manifest <LOCKED_HASH> --confirm-publications <ordered ids>`;
 * every route is then published through generated-publication-execute.ts, the
 * committed rows are verified end to end, and a receipt is written. No secrets
 * are ever written to reports or receipts.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import type { CanaryManifest } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { inspectDeployment, readCredentials, type LiveSnapshot } from './generated-publication-live.ts';
import { OUTPUT } from './generated-publication-frozen.ts';
import {
  buildReceipt, createExecuteDatabase, createExecuteDelivery, createExecuteStorage, createSupabaseClient,
  expectedPublicationConfirmation, finalVerification, parseExecuteArgs, planExecuteBatch, runBatch,
  validateExecuteConfirmations, type ExecuteArgParse, type PlannedPublication,
} from './generated-publication-execute.ts';
import { deploymentBlockers, inspectPublicObjects, LOCKED_MANIFEST_HASH, verifyLocalCanary } from './generated-publication-validation.ts';

const RECEIPT_PATH = `${OUTPUT}/generated-route-canary-v1-execution-receipt.json`;
const CANARY_COUNT = 10;

// Preserve every explicit fail-closed status (uppercase token plus optional :suffix); map unknown
// runtime failures to a stable read-only token while still recording the real reason separately.
const EXPLICIT_STATUS = /^[A-Z][A-Z0-9_]+(:[^\s]{0,200})*$/;
function preflightReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (EXPLICIT_STATUS.test(message)) return message;
  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout|aborted|fetch failed/i.test(message))) return 'LIVE_READ_TIMEOUT_OR_NETWORK_FAILED';
  return 'LOCAL_OR_LIVE_PREFLIGHT_FAILED';
}
function errorDetail(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200) || 'UNKNOWN_ERROR'; }

export async function readLiveAndObjects(manifest: CanaryManifest) {
  const live = await inspectDeployment(manifest.entries.map((entry) => entry.request.provenance.summit.osmId));
  const objects = await inspectPublicObjects(manifest);
  return { live, objects };
}

/** Unchanged conservative preflight: an execute is only "ready" from a clean baseline or an exact idempotent resume. */
export function dryRunBlockers(manifest: CanaryManifest, live: LiveSnapshot, objects: Array<{ publicationId: string; kind: 'gpx' | 'geojson'; status: string; reason?: string }>) {
  const blockers = deploymentBlockers(manifest, live, { allowResume: true });
  for (const object of objects) if (object.status === 'BLOCKED') blockers.push(`${object.reason}:${object.publicationId}:${object.kind}`);
  for (const entry of manifest.entries) {
    const existing = live.publications.find((p) => p.publication_idempotency_key === entry.request.publicationIdempotencyKey);
    if (existing && objects.some((o) => o.publicationId === entry.request.publicationId && o.status !== 'MATCH')) blockers.push(`ACTIVE_PUBLICATION_OBJECT_MISSING:${entry.request.publicationId}`);
    if (!existing && objects.some((o) => o.publicationId === entry.request.publicationId && o.status === 'MATCH')) blockers.push(`STORAGE_OBJECT_COLLISION:${entry.request.publicationId}`);
  }
  return [...new Set(blockers)].sort();
}

/** Execute preflight: allows exact committed idempotent resumes, still fails closed on anything else. */
export function executeBlockers(manifest: CanaryManifest, live: LiveSnapshot, objects: Array<{ publicationId: string; kind: 'gpx' | 'geojson'; status: string; reason?: string }>, planned: PlannedPublication[]) {
  const blockers = deploymentBlockers(manifest, live, { allowResume: true });
  for (const object of objects) if (object.status === 'BLOCKED') blockers.push(`${object.reason}:${object.publicationId}:${object.kind}`);
  for (const item of planned) {
    const id = item.entry.request.publicationId;
    if (item.blockers.length) blockers.push(`PLANNED_ROUTE_BLOCKED:${id}:${item.blockers.join(',')}`);
    for (const kind of ['gpx', 'geojson'] as const) {
      const match = objects.find((o) => o.publicationId === id && o.kind === kind);
      if (item.action === 'CREATE' && match?.status === 'MATCH') blockers.push(`STORAGE_OBJECT_COLLISION:${id}:${kind}`);
      if (item.action === 'RESUME' && (match?.status === 'ABSENT' || match?.status === 'BLOCKED')) blockers.push(`ACTIVE_PUBLICATION_OBJECT_MISSING:${id}:${kind}`);
    }
  }
  return [...new Set(blockers)].sort();
}

export async function dryRun() {
  const manifest = await verifyLocalCanary();
  const { live, objects } = await readLiveAndObjects(manifest);
  const blockers = dryRunBlockers(manifest, live, objects);
  const plan = planExecuteBatch(manifest, live);
  const existingExactPublications = plan.planned.filter((item) => item.action === 'RESUME').length;
  const report = {
    mode: 'DRY_RUN_ONLY', manifestHash: LOCKED_MANIFEST_HASH, CANARY_COUNT,
    DB_WRITES: 0, STORAGE_WRITES: 0, PUBLICATION_WRITES: 0, ACTIVE_CHANGES: 0, EXTERNAL_ROUTE_SOURCE_REQUESTS: 0,
    approvalCount: live.approvalCount, provenanceCount: live.provenanceCount,
    generatedTableAvailable: live.generatedTableAvailable, generatedApprovalTableAvailable: live.generatedApprovalTableAvailable, generatedRpcAvailable: live.generatedRpcAvailable,
    storageAbsent: objects.filter((o) => o.status === 'ABSENT').length, storagePresent: objects.filter((o) => o.status !== 'ABSENT').length,
    existingExactPublications, remainingPublications: CANARY_COUNT - existingExactPublications,
    READY_FOR_EXPLICIT_EXECUTE: blockers.length === 0, blockers: [...new Set(blockers)].sort(),
    liveInspectionComplete: true, executionImplemented: true,
    requiredConfirmations: { manifestHash: LOCKED_MANIFEST_HASH, publicationIds: expectedPublicationConfirmation(manifest) },
    futureExecuteCommand: `node --experimental-strip-types scripts/gpx/publish-generated-route-canary.ts --execute --confirm-manifest ${LOCKED_MANIFEST_HASH} --confirm-publications ${expectedPublicationConfirmation(manifest).join(',')}`,
    live, objects,
    plannedPublications: manifest.entries.map((e) => ({ requestHash: e.requestHash, ...e.request })),
  };
  await writeFile(`${OUTPUT}/canary-dry-run.json`, stableJson(report) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exitCode = 2;
}

export async function executeGated(parsed: ExecuteArgParse) {
  const manifest = await verifyLocalCanary();
  validateExecuteConfirmations(parsed.confirmations!, manifest);
  const { live, objects } = await readLiveAndObjects(manifest);
  const planned = planExecuteBatch(manifest, live);
  const blockers = executeBlockers(manifest, live, objects, planned.planned);
  if (blockers.length) {
    const blocked = { mode: 'EXECUTE_PREFLIGHT_BLOCKED', attemptedAt: new Date().toISOString(), manifestHash: LOCKED_MANIFEST_HASH, CANARY_COUNT,
      DB_WRITES: 0, STORAGE_WRITES: 0, PUBLICATION_WRITES: 0, ACTIVE_CHANGES: 0, EXTERNAL_ROUTE_SOURCE_REQUESTS: 0,
      READY_FOR_EXPLICIT_EXECUTE: false, blockers, liveInspectionComplete: true, executionImplemented: true, live, objects };
    console.error(JSON.stringify(blocked));
    process.exitCode = 2;
    return;
  }
  const credentials = readCredentials();
  const startedAt = new Date().toISOString();
  const client = createSupabaseClient(credentials.origin, credentials.key);
  const run = await runBatch(planned.planned, createExecuteStorage(client, { origin: credentials.origin, key: credentials.key }), createExecuteDatabase(client), createExecuteDelivery());
  const after = await readLiveAndObjects(manifest);
  const final = finalVerification(manifest, live, after.live, after.objects, run);
  const completedAt = new Date().toISOString();
  const receipt = buildReceipt(run, final, startedAt, completedAt);
  await writeFile(RECEIPT_PATH, stableJson(receipt) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  if (run.failedIndex !== null) { console.error(`EXECUTE_PARTIAL:${run.failedIndex + 1}`); process.exitCode = 3; }
  else if (final.status !== 'PASS') { console.error(`FINAL_VERIFICATION_FAILED:${final.errors.join(',')}`); process.exitCode = 3; }
}

export async function main(argv: string[]) {
  const parsed = parseExecuteArgs(argv);
  if (parsed.mode === 'DRY_RUN_ONLY') { await dryRun(); return; }
  await executeGated(parsed);
}

const isEntryPoint = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Never leave a previous successful snapshot looking like the current result.
    const reason = preflightReason(error);
    const failed = { mode: 'DRY_RUN_ONLY', attemptedAt: new Date().toISOString(), manifestHash: LOCKED_MANIFEST_HASH,
      CANARY_COUNT, DB_WRITES: 0, STORAGE_WRITES: 0, PUBLICATION_WRITES: 0, ACTIVE_CHANGES: 0, EXTERNAL_ROUTE_SOURCE_REQUESTS: 0,
      READY_FOR_EXPLICIT_EXECUTE: false, blockers: [reason], errorDetail: errorDetail(error),
      executionImplemented: true, liveInspectionComplete: false, live: null, objects: [] };
    await writeFile(`${OUTPUT}/canary-dry-run.json`, stableJson(failed) + '\n');
    console.error(JSON.stringify(failed));
    process.exitCode = 1;
  }
}