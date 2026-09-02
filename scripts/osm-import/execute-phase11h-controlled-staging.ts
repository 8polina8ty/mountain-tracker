import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Stable } from "./phase11-publication.ts";

const QUEUE_PATH = resolve("data/osm/alps/staging/phase11h-human-calibration-queue.json");
const PLAN_PATH = resolve("data/osm/alps/staging/phase11h-controlled-staging-plan.json");
const READINESS_PATH = resolve("data/osm/alps/staging/phase11h-readiness.json");
const NAME_AUDIT_PATH = resolve("data/osm/alps/staging/phase11h-name-resolution-audit.json");
const GREENS_PATH = resolve("data/osm/alps/staging/phase11g-expanded-green-candidates.json");
const CONTRACT_PATH = resolve(
  "data/osm/alps/staging/phase11i-human-calibration-staging-contract.json",
);
const EXECUTION_PAYLOAD_CONTRACT_PATH = resolve(
  "data/osm/alps/staging/phase11i-executable-staging-plan.jsonl",
);
const ALLOWLISTED_CONTRACT_ARG = "data/osm/alps/staging/phase11i-human-calibration-staging-contract.json";

const REQUIRED_RELATION_COUNT = 45;
const QUEUE_FILE_SHA256 =
  "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const PLAN_FILE_SHA256 =
  "87551e00ecd94f517720e4cfea2b51a98d1da12620e34c627156d5d3bc9b9cf0";
const READINESS_FILE_SHA256 =
  "3e1cd9f3681672e59e0de8d738d87cc2cc1f7c38a3a4449a9d8b235a3e650ede";
const NAME_AUDIT_FILE_SHA256 =
  "318755974ecb0c7297bf5d5a0ead052c6cbea09bd09e3e9dc1c97c8c1d0c5b90";
const PLAN_DETERMINISTIC_HASH =
  "e5f2d73878be862c2066a56c79ea67e5afd2536ed1d340339feb87039e94c6a6";
const CONTRACT_FILE_SHA256 =
  "183706634754b14bbae0e79c16bd43708140b338690200f210cd9d3b5f7cc1a1";

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function recomputeDeterministicHash(artifact: Record<string, unknown>): string {
  const content = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  delete content.deterministicArtifactHash;
  return sha256Stable(content);
}

function pinnedMatches(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`PHASE11H_${label}_DRIFT: expected ${expected}, found ${actual}.`);
  }
}

export interface QueueArtifact {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: boolean;
  autoApprovalEnabled: boolean;
  queueVersion: string;
  selectionTargetSize: number;
  qaQuestionContractVersion: string;
  qaStatusVocabulary: string[];
  questions: Array<{ id: string; prompt: string }>;
  sampleSize: number;
  sample: Array<{
    canonicalRelationId: string;
    candidateHash: string;
    qualificationHash: string;
    nameStatus: string;
    nameOrigin: string | null;
    resolvedDisplayName: string | null;
    startContext: string | null;
    qualityBand: string;
    selectionTier: string;
    selectionReason: string | null;
    humanDecisionStatus: string | null;
    humanDecisionReviewerId: string | null;
    humanDecisionReviewedAt: string | null;
    humanDecisionNote: string | null;
  }>;
  noPrefilledHumanDecision: boolean;
  deterministicArtifactHash: string;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

interface PlanArtifact {
  executed: boolean;
  readOnly: boolean;
  scope: { relations: string[] };
  deterministicArtifactHash: string;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

interface GreensArtifact {
  records: Array<{
    canonicalRouteSourceId: string;
    safeStatus: string;
    qualityScore: number;
    deterministicQualificationHash: string;
  }>;
}

export interface FrozenContract {
  executed: boolean;
  databaseModeBefore: string;
  executionToken: string;
  queueHash: string;
  queueDeterministicArtifactHash: string;
  queueVersion: string;
  expectedBeforeState: {
    stagingRowsForRelations: number;
    summitAssociationRowsForRelations: number;
    qaDecisionRows: number;
    qaHistoryRows: number;
    publishedRoutesForRelations: number;
  };
  records: Array<{ sourceRelationId: string; canonicalRelationId: string }>;
  [key: string]: unknown;
}

export interface Phase11iB1ArtifactVerification {
  queueArtifact: QueueArtifact;
  frozenContract: FrozenContract;
  contractFileSha256: string;
}

export async function verifyPhase11hArtifacts(): Promise<Phase11iB1ArtifactVerification> {
  const [queue, plan, readiness, nameAudit, greens, contract] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(PLAN_PATH, "utf8"),
    readFile(READINESS_PATH, "utf8"),
    readFile(NAME_AUDIT_PATH, "utf8"),
    readFile(GREENS_PATH, "utf8"),
    readFile(CONTRACT_PATH, "utf8"),
  ]);
  pinnedMatches("QUEUE_FILE", sha256Bytes(Buffer.from(queue)), QUEUE_FILE_SHA256);
  pinnedMatches("PLAN_FILE", sha256Bytes(Buffer.from(plan)), PLAN_FILE_SHA256);
  pinnedMatches("READINESS_FILE", sha256Bytes(Buffer.from(readiness)), READINESS_FILE_SHA256);
  pinnedMatches("NAME_AUDIT_FILE", sha256Bytes(Buffer.from(nameAudit)), NAME_AUDIT_FILE_SHA256);
  pinnedMatches("CONTRACT_FILE", sha256Bytes(Buffer.from(contract)), CONTRACT_FILE_SHA256);

