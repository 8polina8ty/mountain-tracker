import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sha256Stable } from "./phase11-publication.ts";
import { createPhase11hAdminClient } from "./phase11h-live.ts";

const STAGING = "data/osm/alps/staging";
const CANONICAL_CONFIRMED = "data/osm/alps/audit/canonical-confirmed-routes.jsonl";
const GREENS_PATH = `${STAGING}/phase11g-expanded-green-candidates.json`;
const QUEUE_PATH = `${STAGING}/phase11h-human-calibration-queue.json`;
const NAME_AUDIT_PATH = `${STAGING}/phase11h-name-resolution-audit.json`;
const OUT_STAGEABILITY_PATH = `${STAGING}/phase11i-b2-human-calibration-stageability.json`;

export const STAGEABILITY_CONTRACT = "mountain-tracker-phase11i-b2-stageability/v1" as const;

export type MountainResolutionStatus = "EXACT" | "MISSING" | "AMBIGUOUS";

export interface StageabilityRecord {
  canonicalRelationId: string;
  summitOsmId: string;
  mountainResolutionStatus: MountainResolutionStatus;
  resolvedMountainId: number | null;
  resolutionEvidence: string[];
  stagingEligible: boolean;
  blockingReason: string | null;
}

export interface B2StageabilityArtifact {
  schemaVersion: number;
  artifactType: "PHASE11I_B2_STAGEABILITY";
  contractVersion: typeof STAGEABILITY_CONTRACT;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  originalQueueCount: number;
  stageableCount: number;
  blockedCount: number;
  exactCount: number;
  missingCount: number;
  ambiguousCount: number;
  blockedRelation: {
    canonicalRelationId: string;
    route: string | null;
    summitOsmId: string;
    blockingReason: string;
  } | null;
  records: StageabilityRecord[];
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadEnv(content: string): void {
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

interface QueueMember {
  canonicalRelationId: string;
  qualificationHash: string;
  candidateHash: string;
  nameStatus: string;
  nameOrigin: string | null;
  resolvedDisplayName: string | null;
  routeName?: string | null;
}

interface CanonicalRoute {
  canonicalRouteSourceId: string;
  confirmedSummits: Array<{
    peakSourceId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
  }>;
}

interface GreenCandidate {
  canonicalRouteSourceId: string;
  routeName: string | null;
  deterministicQualificationHash: string;
}

interface NameAuditRecord {
  canonicalRelationId: string;
  sourceName: string | null;
  nameStatus: string;
  nameOrigin: string | null;
  derivedDisplayName: string | null;
}

async function loadStageabilityInputs(): Promise<{
  queueMembers: QueueMember[];
  canonicalRoutes: Map<string, CanonicalRoute>;
  greensByRelation: Map<string, GreenCandidate>;
  nameAuditByRelation: Map<string, NameAuditRecord>;
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
}> {
  const [queueRaw, canonicalRaw, greensRaw, nameAuditRaw] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(CANONICAL_CONFIRMED, "utf8"),
    readFile(GREENS_PATH, "utf8"),
    readFile(NAME_AUDIT_PATH, "utf8"),
  ]);

  const sourceFiles = [
    { path: QUEUE_PATH, sha256: sha256Bytes(Buffer.from(queueRaw)), bytes: Buffer.byteLength(queueRaw) },
    { path: CANONICAL_CONFIRMED, sha256: sha256Bytes(Buffer.from(canonicalRaw)), bytes: Buffer.byteLength(canonicalRaw) },
    { path: GREENS_PATH, sha256: sha256Bytes(Buffer.from(greensRaw)), bytes: Buffer.byteLength(greensRaw) },
    { path: NAME_AUDIT_PATH, sha256: sha256Bytes(Buffer.from(nameAuditRaw)), bytes: Buffer.byteLength(nameAuditRaw) },
  ];

  const queueArtifact = JSON.parse(queueRaw) as {
    sample: QueueMember[];
    sampleSize: number;
    deterministicArtifactHash: string;
  };
  if (queueArtifact.sampleSize !== 45 || queueArtifact.sample.length !== 45) {
    throw new Error("PHASE11I_B2_STAGEABILITY_QUEUE_COUNT_DRIFT");
  }

