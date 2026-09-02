import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { sha256Stable } from "./phase11-publication.ts";
import type { Phase11gQualificationResult } from "./phase11g-qualification.ts";
import { FrozenRouteMemberStore } from "./phase11c9-route-member-store.ts";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
  type RouteTopologyAnalysis,
  type TopologyRouteGeometry,
} from "../../Lib/osmStagingPreview/topology.ts";
import {
  classifyStartContextV3,
  loadPhase11f2FeatureIndex,
} from "./start-context-classifier3.ts";
import {
  buildFeatureIndex,
  type EleNodeRecord,
} from "./phase11f3-start-elevation.ts";
import {
  PHASE11H_CONTRACT,
  PHASE11H_NAME_RESOLUTION_CONTRACT,
  PHASE11H_QA_QUESTION_CONTRACT,
  PHASE11H_QA_QUESTIONS,
  PHASE11H_QA_STATUS_VOCABULARY,
  PHASE11H_SAMPLE_TARGET,
  PHASE11H_STAGING_CONTRACT,
  deriveNamedStartEntity,
  isNameReady,
  resolvePhase11hNameResolution,
  qualityBand,
  type Phase11hNameResolution,
  type Phase11hQualityBand,
} from "./phase11h-naming.ts";
import {
  selectPhase11hCalibrationSample,
} from "./phase11h-sample.ts";

const DATA_ROOT = "data/osm/alps";
const CANONICAL_CONFIRMED = `${DATA_ROOT}/audit/canonical-confirmed-routes.jsonl`;
const ROUTES_JSONL = `${DATA_ROOT}/routes.jsonl`;
const FEATURE_DIR = `${DATA_ROOT}/staging/phase11f2-features`;
const ELE_NODES_RAW = `${DATA_ROOT}/staging/phase11f3-features/ele-nodes-raw.json`;

const GREEN_ARTIFACT = `${DATA_ROOT}/staging/phase11g-expanded-green-candidates.json`;
const CHECKPOINT_PATH = "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite";
const OUT_STAGING = `${DATA_ROOT}/staging`;

const NAME_AUDIT_PATH = `${OUT_STAGING}/phase11h-name-resolution-audit.json`;
const QUEUE_PATH = `${OUT_STAGING}/phase11h-human-calibration-queue.json`;
const READINESS_PATH = `${OUT_STAGING}/phase11h-readiness.json`;
const STAGING_PLAN_PATH = `${OUT_STAGING}/phase11h-controlled-staging-plan.json`;

const EXISTING_VALIDATED_GREEN = 124;
const PHASE11G_NEW_GREEN_EXPECTED = 121;

const QA_STATUS_VOCABULARY_READ = [
  "PENDING",
  "VISUALLY_APPROVED",
  "NEEDS_REVIEW",
  "REJECTED",
] as const;

interface CanonicalConfirmedRoute {
  canonicalRouteSourceId: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  sourceRouteIds: string[];
  confirmedSummits: Array<{
    peakSourceId: string;
    peakName: string | null;
    peakElevationMeters: number | null;
    peakCoordinates: [number, number] | null;
    minimumGeometryDistanceMeters: number | null;
    endpointDistanceMeters: number | null;
    finalConfidence: number;
  }>;
}

interface RoutesRecord {
  source: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: [number, number][] | [number, number][][];
  };
}

function artifact<T extends object>(content: T): T & { deterministicArtifactHash: string } {
  return { ...content, deterministicArtifactHash: sha256Stable(content) };
}

function serialize(input: unknown): string {
  return JSON.stringify(input, null, 2);
}

async function loadJsonLines<T>(pathValue: string): Promise<T[]> {
  const lines = (await readFile(pathValue, "utf8")).trim().split(/\r?\n/);
  return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}

async function loadRoutesById(): Promise<Map<string, RoutesRecord>> {
  const result = new Map<string, RoutesRecord>();
  for (const record of await loadJsonLines<RoutesRecord>(ROUTES_JSONL)) {
    result.set(String(record.sourceId), record);
  }
  return result;
}

