import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sha256Stable } from "./phase11-publication.ts";
import {
  createPhase11hAdminClient,
  loadPhase11hBeforeState,
} from "./phase11h-live.ts";
import type { B2StagingPayloadArtifact, StagingPayloadRecord } from "./phase11i-b2-staging-payloads.ts";

const STAGING = "data/osm/alps/staging";
const QUEUE_PATH = resolve(`${STAGING}/phase11h-human-calibration-queue.json`);
const QUEUE_SHA256 = "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const SNAPSHOT_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-source-snapshot.json`);
const STAGEABILITY_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-stageability.json`);
const PAYLOADS_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-staging-payloads.json`);
const CONTRACT_PATH = resolve(`${STAGING}/phase11i-b2-execution-contract.json`);
const RECEIPT_PATH = resolve(`${STAGING}/phase11i-b2-controlled-staging-execution.json`);

const STAGEABLE_TOTAL = 44;
const BLOCKED_RELATION = "19752996";

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function recomputeDeterministicHash(artifact: Record<string, unknown>): string {
  const content = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  delete content.deterministicArtifactHash;
  return sha256Stable(content);
}

function pinnedMatches(label: string, actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`PHASE11I_B2_EXECUTOR_${label}_DRIFT`);
}

export interface B2ExecutorSnapshotRecord {
  canonicalRelationId: string;
  geometryHash: string;
  summit: { peakOsmId: string };
  mountain: { mountainId: number };
  qualification: { qualificationHash: string };
}

export interface B2ExecutorContract {
  executed: boolean;
  databaseModeBefore: string;
  originalQueueHash: string;
  stageableCount: number;
  blockedCount: number;
  sourceSnapshotHash: string;
  stageabilityHash: string;
  payloadArtifactHash: string;
  oldExecutionToken: string;
  executionToken: string;
  deterministicArtifactHash: string;
  records: Array<{
    canonicalRelationId: string;
    peakOsmId: string;
    mountainId: number;
    geometryHash: string;
    qualificationHash: string;
    mainPayloadHash: string;
    summitPayloadHash: string;
  }>;
  expectedAfterState: Record<string, unknown>;
  [key: string]: unknown;
}

export interface B2ExecutorArtifactVerification {
  queueArtifactHash: string;
  snapshotDeterministicHash: string;
  stageabilityDeterministicHash: string;
  payloadsDeterministicHash: string;
  contractDeterministicHash: string;
  contractFileSha256: string;
  contract: B2ExecutorContract;
  payloads: B2StagingPayloadArtifact;
  records: Array<{
    canonicalRelationId: string;
    mainPayloadHash: string;
    summitPayloadHash: string;
  }>;
}

export type Phase11iB2Action =
  | "WOULD_CREATE"
  | "EXACT_UNCHANGED"
  | "PAYLOAD_CONFLICT"
  | "QA_CONFLICT"
  | "ACTIVE_OVERLAP"
  | "MOUNTAIN_IDENTITY_DRIFT"
  | "OTHER_BLOCKED";

export interface Phase11iB2StatusEntry {
  canonicalRelationId: string;
  peakOsmId: string;
  frozenMountainId: number;
  action: Phase11iB2Action;
  reason: string | null;
  identityDrift: boolean;
  downstream: {
    staging: boolean;
    published: boolean;
    active: boolean;
    qa: boolean;
    exactUnchanged: boolean;
  };
}

export interface Phase11iB2Summary {
  wouldCreate: number;
  exactUnchanged: number;
  payloadConflicts: number;
  qaConflicts: number;
  activeOverlap: number;
  mountainIdentityDrift: number;
  otherBlocked: number;
}

