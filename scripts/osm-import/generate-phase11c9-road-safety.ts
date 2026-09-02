import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  type PublicationCandidateArtifact,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  PHASE11C3_BASELINE_ACTIVE_RELATION_IDS,
  PHASE11C3_V2_MANIFEST_PATH,
  selectPhase11C3EligibleCandidates,
  type Phase11C3LockedBatchManifest,
} from "./phase11c3-scale-readiness.ts";
import { loadPhase11c4PublicationGateInput } from "./phase11c4-live-data.ts";
import { sha256Stable } from "./phase11-publication.ts";
import { MotorwaySpatialIndex, buildOrVerifyMotorwayIndex,
  createRoadSafetySourceDatasetIdentity } from "./phase11c9-road-index.ts";
import { FrozenRouteMemberStore } from "./phase11c9-route-member-store.ts";
import {
  analyzeRouteRoadSafety,
  createPhase11C9RoadSafetyReport,
  verifyPhase11C9RoadSafetyReport,
  type RoadSafetyRouteResult,
  type RoadSafetyWay,
} from "./phase11c9-road-safety.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const CHECKPOINT_DIRECTORY = "data/osm/alps/checkpoints/fafc4f7a772832f2";
const CHECKPOINT_PATH = `${CHECKPOINT_DIRECTORY}/bulk-store.sqlite`;
const CHECKPOINT_MANIFEST_PATH = `${CHECKPOINT_DIRECTORY}/manifest.json`;
const PIPELINE_SUMMARY_PATH = "data/osm/alps/summary.json";
const MOTORWAY_INDEX_PATH = "data/osm/alps/road-safety/phase11c9-motorways.sqlite";
const REPORT_PATH = "data/osm/alps/publication/phase11c9-road-safety-batch-100.json";
const POOL_REPORT_PATH =
  "data/osm/alps/publication/phase11c9-road-safety-eligible-pool-103.json";

function combineArtifacts(
  historical: PublicationCandidateArtifact,
  phase11c4: PublicationCandidateArtifact,
): PublicationCandidateArtifact {
  return {
    ...historical,
    candidates: [...historical.candidates, ...phase11c4.candidates],
    candidateCount: historical.candidateCount + phase11c4.candidateCount,
    totalReviewedRoutes:
      historical.totalReviewedRoutes + phase11c4.totalReviewedRoutes,
    qaProgress: {
      total: historical.qaProgress.total + phase11c4.qaProgress.total,
      decided: historical.qaProgress.decided + phase11c4.qaProgress.decided,
      pending: historical.qaProgress.pending + phase11c4.qaProgress.pending,
      visuallyApproved:
        historical.qaProgress.visuallyApproved + phase11c4.qaProgress.visuallyApproved,
      needsReview:
        historical.qaProgress.needsReview + phase11c4.qaProgress.needsReview,
      rejected: historical.qaProgress.rejected + phase11c4.qaProgress.rejected,
      warnings: historical.qaProgress.warnings + phase11c4.qaProgress.warnings,
      warningsPending:
        historical.qaProgress.warningsPending + phase11c4.qaProgress.warningsPending,
    },
    blockedCandidateCount:
      historical.blockedCandidateCount + phase11c4.blockedCandidateCount,
    blockedCountsByReason: {
      PENDING:
        historical.blockedCountsByReason.PENDING +
        phase11c4.blockedCountsByReason.PENDING,
      NEEDS_REVIEW:
        historical.blockedCountsByReason.NEEDS_REVIEW +
        phase11c4.blockedCountsByReason.NEEDS_REVIEW,
      REJECTED:
        historical.blockedCountsByReason.REJECTED +
        phase11c4.blockedCountsByReason.REJECTED,
    },
  };
}

function loadRoutes(text: string): Map<string, ClassifiableRoute> {
  return new Map(text.trim().split(/\r?\n/).map((line) => {
    const route = JSON.parse(line) as ClassifiableRoute;
    return [route.sourceId, route] as const;
  }));
}

function nearbyMotorways(
  routeWays: RoadSafetyWay[],
  index: MotorwaySpatialIndex,
): RoadSafetyWay[] {
  const ways = new Map<number, RoadSafetyWay>();
  for (const routeWay of routeWays) {
    if (routeWay.nodes.length < 2) continue;
    const longitudes = routeWay.nodes.map((node) => node.coordinate[0]);
    const latitudes = routeWay.nodes.map((node) => node.coordinate[1]);
    const padding = 0.0000001;
    for (const way of index.queryBounds({
      minimumLongitude: Math.min(...longitudes) - padding,
      maximumLongitude: Math.max(...longitudes) + padding,
      minimumLatitude: Math.min(...latitudes) - padding,
      maximumLatitude: Math.max(...latitudes) + padding,
    })) ways.set(way.id, way);
  }
  return [...ways.values()].sort((left, right) => left.id - right.id);
}

function summary(records: RoadSafetyRouteResult[]) {
  return {
    total: records.length,
    safe: records.filter((record) => record.status === "SAFE").length,
    blocked: records.filter((record) => record.status === "BLOCKED").length,
    manualReviewRequired: records.filter(
      (record) => record.status === "MANUAL_REVIEW_REQUIRED",
    ).length,
  };
}

