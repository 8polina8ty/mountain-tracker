import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PHASE11C4_QA_QUEUE_SIZE } from "./phase11c3-scale-readiness.ts";
import { iterateJsonLines, writeJsonAtomically } from "./jsonl.ts";
import {
  buildPhase11c4QueueCandidate,
  selectDeterministicPhase11c4Queue,
  type Phase11c4QueueRecord,
  type Phase11c4RouteAnalysis,
} from "./phase11c4-qa-queue.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

const ACTIVE_RELATIONS = [
  "196164", "20916", "33528", "199145", "207900", "207913",
  "361148", "140270", "1877850", "2210870", "915266", "3973107",
  "2202791", "1796122", "2135331", "1165714", "961283", "2050305",
] as const;

interface PublicationCandidatesDocument {
  candidates: Array<{ canonicalRouteSourceId: string }>;
}

interface ImportPlanDocument {
  generatedAt: string;
  datasetFingerprint: string;
  records: ImportPlanRecord[];
}

async function main(): Promise<void> {
  const [publicationCandidates, plan] = await Promise.all([
    readFile(resolve("data/osm/alps/staging/publication-candidates.json"), "utf8").then(
      (value) => JSON.parse(value) as PublicationCandidatesDocument,
    ),
    readFile(resolve("data/osm/alps/staging/import-plan.json"), "utf8").then(
      (value) => JSON.parse(value) as ImportPlanDocument,
    ),
  ]);
  const reviewedCanonicalIds = publicationCandidates.candidates.map(
    (candidate) => candidate.canonicalRouteSourceId,
  );
  const excludedCanonicalIds = new Set<string>([
    ...ACTIVE_RELATIONS,
    ...reviewedCanonicalIds,
  ]);
  const planByRelation = new Map(
    plan.records.map((record) => [record.sourceRelationId, record]),
  );
  const candidates: Phase11c4QueueRecord[] = [];
  let sourceOrder = 0;
  for await (const analysis of iterateJsonLines<Phase11c4RouteAnalysis>(
    resolve("data/osm/alps/route-analysis.jsonl"),
  )) {
    const candidate = buildPhase11c4QueueCandidate({
      analysis,
      planRecord: planByRelation.get(analysis.routeSourceId),
      excludedCanonicalIds,
      sourceOrder,
    });
    sourceOrder += 1;
    if (candidate) candidates.push(candidate);
  }

  const { queue, deterministicQueueHash } = selectDeterministicPhase11c4Queue(
    candidates,
    PHASE11C4_QA_QUEUE_SIZE,
  );
  const output = {
    schemaVersion: 1,
    artifactType: "PHASE11C4_NEW_QA_QUEUE",
    generatedAt: plan.generatedAt,
    datasetFingerprint: plan.datasetFingerprint,
    deterministicQueueHash,
    selectionMethod:
      "Phase 8 READY_FOR_STAGING admission with supported non-review activity classification; priority descending; source artifact order; numeric relation ID final tie-break; unique relation, canonical source, and source URL.",
    description:
      "Deterministic queue of NEW routes requiring visual QA review. Excludes the reviewed Phase 10 pool and ACTIVE production relations.",
    currentReviewedRoutes: publicationCandidates.candidates.length,
    currentActiveRoutes: ACTIVE_RELATIONS.length,
    newRoutesQueued: queue.length,
    targetReviewedPool: publicationCandidates.candidates.length + queue.length,
    estimatedEligibleAfterApproval: Math.min(queue.length, 100),
    queue,
  };
  const outputPath = resolve("data/osm/alps/publication/phase11c4-new-qa-queue.json");
  await writeJsonAtomically(outputPath, output);
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      eligibleCandidates: candidates.length,
      newRoutesQueued: queue.length,
      deterministicQueueHash,
      databaseWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