async function loadCanonicalById(): Promise<Map<string, CanonicalConfirmedRoute>> {
  const result = new Map<string, CanonicalConfirmedRoute>();
  for (const record of await loadJsonLines<CanonicalConfirmedRoute>(CANONICAL_CONFIRMED)) {
    result.set(record.canonicalRouteSourceId, record);
  }
  return result;
}

async function loadPhase11gGreens(): Promise<Phase11gQualificationResult[]> {
  const parsed = JSON.parse(await readFile(GREEN_ARTIFACT, "utf8")) as {
    records: Phase11gQualificationResult[];
  };
  if (parsed.records.length !== PHASE11G_NEW_GREEN_EXPECTED) {
    throw new Error(`PHASE11G_GREEN_ARTIFACT_COUNT:${parsed.records.length}`);
  }
  return parsed.records;
}

interface QaReconciliationHit {
  id: string;
  artifact: string;
  status: string;
}

async function scanQaDecisionArtifacts(ids: Set<string>): Promise<{
  hits: QaReconciliationHit[];
  artifactsScanned: number;
}> {
  const identityKeys = [
    "canonicalRouteSourceId",
    "canonicalRelationId",
    "sourceRelationId",
    "canonical_source_id",
    "canonical_relation_id",
  ];
  const hits: QaReconciliationHit[] = [];
  let artifactsScanned = 0;

  const walk = (value: unknown, artifactName: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, artifactName);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : null;
    const decision =
      record.qaDecision && typeof record.qaDecision === "object"
        ? (record.qaDecision as Record<string, unknown>)
        : null;
    const decisionStatus =
      decision && typeof decision.status === "string" ? String(decision.status) : null;
    const resolvedStatus = status ?? decisionStatus;
    if (resolvedStatus && (QA_STATUS_VOCABULARY_READ as readonly string[]).includes(resolvedStatus)) {
      for (const key of identityKeys) {
        const candidate = record[key];
        if (typeof candidate === "string" && ids.has(candidate)) {
          hits.push({ id: candidate, artifact: artifactName, status: resolvedStatus });
        }
      }
    }
    for (const entry of Object.values(record)) walk(entry, artifactName);
  };

  for (const dir of [`${DATA_ROOT}/staging`, `${DATA_ROOT}/publication`]) {
    for (const file of await readdir(dir)) {
      if (!/\.json$/i.test(file)) continue;
      const artifactName = path.join(dir, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(artifactName, "utf8"));
      } catch {
        continue;
      }
      artifactsScanned += 1;
      walk(parsed, artifactName);
    }
  }
  return { hits, artifactsScanned };
}

function evidenceOptions() {
  return {
    hutProximityThresholdMeters: 200,
    highMountainProximityThresholdMeters: 500,
    parkingThresholdMeters: 300,
    trailheadThresholdMeters: 300,
    trailheadInfoThresholdMeters: 100,
    settlementThresholdMeters: 1000,
    settlementTightThresholdMeters: 300,
    transitThresholdMeters: 150,
    dwellingThresholdMeters: 600,
    dwellingTightThresholdMeters: 100,
    eleNodeRadiusMeters: 300,
    minVerticalGainForBaseStartMeters: 500,
  };
}

