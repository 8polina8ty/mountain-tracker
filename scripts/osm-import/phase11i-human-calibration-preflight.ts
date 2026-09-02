import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { sha256Stable } from "./phase11-publication.ts";
import { writeJsonAtomically } from "./jsonl.ts";

const QUEUE_PATH = resolve("data/osm/alps/staging/phase11h-human-calibration-queue.json");
const PLAN_PATH = resolve("data/osm/alps/staging/phase11h-controlled-staging-plan.json");
const READINESS_PATH = resolve("data/osm/alps/staging/phase11h-readiness.json");
const NAME_AUDIT_PATH = resolve("data/osm/alps/staging/phase11h-name-resolution-audit.json");
const GREENS_PATH = resolve("data/osm/alps/staging/phase11g-expanded-green-candidates.json");
const PREFLIGHT_OUTPUT_PATH = resolve(
  "data/osm/alps/staging/phase11i-human-calibration-preflight.json",
);
const CONTRACT_OUTPUT_PATH = resolve(
  "data/osm/alps/staging/phase11i-human-calibration-staging-contract.json",
);

const QUEUE_FILE_SHA256 =
  "ca9b9dca7f84985dc1bf49f6ca5835de6b6b20b9447aff5faf9b611b97b48dcd";
const PLAN_FILE_SHA256 =
  "87551e00ecd94f517720e4cfea2b51a98d1da12620e34c627156d5d3bc9b9cf0";
const READINESS_FILE_SHA256 =
  "3e1cd9f3681672e59e0de8d738d87cc2cc1f7c38a3a4449a9d8b235a3e650ede";
const NAME_AUDIT_FILE_SHA256 =
  "318755974ecb0c7297bf5d5a0ead052c6cbea09bd09e3e9dc1c97c8c1d0c5b90";

const REQUIRED_RELATION_COUNT = 45;
type Phase11hQualityBand = "Q65_74" | "Q75_89" | "Q90";

