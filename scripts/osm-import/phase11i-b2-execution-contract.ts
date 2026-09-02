import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { sha256Stable } from "./phase11-publication.ts";

const STAGING = "data/osm/alps/staging";
const QUEUE_PATH = `${STAGING}/phase11h-human-calibration-queue.json`;
const QUEUE_SHA256 = "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const OLD_CONTRACT_PATH = `${STAGING}/phase11i-human-calibration-staging-contract.json`;
const OLD_EXECUTION_TOKEN_PREFIX = "PHASE11I:";
const SNAPSHOT_PATH = `${STAGING}/phase11i-b2-human-calibration-source-snapshot.json`;
const STAGEABILITY_PATH = `${STAGING}/phase11i-b2-human-calibration-stageability.json`;
const PAYLOADS_PATH = `${STAGING}/phase11i-b2-human-calibration-staging-payloads.json`;
const OUT_CONTRACT_PATH = `${STAGING}/phase11i-b2-execution-contract.json`;

export const B2_EXECUTION_CONTRACT_VERSION = "mountain-tracker-phase11i-b2-execution-contract/v1" as const;

export interface B2ExecutionContractRecord {
  canonicalRelationId: string;
  peakOsmId: string;
  mountainId: number;
  geometryHash: string;
  qualificationHash: string;
  mainPayloadHash: string;
  summitPayloadHash: string;
}