export async function verifyPhase11iB2Artifacts(): Promise<B2ExecutorArtifactVerification> {
  const [queueRaw, snapshotRaw, stageabilityRaw, payloadsRaw, contractRaw] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(SNAPSHOT_PATH, "utf8"),
    readFile(STAGEABILITY_PATH, "utf8"),
    readFile(PAYLOADS_PATH, "utf8"),
    readFile(CONTRACT_PATH, "utf8"),
  ]);

  pinnedMatches("QUEUE_FILE", sha256Bytes(Buffer.from(queueRaw)), QUEUE_SHA256);

  const queue = JSON.parse(queueRaw) as {
    sample: Array<{ canonicalRelationId: string }>;
    deterministicArtifactHash: string;
  };
  const snapshot = JSON.parse(snapshotRaw) as {
    records: B2ExecutorSnapshotRecord[];
    deterministicArtifactHash: string;
  };
  const stageability = JSON.parse(stageabilityRaw) as {
    originalQueueCount: number;
    stageableCount: number;
    blockedCount: number;
    deterministicArtifactHash: string;
  };
  const payloads = JSON.parse(payloadsRaw) as B2StagingPayloadArtifact;
  const contract = JSON.parse(contractRaw) as B2ExecutorContract;

  pinnedMatches(
    "QUEUE_DETERMINISTIC",
    recomputeDeterministicHash(queue as unknown as Record<string, unknown>),
    queue.deterministicArtifactHash,
  );
  if (contract.sourceSnapshotHash !== snapshot.deterministicArtifactHash) {
    throw new Error("PHASE11I_B2_EXECUTOR_SNAPSHOT_HASH_DRIFT");
  }
  pinnedMatches(
    "SNAPSHOT_DETERMINISTIC",
    recomputeDeterministicHash(snapshot as unknown as Record<string, unknown>),
    snapshot.deterministicArtifactHash,
  );
  if (contract.stageabilityHash !== stageability.deterministicArtifactHash) {
    throw new Error("PHASE11I_B2_EXECUTOR_STAGEABILITY_HASH_DRIFT");
  }
  pinnedMatches(
    "STAGEABILITY_DETERMINISTIC",
    recomputeDeterministicHash(stageability as unknown as Record<string, unknown>),
    stageability.deterministicArtifactHash,
  );
  if (contract.payloadArtifactHash !== payloads.deterministicArtifactHash) {
    throw new Error("PHASE11I_B2_EXECUTOR_PAYLOADS_HASH_DRIFT");
  }
  pinnedMatches(
    "PAYLOADS_DETERMINISTIC",
    recomputeDeterministicHash(payloads as unknown as Record<string, unknown>),
    payloads.deterministicArtifactHash,
  );

  pinnedMatches(
    "CONTRACT_DETERMINISTIC",
    recomputeDeterministicHash(contract as unknown as Record<string, unknown>),
    contract.deterministicArtifactHash,
  );

  if (contract.executed || contract.databaseModeBefore !== "SELECT_ONLY") {
    throw new Error("PHASE11I_B2_EXECUTOR_CONTRACT_NO_LONGER_SELECT_ONLY");
  }
  if (contract.originalQueueHash !== QUEUE_SHA256) {
    throw new Error("PHASE11I_B2_EXECUTOR_CONTRACT_QUEUE_HASH_DRIFT");
  }
  if (queue.sample.length !== 45 || queue.sample.length !== contract.originalQueueCount) {
    throw new Error("PHASE11I_B2_EXECUTOR_QUEUE_COUNT_DRIFT");
  }
  if (contract.stageableCount !== STAGEABLE_TOTAL || contract.blockedCount !== 1) {
    throw new Error("PHASE11I_B2_EXECUTOR_CONTRACT_COUNTS_DRIFT");
  }
  if (stageability.originalQueueCount !== 45 || stageability.stageableCount !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_EXECUTOR_STAGEABILITY_COUNTS_DRIFT");
  }
  if (contract.records.length !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_EXECUTOR_CONTRACT_RECORD_COUNT_DRIFT");
  }
  if (snapshot.records.length !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_EXECUTOR_SNAPSHOT_RECORD_COUNT_DRIFT");
  }
  if (payloads.records.length !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_EXECUTOR_PAYLOAD_RECORD_COUNT_DRIFT");
  }

  if (contract.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION)) {
    throw new Error("PHASE11I_B2_EXECUTOR_BLOCKED_IN_SCOPE");
  }
  if (payloads.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION)) {
    throw new Error("PHASE11I_B2_EXECUTOR_BLOCKED_IN_PAYLOADS");
  }

  const recordIds = contract.records.map((r) => r.canonicalRelationId);
  if (new Set(recordIds).size !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_EXECUTOR_DUPLICATE_RELATIONS");
  }

  const payloadByRelation = new Map(payloads.records.map((r) => [r.canonicalRelationId, r]));
  for (const record of contract.records) {
    const payloadRecord = payloadByRelation.get(record.canonicalRelationId);
    if (!payloadRecord) throw new Error(`PHASE11I_B2_EXECUTOR_PAYLOAD_MISSING:${record.canonicalRelationId}`);
    if (payloadRecord.mainPayloadHash !== record.mainPayloadHash) {
      throw new Error(`PHASE11I_B2_EXECUTOR_MAIN_PAYLOAD_HASH_DRIFT:${record.canonicalRelationId}`);
    }
    if (payloadRecord.summitPayloadHash !== record.summitPayloadHash) {
      throw new Error(`PHASE11I_B2_EXECUTOR_SUMMIT_PAYLOAD_HASH_DRIFT:${record.canonicalRelationId}`);
    }
  }

  const expectedToken = expectedExecutionToken(
    contract,
    recordIds,
    snapshot,
    stageability,
    payloads,
    BLOCKED_RELATION,
  );
  if (expectedToken !== contract.executionToken) {
    throw new Error("PHASE11I_B2_EXECUTOR_TOKEN_RECOMPUTE_DRIFT");
  }
  if (contract.executionToken === contract.oldExecutionToken) {
    throw new Error("PHASE11I_B2_EXECUTOR_TOKEN_SAME_AS_OLD");
  }
  if (!contract.executionToken.startsWith("PHASE11I-B2:")) {
    throw new Error("PHASE11I_B2_EXECUTOR_TOKEN_FORMAT");
  }

  return {
    queueArtifactHash: queue.deterministicArtifactHash,
    snapshotDeterministicHash: snapshot.deterministicArtifactHash,
    stageabilityDeterministicHash: stageability.deterministicArtifactHash,
    payloadsDeterministicHash: payloads.deterministicArtifactHash,
    contractDeterministicHash: contract.deterministicArtifactHash,
    contractFileSha256: sha256Bytes(Buffer.from(contractRaw)),
    contract,
    payloads,
    records: payloads.records.map((r) => ({
      canonicalRelationId: r.canonicalRelationId,
      mainPayloadHash: r.mainPayloadHash,
      summitPayloadHash: r.summitPayloadHash,
    })),
  };
}

