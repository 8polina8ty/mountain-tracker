import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { writeJsonAtomically } from "./jsonl.ts";
import { sha256Stable } from "./phase11-publication.ts";

const ROOT = resolve("data/osm/alps/staging");
const QUEUE_PATH = resolve(ROOT, "phase11h-human-calibration-queue.json");
const RECEIPT_PATH = resolve(ROOT, "phase11i-b2-controlled-staging-execution.json");
const PAYLOADS_PATH = resolve(ROOT, "phase11i-b2-human-calibration-staging-payloads.json");
const STAGEABILITY_PATH = resolve(ROOT, "phase11i-b2-human-calibration-stageability.json");
const GREENS_PATH = resolve(ROOT, "phase11g-expanded-green-candidates.json");
export const RESULT_PATH = resolve(ROOT, "phase11i-human-calibration-result.json");

export const RESULT_CONTRACT =
  "mountain-tracker-phase11i-human-calibration-result/v1" as const;
const BLOCKED_RELATION = "19752996";
const EXPECTED_TOTAL = 45;
const EXPECTED_STAGED = 44;
const ALLOWED_DECISIONS = [
  "VISUALLY_APPROVED",
  "NEEDS_REVIEW",
  "REJECTED",
] as const;

type HumanDecision = (typeof ALLOWED_DECISIONS)[number];
type DecisionCounts = Record<HumanDecision, number>;

interface QueueMember {
  canonicalRelationId: string;
  qualificationHash: string;
  resolvedDisplayName: string | null;
  startContext: "BASE_START" | "HUT_START";
  qualityBand: "Q65_74" | "Q75_89" | "Q90";
  nameStatus: "SOURCE_NAME" | "DERIVED_SOURCE_BACKED" | "REF_ONLY" | "UNRESOLVED";
  selectionTier:
    | "BASE_BAND_STRATUM"
    | "NAMED_STRATUM"
    | "HUT_FULL_COVERAGE"
    | "HASH_RANDOM_CONTROL";
  humanDecisionStatus: null;
}

interface QueueArtifact {
  artifactType: string;
  deterministicArtifactHash: string;
  sampleSize: number;
  sample: QueueMember[];
}

interface ReceiptArtifact {
  artifactType: string;
  queueHash: string;
  authorizedCount: number;
  blockedCount: number;
  blockedRelation: string;
  execution: { stagedResults: string[] };
}

interface PayloadRecord {
  canonicalRelationId: string;
  mainPayload: {
    contract_version: string;
    idempotency_key: string;
    payload_hash: string;
    source_relation_id: string;
    canonical_source_id: string;
    import_eligibility: string;
    matched_primary_mountain_id: number;
  };
  summitPayloads: Array<{
    peak_osm_id: string;
    mountain_id: number;
    final_association: string;
    mountain_match_classification: string;
  }>;
}

interface PayloadArtifact {
  artifactType: string;
  records: PayloadRecord[];
}

interface StageabilityArtifact {
  artifactType: string;
  stageableCount: number;
  blockedCount: number;
  blockedRelation: {
    canonicalRelationId: string;
    blockingReason: string;
  };
}

interface GreensArtifact {
  records: Array<{
    canonicalRouteSourceId: string;
    safeStatus: string;
    deterministicQualificationHash: string;
  }>;
}

export interface LiveStagingRow {
  id: string;
  contract_version: string;
  idempotency_key: string;
  payload_hash: string;
  source_relation_id: string;
  canonical_source_id: string;
  import_eligibility: string;
  matched_primary_mountain_id: number;
}

export interface LiveSummitRow {
  staging_route_id: string;
  peak_osm_id: string;
  mountain_id: number;
  final_association: string;
  mountain_match_classification: string;
}

export interface LiveDecisionRow {
  staging_route_id: string;
  status: string;
  reviewer_note: string | null;
  reviewed_at: string;
  reviewer_user_id: string;
  version: number;
}

export interface LiveHistoryRow {
  id: number;
  staging_route_id: string;
  old_status: string;
  new_status: string;
  reviewer_note: string | null;
  reviewer_user_id: string;
  decision_version: number;
  occurred_at: string;
}