export interface B2ExecutionContract {
  schemaVersion: number;
  artifactType: "PHASE11I_B2_EXECUTION_CONTRACT";
  contractVersion: typeof B2_EXECUTION_CONTRACT_VERSION;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  executed: boolean;
  databaseModeBefore: "SELECT_ONLY";
  phase: "Phase 11I-B2a frozen staging payload contract validated; execution in Phase 11I-B2b requires explicit user command with the execution token.";
  originalQueueHash: string;
  originalQueueCount: number;
  stageableSubsetHash: string;
  stageableCount: number;
  blockedCount: number;
  sourceSnapshotHash: string;
  stageabilityHash: string;
  payloadArtifactHash: string;
  oldExecutionToken: string;
  executionToken: string;
  records: B2ExecutionContractRecord[];
  blockedRecords: Array<{
    canonicalRelationId: string;
    summitOsmId: string;
    blockingReason: string;
  }>;
  expectedBeforeState: {
    stagingRowsForRelations: 0;
    summitAssociationRowsForRelations: 0;
    qaDecisionRows: 0;
    qaHistoryRows: 0;
    publishedRoutesForRelations: 0;
  };
  expectedAfterState: {
    stagingRowsForRelations: 44;
    summitAssociationRowsForRelations: 44;
    qaDecisionRows: 0;
    qaHistoryRows: 0;
    publishedRoutesForRelations: 0;
  };
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function computeHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function buildExecutionContract(): Promise<B2ExecutionContract> {
  const [queueRaw, oldContractRaw, snapshotRaw, stageabilityRaw, payloadsRaw] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(OLD_CONTRACT_PATH, "utf8"),
    readFile(SNAPSHOT_PATH, "utf8"),
    readFile(STAGEABILITY_PATH, "utf8"),
    readFile(PAYLOADS_PATH, "utf8"),
  ]);

  const queueHash = computeHash(queueRaw);
  if (queueHash !== QUEUE_SHA256) {
    throw new Error(`PHASE11I_B2_QUEUE_HASH_DRIFT: expected ${QUEUE_SHA256}, found ${queueHash}`);
  }

  const queueArtifact = JSON.parse(queueRaw) as {
    sample: Array<{ canonicalRelationId: string }>;
    sampleSize: number;
    deterministicArtifactHash: string;
  };
  if (queueArtifact.sampleSize !== 45 || queueArtifact.sample.length !== 45) {
    throw new Error("PHASE11I_B2_QUEUE_COUNT_DRIFT");
  }

  const oldContract = JSON.parse(oldContractRaw) as {
    executionToken: string;
    records: Array<{ canonicalRelationId: string }>;
    deterministicArtifactHash: string;
  };
  const oldToken = oldContract.executionToken;
  if (!oldToken.startsWith(OLD_EXECUTION_TOKEN_PREFIX)) {
    throw new Error("PHASE11I_B2_OLD_TOKEN_FORMAT");
  }

  const snapshot = JSON.parse(snapshotRaw) as {
    records: Array<{
      canonicalRelationId: string;
      geometryHash: string;
      summit: { peakOsmId: string };
      mountain: { mountainId: number };
      qualification: { qualificationHash: string };
    }>;
    exclusions: Array<{ canonicalRelationId: string }>;
    deterministicArtifactHash: string;
    sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
  };

  const stageability = JSON.parse(stageabilityRaw) as {
    originalQueueCount: number;
    stageableCount: number;
    blockedCount: number;
    blockedRelation: { canonicalRelationId: string; summitOsmId: string; blockingReason: string } | null;
    records: Array<{
      canonicalRelationId: string;
      stagingEligible: boolean;
    }>;
    deterministicArtifactHash: string;
  };

  const payloads = JSON.parse(payloadsRaw) as {
    mainPayloadCount: number;
    summitPayloadCount: number;
    records: Array<{
      canonicalRelationId: string;
      mainPayloadHash: string;
      summitPayloadHash: string;
    }>;
    deterministicArtifactHash: string;
  };

  if (stageability.originalQueueCount !== 45) {
    throw new Error("PHASE11I_B2_STAGEABILITY_QUEUE_COUNT_DRIFT");
  }
  if (stageability.stageableCount !== 44 || stageability.blockedCount !== 1) {
    throw new Error("PHASE11I_B2_STAGEABILITY_COUNTS_DRIFT");
  }
  if (snapshot.records.length !== 44) {
    throw new Error("PHASE11I_B2_SNAPSHOT_RECORD_COUNT_DRIFT");
  }
  if (snapshot.exclusions.length !== 1) {
    throw new Error("PHASE11I_B2_SNAPSHOT_EXCLUSION_COUNT_DRIFT");
  }
  if (payloads.mainPayloadCount !== 44 || payloads.summitPayloadCount !== 44) {
    throw new Error("PHASE11I_B2_PAYLOAD_COUNT_DRIFT");
  }

  const payloadByRelation = new Map(payloads.records.map((r) => [r.canonicalRelationId, r]));

  const records: B2ExecutionContractRecord[] = snapshot.records.map((record) => {
    const payloadRecord = payloadByRelation.get(record.canonicalRelationId);
    if (!payloadRecord) {
      throw new Error(`PHASE11I_B2_MISSING_PAYLOAD:${record.canonicalRelationId}`);
    }
    return {
      canonicalRelationId: record.canonicalRelationId,
      peakOsmId: record.summit.peakOsmId,
      mountainId: record.mountain.mountainId,
      geometryHash: record.geometryHash,
      qualificationHash: record.qualification.qualificationHash,
      mainPayloadHash: payloadRecord.mainPayloadHash,
      summitPayloadHash: payloadRecord.summitPayloadHash,
    };
  });

  if (records.length !== 44) {
    throw new Error("PHASE11I_B2_EXECUTION_RECORD_COUNT_DRIFT");
  }

  const recordIds = records.map((r) => r.canonicalRelationId);
  if (new Set(recordIds).size !== 44) {
    throw new Error("PHASE11I_B2_EXECUTION_DUPLICATE_RELATIONS");
  }

  if (!stageability.blockedRelation) {
    throw new Error("PHASE11I_B2_MISSING_BLOCKED_RELATION");
  }

  const tokenContent = {
    version: "phase11i-b2",
    queueHash,
    snapshotHash: snapshot.deterministicArtifactHash,
    stageabilityHash: stageability.deterministicArtifactHash,
    payloadHash: payloads.deterministicArtifactHash,
    recordIds: [...recordIds].sort((a, b) => Number(a) - Number(b)),
    mountainIds: records.map((r) => r.mountainId).sort((a, b) => a - b),
    geometryHashes: records.map((r) => r.geometryHash).sort(),
    blockedRelationId: stageability.blockedRelation.canonicalRelationId,
  };
  const executionToken = `PHASE11I-B2:${sha256Stable(tokenContent)}:${queueHash}`;

  const content: Omit<B2ExecutionContract, "deterministicArtifactHash"> = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_EXECUTION_CONTRACT",
    contractVersion: B2_EXECUTION_CONTRACT_VERSION,
    readOnly: true,
    publishable: false,
    qaDecisionWrites: 0,
    autoApprovalEnabled: false,
    executed: false,
    databaseModeBefore: "SELECT_ONLY",
    phase: "Phase 11I-B2a frozen staging payload contract validated; execution in Phase 11I-B2b requires explicit user command with the execution token.",
    originalQueueHash: queueHash,
    originalQueueCount: 45,
    stageableSubsetHash: stageability.deterministicArtifactHash,
    stageableCount: 44,
    blockedCount: 1,
    sourceSnapshotHash: snapshot.deterministicArtifactHash,
    stageabilityHash: stageability.deterministicArtifactHash,
    payloadArtifactHash: payloads.deterministicArtifactHash,
    oldExecutionToken: oldToken,
    executionToken,
    records,
    blockedRecords: [
      {
        canonicalRelationId: stageability.blockedRelation.canonicalRelationId,
        summitOsmId: stageability.blockedRelation.summitOsmId,
        blockingReason: stageability.blockedRelation.blockingReason,
      },
    ],
    expectedBeforeState: {
      stagingRowsForRelations: 0,
      summitAssociationRowsForRelations: 0,
      qaDecisionRows: 0,
      qaHistoryRows: 0,
      publishedRoutesForRelations: 0,
    },
    expectedAfterState: {
      stagingRowsForRelations: 44,
      summitAssociationRowsForRelations: 44,
      qaDecisionRows: 0,
      qaHistoryRows: 0,
      publishedRoutesForRelations: 0,
    },
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };

  const deterministicArtifactHash = sha256Stable(content);
  return { ...content, deterministicArtifactHash };
}