  const queueArtifact = JSON.parse(queue) as QueueArtifact;
  const planArtifact = JSON.parse(plan) as PlanArtifact;
  const readinessArtifact = JSON.parse(readiness) as {
    calibration: { humanCalibrationReady: boolean };
  };
  const greensArtifact = JSON.parse(greens) as GreensArtifact;
  const frozenContract = JSON.parse(contract) as FrozenContract;

  pinnedMatches(
    "QUEUE_DETERMINISTIC",
    recomputeDeterministicHash(queueArtifact as unknown as Record<string, unknown>),
    queueArtifact.deterministicArtifactHash,
  );
  pinnedMatches(
    "PLAN_DETERMINISTIC",
    recomputeDeterministicHash(planArtifact as unknown as Record<string, unknown>),
    PLAN_DETERMINISTIC_HASH,
  );
  pinnedMatches(
    "PLAN_EMBEDDED_DETERMINISTIC",
    planArtifact.deterministicArtifactHash,
    PLAN_DETERMINISTIC_HASH,
  );
  if (
    queueArtifact.writes.databaseWrites !== 0 ||
    queueArtifact.writes.qaWrites !== 0 ||
    queueArtifact.writes.publicationWrites !== 0 ||
    planArtifact.writes.databaseWrites !== 0 ||
    planArtifact.writes.qaWrites !== 0 ||
    planArtifact.writes.publicationWrites !== 0
  ) {
    throw new Error("PHASE11H_FROZEN_ARTIFACT_PROMISED_WRITES");
  }
  if (!readinessArtifact.calibration.humanCalibrationReady) {
    throw new Error("PHASE11H_READINESS_NOT_CONFIRMED");
  }
  if (!planArtifact.readOnly || planArtifact.executed) {
    throw new Error("PHASE11H_PLAN_NO_LONGER_READ_ONLY");
  }
  if (frozenContract.executed || frozenContract.databaseModeBefore !== "SELECT_ONLY") {
    throw new Error("PHASE11H_CONTRACT_NO_LONGER_SELECT_ONLY");
  }
  if (
    frozenContract.queueHash !== QUEUE_FILE_SHA256 ||
    frozenContract.queueDeterministicArtifactHash !== queueArtifact.deterministicArtifactHash ||
    frozenContract.records.length !== REQUIRED_RELATION_COUNT
  ) {
    throw new Error("PHASE11H_FROZEN_CONTRACT_DRIFT");
  }

  const members = queueArtifact.sample.map(
    (value) =>
      ({
        canonicalRelationId: String(value.canonicalRelationId ?? ""),
        qualificationHash: String(value.qualificationHash ?? ""),
        candidateHash: String(value.candidateHash ?? ""),
        humanDecisionStatus: value.humanDecisionStatus === null ? null : value.humanDecisionStatus,
      }) as {
        canonicalRelationId: string;
        qualificationHash: string;
        candidateHash: string;
        humanDecisionStatus: string | null;
      },
  );
  if (members.length !== REQUIRED_RELATION_COUNT) {
    throw new Error(`PHASE11H_QUEUE_MEMBER_COUNT:${members.length}`);
  }
  if (
    members.some((member) => member.humanDecisionStatus !== null) ||
    members.some(
      (member) =>
        !/^\d+$/.test(member.canonicalRelationId) ||
        !/^[0-9a-f]{64}$/.test(member.qualificationHash) ||
        !/^[0-9a-f]{64}$/.test(member.candidateHash),
    )
  ) {
    throw new Error("PHASE11H_QUEUE_INVALID_OR_PREDECIDED");
  }
  const memberIds = members.map((member) => member.canonicalRelationId);
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error("PHASE11H_QUEUE_DUPLICATE_RELATIONS");
  }
  if (planArtifact.scope.relations.length !== memberIds.length) {
    throw new Error("PHASE11H_PLAN_SCOPE_COUNT_DRIFT");
  }
  if (planArtifact.scope.relations.some((relation) => !memberIds.includes(relation))) {
    throw new Error("PHASE11H_QUEUE_PLAN_SCOPE_MISMATCH");
  }

  const greenByRelation = new Map(
    greensArtifact.records.map((record) => [record.canonicalRouteSourceId, record]),
  );
  for (const member of members) {
    const green = greenByRelation.get(member.canonicalRelationId);
    if (!green) throw new Error(`PHASE11H_MISSING_GREEN:${member.canonicalRelationId}`);
    if (green.safeStatus !== "GREEN") {
      throw new Error(`PHASE11H_NOT_GREEN:${member.canonicalRelationId}`);
    }
    if (green.deterministicQualificationHash !== member.qualificationHash) {
      throw new Error(`PHASE11H_QUALIFICATION_HASH_DRIFT:${member.canonicalRelationId}`);
    }
  }

  return { queueArtifact, frozenContract, contractFileSha256: CONTRACT_FILE_SHA256 };
}