interface FrozenContracts {
  queueRaw: string;
  queue: QueueArtifact;
  receipt: ReceiptArtifact;
  payloads: PayloadArtifact;
  stageability: StageabilityArtifact;
  greens: GreensArtifact;
}

export interface HumanCalibrationResult {
  schemaVersion: 1;
  artifactType: "PHASE11I_HUMAN_CALIBRATION_RESULT";
  contractVersion: typeof RESULT_CONTRACT;
  auditedAt: string;
  readOnly: true;
  publishable: false;
  queue: {
    queueFileSha256: string;
    queueHash: string;
    queueDeterministicArtifactHash: string;
    totalCalibrationMembers: 45;
    stagedAndReviewed: 44;
    blocked: 1;
    blockedRelation: "19752996";
  };
  decisionDistribution: DecisionCounts & {
    PENDING: number;
    total: number;
    approvalRate: number;
    needsReviewRate: number;
    rejectionRate: number;
  };
  matrices: {
    startContext: Record<"BASE_START" | "HUT_START", DecisionCounts>;
    qualityBand: Record<
      "Q65_74" | "Q75_89" | "Q90+",
      DecisionCounts & { total: number; needsReviewRate: number; rejectionRate: number }
    >;
    nameStatus: Record<QueueMember["nameStatus"], DecisionCounts>;
    selectionTier: Record<QueueMember["selectionTier"], DecisionCounts>;
  };
  machineFalseGreen: {
    humanRejectedMachineGreen: Array<FailureRecord>;
    humanNeedsReviewMachineGreen: Array<FailureRecord>;
  };
  failureClusters: Record<
    "BASE_START" | "HUT_START" | "LOW_QUALITY" | "DERIVED_NAME" | "TOPOLOGY" | "WRONG_SUMMIT" | "INCOMPLETE_GEOMETRY" | "ROAD_SAFETY" | "DETOUR_TRAVERSE",
    string[]
  >;
  integrity: {
    historyIntegrityPass: boolean;
    payloadCompatibilityPass: boolean;
    mismatchRelationIds: string[];
    currentDecisionRows: number;
    historyRows: number;
    duplicateCurrentDecisionRows: number;
    orphanHistoryRows: number;
  };
  blockedRelation: {
    canonicalRelationId: "19752996";
    machineStatus: "GREEN";
    blockingReason: "MOUNTAIN_IDENTITY_MISSING";
    staging: 0;
    decision: 0;
    history: 0;
    includedInPersistedCalibrationResult: false;
  };
  records: ReconciledRoute[];
  calibrationResult: "PASS" | "NEEDS_MODEL_REVISION" | "NEEDS_TARGETED_REVIEW";
  calibrationRationale: string;
  zeroWriteAttestation: {
    databaseWrites: 0;
    qaWrites: 0;
    qaHistoryWrites: 0;
    stagingWrites: 0;
    publicationWrites: 0;
    activeChanges: 0;
  };
  deterministicArtifactHash: string;
}

interface ReconciledRoute {
  canonicalRelationId: string;
  stagingRouteId: string;
  displayName: string | null;
  humanDecision: HumanDecision;
  payloadHash: string;
  payloadCompatible: true;
  decisionTimestamp: string;
  decisionVersion: number;
  historyCount: number;
  reviewerNote: string | null;
  startContext: QueueMember["startContext"];
  qualityBand: "Q65_74" | "Q75_89" | "Q90+";
  nameStatus: QueueMember["nameStatus"];
  selectionTier: QueueMember["selectionTier"];
  machineStatus: "GREEN";
}

interface FailureRecord {
  canonicalRelationId: string;
  stagingRouteId: string;
  decision: "NEEDS_REVIEW" | "REJECTED";
  reviewerNote: string | null;
  startContext: QueueMember["startContext"];
  qualityBand: ReconciledRoute["qualityBand"];
  nameStatus: QueueMember["nameStatus"];
  selectionTier: QueueMember["selectionTier"];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyCounts(): DecisionCounts {
  return { VISUALLY_APPROVED: 0, NEEDS_REVIEW: 0, REJECTED: 0 };
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1_000_000) / 1_000_000;
}