async function main(): Promise<void> {
  const contract = await buildExecutionContract();

  if (contract.executed) throw new Error("PHASE11I_B2_CONTRACT_ALREADY_EXECUTED");
  if (contract.stageableCount !== 44) throw new Error("PHASE11I_B2_CONTRACT_STAGEABLE_DRIFT");
  if (contract.blockedCount !== 1) throw new Error("PHASE11I_B2_CONTRACT_BLOCKED_DRIFT");
  if (contract.records.length !== 44) throw new Error("PHASE11I_B2_CONTRACT_RECORD_DRIFT");
  if (contract.executionToken === contract.oldExecutionToken) {
    throw new Error("PHASE11I_B2_TOKEN_SAME_AS_OLD");
  }
  if (contract.blockedRecords.length !== 1) throw new Error("PHASE11I_B2_CONTRACT_BLOCKED_RECORD_DRIFT");
  if (contract.blockedRecords[0].canonicalRelationId !== "19752996") {
    throw new Error("PHASE11I_B2_CONTRACT_BLOCKED_RELATION_UNEXPECTED");
  }
  if (contract.blockedRecords[0].blockingReason !== "MOUNTAIN_IDENTITY_MISSING") {
    throw new Error("PHASE11I_B2_CONTRACT_BLOCKED_REASON_UNEXPECTED");
  }

  await writeFile(OUT_CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

  const fileHash = sha256Bytes(Buffer.from(JSON.stringify(contract)));
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PASS",
        stageableCount: contract.stageableCount,
        blockedCount: contract.blockedCount,
        executionToken: contract.executionToken,
        oldExecutionToken: contract.oldExecutionToken,
        contractPath: OUT_CONTRACT_PATH,
        contractHash: fileHash,
        deterministicArtifactHash: contract.deterministicArtifactHash,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