  const canonicalRoutes = new Map<string, CanonicalRoute>();
  for (const line of canonicalRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as CanonicalRoute;
    canonicalRoutes.set(record.canonicalRouteSourceId, record);
  }

  const greensArtifact = JSON.parse(greensRaw) as {
    records: GreenCandidate[];
  };
  const greensByRelation = new Map(
    greensArtifact.records.map((record) => [record.canonicalRouteSourceId, record]),
  );

  const nameAuditArtifact = JSON.parse(nameAuditRaw) as {
    records: NameAuditRecord[];
  };
  const nameAuditByRelation = new Map(
    nameAuditArtifact.records.map((record) => [record.canonicalRelationId, record]),
  );

  return {
    queueMembers: queueArtifact.sample,
    canonicalRoutes,
    greensByRelation,
    nameAuditByRelation,
    sourceFiles,
  };
}

async function resolvePeakOsmIdsToMountains(
  client: SupabaseClient,
  peaks: Array<{ canonicalRelationId: string; peakOsmId: string }>,
): Promise<Map<string, { mountainId: number; status: "EXACT" } | { mountainId: null; status: "MISSING" | "AMBIGUOUS" }>> {
  const resolved = new Map<string, { mountainId: number; status: "EXACT" } | { mountainId: null; status: "MISSING" | "AMBIGUOUS" }>();
  const chunkSize = 40;
  for (let index = 0; index < peaks.length; index += chunkSize) {
    const chunk = peaks.slice(index, index + chunkSize);
    for (const peak of chunk) {
      const result = await client
        .from("mountains")
        .select("id,osm_id")
        .eq("osm_id", peak.peakOsmId);
      if (result.error) {
        resolved.set(peak.canonicalRelationId, { mountainId: null, status: "MISSING" });
        continue;
      }
      const rows = (result.data ?? []) as Array<{ id: number | string; osm_id: string | null }>;
      if (rows.length === 0) {
        resolved.set(peak.canonicalRelationId, { mountainId: null, status: "MISSING" });
      } else if (rows.length === 1) {
        resolved.set(peak.canonicalRelationId, { mountainId: Number(rows[0].id), status: "EXACT" });
      } else {
        resolved.set(peak.canonicalRelationId, { mountainId: null, status: "AMBIGUOUS" });
      }
    }
  }
  return resolved;
}