async function deriveResolutionFor(
  green: Phase11gQualificationResult,
  canonicalById: Map<string, CanonicalConfirmedRoute>,
  routesById: Map<string, RoutesRecord>,
  featureIndex: Awaited<ReturnType<typeof loadPhase11f2FeatureIndex>>,
  phase11f3Index: ReturnType<typeof buildFeatureIndex>,
  routeStore: FrozenRouteMemberStore,
): Promise<Phase11hNameResolution> {
  const id = green.canonicalRouteSourceId;
  const canonicalRecord = canonicalById.get(id) ?? null;
  const routesRec = routesById.get(id) ?? null;
  const confirmed = canonicalRecord?.confirmedSummits ?? [];
  const summit = confirmed[0] ?? null;
  const summitEntity =
    summit === null
      ? null
      : {
          peakSourceId: summit.peakSourceId,
          peakName: summit.peakName,
          peakElevationMeters: summit.peakElevationMeters,
        };

  let topology: RouteTopologyAnalysis | null = null;
  try {
    topology = routesRec?.geometry
      ? analyzeRouteTopology(
          routesRec.geometry as TopologyRouteGeometry,
        )
      : null;
  } catch {
    topology = null;
  }
  const summitCoords = confirmed
    .map((value) => value.peakCoordinates)
    .filter((value): value is [number, number] => value !== null);
  const singleExactTerminal =
    confirmed.length === 1 &&
    confirmed[0].endpointDistanceMeters != null &&
    confirmed[0].endpointDistanceMeters <= 10;
  const orientable = summitCoords.length === 1;
  const endpoint = topology ? selectRouteEndpoints(topology, summitCoords) : null;
  const hasValidStartFinish =
    topology !== null &&
    topology.physicalEndpointCount === 2 &&
    endpoint !== null &&
    !endpoint.ambiguous;

  let startEntity = null;
  let contextMatchesStored = true;
  if (
    topology &&
    endpoint &&
    singleExactTerminal &&
    orientable &&
    hasValidStartFinish &&
    endpoint.startCoordinate &&
    (green.startContext === "HUT_START" || green.startContext === "BASE_START")
  ) {
    const summitEle = confirmed[0].peakElevationMeters ?? null;
    const evidence = await classifyStartContextV3(
      endpoint.startCoordinate,
      endpoint.startCoordinate,
      summitEle,
      featureIndex,
      phase11f3Index,
    );
    contextMatchesStored = evidence.type === green.startContext;
    if (contextMatchesStored) {
      startEntity = deriveNamedStartEntity({
        startContext: green.startContext,
        nearbyFeatures: evidence.nearbyFeatures,
        options: evidenceOptions(),
      });
    }
  }

  let rawTags: Record<string, string> = {};
  const relation = routeStore.getRelation(Number(id));
  if (relation) {
    rawTags = relation.tags;
  } else if (canonicalRecord) {
    for (const sourceId of canonicalRecord.sourceRouteIds) {
      const candidate = routeStore.getRelation(Number(sourceId));
      if (candidate) {
        rawTags = candidate.tags;
        break;
      }
    }
  }
  if (!contextMatchesStored) startEntity = null;

  return resolvePhase11hNameResolution({
    canonicalRelationId: id,
    rawTags,
    startContext: green.startContext ?? null,
    startEntity,
    summitEntity,
  });
}

