import { readFile } from "node:fs/promises";

import { writeJsonLines } from "./jsonl.ts";
import {
  applyMemberChainRecoveryToPlan,
  recoverDeterministicMemberChain,
  type Phase11eQualificationResult,
} from "./phase11e-recovery.ts";
import { FrozenRouteMemberStore } from "./phase11c9-route-member-store.ts";
import {
  validateFirstWriteManifest,
  type FirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";

const PATHS = {
  plan: "data/osm/alps/staging/import-plan.json",
  queue: "data/osm/alps/publication/phase11e-qa-queue.json",
  green: "data/osm/alps/publication/phase11e-qualified-safe-candidates.json",
  yellow: "data/osm/alps/publication/phase11e-yellow-review-candidates.json",
  manifest: "data/osm/alps/staging/phase11e-staging-manifest.json",
  checkpoint: "data/osm/alps/checkpoints/fafc4f7a772832f2/bulk-store.sqlite",
  output: "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl",
} as const;

interface PlanDocument {
  datasetFingerprint: string;
  records: ImportPlanRecord[];
}

interface QueueDocument {
  queue: Array<{
    sourceRelationId: string;
    stagingPayloadHash: string;
    recoveredByPhase11e: boolean;
  }>;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("Offline execution-plan reconstruction accepts no arguments.");
  const [plan, queue, green, yellow, manifest] = await Promise.all([
    json<PlanDocument>(PATHS.plan),
    json<QueueDocument>(PATHS.queue),
    json<{ records: Phase11eQualificationResult[] }>(PATHS.green),
    json<{ records: Phase11eQualificationResult[] }>(PATHS.yellow),
    json<FirstWriteManifest>(PATHS.manifest),
  ]);
  const planByRelation = new Map(plan.records.map((record) => [record.sourceRelationId, record]));
  const qualificationByRelation = new Map([...green.records, ...yellow.records]
    .map((record) => [record.sourceRelationId, record]));
  const manifestIds = new Set(manifest.records.map((record) => record.sourceRelationId));
  const store = new FrozenRouteMemberStore(PATHS.checkpoint);
  const executable: ImportPlanRecord[] = [];
  try {
    for (const queued of queue.queue) {
      if (!manifestIds.has(queued.sourceRelationId)) continue;
      const original = planByRelation.get(queued.sourceRelationId);
      const qualification = qualificationByRelation.get(queued.sourceRelationId);
      if (!original || !qualification) throw new Error(`PHASE11E_OFFLINE_PLAN_IDENTITY_MISSING:${queued.sourceRelationId}`);
      let effective = original;
      if (queued.recoveredByPhase11e) {
        const recovery = recoverDeterministicMemberChain({
          relationId: queued.sourceRelationId,
          originalComponentCount: original.contract.route.componentCount,
          store,
        });
        if (recovery.status !== "RECOVERED") {
          throw new Error(`PHASE11E_OFFLINE_RECOVERY_FAILED:${queued.sourceRelationId}:${recovery.reasonCode}`);
        }
        effective = applyMemberChainRecoveryToPlan({
          record: original,
          recovery,
          qualityScore: qualification.qualityScore,
        });
      }
      if (effective.payloadHash !== queued.stagingPayloadHash) {
        throw new Error(`PHASE11E_OFFLINE_PAYLOAD_DRIFT:${queued.sourceRelationId}`);
      }
      executable.push(effective);
    }
  } finally {
    store.close();
  }
  validateFirstWriteManifest(executable, manifest, plan.datasetFingerprint);
  await writeJsonLines(PATHS.output, executable);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    records: executable.length,
    recovered: executable.filter((record) => queue.queue.find((queued) => queued.sourceRelationId === record.sourceRelationId)?.recoveredByPhase11e).length,
    manifestHash: manifest.manifestHash,
    databaseWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
