import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  computeAutoQaRecommendation,
  type AutoQaRecommendation,
} from "../../Lib/osmStagingPreview/auto-qa.ts";
import type {
  ApprovedStagingRouteListItem,
  PreviewMetadataDocument,
} from "../../Lib/osmStagingPreview/core.ts";
import { writeJsonAtomically } from "./jsonl.ts";
import type { Phase11c4QueueRecord } from "./phase11c4-qa-queue.ts";

interface QueueDocument {
  generatedAt: string;
  deterministicQueueHash: string;
  queue: Phase11c4QueueRecord[];
}

async function main(): Promise<void> {
  const [queueDocument, metadata] = await Promise.all([
    readFile("data/osm/alps/publication/phase11c4-new-qa-queue.json", "utf8").then(
      (value) => JSON.parse(value) as QueueDocument,
    ),
    readFile("data/osm/alps/staging/phase11c4-preview-metadata.json", "utf8").then(
      (value) => JSON.parse(value) as PreviewMetadataDocument,
    ),
  ]);
  const queueByRelation = new Map(
    queueDocument.queue.map((record) => [record.sourceRelationId, record]),
  );
  const evaluated = metadata.records.map((record) => {
    const queueRecord = queueByRelation.get(record.sourceRelationId);
    if (!queueRecord) throw new Error(`Missing queue relation ${record.sourceRelationId}.`);
    const route: ApprovedStagingRouteListItem = {
      ...record,
      stagingRouteId: `not-staged:${record.sourceRelationId}`,
      qaStatus: "PENDING",
      qaDecision: null,
    };
    const recommendation = computeAutoQaRecommendation(route, {
      routeType: queueRecord.activityRouteType,
      confidence: 0.95,
      manualReviewRequired: false,
      evidence: ["Phase 11C.4 queue admission classified the route as hiking."],
      conflictingTypes: [],
    });
    return { queueRecord, recommendation };
  });
  const counts: Record<AutoQaRecommendation, number> = { GREEN: 0, YELLOW: 0, RED: 0 };
  for (const record of evaluated) counts[record.recommendation.recommendation] += 1;
  const green = evaluated
    .filter((record) => record.recommendation.recommendation === "GREEN")
    .slice(0, 50);
  if (green.length !== 50) throw new Error(`Only ${green.length} GREEN routes are available.`);
  const routes = green.map(({ queueRecord, recommendation }) => ({
    relationId: queueRecord.canonicalRouteSourceId,
    routeName: queueRecord.routeName,
    mountainId: queueRecord.mountainId,
    quality: queueRecord.quality,
    topology: queueRecord.topology,
    semanticType: queueRecord.semanticType,
    activityRouteType: queueRecord.activityRouteType,
    autoQa: recommendation,
  }));
  const deterministicSampleHash = createHash("sha256")
    .update(JSON.stringify(routes))
    .digest("hex");
  const sample = {
    schemaVersion: 1,
    artifactType: "PHASE11C6_CALIBRATION_SAMPLE",
    generatedAt: queueDocument.generatedAt,
    sourceQueueHash: queueDocument.deterministicQueueHash,
    deterministicSampleHash,
    description:
      "Deterministic GREEN calibration sample for human review only. Recommendations never save or approve QA decisions.",
    totalAvailable: {
      green: counts.GREEN,
      yellow: counts.YELLOW,
      red: counts.RED,
    },
    targets: { green: 50, yellow: 25, red: 25 },
    selected: { green: routes.length, yellow: 0, red: 0 },
    routes,
  };
  const outputPath = "data/osm/alps/publication/phase11c6-calibration-sample.json";
  await writeJsonAtomically(outputPath, sample);
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      totalAvailable: sample.totalAvailable,
      selected: sample.selected,
      deterministicSampleHash,
      qaWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