function parseStagedIdentities(receipt: ReceiptArtifact): Map<string, string> {
  const identities = new Map<string, string>();
  for (const value of receipt.execution.stagedResults) {
    const separator = value.indexOf(":");
    const relationId = value.slice(0, separator);
    const stagingRouteId = value.slice(separator + 1);
    if (
      separator < 1 ||
      !/^\d+$/.test(relationId) ||
      !/^[0-9a-f-]{36}$/i.test(stagingRouteId) ||
      identities.has(relationId)
    ) {
      throw new Error("Phase 11I-B2 execution receipt contains invalid staged identities.");
    }
    identities.set(relationId, stagingRouteId);
  }
  return identities;
}

function normalizeQualityBand(value: QueueMember["qualityBand"]): ReconciledRoute["qualityBand"] {
  return value === "Q90" ? "Q90+" : value;
}

function toFailureRecord(route: ReconciledRoute): FailureRecord {
  if (route.humanDecision === "VISUALLY_APPROVED") {
    throw new Error("Approved route cannot be converted to a failure record.");
  }
  return {
    canonicalRelationId: route.canonicalRelationId,
    stagingRouteId: route.stagingRouteId,
    decision: route.humanDecision,
    reviewerNote: route.reviewerNote,
    startContext: route.startContext,
    qualityBand: route.qualityBand,
    nameStatus: route.nameStatus,
    selectionTier: route.selectionTier,
  };
}

function noteMatches(note: string | null, pattern: RegExp): boolean {
  return note !== null && pattern.test(note);
}

