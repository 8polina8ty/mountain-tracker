import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Stable } from "./phase11-publication.ts";
import { writeJsonAtomically } from "./jsonl.ts";
import {
  createPhase11hAdminClient,
  loadPhase11hBeforeState,
} from "./phase11h-live.ts";

const STAGING = "data/osm/alps/staging";
const QUEUE_PATH = resolve(`${STAGING}/phase11h-human-calibration-queue.json`);
const QUEUE_SHA256 = "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const SNAPSHOT_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-source-snapshot.json`);
const STAGEABILITY_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-stageability.json`);
const PAYLOADS_PATH = resolve(`${STAGING}/phase11i-b2-human-calibration-staging-payloads.json`);
const CONTRACT_PATH = resolve(`${STAGING}/phase11i-b2-execution-contract.json`);
const OUT_PREFLIGHT_PATH = resolve(`${STAGING}/phase11i-b2-preflight.json`);

const BLOCKED_RELATION = "19752996";
const STAGEABLE_TOTAL = 44;

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function recomputeDeterministicHash(artifact: Record<string, unknown>): string {
  const content = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  delete content.deterministicArtifactHash;
  return sha256Stable(content);
}

function pinnedMatches(label: string, actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`PHASE11I_B2_PREFLIGHT_${label}_DRIFT`);
}

async function main(): Promise<void> {
  const [queueRaw, snapshotRaw, stageabilityRaw, payloadsRaw, contractRaw] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(SNAPSHOT_PATH, "utf8"),
    readFile(STAGEABILITY_PATH, "utf8"),
    readFile(PAYLOADS_PATH, "utf8"),
    readFile(CONTRACT_PATH, "utf8"),
  ]);

  const queue = JSON.parse(queueRaw) as {
    sample: Array<{ canonicalRelationId: string; humanDecisionStatus: string | null }>;
    deterministicArtifactHash: string;
  };
  const snapshot = JSON.parse(snapshotRaw) as {
    records: Array<{
      canonicalRelationId: string;
      summit: { peakOsmId: string };
      mountain: { mountainId: number };
      geometryHash: string;
    }>;
    deterministicArtifactHash: string;
  };
  const stageability = JSON.parse(stageabilityRaw) as {
    deterministicArtifactHash: string;
  };
  const payloads = JSON.parse(payloadsRaw) as {
    deterministicArtifactHash: string;
  };
  const contract = JSON.parse(contractRaw) as {
    deterministicArtifactHash: string;
    executed: boolean;
    originalQueueHash: string;
    records: Array<{
      canonicalRelationId: string;
      peakOsmId: string;
      mountainId: number;
      mainPayloadHash: string;
    }>;
    oldExecutionToken: string;
    executionToken: string;
  };

  pinnedMatches(
    "QUEUE_FILE",
    sha256Bytes(Buffer.from(queueRaw)),
    QUEUE_SHA256,
  );
  pinnedMatches(
    "QUEUE_DETERMINISTIC",
    recomputeDeterministicHash(queue as unknown as Record<string, unknown>),
    queue.deterministicArtifactHash,
  );
  pinnedMatches(
    "SNAPSHOT_DETERMINISTIC",
    recomputeDeterministicHash(snapshot as unknown as Record<string, unknown>),
    snapshot.deterministicArtifactHash,
  );
  pinnedMatches(
    "STAGEABILITY_DETERMINISTIC",
    recomputeDeterministicHash(stageability as unknown as Record<string, unknown>),
    stageability.deterministicArtifactHash,
  );
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
  if (contract.executed) throw new Error("PHASE11I_B2_PREFLIGHT_CONTRACT_EXECUTED");
  if (contract.originalQueueHash !== QUEUE_SHA256) {
    throw new Error("PHASE11I_B2_PREFLIGHT_CONTRACT_QUEUE_HASH_DRIFT");
  }

  if (queue.sample.length !== 45) throw new Error("PHASE11I_B2_PREFLIGHT_QUEUE_COUNT_DRIFT");
  if (snapshot.records.length !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_PREFLIGHT_SNAPSHOT_COUNT_DRIFT");
  }
  if (contract.records.length !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_PREFLIGHT_CONTRACT_COUNT_DRIFT");
  }

  if (
    contract.executionToken === contract.oldExecutionToken ||
    !contract.executionToken.startsWith("PHASE11I-B2:")
  ) {
    throw new Error("PHASE11I_B2_PREFLIGHT_TOKEN_UNEXPECTED");
  }

  const blockedMember = queue.sample.find((m) => m.canonicalRelationId === BLOCKED_RELATION);
  if (!blockedMember) throw new Error(`PHASE11I_B2_PREFLIGHT_MISSING_BLOCKED_IN_QUEUE:${BLOCKED_RELATION}`);
  if (blockedMember.humanDecisionStatus !== null) {
    throw new Error("PHASE11I_B2_PREFLIGHT_BLOCKED_DECIDED");
  }
  if (contract.records.some((r) => r.canonicalRelationId === BLOCKED_RELATION)) {
    throw new Error("PHASE11I_B2_PREFLIGHT_BLOCKED_IN_SCOPE");
  }

  const relationIds = contract.records.map((r) => r.canonicalRelationId);
  if (new Set(relationIds).size !== STAGEABLE_TOTAL) {
    throw new Error("PHASE11I_B2_PREFLIGHT_DUPLICATE_RELATIONS");
  }

  const client = await createPhase11hAdminClient();

  const beforeState = await loadPhase11hBeforeState(client, relationIds);

  const stagingByRelation = beforeState.stagingRowsByRelation;
  const published = new Set<string>();
  for (const relation of relationIds) {
    if (
      beforeState.provenanceByRelation.has(relation) ||
      beforeState.publishedRelationIds.has(relation)
    ) {
      published.add(relation);
    }
  }

  const identityByRelation = new Map<string, { mountainId: number; peakOsmId: string }>();
  for (const record of snapshot.records) {
    identityByRelation.set(record.canonicalRelationId, {
      mountainId: record.mountain.mountainId,
      peakOsmId: record.summit.peakOsmId,
    });
  }

  const peakOsmIds = [...new Set(identityByRelation.values().map((v) => v.peakOsmId))];
  const chunkSize = 40;
  const mountainDrift: string[] = [];
  const deployedMountainByOsm = new Map<string, number>();
  for (let index = 0; index < peakOsmIds.length; index += chunkSize) {
    const chunkPeaks = peakOsmIds.slice(index, index + chunkSize);
    const response = await client
      .from("mountains")
      .select("id,osm_id")
      .in("osm_id", chunkPeaks);
    if (response.error) throw new Error(`PHASE11I_B2_PREFLIGHT_MOUNTAIN_QUERY:${response.error.message}`);
    const rows = (response.data ?? []) as Array<{ id: number | string; osm_id: string | null }>;
    for (const row of rows) {
      const osmId = String(row.osm_id ?? "");
      if (osmId) deployedMountainByOsm.set(osmId, Number(row.id));
    }
  }
  for (const [relation, identity] of identityByRelation) {
    const deployedId = deployedMountainByOsm.get(identity.peakOsmId);
    if (deployedId === undefined) {
      mountainDrift.push(`${relation}:peakOsmId=${identity.peakOsmId}:MISSING_IN_MOUNTAINS`);
    } else if (identity.mountainId !== deployedId) {
      mountainDrift.push(`${relation}:expectedMountain=${identity.mountainId}:deployed=${deployedId}`);
    }
  }

  let payloadConflicts = 0;
  let qaConflicts = 0;
  let activeOverlap = 0;
  let otherBlocked = 0;
  let wouldCreate = 0;
  const exactUnchanged = 0;

  const records = relationIds.map((relation) => {
    const identity = identityByRelation.get(relation)!;
    const stagingRow = stagingByRelation.get(relation);
    const isPublished = published.has(relation);
    const isActive =
      beforeState.provenanceByRelation.get(relation)?.publication_status?.toUpperCase() === "ACTIVE";
    const qaHit =
      stagingRow &&
      (beforeState.qaStagingIds.has(stagingRow.id) || beforeState.qaHistoryStagingIds.has(stagingRow.id));

    let action: "WOULD_CREATE" | "BLOCKED";
    let reason: string | null = null;
    if (stagingRow) {
      action = "BLOCKED";
      reason = "PAYLOAD_CONFLICT_STAGING_ROW_ALREADY_PRESENT";
    } else if (qaHit) {
      action = "BLOCKED";
      reason = "QA_DECISION_OR_HISTORY_PRESENT";
    } else if (isPublished || isActive) {
      action = "BLOCKED";
      reason = "ALREADY_PUBLISHED_ACTIVE";
    } else {
      action = "WOULD_CREATE";
      reason = null;
    }

    if (action === "WOULD_CREATE") wouldCreate += 1;
    else if (stagingRow) payloadConflicts += 1;
    else if (qaHit) qaConflicts += 1;
    else if (isPublished || isActive) activeOverlap += 1;
    else otherBlocked += 1;

    return {
      canonicalRelationId: relation,
      peakOsmId: identity.peakOsmId,
      frozenMountainId: identity.mountainId,
      action,
      reason,
      identityDrift: mountainDrift.some((d) => d.startsWith(`${relation}:`)),
      downstream: {
        staging: Boolean(stagingRow),
        published: isPublished,
        active: isActive,
        qa: qaHit,
      },
    };
  });

  const mountainIdentityDrift = new Set(
    mountainDrift.map((d) => d.split(":")[0]),
  ).size;

  const executionSafe =
    wouldCreate === STAGEABLE_TOTAL &&
    exactUnchanged === 0 &&
    payloadConflicts === 0 &&
    qaConflicts === 0 &&
    activeOverlap === 0 &&
    mountainIdentityDrift === 0 &&
    otherBlocked === 0;

  const preflight = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_PREFLIGHT",
    phase: "Phase 11I-B2a live SELECT-only preflight on the new frozen B2 contract.",
    databaseMode: "SELECT_ONLY",
    readOnly: true,
    publishable: false,
    checkedAt: new Date().toISOString(),
    queueFileSha256: QUEUE_SHA256,
    queueCount: 45,
    stageableCount: STAGEABLE_TOTAL,
    blockedCount: 1,
    blockedRelation: BLOCKED_RELATION,
    records,
    summary: {
      wouldCreate,
      exactUnchanged,
      payloadConflicts,
      qaConflicts,
      activeOverlap,
      mountainIdentityDrift,
      otherBlocked,
    },
    executionSafe,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
    deterministicArtifactHash: "",
  } as Record<string, unknown>;

  const deterministicArtifactHash = sha256Stable(preflight);
  const artifact = { ...preflight, deterministicArtifactHash };

  await writeJsonAtomically(OUT_PREFLIGHT_PATH, artifact);

  process.stdout.write(
    `${JSON.stringify(
      {
        executionSafe,
        summary: {
          wouldCreate,
          exactUnchanged,
          payloadConflicts,
          qaConflicts,
          activeOverlap,
          mountainIdentityDrift,
          otherBlocked,
        },
        preflightPath: OUT_PREFLIGHT_PATH,
        preflightFileSha256: sha256Bytes(Buffer.from(await readFile(OUT_PREFLIGHT_PATH, "utf8"))),
        deterministicArtifactHash,
        writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