async function main(): Promise<void> {
  await mkdir(OUT_STAGING, { recursive: true });

  process.stdout.write("Phase 11H HUMAN CALIBRATION & MISSING-NAME RESOLUTION (offline, frozen OSM only)\n");

  const greens = await loadPhase11gGreens();
  const [canonicalById, routesById, featureIndex] = await Promise.all([
    loadCanonicalById(),
    loadRoutesById(),
    loadPhase11f2FeatureIndex(FEATURE_DIR),
  ]);
  const eleNodes = (JSON.parse(await readFile(ELE_NODES_RAW, "utf8")) as EleNodeRecord[]).filter(
    (node) => node.coordinate && node.normalizedMeters != null,
  );
  const phase11f3Index = buildFeatureIndex(featureIndex, eleNodes);
  const routeStore = new FrozenRouteMemberStore(CHECKPOINT_PATH);

  const resolutions: Phase11hNameResolution[] = [];
  try {
    for (const green of greens) {
      resolutions.push(
        await deriveResolutionFor(green, canonicalById, routesById, featureIndex, phase11f3Index, routeStore),
      );
    }
  } finally {
    routeStore.close();
  }

  const resolutionById = new Map<string, Phase11hNameResolution>(
    resolutions.map((resolution) => [resolution.canonicalRelationId, resolution]),
  );
  const nameStatusCounts: Record<string, number> = {};
  const refKindCounts: Record<string, number> = {};
  for (const resolution of resolutions) {
    nameStatusCounts[resolution.nameStatus] = (nameStatusCounts[resolution.nameStatus] ?? 0) + 1;
    refKindCounts[resolution.refKind] = (refKindCounts[resolution.refKind] ?? 0) + 1;
  }
  const nameReadyTotal = resolutions.filter((resolution) => isNameReady(resolution.nameStatus)).length;
  const nameUnresolvedTotal = resolutions.length - nameReadyTotal;
  const hutResolved = resolutions.filter(
    (resolution) => resolution.startContext === "HUT_START" && isNameReady(resolution.nameStatus),
  ).length;
  const baseResolved = resolutions.filter(
    (resolution) => resolution.startContext === "BASE_START" && isNameReady(resolution.nameStatus),
  ).length;

  const sampleSelection = selectPhase11hCalibrationSample(greens, PHASE11H_SAMPLE_TARGET);
  const sample = sampleSelection.records;

  const candidateHashes: Record<string, string> = {};
  for (const green of greens) {
    candidateHashes[green.canonicalRouteSourceId] = sha256Stable({
      artifactType: "PHASE11H_CANDIDATE",
      contractVersion: PHASE11H_CONTRACT,
      canonicalRouteSourceId: green.canonicalRouteSourceId,
      sourceUrl: green.sourceUrl,
      greenClass: green.greenClass,
      qualityScore: green.qualityScore,
    });
  }

  const reconcile = await scanQaDecisionArtifacts(new Set(greens.map((green) => green.canonicalRouteSourceId)));

  const nameAudit = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11H_NAME_RESOLUTION_AUDIT",
    contractVersion: PHASE11H_NAME_RESOLUTION_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    recordCount: resolutions.length,
    counts: nameStatusCounts,
    nameReady: nameReadyTotal,
    nameUnresolved: nameUnresolvedTotal,
    refPartition: refKindCounts,
    hutNameResolved: hutResolved,
    baseNameResolved: baseResolved,
    records: resolutions,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const sampleBase = sample.filter((record) => record.startContext === "BASE_START").length;
  const sampleHut = sample.filter((record) => record.startContext === "HUT_START").length;
  const sampleNamed = sample.filter((record) => record.greenClass === "GREEN_NAMED").length;
  const sampleMissingName = sample.filter((record) => record.greenClass === "GREEN_MISSING_NAME").length;
  const sampleDerivedName = sample.filter((record) => {
    const resolution = resolutionById.get(record.canonicalRelationId);
    return resolution?.nameStatus === "DERIVED_SOURCE_BACKED";
  }).length;
  const sampleUnresolvedName = sample.filter((record) => {
    const resolution = resolutionById.get(record.canonicalRelationId);
    return resolution !== undefined && !isNameReady(resolution.nameStatus);
  }).length;
  const sampleLowQuality = sample.filter((record) => record.qualityBand === "Q65_74").length;
  const sampleRandomControl = sample.filter((record) => record.selectionTier === "HASH_RANDOM_CONTROL").length;

  const populationBands = new Set<Phase11hQualityBand>(
    greens.map((green) => qualityBand(green.qualityScore)),
  );
  const sampleBands = new Set(sample.map((record) => record.qualityBand));
  const humanCalibrationReady =
    sample.length > 0 &&
    sampleBase > 0 &&
    sampleHut > 0 &&
    sampleMissingName > 0 &&
    [...populationBands].every((band) => sampleBands.has(band));

  const qaStatusById = new Map<string, string>();
  for (const hit of reconcile.hits) {
    if (!qaStatusById.has(hit.id)) qaStatusById.set(hit.id, hit.status);
  }
  const existingApproved = greens.filter(
    (green) => qaStatusById.get(green.canonicalRouteSourceId) === "VISUALLY_APPROVED",
  ).length;
  const rejectedMachineEligible = greens.filter(
    (green) => qaStatusById.get(green.canonicalRouteSourceId) === "REJECTED",
  ).length;
  const needsReviewMachineEligible = greens.filter(
    (green) => qaStatusById.get(green.canonicalRouteSourceId) === "NEEDS_REVIEW",
  ).length;
  const humanQaBlocked = rejectedMachineEligible + needsReviewMachineEligible;
  const humanQaPending = greens.length - existingApproved - humanQaBlocked;

  const queueMembers = sample.map((record) => {
    const resolution = resolutionById.get(record.canonicalRelationId);
    return {
      canonicalRelationId: record.canonicalRelationId,
      candidateHash: candidateHashes[record.canonicalRelationId],
      qualificationHash: record.qualificationHash,
      nameStatus: resolution?.nameStatus ?? "UNRESOLVED",
      nameOrigin: resolution?.nameOrigin ?? null,
      resolvedDisplayName: resolution?.derivedDisplayName ?? null,
      startContext: record.startContext,
      qualityBand: record.qualityBand,
      selectionTier: record.selectionTier,
      selectionReason: record.selectionReason,
      humanDecisionStatus: null,
      humanDecisionReviewerId: null,
      humanDecisionReviewedAt: null,
      humanDecisionNote: null,
    };
  });

  const queueArtifact = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11H_HUMAN_CALIBRATION_QUEUE",
    contractVersion: PHASE11H_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    qaDecisionWrites: 0 as const,
    autoApprovalEnabled: false as const,
    queueVersion: "phase11h-calibration-1",
    deterministicOrdering: sampleSelection.deterministicOrderingRule,
    selectionTargetSize: sampleSelection.targetSize,
    qaQuestionContractVersion: PHASE11H_QA_QUESTION_CONTRACT,
    qaStatusVocabulary: [...PHASE11H_QA_STATUS_VOCABULARY],
    questions: PHASE11H_QA_QUESTIONS,
    sampleSize: sample.length,
    sample: queueMembers,
    noPrefilledHumanDecision: true as const,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const planRows = sample.map((record) => ({
    canonicalRelationId: record.canonicalRelationId,
    stagingContractVersion: PHASE11H_STAGING_CONTRACT,
    previouslyStaged: false,
    unchanged: false,
    conflict: null,
    conflictReason: null,
    blocked: false,
    blockedReason: null,
    wouldCreateEntry: true,
  }));
  const wouldCreate = planRows.filter((row) => row.wouldCreateEntry).length;
  const unchanged = planRows.filter((row) => row.unchanged).length;
  const conflicts = planRows.filter((row) => row.conflictReason !== null).length;
  const blocked = planRows.filter((row) => row.blocked).length;

  const stagingPlanArtifact = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11H_CONTROLLED_STAGING_PLAN",
    contractVersion: PHASE11H_CONTRACT,
    readOnly: true as const,
    executed: false as const,
    purpose:
      "Deterministic controlled staging plan ONLY for interactive human visual review of the Phase 11H calibration sample. NOT executed in Phase 11H.",
    stagedStateOracle:
      "Phase 11H has no Supabase DB access and performs zero reads/writes against staging. By Phase 11G construction none of the 121 GREEN candidates are Active or previously staged routes; on execution every sample relation would be created. previouslyStaged therefore defaults to false and is unverifiable offline.",
    stagingContractVersion: PHASE11H_STAGING_CONTRACT,
    scope: {
      sampleSize: sample.length,
      relations: sample.map((record) => record.canonicalRelationId).sort((a, b) => Number(a) - Number(b)),
    },
    wouldCreate,
    unchanged,
    conflicts,
    blocked,
    rows: planRows,
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  const readinessArtifact = artifact({
    schemaVersion: 1 as const,
    artifactType: "PHASE11H_READINESS",
    contractVersion: PHASE11H_CONTRACT,
    readOnly: true as const,
    publishable: false as const,
    autoApprovalEnabled: false as const,
    existingValidatedGreen: EXISTING_VALIDATED_GREEN,
    phase11gNewGreen: greens.length,
    combinedMachineGreen: EXISTING_VALIDATED_GREEN + greens.length,
    nameResolution: {
      counts: nameStatusCounts,
      nameReadyTotal,
      nameUnresolvedTotal,
      hutNameResolved: hutResolved,
      baseNameResolved: baseResolved,
      refPartition: refKindCounts,
    },
    calibration: {
      sampleSize: sample.length,
      sampleBase,
      sampleHut,
      sampleNamed,
      sampleMissingName,
      sampleDerivedName,
      sampleUnresolvedName,
      sampleLowQuality,
      sampleRandomControl,
      qualityBands: {
        Q65_74: sample.filter((record) => record.qualityBand === "Q65_74").length,
        Q75_89: sample.filter((record) => record.qualityBand === "Q75_89").length,
        Q90: sample.filter((record) => record.qualityBand === "Q90").length,
      },
      humanCalibrationReady,
    },
    publicationPartition: {
      MACHINE_GREEN_NAME_READY: nameReadyTotal,
      MACHINE_GREEN_NAME_UNRESOLVED: nameUnresolvedTotal,
      HUMAN_QA_EXISTING_APPROVED: existingApproved,
      HUMAN_QA_PENDING: humanQaPending,
      HUMAN_QA_BLOCKED: humanQaBlocked,
    },
    finalPartition: {
      READY_FOR_HUMAN_QA: greens.length,
      NAME_RESOLVED: nameReadyTotal,
      NAME_UNRESOLVED: nameUnresolvedTotal,
      BLOCKED_BY_HUMAN_QA: humanQaBlocked,
      READY_FOR_CONTROLLED_STAGING: 0 as const,
    },
    humanGuards: {
      rejectedMachineEligible,
      needsReviewMachineEligible,
      existingApprovedCount: existingApproved,
      reconciledArtifactHits: reconcile.hits.length,
      artifactsScanned: reconcile.artifactsScanned,
      derivedNameRequiresHumanConfirmation: true as const,
      visuallyApprovedIsNotNameApproval: true as const,
    },
    stagingForReview: {
      requiredForInteractiveUi: true as const,
      artifactOnlyQueueSupported: false as const,
      planExecuted: false as const,
      planPath: STAGING_PLAN_PATH,
      wouldCreate,
      unchanged,
      conflicts,
      blocked,
    },
    writes: { databaseWrites: 0 as const, qaWrites: 0 as const, publicationWrites: 0 as const },
  });

  await writeFile(NAME_AUDIT_PATH, serialize(nameAudit));
  await writeFile(QUEUE_PATH, serialize(queueArtifact));
  await writeFile(READINESS_PATH, serialize(readinessArtifact));
  await writeFile(STAGING_PLAN_PATH, serialize(stagingPlanArtifact));

  console.log("\nPhase 11H HUMAN CALIBRATION & MISSING-NAME RESOLUTION");
  console.log(`GREEN candidates: ${greens.length}`);
  console.log(`Naming resolution: ${JSON.stringify(nameStatusCounts)}`);
  console.log(`Name ready: ${nameReadyTotal}, name unresolved: ${nameUnresolvedTotal}`);
  console.log(`Ref partition: ${JSON.stringify(refKindCounts)}`);
  console.log(`HUT names resolved: ${hutResolved}, BASE names resolved: ${baseResolved}`);
  console.log(`Calibration sample: ${sample.length} (base ${sampleBase}, hut ${sampleHut}, named ${sampleNamed}, missing-name ${sampleMissingName}, derived ${sampleDerivedName}, unresolved ${sampleUnresolvedName}, low-quality ${sampleLowQuality}, random control ${sampleRandomControl})`);
  console.log(`Human calibration ready: ${humanCalibrationReady}`);
  console.log(`Human guards: rejected ${rejectedMachineEligible}, needs-review ${needsReviewMachineEligible}, approved ${existingApproved}`);
  console.log(`Controlled staging plan (NOT executed): wouldCreate ${wouldCreate}, unchanged ${unchanged}, conflicts ${conflicts}, blocked ${blocked}`);
  console.log("Artifacts:");
  console.log(`  ${NAME_AUDIT_PATH}`);
  console.log(`  ${QUEUE_PATH}`);
  console.log(`  ${READINESS_PATH}`);
  console.log(`  ${STAGING_PLAN_PATH}`);
}

await main();