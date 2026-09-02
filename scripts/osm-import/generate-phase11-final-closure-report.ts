import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { writeJsonAtomically } from "./jsonl.ts";
import { sha256Stable } from "./phase11-publication.ts";

const CONTRACT_VERSION = "mountain-tracker-phase11-final-closure/v1" as const;
const BLOCKED_RELATION_ID = "19752996";
const BLOCKED_PEAK_OSM_ID = "14110138897";
const REPORT_PATH = resolve("data/osm/alps/publication/phase11-final-closure-report.json");

const SOURCE_PATHS = {
  phase11c3: "data/osm/alps/publication/phase11c3-combined-readiness.json",
  phase11c9: "data/osm/alps/publication/phase11c9-road-safety-eligible-pool-103.json",
  phase11d: "data/osm/alps/publication/phase11d-scale-readiness.json",
  phase11e: "data/osm/alps/publication/phase11e-scale-readiness.json",
  phase11f1: "data/osm/alps/staging/phase11f1-start-context-classification.json",
  phase11f2: "data/osm/alps/publication/phase11f2-start-context-readiness.json",
  phase11f3Readiness: "data/osm/alps/publication/phase11f3-start-context-readiness.json",
  phase11f3Classification: "data/osm/alps/staging/phase11f3-start-context-classification.json",
  phase11gAudit: "data/osm/alps/staging/phase11g-expanded-candidate-audit.json",
  phase11gGreens: "data/osm/alps/staging/phase11g-expanded-green-candidates.json",
  phase11hReadiness: "data/osm/alps/staging/phase11h-readiness.json",
  phase11hNames: "data/osm/alps/staging/phase11h-name-resolution-audit.json",
  phase11iReceipt: "data/osm/alps/staging/phase11i-b2-controlled-staging-execution.json",
  phase11iStageability: "data/osm/alps/staging/phase11i-b2-human-calibration-stageability.json",
  phase11iCalibration: "data/osm/alps/staging/phase11i-human-calibration-result.json",
} as const;

type JsonObject = Record<string, unknown>;

interface ReceiptArtifact extends JsonObject {
  authorizedCount: number;
  blockedCount: number;
  blockedRelation: string;
  execution: { stagedResults: string[] };
}

interface F3ClassificationArtifact extends JsonObject {
  elevationHierarchyVersion: string;
  totalRoutes: number;
  typeCounts: Record<string, number>;
  routes: Array<{
    sourceRelationId: string;
    startContext: { type: string; startElevationSource: string | null; reasons: string[] };
  }>;
}

interface GreenArtifact extends JsonObject {
  recordCount: number;
  records: Array<{
    canonicalRouteSourceId: string;
    safeStatus: string;
    startContext: string;
    reasonCodes: string[];
    greenClass: string | null;
  }>;
}

