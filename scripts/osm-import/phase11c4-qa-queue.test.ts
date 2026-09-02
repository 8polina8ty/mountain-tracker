import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isPhase11c4StagingReady,
  phase11c4QueueHash,
  selectDeterministicPhase11c4Queue,
  type Phase11c4QueueRecord,
} from "./phase11c4-qa-queue.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

function candidate(id: string, sourceOrder: number): Phase11c4QueueRecord {
  return {
    sourceRelationId: id,
    canonicalRouteSourceId: id,
    routeName: `Route ${id}`,
    mountainId: Number(id),
    quality: 100,
    topology: "SIMPLE",
    semanticType: "summit_route",
    activityRouteType: "hiking",
    auditFlags: [],
    warnings: [],
    summitPeakOsmId: `9${id}`,
    summitName: `Peak ${id}`,
    summitElevationMeters: 2_000,
    adminBoundaryStatus: "ASSIGNED",
    sourceUrl: `https://www.openstreetmap.org/relation/${id}`,
    priorityScore: 2_500,
    sourceOrder,
  };
}

test("invalid candidate is replaced by the next deterministic eligible candidate", () => {
  const eligible = [candidate("1", 0), candidate("3", 2), candidate("4", 3)];
  const result = selectDeterministicPhase11c4Queue(eligible, 2);
  assert.deepEqual(result.queue.map((record) => record.sourceRelationId), ["1", "3"]);
  assert.equal(result.deterministicQueueHash, phase11c4QueueHash(result.queue));
});

test("selection order and hash are deterministic for the locked source order", () => {
  const candidates = [candidate("3", 2), candidate("1", 0), candidate("2", 1)];
  const first = selectDeterministicPhase11c4Queue(candidates, 3);
  const second = selectDeterministicPhase11c4Queue([...candidates].reverse(), 3);
  assert.deepEqual(first, second);
});

test("final Phase 11C.4 artifact is 150/150 Phase 8 ready with no historical overlap", async () => {
  const [queueDocument, planDocument, reviewedDocument] = await Promise.all([
    readFile("data/osm/alps/publication/phase11c4-new-qa-queue.json", "utf8").then(JSON.parse),
    readFile("data/osm/alps/staging/import-plan.json", "utf8").then(JSON.parse),
    readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(JSON.parse),
  ]);
  const queue = queueDocument.queue as Phase11c4QueueRecord[];
  const plan = planDocument.records as ImportPlanRecord[];
  const planByRelation = new Map(plan.map((record) => [record.sourceRelationId, record]));
  const reviewed = new Set<string>(
    reviewedDocument.candidates.map((record: { canonicalRouteSourceId: string }) => record.canonicalRouteSourceId),
  );
  const active = new Set([
    "196164", "20916", "33528", "199145", "207900", "207913", "361148", "140270",
    "1877850", "2210870", "915266", "3973107", "2202791", "1796122", "2135331",
    "1165714", "961283", "2050305",
  ]);
  assert.equal(queue.length, 150);
  assert.equal(queue.filter((record) => isPhase11c4StagingReady(planByRelation.get(record.sourceRelationId))).length, 150);
  assert.equal(new Set(queue.map((record) => record.sourceRelationId)).size, 150);
  assert.equal(new Set(queue.map((record) => record.canonicalRouteSourceId)).size, 150);
  assert.equal(new Set(queue.map((record) => record.sourceUrl)).size, 150);
  assert.equal(queue.some((record) => ["mixed", "other"].includes(record.activityRouteType)), false);
  assert.equal(queue.some((record) => reviewed.has(record.canonicalRouteSourceId)), false);
  assert.equal(queue.some((record) => active.has(record.canonicalRouteSourceId)), false);
  assert.equal(queueDocument.deterministicQueueHash, phase11c4QueueHash(queue));
  assert.deepEqual(
    queue.filter((record) => ["660063", "9636644", "11517353"].includes(record.sourceRelationId)),
    [],
  );
  assert.equal(isPhase11c4StagingReady(planByRelation.get("660063")), false);
  assert.equal(isPhase11c4StagingReady(planByRelation.get("9636644")), false);
  assert.equal(isPhase11c4StagingReady(planByRelation.get("11517353")), false);
  assert.equal(isPhase11c4StagingReady(undefined), false);
});
