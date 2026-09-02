import { readFile } from "node:fs/promises";

import { PHASE11C4_QA_QUEUE_SIZE } from "./phase11c3-scale-readiness.ts";
import {
  isPhase11c4StagingReady,
  phase11c4QueueHash,
  type Phase11c4QueueRecord,
} from "./phase11c4-qa-queue.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

const ACTIVE_RELATIONS = new Set([
  "196164", "20916", "33528", "199145", "207900", "207913", "361148", "140270",
  "1877850", "2210870", "915266", "3973107", "2202791", "1796122", "2135331",
  "1165714", "961283", "2050305",
]);

async function main(): Promise<void> {
  const [queueDocument, planDocument, reviewedDocument] = await Promise.all([
    readFile("data/osm/alps/publication/phase11c4-new-qa-queue.json", "utf8").then(JSON.parse),
    readFile("data/osm/alps/staging/import-plan.json", "utf8").then(JSON.parse),
    readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(JSON.parse),
  ]);
  const queue = queueDocument.queue as Phase11c4QueueRecord[];
  const planByRelation = new Map<string, ImportPlanRecord>(
    (planDocument.records as ImportPlanRecord[]).map((record) => [record.sourceRelationId, record]),
  );
  const reviewed = new Set<string>(
    reviewedDocument.candidates.map(
      (record: { canonicalRouteSourceId: string }) => record.canonicalRouteSourceId,
    ),
  );
  const blockers: Array<{ sourceRelationId: string; reasons: string[] }> = [];
  const relations = new Set<string>();
  const canonicals = new Set<string>();
  const sourceUrls = new Set<string>();
  for (const queueRecord of queue) {
    const reasons: string[] = [];
    const planRecord = planByRelation.get(queueRecord.sourceRelationId);
    if (!isPhase11c4StagingReady(planRecord)) reasons.push("NOT_PHASE8_READY");
    if (reviewed.has(queueRecord.canonicalRouteSourceId)) reasons.push("ALREADY_REVIEWED");
    if (ACTIVE_RELATIONS.has(queueRecord.canonicalRouteSourceId)) reasons.push("ALREADY_ACTIVE");
    if (relations.has(queueRecord.sourceRelationId)) reasons.push("DUPLICATE_RELATION");
    if (canonicals.has(queueRecord.canonicalRouteSourceId)) reasons.push("DUPLICATE_CANONICAL");
    if (sourceUrls.has(queueRecord.sourceUrl)) reasons.push("DUPLICATE_SOURCE_URL");
    relations.add(queueRecord.sourceRelationId);
    canonicals.add(queueRecord.canonicalRouteSourceId);
    sourceUrls.add(queueRecord.sourceUrl);
    if (planRecord?.contract.source.sourceUrl !== queueRecord.sourceUrl) reasons.push("SOURCE_URL_DRIFT");
    if (planRecord?.contract.confirmedSummits[0]?.mountainMatch.mountainId !== queueRecord.mountainId) {
      reasons.push("MOUNTAIN_ID_DRIFT");
    }
    if (reasons.length > 0) blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reasons });
  }
  const deterministicHashMatches =
    queueDocument.deterministicQueueHash === phase11c4QueueHash(queue);
  const result = {
    queueTotal: queue.length,
    expectedTotal: PHASE11C4_QA_QUEUE_SIZE,
    phase8ReadyCount: queue.length - blockers.filter((blocker) => blocker.reasons.includes("NOT_PHASE8_READY")).length,
    blocked: blockers.length,
    deterministicHashMatches,
    blockers,
    databaseWrites: 0,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    queue.length !== PHASE11C4_QA_QUEUE_SIZE ||
    blockers.length > 0 ||
    !deterministicHashMatches
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