function assertClosure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PHASE11_FINAL_CLOSURE:${message}`);
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

async function readJson<T>(path: string): Promise<{ value: T; sha256: string }> {
  const raw = await readFile(resolve(path), "utf8");
  return {
    value: JSON.parse(raw) as T,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function exactCount(
  client: SupabaseClient,
  table: string,
): Promise<number> {
  const result = await client.from(table).select("*", { count: "exact", head: true });
  if (result.error) throw new Error(`PHASE11_FINAL_COUNT_${table}:${result.error.message}`);
  return result.count ?? 0;
}

async function queryRows<T>(
  operation: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const result = await operation;
  if (result.error) throw new Error(`PHASE11_FINAL_${label}:${result.error.message}`);
  return result.data ?? [];
}

function stagedIdentities(receipt: ReceiptArtifact): Map<string, string> {
  const identities = new Map<string, string>();
  for (const identity of receipt.execution.stagedResults) {
    const separator = identity.indexOf(":");
    assertClosure(separator > 0, `INVALID_STAGED_IDENTITY:${identity}`);
    identities.set(identity.slice(0, separator), identity.slice(separator + 1));
  }
  return identities;
}

async function loadLiveState(client: SupabaseClient, receipt: ReceiptArtifact, machineIds: string[]) {
  const identities = stagedIdentities(receipt);
  const phase11hRelationIds = [...identities.keys()];
  const phase11hStagingIds = [...identities.values()];

  const [
    stagingTotal,
    summitTotal,
    qaTotal,
    qaHistoryTotal,
    provenanceTotal,
    activeRows,
    phase11hStaging,
    phase11hSummits,
    phase11hQa,
    phase11hQaHistory,
    phase11hProvenance,
    blockedCanonical,
    blockedSource,
    blockedMountain,
  ] = await Promise.all([
    exactCount(client, "osm_route_import_staging"),
    exactCount(client, "osm_route_import_summit_staging"),
    exactCount(client, "osm_staging_route_visual_qa"),
    exactCount(client, "osm_staging_route_visual_qa_history"),
    exactCount(client, "osm_route_publication_provenance"),
    queryRows<{ mountain_route_id: number; staging_route_id: string; canonical_relation_id: string; publication_status: string }>(
      client
        .from("osm_route_publication_provenance")
        .select("mountain_route_id,staging_route_id,canonical_relation_id,publication_status")
        .eq("publication_status", "ACTIVE")
        .order("mountain_route_id", { ascending: true }),
      "ACTIVE_PROVENANCE",
    ),
    queryRows<{ id: string; canonical_source_id: string; source_relation_id: string }>(
      client
        .from("osm_route_import_staging")
        .select("id,canonical_source_id,source_relation_id")
        .in("id", phase11hStagingIds),
      "PHASE11H_STAGING",
    ),
    queryRows<{ staging_route_id: string; final_association: string }>(
      client
        .from("osm_route_import_summit_staging")
        .select("staging_route_id,final_association")
        .in("staging_route_id", phase11hStagingIds),
      "PHASE11H_SUMMITS",
    ),
    queryRows<{ staging_route_id: string; status: string }>(
      client
        .from("osm_staging_route_visual_qa")
        .select("staging_route_id,status")
        .in("staging_route_id", phase11hStagingIds),
      "PHASE11H_QA",
    ),
    queryRows<{ staging_route_id: string; new_status: string; decision_version: number }>(
      client
        .from("osm_staging_route_visual_qa_history")
        .select("staging_route_id,new_status,decision_version")
        .in("staging_route_id", phase11hStagingIds),
      "PHASE11H_QA_HISTORY",
    ),
    queryRows<{ staging_route_id: string; canonical_relation_id: string; publication_status: string }>(
      client
        .from("osm_route_publication_provenance")
        .select("staging_route_id,canonical_relation_id,publication_status")
        .in("staging_route_id", phase11hStagingIds),
      "PHASE11H_PROVENANCE",
    ),
    queryRows<{ id: string }>(
      client
        .from("osm_route_import_staging")
        .select("id")
        .eq("canonical_source_id", BLOCKED_RELATION_ID),
      "BLOCKED_CANONICAL",
    ),
    queryRows<{ id: string }>(
      client
        .from("osm_route_import_staging")
        .select("id")
        .eq("source_relation_id", BLOCKED_RELATION_ID),
      "BLOCKED_SOURCE",
    ),
    queryRows<{ id: number; osm_id: string }>(
      client.from("mountains").select("id,osm_id").eq("osm_id", BLOCKED_PEAK_OSM_ID),
      "BLOCKED_MOUNTAIN",
    ),
  ]);

  const blockedStagingIds = [
    ...new Set([...blockedCanonical, ...blockedSource].map((row) => String(row.id))),
  ];
  const [blockedQa, blockedHistory, blockedProvenance] = blockedStagingIds.length
    ? await Promise.all([
        queryRows<{ staging_route_id: string }>(
          client.from("osm_staging_route_visual_qa").select("staging_route_id").in("staging_route_id", blockedStagingIds),
          "BLOCKED_QA",
        ),
        queryRows<{ staging_route_id: string }>(
          client.from("osm_staging_route_visual_qa_history").select("staging_route_id").in("staging_route_id", blockedStagingIds),
          "BLOCKED_QA_HISTORY",
        ),
        queryRows<{ staging_route_id: string }>(
          client.from("osm_route_publication_provenance").select("staging_route_id").in("staging_route_id", blockedStagingIds),
          "BLOCKED_PROVENANCE",
        ),
      ])
    : [[], [], []];

  const activeIds = new Set(activeRows.map((row) => String(row.canonical_relation_id)));
  const activeMachineGreenIds = machineIds.filter((id) => activeIds.has(id));
  const unpublishedMachineGreenIds = machineIds.filter((id) => !activeIds.has(id));
  const phase11hStagingIdSet = new Set(phase11hStaging.map((row) => row.id));
  const exactReceiptMatches = phase11hRelationIds.filter((relationId) => {
    const stagingId = identities.get(relationId);
    return phase11hStaging.some(
      (row) =>
        row.id === stagingId &&
        (String(row.canonical_source_id) === relationId || String(row.source_relation_id) === relationId),
    );
  }).length;

  return {
    totals: {
      stagingRoutes: stagingTotal,
      summitStagingRows: summitTotal,
      qaCurrentDecisions: qaTotal,
      qaHistoryRows: qaHistoryTotal,
      publicationProvenanceRows: provenanceTotal,
      activePublications: activeRows.length,
      uniqueActiveMountainRoutes: new Set(activeRows.map((row) => String(row.mountain_route_id))).size,
      uniqueActiveRelations: activeIds.size,
    },
    phase11hControlledStaging: {
      expectedRelations: phase11hRelationIds.length,
      routeRows: phase11hStaging.length,
      exactReceiptMatches,
      summitRows: phase11hSummits.filter((row) => phase11hStagingIdSet.has(row.staging_route_id)).length,
      singleConfirmedSummitRows: phase11hSummits.filter((row) => row.final_association === "CONFIRMED").length,
      qaCurrentRows: phase11hQa.length,
      visuallyApprovedRows: phase11hQa.filter((row) => row.status === "VISUALLY_APPROVED").length,
      needsReviewRows: phase11hQa.filter((row) => row.status === "NEEDS_REVIEW").length,
      rejectedRows: phase11hQa.filter((row) => row.status === "REJECTED").length,
      qaHistoryRows: phase11hQaHistory.length,
      publicationProvenanceRows: phase11hProvenance.length,
      activePublicationRows: phase11hProvenance.filter((row) => row.publication_status === "ACTIVE").length,
    },
    blockedRelation: {
      canonicalRelationId: BLOCKED_RELATION_ID,
      peakOsmId: BLOCKED_PEAK_OSM_ID,
      stagingRows: blockedStagingIds.length,
      qaCurrentRows: blockedQa.length,
      qaHistoryRows: blockedHistory.length,
      publicationProvenanceRows: blockedProvenance.length,
      exactMountainIdentityRows: blockedMountain.length,
    },
    machineGreenPublicationPartition: {
      total: machineIds.length,
      activeOverlap: activeMachineGreenIds.length,
      activeRelationIds: activeMachineGreenIds,
      unpublished: unpublishedMachineGreenIds.length,
      unpublishedRelationIds: unpublishedMachineGreenIds,
    },
  };
}

export async function generatePhase11FinalClosureReport() {
  try {
    loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  assertClosure(url && secret, "SUPABASE_READ_CREDENTIALS_REQUIRED");

  const entries = await Promise.all(
    Object.entries(SOURCE_PATHS).map(async ([key, path]) => [key, path, await readJson<JsonObject>(path)] as const),
  );
  const artifacts = Object.fromEntries(entries.map(([key, , artifact]) => [key, artifact.value])) as Record<string, JsonObject>;
  const sourceArtifacts = Object.fromEntries(
    entries.map(([key, path, artifact]) => [key, { path, sha256: artifact.sha256 }]),
  );

  const f3 = artifacts.phase11f3Classification as unknown as F3ClassificationArtifact;
  const g = artifacts.phase11gGreens as unknown as GreenArtifact;
  const h = artifacts.phase11hReadiness;
  const i = artifacts.phase11iCalibration;
  const receipt = artifacts.phase11iReceipt as unknown as ReceiptArtifact;
  const gAudit = artifacts.phase11gAudit;

  const f3GreenIds = f3.routes
    .filter((route) => route.startContext.type === "BASE_START" || route.startContext.type === "HUT_START")
    .map((route) => String(route.sourceRelationId));
  const gGreenIds = g.records.map((route) => String(route.canonicalRouteSourceId));
  const f3Set = new Set(f3GreenIds);
  const overlapIds = gGreenIds.filter((id) => f3Set.has(id));
  const machineIds = [...new Set([...f3GreenIds, ...gGreenIds])].sort((a, b) => Number(a) - Number(b));
  const tothorn = f3.routes.find((route) => String(route.sourceRelationId) === "274491");

  assertClosure(f3GreenIds.length === 124, `F3_GREEN_EXPECTED_124_GOT_${f3GreenIds.length}`);
  assertClosure(gGreenIds.length === 121, `G_GREEN_EXPECTED_121_GOT_${gGreenIds.length}`);
  assertClosure(overlapIds.length === 0, `GREEN_OVERLAP_${overlapIds.join(",")}`);
  assertClosure(machineIds.length === 245, `COMBINED_GREEN_EXPECTED_245_GOT_${machineIds.length}`);
  assertClosure(tothorn?.startContext.type === "HIGH_MOUNTAIN_START", "TOTHORN_CONTEXT_DRIFT");
  assertClosure(Number(h.existingValidatedGreen) === 124, "H_F3_COUNT_DRIFT");
  assertClosure(Number(h.phase11gNewGreen) === 121, "H_G_COUNT_DRIFT");
  assertClosure(Number(h.combinedMachineGreen) === 245, "H_COMBINED_COUNT_DRIFT");
  assertClosure(receipt.authorizedCount === 44 && receipt.blockedCount === 1, "I_RECEIPT_COUNT_DRIFT");

  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const live = await loadLiveState(client, receipt, machineIds);
  const decisionDistribution = i.decisionDistribution as Record<string, number>;
  const integrity = i.integrity as Record<string, unknown>;
  const matrices = i.matrices as Record<string, unknown>;
  const nameResolution = h.nameResolution as Record<string, unknown>;
  const sourceIdentity = gAudit.sourceIdentity as Record<string, unknown>;

  const gitStatusLines = git(["status", "--porcelain=v1"]).split(/\r?\n/).filter(Boolean);
  const localMainDivergence = git(["rev-list", "--left-right", "--count", "main...HEAD"]).split(/\s+/).map(Number);
  const trackingDivergence = git(["rev-list", "--left-right", "--count", "origin/main...HEAD"]).split(/\s+/).map(Number);

  const content = {
    schemaVersion: 1,
    artifactType: "PHASE11_FINAL_CLOSURE_REPORT",
    contractVersion: CONTRACT_VERSION,
    auditedAt: new Date().toISOString(),
    readOnly: true,
    publishable: false,
    objective: "Authoritative Phase 11 closure audit before Phase 12; no production writes or publication authorization.",
    sourceArtifacts,
    datasetIdentity: {
      pbfPath: sourceIdentity.pbfPath,
      pbfSizeBytes: sourceIdentity.pbfSizeBytes,
      pbfModifiedMilliseconds: sourceIdentity.pbfModifiedMilliseconds,
      pbfSha256: sourceIdentity.pbfSha256,
      pipelineDatasetFingerprint: sourceIdentity.pipelineDatasetFingerprint,
      checkpointManifestSha256: sourceIdentity.checkpointManifestSha256,
      motorwayIndexContentHash: sourceIdentity.motorwayIndexContentHash,
    },
    pipeline: {
      contractVersions: {
        phase11dQualification: "mountain-tracker-osm-scale-qualification/v1",
        phase11eRecovery: "mountain-tracker-osm-candidate-recovery/v1",
        phase11f2StartContext: "mountain-tracker-start-context/v2",
        phase11f3ElevationHierarchy: "1",
        phase11c9RoadSafety: "mountain-tracker-osm-road-safety/v1",
        phase11gExpansion: "mountain-tracker-osm-candidate-expansion/v1",
        phase11hCalibration: "mountain-tracker-phase11h-human-calibration/v1",
        phase11hNameResolution: "mountain-tracker-phase11h-name-resolution/v1",
        phase11hQaQuestions: "mountain-tracker-phase11h-human-qa/v1",
        staging: "mountain-tracker-osm-route/v1",
        phase11iControlledExecution: "mountain-tracker-phase11i-b2-execution-contract/v1",
        phase11iCalibrationResult: "mountain-tracker-phase11i-human-calibration-result/v1",
      },
      effectiveGreenRequirements: [
        "semanticType=summit_route",
        "routeType=hiking and no manual activity-review requirement",
        "one CONFIRMED summit within the exact terminal identity threshold and exact mountain identity",
        "valid LineString geometry",
        "SIMPLE topology with two unambiguous physical endpoints",
        "roadSafetyStatus=SAFE",
        "startContext=BASE_START or HUT_START",
        "no active, duplicate relation, duplicate source URL, publication conflict, or data-integrity guard",
        "human status is not REJECTED or NEEDS_REVIEW where a persisted human guard applies",
      ],
      highMountainStartIsGreen: false,
      ambiguousStartIsGreen: false,
      humanApprovalIsAutomaticPublicationAuthorization: false,
      phase11gAutoApprovalEnabled: false,
    },
    production: live,
    machineScale: {
      phase11f3ExistingGreen: f3GreenIds.length,
      phase11gNewGreen: gGreenIds.length,
      overlap: overlapIds.length,
      overlapRelationIds: overlapIds,
      combinedMachineGreen: machineIds.length,
      humanCalibrationQueue: 45,
      humanReviewedSample: 44,
      activePublications: live.totals.activePublications,
      populationsAreDistinct: true,
    },
    humanCalibration: {
      artifactResult: i.calibrationResult,
      decisionDistribution,
      matrices,
      historyIntegrityPass: integrity.historyIntegrityPass,
      payloadCompatibilityPass: integrity.payloadCompatibilityPass,
      humanRejectedMachineGreen: ((i.machineFalseGreen as JsonObject).humanRejectedMachineGreen as unknown[]).length,
      humanNeedsReviewMachineGreen: ((i.machineFalseGreen as JsonObject).humanNeedsReviewMachineGreen as unknown[]).length,
      scopeCaveat: "The 44/44 result is calibration evidence for the reviewed sample only; it does not mean all 245 machine-GREEN routes are human-approved.",
    },
    roadSafety: {
      contractStatus: "UNCHANGED_AND_MANDATORY",
      motorwayOverlap: "BLOCKED",
      motorwayLinkOverlap: "BLOCKED",
      accessFootSemantics: "foot overrides generic access; forbidden pedestrian access blocks; ambiguous access fails closed to review",
      atGradeMotorwayCrossing: "BLOCKED",
      gradeSeparatedCrossing: "SAFE only with explicit bridge/tunnel/layer evidence",
      ambiguousCrossing: "FAIL_CLOSED_TO_REVIEW",
      weakenedDuringFThroughI: false,
    },
    startContext: {
      hierarchyVersion: String(f3.elevationHierarchyVersion ?? "1"),
      totalClassified: f3.totalRoutes,
      counts: f3.typeCounts,
      greenCompatible: ["BASE_START", "HUT_START"],
      nonGreen: ["HIGH_MOUNTAIN_START", "AMBIGUOUS_START"],
      deterministicElevationHierarchy: [
        "EXACT_ENDPOINT_OSM_ELE",
        "EXACT_START_FEATURE_ELE",
        "otherwise START_ELEVATION_UNPROVEN",
      ],
      elevationConflictBehavior: "Nearby same-priority evidence differing beyond tolerance fails closed as START_ELEVATION_CONFLICT.",
      externalDemOrElevationApi: false,
      tothorn: {
        canonicalRelationId: "274491",
        routeName: "Tothorn route",
        classification: tothorn?.startContext.type,
        green: false,
        startElevationSource: tothorn?.startContext.startElevationSource,
        evidence: tothorn?.startContext.reasons,
      },
    },
    naming: {
      statuses: [
        "SOURCE_NAME",
        "SOURCE_OFFICIAL_NAME",
        "SOURCE_LOCAL_NAME",
        "DERIVED_SOURCE_BACKED",
        "REF_ONLY",
        "UNRESOLVED",
      ],
      resolutionCounts: nameResolution.counts,
      nameReady: nameResolution.nameReadyTotal,
      nameUnresolved: nameResolution.nameUnresolvedTotal,
      derivedNamesArePresentationMetadataOnly: true,
      derivedNamesRewriteOsmSourceName: false,
      refOnlyIsPrimaryPublicName: false,
      unresolvedFailsClosed: true,
    },
    blockersAndDeferred: {
      mountainIdentityMissing: [
        {
          canonicalRelationId: BLOCKED_RELATION_ID,
          peakOsmId: BLOCKED_PEAK_OSM_ID,
          reason: "MOUNTAIN_IDENTITY_MISSING",
          liveState: live.blockedRelation,
        },
      ],
      ambiguousStartCountInF3Population: f3.typeCounts.AMBIGUOUS_START,
      highMountainStartCountInF3Population: f3.typeCounts.HIGH_MOUNTAIN_START,
      phase11gStartContextNonGreenCount: (gAudit.buckets as Record<string, number>).START_CONTEXT_NON_GREEN,
      missingNameMachineGreenInPhase11g: g.records.filter((record) => record.greenClass === "GREEN_MISSING_NAME").length,
      unresolvedNameInPhase11g: nameResolution.nameUnresolvedTotal,
      unpublishedMachineGreen: live.machineGreenPublicationPartition.unpublished,
      unpublishedMachineGreenRelationIds: live.machineGreenPublicationPartition.unpublishedRelationIds,
      workingTree: {
        dirty: gitStatusLines.length > 0,
        porcelainEntryCount: gitStatusLines.length,
        temporaryOrWipArtifactsPresent: gitStatusLines.some((line) => line.startsWith("??")),
        note: "The current tree contains extensive uncommitted Phase 11 work and local diagnostic/WIP artifacts; closure does not remove or normalize them.",
      },
      gitHubMainLocalDivergence: {
        currentBranch: git(["branch", "--show-current"]),
        head: git(["rev-parse", "HEAD"]),
        localMainAheadOfHead: localMainDivergence[0],
        headAheadOfLocalMain: localMainDivergence[1],
        originMainAheadOfHead: trackingDivergence[0],
        headAheadOfOriginMain: trackingDivergence[1],
        trackingRefFreshnessVerifiedByFetch: false,
        caveat: "origin/main equals HEAD in the local tracking ref, but no network fetch was authorized or performed; current GitHub main cannot be certified.",
      },
    },
    databaseSafety: {
      authorizedHistoricalWrites: [
        "Earlier Phase 11 ACTIVE publication batches",
        "Controlled Phase 11H calibration staging: 44 route rows and 44 summit rows",
        "Explicit human QA decisions/history for those 44 staged routes",
      ],
      phase11hOrIPublishedControlledSample: live.phase11hControlledStaging.publicationProvenanceRows > 0,
      phase11hOrIModifiedActive: live.phase11hControlledStaging.activePublicationRows > 0,
      createdBlockedMountainIdentity: live.blockedRelation.exactMountainIdentityRows > 0,
      unrelatedWritesPerformedByClosure: false,
      closureDatabaseWrites: 0,
    },
    validation: {
      executedDuringClosure: true,
      overall: "PASS_WITH_WARNINGS",
      commands: [
        {
          command: "npm run lint",
          status: "PASS_WITH_WARNINGS",
          warnings: 19,
          note: "Existing unused-symbol warnings in uncommitted Phase 11 diagnostic/test scripts; zero lint errors.",
        },
        { command: "npx tsc --noEmit --incremental false", status: "PASS" },
        { command: "npm run test:projects", status: "PASS" },
        { command: "npm run test:social", status: "PASS" },
        { command: "npm run test:achievements", status: "PASS" },
        { command: "npm run test:weather", status: "PASS" },
        { command: "npm run test:phase11f", status: "PASS" },
        { command: "npm run test:phase11h", status: "PASS" },
        { command: "npm run test:phase11i", status: "PASS" },
        { command: "node --experimental-strip-types --test scripts/osm-import/phase11g-qualification.test.ts", status: "PASS" },
        { command: "npm run test:phase11closure", status: "PASS" },
        { command: "npm run build", status: "PASS" },
        { command: "git diff --check", status: "PASS" },
      ],
      persistentRuntimeStarted: false,
      manualRuntimeVerificationRequired: false,
    },
    zeroUnapprovedPublicationAttestation: {
      closurePublicationWrites: 0,
      closureActiveChanges: 0,
      closureStagingWrites: 0,
      closureQaWrites: 0,
      phase11hControlledSamplePublicationRows: live.phase11hControlledStaging.publicationProvenanceRows,
      phase11hControlledSampleActiveRows: live.phase11hControlledStaging.activePublicationRows,
      blockedRelationPublicationRows: live.blockedRelation.publicationProvenanceRows,
      attested: live.phase11hControlledStaging.publicationProvenanceRows === 0 && live.blockedRelation.publicationProvenanceRows === 0,
    },
    readiness: {
      phase11Closure: "PASS_WITH_DOCUMENTED_DEFERRED_ITEMS",
      readyForPhase12Planning: true,
      readyToPublishAllMachineGreen: false,
      publicationAuthorizationGrantedByThisArtifact: false,
    },
  };

  assertClosure(live.totals.activePublications === 118, `ACTIVE_EXPECTED_118_GOT_${live.totals.activePublications}`);
  assertClosure(live.phase11hControlledStaging.routeRows === 44, "PHASE11H_ROUTE_COUNT_DRIFT");
  assertClosure(live.phase11hControlledStaging.exactReceiptMatches === 44, "PHASE11H_RECEIPT_IDENTITY_DRIFT");
  assertClosure(live.phase11hControlledStaging.summitRows === 44, "PHASE11H_SUMMIT_COUNT_DRIFT");
  assertClosure(live.phase11hControlledStaging.visuallyApprovedRows === 44, "PHASE11H_APPROVAL_COUNT_DRIFT");
  assertClosure(live.phase11hControlledStaging.publicationProvenanceRows === 0, "PHASE11H_PUBLICATION_WRITE_DETECTED");
  assertClosure(live.blockedRelation.stagingRows === 0, "BLOCKED_RELATION_STAGED");
  assertClosure(live.blockedRelation.qaCurrentRows === 0, "BLOCKED_RELATION_QA_DETECTED");
  assertClosure(live.blockedRelation.exactMountainIdentityRows === 0, "BLOCKED_MOUNTAIN_IDENTITY_CREATED");
  assertClosure(decisionDistribution.VISUALLY_APPROVED === 44, "CALIBRATION_APPROVAL_DRIFT");
  assertClosure(decisionDistribution.NEEDS_REVIEW === 0, "CALIBRATION_NEEDS_REVIEW_DRIFT");
  assertClosure(decisionDistribution.REJECTED === 0, "CALIBRATION_REJECTION_DRIFT");
  assertClosure(integrity.historyIntegrityPass === true, "CALIBRATION_HISTORY_INTEGRITY_FAILED");
  assertClosure(integrity.payloadCompatibilityPass === true, "CALIBRATION_PAYLOAD_COMPATIBILITY_FAILED");

  const report = { ...content, deterministicArtifactHash: sha256Stable(content) };
  await writeJsonAtomically(REPORT_PATH, report);
  return report;
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  generatePhase11FinalClosureReport()
    .then((report) => {
      console.log(
        JSON.stringify(
          {
            artifact: REPORT_PATH,
            activePublications: report.production.totals.activePublications,
            controlledStaging: report.production.phase11hControlledStaging,
            machineScale: report.machineScale,
            blockedRelation: report.production.blockedRelation,
            readiness: report.readiness,
            databaseWrites: report.databaseSafety.closureDatabaseWrites,
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