function sha256Bytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadLocalEnvironment(content: string): void {
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

function pinnedMatches(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label} changed: expected ${expected}, found ${actual}.`);
  }
}

function recomputeDeterministicHash(artifact: Record<string, unknown>): string {
  const content = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  delete content.deterministicArtifactHash;
  return sha256Stable(content);
}

function relationIdsFromPublishedUrl(url: string): string | null {
  const match = url.match(/(?:\/|\/relation\/)(\d+)$/);
  return match ? match[1] : null;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function main(): Promise<void> {
  loadLocalEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("Supabase read credentials are not configured.");

  const [queue, plan, readiness, nameAudit, greens] = await Promise.all([
    readFile(QUEUE_PATH, "utf8"),
    readFile(PLAN_PATH, "utf8"),
    readFile(READINESS_PATH, "utf8"),
    readFile(NAME_AUDIT_PATH, "utf8"),
    readFile(GREENS_PATH, "utf8"),
  ]);
  const queueArtifact = JSON.parse(queue) as {
    deterministicArtifactHash: string;
    sample: Array<Record<string, unknown>>;
    writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  };
  const planArtifact = JSON.parse(plan) as {
    executed: boolean;
    readOnly: boolean;
    scope: { relations: string[] };
    deterministicArtifactHash: string;
    writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  };
  const readinessArtifact = JSON.parse(readiness) as {
    calibration: { humanCalibrationReady: boolean };
    deterministicArtifactHash: string;
  };
  const nameAuditArtifact = JSON.parse(nameAudit) as {
    deterministicArtifactHash: string;
  };
  const greensArtifact = JSON.parse(greens) as {
    records: Array<{
      canonicalRouteSourceId: string;
      safeStatus: string;
      qualityScore: number;
      deterministicQualificationHash: string;
    }>;
  };

  pinnedMatches("queue artifact file", sha256Bytes(Buffer.from(queue)), QUEUE_FILE_SHA256);
  pinnedMatches("plan artifact file", sha256Bytes(Buffer.from(plan)), PLAN_FILE_SHA256);
  pinnedMatches("readiness artifact file", sha256Bytes(Buffer.from(readiness)), READINESS_FILE_SHA256);
  pinnedMatches(
    "name resolution audit artifact file",
    sha256Bytes(Buffer.from(nameAudit)),
    NAME_AUDIT_FILE_SHA256,
  );
  pinnedMatches(
    "queue deterministic hash",
    recomputeDeterministicHash(queueArtifact),
    queueArtifact.deterministicArtifactHash,
  );
  pinnedMatches(
    "plan deterministic hash",
    recomputeDeterministicHash(planArtifact),
    "e5f2d73878be862c2066a56c79ea67e5afd2536ed1d340339feb87039e94c6a6",
  );
  pinnedMatches(
    "plan embedded deterministic hash",
    planArtifact.deterministicArtifactHash,
    "e5f2d73878be862c2066a56c79ea67e5afd2536ed1d340339feb87039e94c6a6",
  );
  pinnedMatches(
    "readiness deterministic hash",
    recomputeDeterministicHash(readinessArtifact),
    readinessArtifact.deterministicArtifactHash,
  );
  pinnedMatches(
    "name audit deterministic hash",
    recomputeDeterministicHash(nameAuditArtifact),
    nameAuditArtifact.deterministicArtifactHash,
  );

  if (!planArtifact.readOnly || planArtifact.executed) {
    throw new Error("Phase 11H controlled staging plan is no longer a read-only unexecuted plan.");
  }
  if (
    planArtifact.writes.databaseWrites !== 0 ||
    planArtifact.writes.qaWrites !== 0 ||
    planArtifact.writes.publicationWrites !== 0 ||
    queueArtifact.writes.databaseWrites !== 0 ||
    queueArtifact.writes.qaWrites !== 0 ||
    queueArtifact.writes.publicationWrites !== 0
  ) {
    throw new Error("Frozen Phase 11H artifact promised non-zero writes.");
  }
  if (!readinessArtifact.calibration.humanCalibrationReady) {
    throw new Error("Phase 11H readiness does not confirm human calibration readiness.");
  }

  const members = (queueArtifact.sample ?? []).map((value) => ({
    canonicalRelationId: String(value.canonicalRelationId ?? ""),
    candidateHash: String(value.candidateHash ?? ""),
    qualificationHash: String(value.qualificationHash ?? ""),
    nameStatus: String(value.nameStatus ?? ""),
    startContext: String(value.startContext ?? ""),
    qualityBand: String(value.qualityBand ?? "") as Phase11hQualityBand,
    selectionTier: String(value.selectionTier ?? ""),
    humanDecisionStatus: value.humanDecisionStatus === null ? null : value.humanDecisionStatus,
  }));
  if (members.length !== REQUIRED_RELATION_COUNT) {
    throw new Error(`Phase 11H queue must contain exactly ${REQUIRED_RELATION_COUNT} members.`);
  }
  if (
    members.some((member) => member.humanDecisionStatus !== null) ||
    members.some(
      (member) =>
        !/^\d+$/.test(member.canonicalRelationId) ||
        !/^[0-9a-f]{64}$/.test(member.candidateHash) ||
        !/^[0-9a-f]{64}$/.test(member.qualificationHash),
    )
  ) {
    throw new Error("Phase 11H queue contains invalid or pre-decided members.");
  }
  const memberIds = members.map((member) => member.canonicalRelationId);
  if (new Set(memberIds).size !== members.length) {
    throw new Error("Phase 11H queue contains duplicate relations.");
  }
  const planRelations = planArtifact.scope.relations;
  if (new Set(planRelations).size !== planRelations.length || planRelations.length !== memberIds.length) {
    throw new Error("Phase 11H plan relation scope is inconsistent.");
  }
  if (planRelations.some((relation) => !memberIds.includes(relation))) {
    throw new Error("Phase 11H queue does not exactly match the controlled staging plan scope.");
  }

  const greenByRelation = new Map(
    greensArtifact.records.map((record) => [record.canonicalRouteSourceId, record]),
  );
  for (const member of members) {
    const green = greenByRelation.get(member.canonicalRelationId);
    if (!green) throw new Error(`Missing Phase 11G qualification for relation ${member.canonicalRelationId}.`);
    if (green.safeStatus !== "GREEN") {
      throw new Error(`Relation ${member.canonicalRelationId} is no longer GREEN in Phase 11G.`);
    }
    if (green.deterministicQualificationHash !== member.qualificationHash) {
      throw new Error(`Qualification hash drift for relation ${member.canonicalRelationId}.`);
    }
  }

  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [stagingByCanonical, stagingBySource, provenance, publishedRoutes] = await Promise.all([
    Promise.all(
      chunk(memberIds, 40).map((ids) =>
        client
          .from("osm_route_import_staging")
          .select(
            "id,idempotency_key,payload_hash,source_relation_id,canonical_source_id,contract_version,import_eligibility,staged_at",
          )
          .in("canonical_source_id", ids),
      ),
    ),
    Promise.all(
      chunk(memberIds, 40).map((ids) =>
        client
          .from("osm_route_import_staging")
          .select("id,source_relation_id,canonical_source_id,import_eligibility")
          .in("source_relation_id", ids),
      ),
    ),
    Promise.all(
      chunk(memberIds, 40).map((ids) =>
        client
          .from("osm_route_publication_provenance")
          .select(
            "mountain_route_id,staging_route_id,canonical_relation_id,source_url,publication_status",
          )
          .in("canonical_relation_id", ids),
      ),
    ),
    Promise.all([
      client.from("mountain_routes").select("id,source_url").like("source_url", "https://www.openstreetmap.org/relation/%"),
      client.from("mountain_routes").select("id,source_url").like("source_url", "/api/osm-route-publications/openstreetmap/relation/%/geojson"),
    ]),
  ]);

  const stagingRowsByCanonical = stagingByCanonical.flatMap((result) => {
    if (result.error) throw new Error(`Canonical staging read failed: ${result.error.message}`);
    return result.data ?? [];
  });
  const stagingRowsBySource = stagingBySource.flatMap((result) => {
    if (result.error) throw new Error(`Source staging read failed: ${result.error.message}`);
    return result.data ?? [];
  });
  const publishedResponses = publishedRoutes as [
    { error: { message: string } | null; data: Array<{ source_url: string }> | null },
    { error: { message: string } | null; data: Array<{ source_url: string }> | null },
  ];
  for (const result of publishedResponses) {
    if (result.error) throw new Error(`Published route read failed: ${result.error.message}`);
  }
  const provenanceRows = provenance.flatMap((result) => {
    if (result.error) throw new Error(`Publication provenance read failed: ${result.error.message}`);
    return result.data ?? [];
  });

  const stagingRowsByRelation = new Map<string, Record<string, unknown>>();
  for (const row of [...stagingRowsByCanonical, ...stagingRowsBySource]) {
    for (const key of ["canonical_source_id", "source_relation_id"] as const) {
      const relation = String(row[key] ?? "");
      if (relation && memberIds.includes(relation)) stagingRowsByRelation.set(relation, row);
    }
  }

  let stagingRouteIds: string[] = [];
  if (stagingRowsByRelation.size > 0) {
    stagingRouteIds = [...new Set(stagingRowsByRelation.values().map((row) => String(row.id)))];
  }
  const [summitResult, qaResult, historyResult] = stagingRouteIds.length
    ? await Promise.all([
        client
          .from("osm_route_import_summit_staging")
          .select("staging_route_id,peak_osm_id,mountain_id,final_association")
          .in("staging_route_id", stagingRouteIds),
        client
          .from("osm_staging_route_visual_qa")
          .select("staging_route_id,status,version")
          .in("staging_route_id", stagingRouteIds),
        client
          .from("osm_staging_route_visual_qa_history")
          .select("staging_route_id,old_status,new_status,decision_version")
          .in("staging_route_id", stagingRouteIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  for (const [label, result] of [
    ["summit", summitResult],
    ["QA", qaResult],
    ["QA history", historyResult],
  ] as const) {
    if (result.error) throw new Error(`${label} read failed: ${result.error.message}`);
  }

  const publishedRelationIds = new Set(
    publishedResponses
      .flatMap((result) => result.data ?? [])
      .map((row) => relationIdsFromPublishedUrl(row.source_url))
      .filter((value): value is string => value !== null),
  );

  const provenanceByRelation = new Map<string, { mountain_route_id: number; publication_status: string; source_url: string | null }>();
  for (const row of provenanceRows) {
    const relation = String(row.canonical_relation_id ?? "");
    const existing = provenanceByRelation.get(relation);
    if (!existing || String(existing.publication_status).toUpperCase() === "ACTIVE") {
      provenanceByRelation.set(relation, {
        mountain_route_id: Number(row.mountain_route_id),
        publication_status: String(row.publication_status),
        source_url: row.source_url === null ? null : String(row.source_url),
      });
    }
  }

  const records = members.map((member) => {
    const relation = member.canonicalRelationId;
    const stagingRow = stagingRowsByRelation.get(relation);
    const provenanceHit = provenanceByRelation.get(relation);
    const publishedUrlHit = publishedRelationIds.has(relation);
    const published = Boolean(provenanceHit) || publishedUrlHit;
    const qaHits =
      stagingRouteIds.length > 0 &&
      stagingRouteIds.some(
        (id) =>
          qaResult.data?.some((row) => String(row.staging_route_id) === id) ||
          historyResult.data?.some((row) => String(row.staging_route_id) === id),
      );
    const action =
      stagingRow || published || qaHits ? "BLOCKED_OTHER" : "WOULD_CREATE";
    const reason = (() => {
      if (stagingRow) return "STAGING_ROW_ALREADY_PRESENT";
      if (published) return "ALREADY_PUBLISHED";
      if (qaHits) return "QA_DECISION_OR_HISTORY_PRESENT";
      return null;
    })();
    return {
      canonicalRelationId: relation,
      qualificationHash: member.qualificationHash,
      candidateHash: member.candidateHash,
      action,
      reason,
      downstreamHits: {
        staging: Boolean(stagingRow),
        provenance: Boolean(provenanceHit),
        provenanceStatus: provenanceHit?.publication_status ?? null,
        published: published,
        qa: qaHits,
      },
    };
  });

  const wouldCreate = records.filter((record) => record.action === "WOULD_CREATE").length;
  const blocked = records.length - wouldCreate;
  const summary = {
    total: memberIds.length,
    wouldCreate,
    unchanged: 0,
    conflicts: blocked,
    blocked,
    stagingRowsPresent: stagingRowsByRelation.size,
    qaDecisionRowsPresent: (qaResult.data ?? []).length,
    qaHistoryRowsPresent: (historyResult.data ?? []).length,
    summitAssociationRowsForFoundStaging: (summitResult.data ?? []).length,
    publicationProvenanceHits: provenanceByRelation.size,
    activeProvenanceHits: records.filter(
      (record) => record.downstreamHits.provenanceStatus === "ACTIVE",
    ).length,
    activeOverlap: records.filter((record) => record.downstreamHits.provenanceStatus === "ACTIVE").length,
    publishedUrlOverlap: records.filter((record) => record.downstreamHits.published).length,
  };
  const executionSafe = wouldCreate === memberIds.length && blocked === 0;

  const preflight = {
    schemaVersion: 1,
    artifactType: "PHASE11I_HUMAN_CALIBRATION_PREFLIGHT",
    auditedAt: new Date().toISOString(),
    databaseMode: "SELECT_ONLY",
    queueFileSha256: QUEUE_FILE_SHA256,
    queueDeterministicArtifactHash: queueArtifact.deterministicArtifactHash,
    planFileSha256: PLAN_FILE_SHA256,
    readinessFileSha256: READINESS_FILE_SHA256,
    nameAuditFileSha256: NAME_AUDIT_FILE_SHA256,
    queueVersion: "phase11h-calibration-1",
    queueCount: memberIds.length,
    executionSafe,
    summary,
    records,
  };
  await writeJsonAtomically(PREFLIGHT_OUTPUT_PATH, preflight);

  let contractHash: string | null = null;
  if (executionSafe) {
    const contractContent = {
      schemaVersion: 1,
      artifactType: "PHASE11I_HUMAN_CALIBRATION_STAGING_CONTRACT",
      phase: "Phase 11I-A approved live preflight; execution in Phase 11I-B requires explicit user command with the execution token.",
      executed: false,
      databaseModeBefore: "SELECT_ONLY",
      executionToken: "PHASE11I:__CONTRACT_HASH__:<queueHash>",
      queueHash: QUEUE_FILE_SHA256,
      queueDeterministicArtifactHash: queueArtifact.deterministicArtifactHash,
      planFileSha256: PLAN_FILE_SHA256,
      planDeterministicArtifactHash: "e5f2d73878be862c2066a56c79ea67e5afd2536ed1d340339feb87039e94c6a6",
      readinessFileSha256: READINESS_FILE_SHA256,
      nameAuditFileSha256: NAME_AUDIT_FILE_SHA256,
      queueVersion: "phase11h-calibration-1",
      stagingContractVersion: "mountain-tracker-osm-route/v1",
      expectedImportEligibility: "AUTO_IMPORT_READY",
      contractVersion: "mountain-tracker-phase11h-human-calibration/v1",
      qaQuestionContractVersion: "mountain-tracker-phase11h-human-qa/v1",
      expectedBeforeState: {
        stagingRowsForRelations: 0,
        summitAssociationRowsForRelations: 0,
        qaDecisionRows: 0,
        qaHistoryRows: 0,
        publishedRoutesForRelations: 0,
      },
      expectedAfterState: {
        stagingRowsForRelations: memberIds.length,
        summitAssociationRowsForRelations: memberIds.length,
        qaDecisionRows: 0,
        qaHistoryRows: 0,
        publishedRoutesForRelations: 0,
      },
      records: records.map((record) => {
        const member = members.find((value) => value.canonicalRelationId === record.canonicalRelationId)!;
        return {
          sourceRelationId: record.canonicalRelationId,
          canonicalRelationId: record.canonicalRelationId,
          qualificationHash: member.qualificationHash,
          candidateHash: member.candidateHash,
          nameStatus: member.nameStatus,
          startContext: member.startContext,
          qualityBand: member.qualityBand,
          selectionTier: member.selectionTier,
        };
      }),
      writes: { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 },
    };
    contractHash = sha256Stable(contractContent);
    const token = `PHASE11I:${contractHash}:${QUEUE_FILE_SHA256}`;
    const contract = {
      ...contractContent,
      executionToken: token,
    };
    await writeJsonAtomically(CONTRACT_OUTPUT_PATH, contract);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        executionSafe,
        preflightOutputPath: PREFLIGHT_OUTPUT_PATH,
        preflightFileSha256: sha256Bytes(Buffer.from(await readFile(PREFLIGHT_OUTPUT_PATH, "utf8"))),
        contractOutputPath: executionSafe ? CONTRACT_OUTPUT_PATH : null,
        contractFileSha256: executionSafe
          ? sha256Bytes(Buffer.from(await readFile(CONTRACT_OUTPUT_PATH, "utf8")))
          : null,
        executionToken: executionSafe ? `PHASE11I:${contractHash}:${QUEUE_FILE_SHA256}` : null,
        databaseWrites: 0,
        summary,
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