export async function buildStageabilityArtifact(options: {
  client?: SupabaseClient;
  envFilePath?: string;
}): Promise<B2StageabilityArtifact> {
  const { queueMembers, canonicalRoutes } = await loadStageabilityInputs();

  const client =
    options.client ??
    await (async () => {
      if (options.envFilePath) {
        try {
          loadEnv(await readFile(resolve(options.envFilePath), "utf8"));
        } catch {
          /* env file optional */
        }
      }
      return createPhase11hAdminClient();
    })();

  const peaks = queueMembers
    .map((member) => {
      const canonical = canonicalRoutes.get(member.canonicalRelationId);
      const summit = canonical?.confirmedSummits?.[0];
      return {
        canonicalRelationId: member.canonicalRelationId,
        peakOsmId: summit?.peakSourceId ?? "",
      };
    })
    .filter((peak) => peak.peakOsmId.length > 0);

  const mountainResolution = await resolvePeakOsmIdsToMountains(client, peaks);

  const records: StageabilityRecord[] = queueMembers.map((member) => {
    const peak = peaks.find((p) => p.canonicalRelationId === member.canonicalRelationId);
    const peakOsmId = peak?.peakOsmId ?? "";
    const resolution = mountainResolution.get(member.canonicalRelationId);

    const resolutionStatus: MountainResolutionStatus =
      resolution?.status ?? "MISSING";
    const mountainId = resolution?.status === "EXACT" ? resolution.mountainId : null;
    const stagingEligible = resolutionStatus === "EXACT";

    const evidence: string[] = [];
    if (resolutionStatus === "EXACT") {
      evidence.push(
        `Live read-only mountains.osm_id lookup for peak ${peakOsmId} returned exactly one row with id=${mountainId}.`,
        "Stageability classification: EXACT_MOUNTAIN_MATCH.",
      );
    } else if (resolutionStatus === "MISSING") {
      evidence.push(
        `Live read-only mountains.osm_id lookup for peak ${peakOsmId} returned zero rows.`,
        "No exact public.mountains identity exists for this frozen summit OSM identity.",
        "Staging blocked until the exact mountain identity exists in the deployed mountain contract.",
      );
    } else {
      evidence.push(
        `Live read-only mountains.osm_id lookup for peak ${peakOsmId} returned multiple rows.`,
        "Ambiguous mountain identity; staging blocked.",
      );
    }

    const blockingReason = stagingEligible
      ? null
      : resolutionStatus === "MISSING"
        ? "MOUNTAIN_IDENTITY_MISSING"
        : "MOUNTAIN_IDENTITY_AMBIGUOUS";

    return {
      canonicalRelationId: member.canonicalRelationId,
      summitOsmId: peakOsmId,
      mountainResolutionStatus: resolutionStatus,
      resolvedMountainId: mountainId,
      resolutionEvidence: evidence,
      stagingEligible,
      blockingReason,
    };
  });

  const exactCount = records.filter((r) => r.mountainResolutionStatus === "EXACT").length;
  const missingCount = records.filter((r) => r.mountainResolutionStatus === "MISSING").length;
  const ambiguousCount = records.filter((r) => r.mountainResolutionStatus === "AMBIGUOUS").length;
  const stageableCount = records.filter((r) => r.stagingEligible).length;
  const blockedCount = records.length - stageableCount;

  if (exactCount + missingCount + ambiguousCount !== records.length) {
    throw new Error("PHASE11I_B2_STAGEABILITY_COUNT_DRIFT");
  }
  if (stageableCount + blockedCount !== records.length) {
    throw new Error("PHASE11I_B2_STAGEABILITY_ELIGIBILITY_DRIFT");
  }

  const blockedRecord = records.find((r) => !r.stagingEligible);
  const blockedCanonical = blockedRecord
    ? queueMembers.find((m) => m.canonicalRelationId === blockedRecord.canonicalRelationId)
    : null;

  const content: Omit<B2StageabilityArtifact, "deterministicArtifactHash"> = {
    schemaVersion: 1,
    artifactType: "PHASE11I_B2_STAGEABILITY",
    contractVersion: STAGEABILITY_CONTRACT,
    readOnly: true,
    publishable: false,
    qaDecisionWrites: 0,
    autoApprovalEnabled: false,
    originalQueueCount: queueMembers.length,
    stageableCount,
    blockedCount,
    exactCount,
    missingCount,
    ambiguousCount,
    blockedRelation: blockedRecord
      ? {
          canonicalRelationId: blockedRecord.canonicalRelationId,
          route: blockedCanonical?.resolvedDisplayName ?? null,
          summitOsmId: blockedRecord.summitOsmId,
          blockingReason: blockedRecord.blockingReason!,
        }
      : null,
    records,
    writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
  };

  const deterministicArtifactHash = sha256Stable(content);
  return { ...content, deterministicArtifactHash };
}

async function main(): Promise<void> {
  const envPath = resolve(".env.local");
  const artifact = await buildStageabilityArtifact({ envFilePath: envPath });

  if (
    artifact.originalQueueCount !== 45 ||
    artifact.stageableCount !== 44 ||
    artifact.blockedCount !== 1 ||
    artifact.exactCount !== 44 ||
    artifact.missingCount !== 1 ||
    artifact.ambiguousCount !== 0
  ) {
    throw new Error("PHASE11I_B2_STAGEABILITY_COUNTS_UNEXPECTED");
  }

  if (!artifact.blockedRelation || artifact.blockedRelation.canonicalRelationId !== "19752996") {
    throw new Error("PHASE11I_B2_STAGEABILITY_BLOCKED_RELATION_UNEXPECTED");
  }

  await writeFile(OUT_STAGEABILITY_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const fileHash = sha256Bytes(Buffer.from(JSON.stringify(artifact)));
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PASS",
        originalQueueCount: artifact.originalQueueCount,
        stageableCount: artifact.stageableCount,
        blockedCount: artifact.blockedCount,
        exactCount: artifact.exactCount,
        missingCount: artifact.missingCount,
        blockedRelation: artifact.blockedRelation?.canonicalRelationId,
        stageabilityPath: OUT_STAGEABILITY_PATH,
        stageabilityHash: fileHash,
        deterministicArtifactHash: artifact.deterministicArtifactHash,
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