async function main(): Promise<void> {
  await mkdir("data/osm/alps/road-safety", { recursive: true });
  const [providedManifest, routeText, historicalInput, phase11c4Input] =
    await Promise.all([
      readFile(PHASE11C3_V2_MANIFEST_PATH, "utf8").then(
        (value) => JSON.parse(value) as Phase11C3LockedBatchManifest,
      ),
      readFile("data/osm/alps/routes.jsonl", "utf8"),
      loadPublicationGateInput(),
      loadPhase11c4PublicationGateInput(),
    ]);

  const { deterministicV2ManifestHash, ...manifestContent } = providedManifest;
  if (
    sha256Stable(manifestContent) !== deterministicV2ManifestHash ||
    providedManifest.records.length !== 100
  ) throw new Error("PHASE11C9_LOCKED_MANIFEST_DRIFT");

  const historicalArtifact = buildPublicationCandidateArtifact(
    historicalInput,
    { expectedRecordCount: 46 },
  );
  const phase11c4Artifact = buildPublicationCandidateArtifact(
    phase11c4Input,
    { expectedRecordCount: 150 },
  );
  const combinedArtifact = combineArtifacts(historicalArtifact, phase11c4Artifact);
  buildPublicationCandidateManifest(combinedArtifact);
  const routes = loadRoutes(routeText);
  const eligible = selectPhase11C3EligibleCandidates({
    artifact: combinedArtifact,
    routes,
    activeRelationIds: new Set(PHASE11C3_BASELINE_ACTIVE_RELATION_IDS),
  });
  if (eligible.length !== 103) {
    throw new Error(`PHASE11C9_EXPECTED_ELIGIBLE_POOL_103:${eligible.length}`);
  }

  const indexMetadata = await buildOrVerifyMotorwayIndex({
    pbfPath: PBF_PATH,
    indexPath: MOTORWAY_INDEX_PATH,
    onProgress: (message) => console.log(message),
  });
  const sourceDatasetIdentity = await createRoadSafetySourceDatasetIdentity({
    pbfPath: PBF_PATH,
    checkpointPath: CHECKPOINT_PATH,
    checkpointManifestPath: CHECKPOINT_MANIFEST_PATH,
    pipelineSummaryPath: PIPELINE_SUMMARY_PATH,
    pipelineDatasetFingerprint: combinedArtifact.datasetFingerprint,
    motorwayIndexMetadata: indexMetadata,
  });

  const routeStore = new FrozenRouteMemberStore(CHECKPOINT_PATH);
  const motorwayIndex = new MotorwaySpatialIndex(MOTORWAY_INDEX_PATH);
  const poolRecords: RoadSafetyRouteResult[] = [];
  try {
    for (let index = 0; index < eligible.length; index += 1) {
      const { candidate, activity } = eligible[index];
      const relationIds = candidate.duplicateProvenance.sourceRouteIds;
      const routeWays = routeStore.routeWays(relationIds);
      const record = analyzeRouteRoadSafety({
        canonicalRelationId: candidate.canonicalRouteSourceId,
        stagingRouteId: candidate.stagingRouteId,
        routeType: activity.routeType,
        routeWays,
        nearbyMotorwayWays: nearbyMotorways(routeWays, motorwayIndex),
        sourceDatasetIdentity,
      });
      poolRecords.push(record);
      if ((index + 1) % 10 === 0 || index + 1 === eligible.length) {
        console.log(`Analyzed ${index + 1}/${eligible.length} eligible routes.`);
      }
    }
  } finally {
    motorwayIndex.close();
    routeStore.close();
  }

  const poolByRelation = new Map(
    poolRecords.map((record) => [record.canonicalRelationId, record]),
  );
  const lockedRecords = providedManifest.records.map((record) => {
    const safety = poolByRelation.get(record.canonicalRouteSourceId);
    if (!safety) {
      throw new Error(
        `PHASE11C9_LOCKED_RECORD_NOT_IN_ELIGIBLE_POOL:${record.canonicalRouteSourceId}`,
      );
    }
    return safety;
  });
  const report = createPhase11C9RoadSafetyReport({
    lockedManifestPath: PHASE11C3_V2_MANIFEST_PATH,
    lockedManifestHash: providedManifest.deterministicV2ManifestHash,
    sourceDatasetIdentity,
    records: lockedRecords,
  });
  verifyPhase11C9RoadSafetyReport(report);

  const poolContent = {
    schemaVersion: 1 as const,
    artifactType: "PHASE11C9_ROAD_SAFETY_ELIGIBLE_POOL" as const,
    readOnly: true as const,
    sourceDatasetIdentity,
    selectionBaselineHash: providedManifest.baselineSnapshot.baselineHash,
    summary: summary(poolRecords),
    records: poolRecords,
    writes: {
      rpcCalls: 0 as const,
      databaseWrites: 0 as const,
      qaWrites: 0 as const,
      publicationWrites: 0 as const,
    },
  };
  const poolReport = {
    ...poolContent,
    deterministicReportHash: sha256Stable(poolContent),
  };
  await Promise.all([
    writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(POOL_REPORT_PATH, `${JSON.stringify(poolReport, null, 2)}\n`, "utf8"),
  ]);

  console.log(JSON.stringify({
    reportPath: REPORT_PATH,
    reportHash: report.deterministicReportHash,
    lockedBatch: report.summary,
    eligiblePoolPath: POOL_REPORT_PATH,
    eligiblePoolHash: poolReport.deterministicReportHash,
    eligiblePool: poolReport.summary,
    safeEligibleRelationIds: poolRecords
      .filter((record) => record.status === "SAFE")
      .map((record) => record.canonicalRelationId),
    rpcCalls: 0,
    databaseWrites: 0,
    qaWrites: 0,
    publicationWrites: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