export interface Phase11iB1DryRunReport {
  status: string;
  mode: string;
  executeFlagPresent: boolean;
  databaseWrites: number;
  qaWrites: number;
  publicationWrites: number;
  activeChanges: number;
  planned: number;
  wouldCreate: number;
  unchanged: number;
  conflicts: number;
  blocked: number;
  queueVersion: string;
  queueHash: string;
  queueDeterministicArtifactHash: string;
  contractFileSha256: string;
  executionTokenVerified: boolean;
  payloadContractPresent: boolean;
  notes: string[];
}

export function buildPhase11iB1DryRunReport(
  verification: Phase11iB1ArtifactVerification,
): Phase11iB1DryRunReport {
  const { queueArtifact, contractFileSha256 } = verification;
  return {
    status: "PASS",
    mode: "DRY_RUN",
    executeFlagPresent: false,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
    activeChanges: 0,
    planned: REQUIRED_RELATION_COUNT,
    wouldCreate: REQUIRED_RELATION_COUNT,
    unchanged: 0,
    conflicts: 0,
    blocked: 0,
    queueVersion: "phase11h-calibration-1",
    queueHash: QUEUE_FILE_SHA256,
    queueDeterministicArtifactHash: queueArtifact.deterministicArtifactHash,
    contractFileSha256,
    executionTokenVerified: false,
    payloadContractPresent: false,
    notes: [
      "Phase 11I-B1 controlled staging executor: DRY-RUN ONLY.",
      "No Supabase dependency is used without --execute.",
      "Staging rows, QA decisions, publications, and ACTIVE changes write nothing.",
      "The frozen execution contract file SHA-256 is verified; its embedded execution token does not recompute from the current file content and must only be supplied verbatim at a later authorized execution.",
      "Actual row creation requires a separately authorized Phase 11I-B execution and a payload contract that does not exist in this workspace.",
    ],
  };
}

function parseArgs(argv: string[]): { execute: boolean; token: string | null; contractPath: string | null } {
  let execute = false;
  let token: string | null = null;
  let contractPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      execute = true;
    } else if (argument === "--token" || argument === "--contract") {
      const value = argv[index + 1];
      if (!value) throw new Error(`PHASE11H_ARGUMENT_VALUE_REQUIRED:${argument}`);
      index += 1;
      if (argument === "--token") token = value;
      else contractPath = value;
    } else {
      throw new Error(`PHASE11H_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  if (contractPath !== null && contractPath !== ALLOWLISTED_CONTRACT_ARG) {
    throw new Error("PHASE11H_CONTRACT_PATH_NOT_ALLOWLISTED");
  }
  return { execute, token, contractPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const verification = await verifyPhase11hArtifacts();

  if (options.execute) {
    const frozenToken = verification.frozenContract.executionToken;
    if (!options.token) throw new Error("PHASE11H_EXECUTION_TOKEN_REQUIRED");
    if (options.token !== frozenToken) throw new Error("PHASE11H_EXECUTION_TOKEN_MISMATCH");
    const tokenParts = frozenToken.split(":");
    if (
      tokenParts.length !== 3 ||
      tokenParts[0] !== "PHASE11I" ||
      !/^[0-9a-f]{64}$/.test(tokenParts[1]) ||
      tokenParts[2] !== QUEUE_FILE_SHA256
    ) {
      throw new Error("PHASE11H_EXECUTION_TOKEN_MALFORMED");
    }
    try {
      await readFile(EXECUTION_PAYLOAD_CONTRACT_PATH, "utf8");
    } catch {
      throw new Error("PHASE11H_EXECUTION_PAYLOAD_CONTRACT_UNAVAILABLE");
    }
    throw new Error("PHASE11H_EXECUTE_MODE_DISABLED_IN_THIS_RELEASE");
  }

  const report = buildPhase11iB1DryRunReport(verification);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});