export function buildHumanCalibrationResult(input: {
  contracts: FrozenContracts;
  stagingRows: LiveStagingRow[];
  summitRows: LiveSummitRow[];
  decisionRows: LiveDecisionRow[];
  historyRows: LiveHistoryRow[];
  blockedStagingRows: LiveStagingRow[];
  auditedAt: string;
}): HumanCalibrationResult {
  const { contracts } = input;
  const stagedIdentities = parseStagedIdentities(contracts.receipt);
  const queueByRelation = new Map(
    contracts.queue.sample.map((member) => [member.canonicalRelationId, member]),
  );
  const payloadByRelation = new Map(
    contracts.payloads.records.map((record) => [record.canonicalRelationId, record]),
  );
  const greenByRelation = new Map(
    contracts.greens.records.map((record) => [record.canonicalRouteSourceId, record]),
  );
  if (
    contracts.queue.artifactType !== "PHASE11H_HUMAN_CALIBRATION_QUEUE" ||
    contracts.queue.sampleSize !== EXPECTED_TOTAL ||
    contracts.queue.sample.length !== EXPECTED_TOTAL ||
    contracts.receipt.artifactType !== "PHASE11I_B2_CONTROLLED_STAGING_EXECUTION_RECEIPT" ||
    contracts.receipt.authorizedCount !== EXPECTED_STAGED ||
    contracts.receipt.blockedCount !== 1 ||
    contracts.receipt.blockedRelation !== BLOCKED_RELATION ||
    stagedIdentities.size !== EXPECTED_STAGED ||
    contracts.payloads.artifactType !== "PHASE11I_B2_STAGING_PAYLOADS" ||
    contracts.payloads.records.length !== EXPECTED_STAGED ||
    contracts.stageability.artifactType !== "PHASE11I_B2_STAGEABILITY" ||
    contracts.stageability.stageableCount !== EXPECTED_STAGED ||
    contracts.stageability.blockedCount !== 1 ||
    contracts.stageability.blockedRelation.canonicalRelationId !== BLOCKED_RELATION ||
    contracts.stageability.blockedRelation.blockingReason !== "MOUNTAIN_IDENTITY_MISSING"
  ) {
    throw new Error("Phase 11I-E frozen calibration scope is invalid.");
  }
  for (const member of contracts.queue.sample) {
    const green = greenByRelation.get(member.canonicalRelationId);
    if (
      member.humanDecisionStatus !== null ||
      !green ||
      green.safeStatus !== "GREEN" ||
      green.deterministicQualificationHash !== member.qualificationHash
    ) {
      throw new Error(`Machine GREEN identity drift for relation ${member.canonicalRelationId}.`);
    }
  }

  const stagingById = new Map<string, LiveStagingRow>();
  const duplicateStagingRelations = new Set<string>();
  for (const row of input.stagingRows) {
    if (stagingById.has(row.id)) duplicateStagingRelations.add(row.canonical_source_id);
    stagingById.set(row.id, row);
  }
  const decisionsById = new Map<string, LiveDecisionRow>();
  const duplicateDecisionIds = new Set<string>();
  for (const row of input.decisionRows) {
    if (decisionsById.has(row.staging_route_id)) duplicateDecisionIds.add(row.staging_route_id);
    decisionsById.set(row.staging_route_id, row);
  }
  const summitsById = new Map<string, LiveSummitRow[]>();
  for (const row of input.summitRows) {
    const rows = summitsById.get(row.staging_route_id) ?? [];
    rows.push(row);
    summitsById.set(row.staging_route_id, rows);
  }
  const historyById = new Map<string, LiveHistoryRow[]>();
  const expectedStagingIds = new Set(stagedIdentities.values());
  let orphanHistoryRows = 0;
  for (const row of input.historyRows) {
    if (!expectedStagingIds.has(row.staging_route_id)) {
      orphanHistoryRows += 1;
    }
    const rows = historyById.get(row.staging_route_id) ?? [];
    rows.push(row);
    historyById.set(row.staging_route_id, rows);
  }

  const mismatches = new Set<string>(duplicateStagingRelations);
  const records: ReconciledRoute[] = [];
  for (const [relationId, stagingRouteId] of stagedIdentities) {
    const member = queueByRelation.get(relationId);
    const expected = payloadByRelation.get(relationId);
    const staging = stagingById.get(stagingRouteId);
    const decision = decisionsById.get(stagingRouteId);
    const summits = summitsById.get(stagingRouteId) ?? [];
    const history = (historyById.get(stagingRouteId) ?? []).sort(
      (left, right) => left.decision_version - right.decision_version,
    );
    if (!member || !expected || !staging || !decision || summits.length !== 1 || history.length === 0) {
      mismatches.add(relationId);
      continue;
    }
    const expectedRoute = expected.mainPayload;
    const expectedSummit = expected.summitPayloads[0];
    const payloadCompatible =
      expected.summitPayloads.length === 1 &&
      staging.id === stagingRouteId &&
      staging.contract_version === expectedRoute.contract_version &&
      staging.idempotency_key === expectedRoute.idempotency_key &&
      staging.payload_hash === expectedRoute.payload_hash &&
      staging.source_relation_id === relationId &&
      staging.canonical_source_id === relationId &&
      staging.import_eligibility === "AUTO_IMPORT_READY" &&
      Number(staging.matched_primary_mountain_id) === expectedRoute.matched_primary_mountain_id &&
      summits[0].peak_osm_id === expectedSummit.peak_osm_id &&
      Number(summits[0].mountain_id) === expectedSummit.mountain_id &&
      summits[0].final_association === "CONFIRMED" &&
      summits[0].mountain_match_classification === "EXACT_MOUNTAIN_MATCH";
    const latest = history.at(-1);
    let previousStatus = "PENDING";
    const historyCompatible = history.every((entry, index) => {
      const valid =
        entry.decision_version === index + 1 &&
        entry.old_status === previousStatus &&
        (ALLOWED_DECISIONS.includes(entry.new_status as HumanDecision) ||
          entry.new_status === "PENDING");
      previousStatus = entry.new_status;
      return valid;
    });
    const currentMatchesLatest =
      latest !== undefined &&
      decision.version === latest.decision_version &&
      decision.status === latest.new_status &&
      decision.reviewer_note === latest.reviewer_note &&
      decision.reviewer_user_id === latest.reviewer_user_id &&
      decision.reviewed_at === latest.occurred_at;
    if (
      !payloadCompatible ||
      !historyCompatible ||
      !currentMatchesLatest ||
      !ALLOWED_DECISIONS.includes(decision.status as HumanDecision)
    ) {
      mismatches.add(relationId);
      continue;
    }
    records.push({
      canonicalRelationId: relationId,
      stagingRouteId,
      displayName: member.resolvedDisplayName,
      humanDecision: decision.status as HumanDecision,
      payloadHash: staging.payload_hash,
      payloadCompatible: true,
      decisionTimestamp: decision.reviewed_at,
      decisionVersion: decision.version,
      historyCount: history.length,
      reviewerNote: decision.reviewer_note,
      startContext: member.startContext,
      qualityBand: normalizeQualityBand(member.qualityBand),
      nameStatus: member.nameStatus,
      selectionTier: member.selectionTier,
      machineStatus: "GREEN",
    });
  }
  for (const stagingId of duplicateDecisionIds) {
    const relation = [...stagedIdentities].find(([, id]) => id === stagingId)?.[0];
    mismatches.add(relation ?? stagingId);
  }
  if (
    input.stagingRows.length !== EXPECTED_STAGED ||
    input.decisionRows.length !== EXPECTED_STAGED ||
    input.blockedStagingRows.length !== 0 ||
    orphanHistoryRows !== 0 ||
    records.length !== EXPECTED_STAGED
  ) {
    for (const relationId of stagedIdentities.keys()) {
      if (!records.some((record) => record.canonicalRelationId === relationId)) {
        mismatches.add(relationId);
      }
    }
    if (input.blockedStagingRows.length !== 0) mismatches.add(BLOCKED_RELATION);
  }
  if (mismatches.size > 0) {
    throw new Error(
      `PHASE11I_E_INTEGRITY_MISMATCH:${[...mismatches].sort((a, b) => Number(a) - Number(b)).join(",")}`,
    );
  }

  const distribution = emptyCounts();
  for (const record of records) distribution[record.humanDecision] += 1;
  const startContext = {
    BASE_START: emptyCounts(),
    HUT_START: emptyCounts(),
  };
  const qualityCounts = {
    Q65_74: emptyCounts(),
    Q75_89: emptyCounts(),
    "Q90+": emptyCounts(),
  };
  const nameStatus = {
    SOURCE_NAME: emptyCounts(),
    DERIVED_SOURCE_BACKED: emptyCounts(),
    REF_ONLY: emptyCounts(),
    UNRESOLVED: emptyCounts(),
  };
  const selectionTier = {
    BASE_BAND_STRATUM: emptyCounts(),
    NAMED_STRATUM: emptyCounts(),
    HUT_FULL_COVERAGE: emptyCounts(),
    HASH_RANDOM_CONTROL: emptyCounts(),
  };
  for (const record of records) {
    startContext[record.startContext][record.humanDecision] += 1;
    qualityCounts[record.qualityBand][record.humanDecision] += 1;
    nameStatus[record.nameStatus][record.humanDecision] += 1;
    selectionTier[record.selectionTier][record.humanDecision] += 1;
  }
  const qualityBand = Object.fromEntries(
    Object.entries(qualityCounts).map(([band, counts]) => {
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return [
        band,
        {
          ...counts,
          total,
          needsReviewRate: rate(counts.NEEDS_REVIEW, total),
          rejectionRate: rate(counts.REJECTED, total),
        },
      ];
    }),
  ) as HumanCalibrationResult["matrices"]["qualityBand"];

  const failures = records.filter(
    (record) => record.humanDecision !== "VISUALLY_APPROVED",
  );
  const failureIds = (predicate: (record: ReconciledRoute) => boolean) =>
    failures.filter(predicate).map((record) => record.canonicalRelationId);
  const rejected = failures
    .filter((record) => record.humanDecision === "REJECTED")
    .map(toFailureRecord);
  const needsReview = failures
    .filter((record) => record.humanDecision === "NEEDS_REVIEW")
    .map(toFailureRecord);
  const calibrationResult: HumanCalibrationResult["calibrationResult"] =
    rejected.length > 0
      ? "NEEDS_MODEL_REVISION"
      : needsReview.length > 0
        ? "NEEDS_TARGETED_REVIEW"
        : "PASS";
  const calibrationRationale =
    calibrationResult === "NEEDS_MODEL_REVISION"
      ? `${rejected.length} machine-GREEN route(s) were human-rejected; publication readiness cannot be inferred and the model requires revision before expansion.`
      : calibrationResult === "NEEDS_TARGETED_REVIEW"
        ? `${needsReview.length} machine-GREEN route(s) remain in NEEDS_REVIEW; resolve those cases before treating the calibration as PASS.`
        : "All 44 stageable machine-GREEN routes were explicitly human-approved with compatible current/history state.";

  const content = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11I_HUMAN_CALIBRATION_RESULT" as const,
    contractVersion: RESULT_CONTRACT,
    auditedAt: input.auditedAt,
    readOnly: true as const,
    publishable: false as const,
    queue: {
      queueFileSha256: sha256(contracts.queueRaw),
      queueHash: contracts.receipt.queueHash,
      queueDeterministicArtifactHash: contracts.queue.deterministicArtifactHash,
      totalCalibrationMembers: 45 as const,
      stagedAndReviewed: 44 as const,
      blocked: 1 as const,
      blockedRelation: BLOCKED_RELATION as "19752996",
    },
    decisionDistribution: {
      ...distribution,
      PENDING: EXPECTED_STAGED - records.length,
      total: records.length,
      approvalRate: rate(distribution.VISUALLY_APPROVED, records.length),
      needsReviewRate: rate(distribution.NEEDS_REVIEW, records.length),
      rejectionRate: rate(distribution.REJECTED, records.length),
    },
    matrices: { startContext, qualityBand, nameStatus, selectionTier },
    machineFalseGreen: {
      humanRejectedMachineGreen: rejected,
      humanNeedsReviewMachineGreen: needsReview,
    },
    failureClusters: {
      BASE_START: failureIds((record) => record.startContext === "BASE_START"),
      HUT_START: failureIds((record) => record.startContext === "HUT_START"),
      LOW_QUALITY: failureIds((record) => record.qualityBand === "Q65_74"),
      DERIVED_NAME: failureIds((record) => record.nameStatus === "DERIVED_SOURCE_BACKED"),
      TOPOLOGY: failureIds((record) => noteMatches(record.reviewerNote, /topolog|branch|verzweig|развет/i)),
      WRONG_SUMMIT: failureIds((record) => noteMatches(record.reviewerNote, /wrong summit|summit.*wrong|gipfel.*falsch|неверн.*вершин/i)),
      INCOMPLETE_GEOMETRY: failureIds((record) => noteMatches(record.reviewerNote, /incomplete|geometry.*missing|unvollst|неполн/i)),
      ROAD_SAFETY: failureIds((record) => noteMatches(record.reviewerNote, /road|motorway|traffic|straße|strasse|дорог/i)),
      DETOUR_TRAVERSE: failureIds((record) => noteMatches(record.reviewerNote, /detour|traverse|umweg|querung|обход|траверс/i)),
    },
    integrity: {
      historyIntegrityPass: true,
      payloadCompatibilityPass: true,
      mismatchRelationIds: [],
      currentDecisionRows: input.decisionRows.length,
      historyRows: input.historyRows.length,
      duplicateCurrentDecisionRows: duplicateDecisionIds.size,
      orphanHistoryRows,
    },
    blockedRelation: {
      canonicalRelationId: BLOCKED_RELATION as "19752996",
      machineStatus: "GREEN" as const,
      blockingReason: "MOUNTAIN_IDENTITY_MISSING" as const,
      staging: 0 as const,
      decision: 0 as const,
      history: 0 as const,
      includedInPersistedCalibrationResult: false as const,
    },
    records,
    calibrationResult,
    calibrationRationale,
    zeroWriteAttestation: {
      databaseWrites: 0 as const,
      qaWrites: 0 as const,
      qaHistoryWrites: 0 as const,
      stagingWrites: 0 as const,
      publicationWrites: 0 as const,
      activeChanges: 0 as const,
    },
  };
  return {
    ...content,
    deterministicArtifactHash: sha256Stable(content),
  };
}