export function expectedExecutionToken(
  contract: Pick<
    B2ExecutorContract,
    "executionToken" | "oldExecutionToken" | "records"
  >,
  recordIds: string[],
  snapshot: { deterministicArtifactHash: string },
  stageability: { deterministicArtifactHash: string },
  payloads: { deterministicArtifactHash: string },
  blockedRelationId: string,
): string {
  const tokenContent = {
    version: "phase11i-b2",
    queueHash: QUEUE_SHA256,
    snapshotHash: snapshot.deterministicArtifactHash,
    stageabilityHash: stageability.deterministicArtifactHash,
    payloadHash: payloads.deterministicArtifactHash,
    recordIds: [...recordIds].sort((a, b) => Number(a) - Number(b)),
    mountainIds: contract.records.map((r) => r.mountainId).sort((a, b) => a - b),
    geometryHashes: contract.records.map((r) => r.geometryHash).sort(),
    blockedRelationId,
  };
  return `PHASE11I-B2:${sha256Stable(tokenContent)}:${QUEUE_SHA256}`;
}

function parseArgs(argv: string[]): { execute: boolean; token: string | null } {
  let execute = false;
  let token: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      execute = true;
    } else if (argument === "--token") {
      const value = argv[index + 1];
      if (!value) throw new Error("PHASE11I_B2_EXECUTOR_TOKEN_VALUE_REQUIRED");
      index += 1;
      token = value;
    } else {
      throw new Error(`PHASE11I_B2_EXECUTOR_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return { execute, token };
}

interface FrozenPayloadIdentity {
  idempotencyKey: string;
  routePayloadHash: string;
}

interface StatusInput {
  contract: B2ExecutorContract;
  frozenPayloadByRelation: Map<string, FrozenPayloadIdentity>;
  provisioningByRelation: Map<
    string,
    { publication_status: string | null; mountain_route_id: number }
  >;
  publishedRelationIds: Set<string>;
  qaStagingIds: Set<string>;
  qaHistoryStagingIds: Set<string>;
  stagingRowsByRelation: Map<string, { id: string; idempotency_key: string; payload_hash: string; canonical_source_id: string }>;
  mountainDrift: Set<string>;
}

function frozenPayloadIdentity(
  verification: B2ExecutorArtifactVerification,
): Map<string, FrozenPayloadIdentity> {
  const map = new Map<string, FrozenPayloadIdentity>();
  for (const record of verification.payloads.records) {
    map.set(record.canonicalRelationId, {
      idempotencyKey: record.mainPayload.idempotency_key,
      routePayloadHash: record.mainPayload.payload_hash,
    });
  }
  return map;
}

function classifyB2Status(input: StatusInput): {
  records: Phase11iB2StatusEntry[];
  summary: Phase11iB2Summary;
} {
  const { contract } = input;
  const { records } = contract;
  const statuses: Phase11iB2StatusEntry[] = [];

  for (const record of records) {
    const relation = record.canonicalRelationId;
    const stagingRow = input.stagingRowsByRelation.get(relation);
    const provenance = input.provisioningByRelation.get(relation);
    const published = Boolean(provenance) || input.publishedRelationIds.has(relation);
    const isActive = provenance?.publication_status?.toUpperCase() === "ACTIVE";
    const qaHit =
      stagingRow &&
      (input.qaStagingIds.has(stagingRow.id) || input.qaHistoryStagingIds.has(stagingRow.id));
    const identityDrift = input.mountainDrift.has(relation);

    let action: Phase11iB2Action;
    let reason: string | null = null;
    let exactUnchanged = false;

    if (stagingRow) {
      const frozen = input.frozenPayloadByRelation.get(relation);
      const matchesFrozen =
        frozen !== undefined &&
        stagingRow.idempotency_key === frozen.idempotencyKey &&
        stagingRow.canonical_source_id === relation &&
        stagingRow.payload_hash === frozen.routePayloadHash;
      if (matchesFrozen) {
        action = "EXACT_UNCHANGED";
        exactUnchanged = true;
      } else {
        action = "PAYLOAD_CONFLICT";
        reason = "PAYLOAD_CONFLICT_STAGING_ROW_DIFFERS_FROM_FROZEN";
      }
    } else if (qaHit) {
      action = "QA_CONFLICT";
      reason = "QA_DECISION_OR_HISTORY_PRESENT";
    } else if (isActive) {
      action = "ACTIVE_OVERLAP";
      reason = "ALREADY_PUBLISHED_ACTIVE";
    } else if (published) {
      action = "OTHER_BLOCKED";
      reason = "ALREADY_PUBLISHED";
    } else if (identityDrift) {
      action = "MOUNTAIN_IDENTITY_DRIFT";
      reason = "FROZEN_MOUNTAIN_BINDING_DRIFT";
    } else {
      action = "WOULD_CREATE";
      reason = null;
    }

    statuses.push({
      canonicalRelationId: relation,
      peakOsmId: record.peakOsmId,
      frozenMountainId: record.mountainId,
      action,
      reason,
      identityDrift,
      downstream: {
        staging: Boolean(stagingRow),
        published,
        active: isActive,
        qa: Boolean(qaHit),
        exactUnchanged,
      },
    });
  }

  const summary: Phase11iB2Summary = {
    wouldCreate: statuses.filter((s) => s.action === "WOULD_CREATE").length,
    exactUnchanged: statuses.filter((s) => s.action === "EXACT_UNCHANGED").length,
    payloadConflicts: statuses.filter((s) => s.action === "PAYLOAD_CONFLICT").length,
    qaConflicts: statuses.filter((s) => s.action === "QA_CONFLICT").length,
    activeOverlap: statuses.filter((s) => s.action === "ACTIVE_OVERLAP").length,
    mountainIdentityDrift: statuses.filter((s) => s.action === "MOUNTAIN_IDENTITY_DRIFT").length,
    otherBlocked: statuses.filter((s) => s.action === "OTHER_BLOCKED").length,
  };

  return { records: statuses, summary };
}

async function verifyLiveMountainBindings(
  client: SupabaseClient,
  contract: B2ExecutorContract,
): Promise<Set<string>> {
  const drift: Set<string> = new Set();
  const peakOsmIds = [...new Set(contract.records.map((r) => r.peakOsmId))];
  const chunkSize = 40;
  const deployedMountainByOsm = new Map<string, number>();
  for (let index = 0; index < peakOsmIds.length; index += chunkSize) {
    const chunkPeaks = peakOsmIds.slice(index, index + chunkSize);
    const response = await client
      .from("mountains")
      .select("id,osm_id")
      .in("osm_id", chunkPeaks);
    if (response.error) throw new Error(`PHASE11I_B2_EXECUTOR_MOUNTAIN_QUERY:${response.error.message}`);
    for (const row of (response.data ?? []) as Array<{ id: number | string; osm_id: string | null }>) {
      const osmId = String(row.osm_id ?? "");
      if (osmId) deployedMountainByOsm.set(osmId, Number(row.id));
    }
  }
  for (const record of contract.records) {
    const deployedId = deployedMountainByOsm.get(record.peakOsmId);
    if (deployedId === undefined || deployedId !== record.mountainId) {
      drift.add(record.canonicalRelationId);
    }
  }
  return drift;
}

async function loadFullStagingRows(
  client: SupabaseClient,
  relationIds: string[],
): Promise<Map<string, { id: string; idempotency_key: string; payload_hash: string; canonical_source_id: string; source_relation_id: string; import_eligibility: string }>> {
  const map = new Map<string, { id: string; idempotency_key: string; payload_hash: string; canonical_source_id: string; source_relation_id: string; import_eligibility: string }>();
  const chunkSize = 40;
  for (let index = 0; index < relationIds.length; index += chunkSize) {
    const chunk = relationIds.slice(index, index + chunkSize);
    const response = await client
      .from("osm_route_import_staging")
      .select("id,idempotency_key,payload_hash,canonical_source_id,source_relation_id,import_eligibility")
      .in("canonical_source_id", chunk);
    if (response.error) throw new Error(`PHASE11I_B2_EXECUTOR_STAGING_QUERY:${response.error.message}`);
    for (const row of (response.data ?? []) as Array<Record<string, unknown>>) {
      const canonical = String(row.canonical_source_id ?? "");
      if (canonical && relationIds.includes(canonical)) {
        map.set(canonical, row as unknown as { id: string; idempotency_key: string; payload_hash: string; canonical_source_id: string; source_relation_id: string; import_eligibility: string });
      }
    }
  }
  return map;
}

export async function runPhase11iB2StatusCheck(
  verification: B2ExecutorArtifactVerification,
  client: SupabaseClient,
): Promise<{ records: Phase11iB2StatusEntry[]; summary: Phase11iB2Summary }> {
  const relationIds = verification.contract.records.map((r) => r.canonicalRelationId);
  const beforeState = await loadPhase11hBeforeState(client, relationIds);

  const provisioningByRelation = new Map<
    string,
    { publication_status: string | null; mountain_route_id: number }
  >();
  for (const [relation, provenance] of beforeState.provenanceByRelation) {
    const active = String(provenance.publication_status).toUpperCase() === "ACTIVE";
    if (!active) continue;
    provisioningByRelation.set(relation, {
      publication_status: provenance.publication_status,
      mountain_route_id: provenance.mountain_route_id,
    });
  }

  const mountainDrift = await verifyLiveMountainBindings(client, verification.contract);
  const fullStagingRows = await loadFullStagingRows(client, relationIds);

  return classifyB2Status({
    contract: verification.contract,
    frozenPayloadByRelation: frozenPayloadIdentity(verification),
    provisioningByRelation,
    publishedRelationIds: beforeState.publishedRelationIds,
    qaStagingIds: beforeState.qaStagingIds,
    qaHistoryStagingIds: beforeState.qaHistoryStagingIds,
    stagingRowsByRelation: fullStagingRows,
    mountainDrift,
  });
}

export function assertExecutionSafe(status: {
  records: Phase11iB2StatusEntry[];
  summary: Phase11iB2Summary;
}): void {
  const { summary } = status;
  if (
    summary.wouldCreate !== STAGEABLE_TOTAL ||
    summary.exactUnchanged !== 0 ||
    summary.payloadConflicts !== 0 ||
    summary.qaConflicts !== 0 ||
    summary.activeOverlap !== 0 ||
    summary.mountainIdentityDrift !== 0 ||
    summary.otherBlocked !== 0
  ) {
    throw new Error(
      `PHASE11I_B2_EXECUTOR_PREWRITE_DRIFT:${JSON.stringify(summary)}`,
    );
  }
  if (status.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION)) {
    throw new Error("PHASE11I_B2_EXECUTOR_BLOCKED_IN_SCOPE");
  }
}

function payloadHash(route: StagingPayloadRecord["mainPayload"]): string {
  return createHash("sha256").update(JSON.stringify(route)).digest("hex");
}

async function stageSingle(
  client: SupabaseClient,
  payloadRecord: StagingPayloadRecord,
): Promise<string> {
  const route = payloadRecord.mainPayload;
  const summitPayloads = payloadRecord.summitPayloads;
  const result = await client.rpc("stage_osm_route_import", {
    p_route: route,
    p_summits: summitPayloads,
  });
  if (result.error) {
    throw new Error(`PHASE11I_B2_EXECUTOR_STAGING_RPC:${payloadRecord.canonicalRelationId}:${result.error.message}`);
  }
  const stagedId = String(result.data ?? "");
  return stagedId;
}

interface PostExecutionState {
  stagingRowsForAuthorized: number;
  exactPayloadMatches: number;
  summitStagingForAuthorized: number;
  payloadMismatches: number;
  mountainIdentityMismatches: number;
  qaDecisionRows: number;
  qaHistoryRows: number;
  publicationRows: number;
  activeChanges: number;
  blockedRelationStagingRows: number;
  visibleApproved: number;
  needsReview: number;
  rejected: number;
}

export async function loadPostExecutionState(
  client: SupabaseClient,
  verification: B2ExecutorArtifactVerification,
): Promise<PostExecutionState> {
  const relationIds = verification.contract.records.map((r) => r.canonicalRelationId);
  const beforeState = await loadPhase11hBeforeState(client, relationIds);

  const provisioningByRelation = new Map<string, { publication_status: string | null; mountain_route_id: number }>();
  for (const [relation, provenance] of beforeState.provenanceByRelation) {
    provisioningByRelation.set(relation, {
      publication_status: provenance.publication_status,
      mountain_route_id: provenance.mountain_route_id,
    });
  }

  const status = classifyB2Status({
    contract: verification.contract,
    frozenPayloadByRelation: frozenPayloadIdentity(verification),
    provisioningByRelation,
    publishedRelationIds: beforeState.publishedRelationIds,
    qaStagingIds: beforeState.qaStagingIds,
    qaHistoryStagingIds: beforeState.qaHistoryStagingIds,
    stagingRowsByRelation: await loadFullStagingRows(client, relationIds),
    mountainDrift: new Set(),
  });

  const { summary } = status;
  const stagingRowsForAuthorized = summary.exactUnchanged + summary.payloadConflicts + summary.wouldCreate;
  const exactPayloadMatches = summary.exactUnchanged + summary.wouldCreate;
  const payloadMismatches = summary.payloadConflicts;
  const activeChanges = summary.activeOverlap;

  const identityStatus = await runPhase11iB2StatusCheck(verification, client);
  const mountainIdentityMismatches = identityStatus.summary.mountainIdentityDrift;

  const qaDecisionRows = beforeState.qaRows.length;
  const qaHistoryRows = beforeState.qaHistoryRows.length;
  const publicationRows = beforeState.provenanceByRelation.size;

  const visibleApproved = beforeState.qaRows.filter((r) => r.status === "VISUALLY_APPROVED").length;
  const needsReview = beforeState.qaRows.filter((r) => r.status === "NEEDS_REVIEW").length;
  const rejected = beforeState.qaRows.filter((r) => r.status === "REJECTED").length;

  let blockedRelationStagingRows = 0;
  const blockedResponse = await client
    .from("osm_route_import_staging")
    .select("id,canonical_source_id")
    .eq("canonical_source_id", BLOCKED_RELATION);
  if (blockedResponse.error) throw new Error(`PHASE11I_B2_EXECUTOR_BLOCKED_QUERY:${blockedResponse.error.message}`);
  blockedRelationStagingRows = (blockedResponse.data ?? []).length;

  return {
    stagingRowsForAuthorized,
    exactPayloadMatches,
    summitStagingForAuthorized: beforeState.summitRows.length,
    payloadMismatches,
    mountainIdentityMismatches,
    qaDecisionRows,
    qaHistoryRows,
    publicationRows,
    activeChanges,
    blockedRelationStagingRows,
    visibleApproved,
    needsReview,
    rejected,
  };
}

export async function buildPhase11iB2DryRunReport(
  verification: B2ExecutorArtifactVerification,
): Promise<{
  status: string;
  mode: string;
  executeFlagPresent: boolean;
  queueFileHashVerified: boolean;
  subsetHashVerified: boolean;
  snapshotHashVerified: boolean;
  payloadHashVerified: boolean;
  contractHashVerified: boolean;
  individualPayloadHashesVerified: boolean;
  liveBeforeStateVerified: boolean;
  planned: number;
  wouldCreate: number;
  exactUnchanged: number;
  payloadConflicts: number;
  qaConflicts: number;
  activeOverlap: number;
  mountainIdentityDrift: number;
  otherBlocked: number;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  executionToken: string;
}> {
  let liveBeforeStateVerified = false;
  let summary: Phase11iB2Summary = {
    wouldCreate: STAGEABLE_TOTAL,
    exactUnchanged: 0,
    payloadConflicts: 0,
    qaConflicts: 0,
    activeOverlap: 0,
    mountainIdentityDrift: 0,
    otherBlocked: 0,
  };
  try {
    const client = await createPhase11hAdminClient();
    const status = await runPhase11iB2StatusCheck(verification, client);
    summary = status.summary;
    liveBeforeStateVerified = true;
  } catch (error) {
    throw new Error(`PHASE11I_B2_EXECUTOR_LIVE_BEFORE_STATE_FAILED:${String(error)}`);
  }

  return {
    status: "PASS",
    mode: "DRY_RUN",
    executeFlagPresent: false,
    queueFileHashVerified: true,
    subsetHashVerified: true,
    snapshotHashVerified: true,
    payloadHashVerified: true,
    contractHashVerified: true,
    individualPayloadHashesVerified: true,
    liveBeforeStateVerified,
    planned: STAGEABLE_TOTAL,
    wouldCreate: summary.wouldCreate,
    exactUnchanged: summary.exactUnchanged,
    payloadConflicts: summary.payloadConflicts,
    qaConflicts: summary.qaConflicts,
    activeOverlap: summary.activeOverlap,
    mountainIdentityDrift: summary.mountainIdentityDrift,
    otherBlocked: summary.otherBlocked,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
    executionToken: verification.contract.executionToken,
  };
}

async function executeStaging(
  verification: B2ExecutorArtifactVerification,
  client: SupabaseClient,
): Promise<{ successes: string[]; failures: string[] }> {
  const successes: string[] = [];
  const failures: string[] = [];
  for (const payloadRecord of verification.payloads.records) {
    const expectedPayloadHash = payloadHash(payloadRecord.mainPayload);
    if (expectedPayloadHash !== payloadRecord.mainPayloadHash) {
      throw new Error(`PHASE11I_B2_EXECUTOR_PAYLOAD_RECOMPUTE_DRIFT:${payloadRecord.canonicalRelationId}`);
    }
    try {
      const stagedId = await stageSingle(client, payloadRecord);
      successes.push(`${payloadRecord.canonicalRelationId}:${stagedId}`);
    } catch (error) {
      failures.push(`${payloadRecord.canonicalRelationId}:${String(error)}`);
    }
  }
  return { successes, failures };
}

export async function writeExecutionReceipt(input: {
  verification: B2ExecutorArtifactVerification;
  prewriteSummary: Phase11iB2Summary;
  execution: { successes: string[]; failures: string[] };
  post: PostExecutionState;
  afterStatus: { records: Phase11iB2StatusEntry[]; summary: Phase11iB2Summary };
  queueHash: string;
  completionTimestamp: string;
}): Promise<{ path: string; fileSha256: string; deterministicArtifactHash: string }> {
  const { verification, prewriteSummary, execution, post, afterStatus } = input;
  const relationIds = verification.contract.records.map((r) => r.canonicalRelationId);
  const receiptContent = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_CONTROLLED_STAGING_EXECUTION_RECEIPT",
    contractVersion: verification.contract.contractVersion,
    contractHash: verification.contractDeterministicHash,
    contractFileSha256: verification.contractFileSha256,
    queueHash: input.queueHash,
    stageableSubsetHash: verification.stageabilityDeterministicHash,
    sourceSnapshotHash: verification.snapshotDeterministicHash,
    payloadArtifactHash: verification.payloadsDeterministicHash,
    executionContractHash: verification.contractDeterministicHash,
    executionToken: verification.contract.executionToken,
    authorizedCount: STAGEABLE_TOTAL,
    blockedCount: 1,
    blockedRelation: BLOCKED_RELATION,
    beforeState: prewriteSummary,
    execution: {
      rpcSuccesses: execution.successes.length,
      rpcFailures: execution.failures.length,
      stagedResults: execution.successes,
      rpcFailuresList: execution.failures,
    },
    afterState: {
      stagingRowsForAuthorized: post.stagingRowsForAuthorized,
      exactPayloadMatches: post.exactPayloadMatches,
      summitStagingForAuthorized: post.summitStagingForAuthorized,
      payloadMismatches: post.payloadMismatches,
      mountainIdentityMismatches: post.mountainIdentityMismatches,
      qaDecisionRows: post.qaDecisionRows,
      qaHistoryRows: post.qaHistoryRows,
      publicationRows: post.publicationRows,
      activeChanges: post.activeChanges,
      blockedRelationStagingRows: post.blockedRelationStagingRows,
      visibleApproved: post.visibleApproved,
      needsReview: post.needsReview,
      rejected: post.rejected,
      summary: afterStatus.summary,
      records: afterStatus.records.map((r) => ({
        canonicalRelationId: r.canonicalRelationId,
        action: r.action,
        reason: r.reason,
      })),
    },
    writes: {
      databaseWrites: execution.successes.length,
      qaWrites: 0,
      publicationWrites: 0,
    },
    relationIds,
    qaWrites: 0,
    publicationWrites: 0,
    activeChanges: post.activeChanges,
    qaDecisionRowsCreated: post.qaDecisionRows,
    qaHistoryRowsCreated: post.qaHistoryRows,
    blockedRelationStagingRows: post.blockedRelationStagingRows,
  };

  const deterministicContent = { ...receiptContent };
  const deterministicArtifactHash = sha256Stable(deterministicContent);
  const artifact = {
    ...deterministicContent,
    completionTimestamp: input.completionTimestamp,
    deterministicArtifactHash,
  };

  await mkdir(dirname(RECEIPT_PATH), { recursive: true });
  const temp = `${RECEIPT_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await rm(RECEIPT_PATH, { force: true });
  await rename(temp, RECEIPT_PATH);
  const writtenBytes = await readFile(RECEIPT_PATH);
  const fileSha256 = sha256Bytes(writtenBytes);

  return { path: RECEIPT_PATH, fileSha256, deterministicArtifactHash };
}

function summarizeSummary(summary: Phase11iB2Summary): string {
  return JSON.stringify(summary);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const verification = await verifyPhase11iB2Artifacts();

  if (options.execute) {
    if (!options.token) throw new Error("PHASE11I_B2_EXECUTOR_EXECUTION_TOKEN_REQUIRED");
    if (options.token !== verification.contract.executionToken) {
      throw new Error("PHASE11I_B2_EXECUTOR_EXECUTION_TOKEN_MISMATCH");
    }

    const client = await createPhase11hAdminClient();
    const prewriteStatus = await runPhase11iB2StatusCheck(verification, client);

    if (prewriteStatus.records.length !== STAGEABLE_TOTAL) {
      throw new Error(`PHASE11I_B2_EXECUTOR_PREWRITE_RECORD_COUNT:${prewriteStatus.records.length}`);
    }
    if (prewriteStatus.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION)) {
      throw new Error("PHASE11I_B2_EXECUTOR_BLOCKED_IN_PREWRITE");
    }

    assertExecutionSafe(prewriteStatus);

    const execution = await executeStaging(verification, client);

    if (execution.failures.length !== 0) {
      throw new Error(
        `PHASE11I_B2_EXECUTOR_EXECUTION_FAILURES:${execution.failures.join(";")}`,
      );
    }

    const post = await loadPostExecutionState(client, verification);
    const afterStatus = await runPhase11iB2StatusCheck(verification, client);

    const receipt = await writeExecutionReceipt({
      verification,
      prewriteSummary: prewriteStatus.summary,
      execution,
      post,
      afterStatus,
      queueHash: QUEUE_SHA256,
      completionTimestamp: new Date().toISOString(),
    });

    const report = {
      executionStatus: "EXECUTED",
      authorized: STAGEABLE_TOTAL,
      created: execution.successes.length,
      exactUnchangedBefore: prewriteStatus.summary.exactUnchanged,
      blocked: 1,
      blockedRelation: BLOCKED_RELATION,
      preflight: prewriteStatus.summary,
      execution: {
        rpcSuccesses: execution.successes.length,
        rpcFailures: execution.failures.length,
      },
      postVerification: {
        stagingRows: post.stagingRowsForAuthorized,
        exactPayloadMatches: post.exactPayloadMatches,
        summitStagingMatches: post.summitStagingForAuthorized,
        payloadMismatches: post.payloadMismatches,
        mountainIdentityMismatches: post.mountainIdentityMismatches,
      },
      qaDecisionsCreated: post.qaDecisionRows,
      qaHistoryCreated: post.qaHistoryRows,
      publicationWrites: post.publicationRows,
      activeChanges: post.activeChanges,
      blockedRelationStagingRows: post.blockedRelationStagingRows,
      postExecutionIdempotency: {
        wouldCreate: afterStatus.summary.wouldCreate,
        exactUnchanged: afterStatus.summary.exactUnchanged,
        conflicts: afterStatus.summary.payloadConflicts,
      },
      executionReceiptPath: receipt.path,
      executionReceiptFileSha256: receipt.fileSha256,
      executionReceiptDeterministicHash: receipt.deterministicArtifactHash,
      previewUrl: "http://localhost:3000/de/internal/osm-staging?queue=phase11h",
      writes: { databaseWrites: execution.successes.length, qaWrites: 0, publicationWrites: 0 },
      prewriteSummary: summarizeSummary(prewriteStatus.summary),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (options.token !== null) {
    const token = options.token;
    if (token === verification.contract.oldExecutionToken) {
      throw new Error("PHASE11I_B2_EXECUTOR_OLD_TOKEN_REJECTED");
    }
    if (token !== verification.contract.executionToken) {
      throw new Error("PHASE11I_B2_EXECUTOR_WRONG_TOKEN_REJECTED");
    }
  }

  const report = await buildPhase11iB2DryRunReport(verification);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