function loadEnvironment(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function loadContracts(): Promise<FrozenContracts> {
  const [queueRaw, receiptRaw, payloadsRaw, stageabilityRaw, greensRaw] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(RECEIPT_PATH, "utf8"),
    readFile(PAYLOADS_PATH, "utf8"),
    readFile(STAGEABILITY_PATH, "utf8"),
    readFile(GREENS_PATH, "utf8"),
  ]);
  return {
    queueRaw,
    queue: JSON.parse(queueRaw) as QueueArtifact,
    receipt: JSON.parse(receiptRaw) as ReceiptArtifact,
    payloads: JSON.parse(payloadsRaw) as PayloadArtifact,
    stageability: JSON.parse(stageabilityRaw) as StageabilityArtifact,
    greens: JSON.parse(greensRaw) as GreensArtifact,
  };
}

async function loadChunks<T>(
  values: string[],
  load: (values: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < values.length; index += 40) {
    const result = await load(values.slice(index, index + 40));
    if (result.error) throw new Error(`Phase 11I-E read failed: ${result.error.message}`);
    rows.push(...(result.data ?? []));
  }
  return rows;
}

async function loadLiveRows(client: SupabaseClient, stagingIds: string[]) {
  const [stagingRows, summitRows, decisionRows, historyRows, blockedCanonical, blockedSource] =
    await Promise.all([
      loadChunks<LiveStagingRow>(stagingIds, (ids) =>
        client
          .from("osm_route_import_staging")
          .select("id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,import_eligibility,matched_primary_mountain_id")
          .in("id", ids),
      ),
      loadChunks<LiveSummitRow>(stagingIds, (ids) =>
        client
          .from("osm_route_import_summit_staging")
          .select("staging_route_id,peak_osm_id,mountain_id,final_association,mountain_match_classification")
          .in("staging_route_id", ids),
      ),
      loadChunks<LiveDecisionRow>(stagingIds, (ids) =>
        client
          .from("osm_staging_route_visual_qa")
          .select("staging_route_id,status,reviewer_note,reviewed_at,reviewer_user_id,version")
          .in("staging_route_id", ids),
      ),
      loadChunks<LiveHistoryRow>(stagingIds, (ids) =>
        client
          .from("osm_staging_route_visual_qa_history")
          .select("id,staging_route_id,old_status,new_status,reviewer_note,reviewer_user_id,decision_version,occurred_at")
          .in("staging_route_id", ids),
      ),
      client
        .from("osm_route_import_staging")
        .select("id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,import_eligibility,matched_primary_mountain_id")
        .eq("canonical_source_id", BLOCKED_RELATION),
      client
        .from("osm_route_import_staging")
        .select("id,contract_version,idempotency_key,payload_hash,source_relation_id,canonical_source_id,import_eligibility,matched_primary_mountain_id")
        .eq("source_relation_id", BLOCKED_RELATION),
    ]);
  if (blockedCanonical.error || blockedSource.error) {
    throw new Error(
      `Phase 11I-E blocked-relation read failed: ${blockedCanonical.error?.message ?? blockedSource.error?.message}`,
    );
  }
  const blockedById = new Map<string, LiveStagingRow>();
  for (const row of [...(blockedCanonical.data ?? []), ...(blockedSource.data ?? [])]) {
    blockedById.set(String(row.id), row as LiveStagingRow);
  }
  return {
    stagingRows,
    summitRows,
    decisionRows,
    historyRows,
    blockedStagingRows: [...blockedById.values()],
  };
}

export async function reconcilePhase11iHumanCalibration(): Promise<HumanCalibrationResult> {
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Phase 11I-E Supabase read credentials are missing.");
  const contracts = await loadContracts();
  const stagingIds = [...parseStagedIdentities(contracts.receipt).values()];
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const live = await loadLiveRows(client, stagingIds);
  const result = buildHumanCalibrationResult({
    contracts,
    ...live,
    auditedAt: new Date().toISOString(),
  });
  await writeJsonAtomically(RESULT_PATH, result);
  return result;
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  reconcilePhase11iHumanCalibration()
    .then((result) => {
      console.log(
        JSON.stringify(
          {
            artifact: RESULT_PATH,
            distribution: result.decisionDistribution,
            historyIntegrityPass: result.integrity.historyIntegrityPass,
            payloadCompatibilityPass: result.integrity.payloadCompatibilityPass,
            calibrationResult: result.calibrationResult,
            zeroWriteAttestation: result.zeroWriteAttestation,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
