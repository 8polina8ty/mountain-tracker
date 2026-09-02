import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { PreviewQaStatus } from "./core.ts";
import {
  executeQaDecisionMutation,
  type QaMutationTarget,
} from "./mutation-core.ts";
import {
  createPhase11hMapViewModel,
  loadPhase11hVisualQaContract,
} from "./phase11h-visual-qa.ts";

async function phase11hTarget(): Promise<QaMutationTarget> {
  const contract = await loadPhase11hVisualQaContract();
  const context = contract.contexts[0];
  const manifest = contract.manifest.records.find(
    (record) => record.sourceRelationId === context.canonicalRelationId,
  );
  assert.ok(manifest);
  return {
    stagingRouteId: context.stagingRouteId,
    contractVersion: contract.manifest.contractVersion,
    importEligibility: "AUTO_IMPORT_READY",
    metadata: structuredClone(context.metadata),
    manifest: structuredClone(manifest),
  };
}

test("all 44 staged Phase 11H members have renderable geometry, start, and summit context", async () => {
  const contract = await loadPhase11hVisualQaContract();
  assert.equal(contract.contexts.length, 44);
  assert.equal(contract.manifest.recordCount, 44);
  assert.equal(contract.metadata.recordCount, 44);
  for (const context of contract.contexts) {
    const view = createPhase11hMapViewModel(context);
    assert.match(context.stagingRouteId, /^[0-9a-f-]{36}$/i);
    assert.ok(view.geometry.coordinates.length > 0);
    assert.equal(view.start.coordinates.length, 2);
    assert.ok(view.start.context.length > 0);
    assert.ok(view.start.label.length > 0);
    assert.equal(view.summit.coordinates.length, 2);
    assert.ok(view.summit.name.length > 0);
    assert.match(view.summit.osmId, /^\d+$/);
  }
});

test("the Cevo calibration member produces the expected map model", async () => {
  const contract = await loadPhase11hVisualQaContract();
  const context = contract.contexts.find(
    (candidate) => candidate.canonicalRelationId === "14450146",
  );
  assert.ok(context);
  const view = createPhase11hMapViewModel(context);
  assert.match(view.routeName, /Cevo/i);
  assert.match(view.start.context, /BASE|HUT/);
  assert.ok(view.start.label.includes(view.start.context.replaceAll("_", " ")));
  assert.equal(view.summit.osmId, context.metadata.summit.peakOsmId);
});

test("Phase 11H exposes the compact A-G human questions without a prefilled decision", async () => {
  const contract = await loadPhase11hVisualQaContract();
  assert.deepEqual(
    contract.calibration.questions.map((question) => question.id),
    ["A", "B", "C", "D", "E", "F", "G"],
  );
  assert.equal(contract.calibration.autoApprovalEnabled, false);
  assert.equal(contract.calibration.noPrefilledHumanDecision, true);
  assert.ok(
    contract.calibration.members.every(
      (member) => member.humanDecisionStatus === null,
    ),
  );
});

test("only the 44 staged members are actionable and blocked relation 19752996 stays read-only", async () => {
  const contract = await loadPhase11hVisualQaContract();
  const blocked = contract.calibration.members.filter(
    (member) => member.stagingStatus === "BLOCKED",
  );
  assert.equal(contract.calibration.members.length, 45);
  assert.equal(contract.contexts.length, 44);
  assert.deepEqual(blocked.map((member) => member.canonicalRelationId), ["19752996"]);
  assert.equal(blocked[0].blockingReason, "MOUNTAIN_IDENTITY_MISSING");
  assert.equal(
    contract.contexts.some(
      (context) => context.canonicalRelationId === "19752996",
    ),
    false,
  );

  const queueSource = await readFile(
    "components/internal/Phase11hCalibrationQueue.tsx",
    "utf8",
  );
  assert.match(queueSource, /route \? \(/);
  assert.match(queueSource, /Open map &amp; visual QA/);
  assert.match(queueSource, /Read-only .* no staging identity .* no QA controls/);
});

for (const status of [
  "VISUALLY_APPROVED",
  "NEEDS_REVIEW",
  "REJECTED",
] as const satisfies readonly PreviewQaStatus[]) {
  test(`explicit ${status} uses the guarded Phase 11H mutation target`, async () => {
    const target = await phase11hTarget();
    let writeCount = 0;
    const result = await executeQaDecisionMutation(
      {
        stagingRouteId: target.stagingRouteId,
        status,
        reviewerNote: "Human visual QA",
        expectedVersion: null,
        queueId: "phase11h",
      },
      {
        authorize: async () => ({ userId: "reviewer-user-id" }),
        validateTarget: async (input) => {
          assert.equal(input.queueId, "phase11h");
          assert.equal(input.stagingRouteId, target.stagingRouteId);
          return target;
        },
        writeDecision: async (input) => {
          writeCount += 1;
          assert.equal(input.reviewerUserId, "reviewer-user-id");
          return {
            status: input.status,
            reviewerNote: input.reviewerNote,
            reviewedAt: "2026-09-02T12:00:00.000Z",
            version: 1,
            changed: true,
          };
        },
      },
    );
    assert.equal(writeCount, 1);
    assert.equal(result.status, status);
  });
}

test("relation or payload mismatch fails closed before the writer", async () => {
  for (const mutate of [
    (target: QaMutationTarget) => {
      target.metadata.sourceRelationId = "19752996";
    },
    (target: QaMutationTarget) => {
      target.metadata.payloadHash = "payload-drift";
    },
  ]) {
    const target = await phase11hTarget();
    mutate(target);
    let writeCount = 0;
    await assert.rejects(
      executeQaDecisionMutation(
        {
          stagingRouteId: target.stagingRouteId,
          status: "NEEDS_REVIEW",
          reviewerNote: null,
          expectedVersion: null,
          queueId: "phase11h",
        },
        {
          authorize: async () => ({ userId: "reviewer-user-id" }),
          validateTarget: async () => target,
          writeDecision: async () => {
            writeCount += 1;
            throw new Error("writer must not run");
          },
        },
      ),
      /reviewed-manifest validation/,
    );
    assert.equal(writeCount, 0);
  }
});

test("Phase 11H UI keeps decisions explicit and reuses the existing atomic RPC", async () => {
  const [formSource, actionSource, mapSource, routeMapSource] = await Promise.all([
    readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8"),
    readFile("app/[locale]/internal/osm-staging/actions.ts", "utf8"),
    readFile("components/internal/OsmStagingRouteMap.tsx", "utf8"),
    readFile("components/mountain/MountainRouteMap.tsx", "utf8"),
  ]);
  assert.match(formSource, /Save is still required/);
  assert.match(formSource, /onClick=\{\(\) => save\("STAY"\)\}/);
  assert.equal(
    (formSource.match(/saveOsmStagingQaDecision\(\{/g) ?? []).length,
    1,
  );
  assert.match(actionSource, /executeQaDecisionMutation/);
  assert.match(
    actionSource,
    /\.rpc\("record_osm_staging_visual_qa_decision"/,
  );
  assert.match(mapSource, /analyzeRouteTopology/);
  assert.match(mapSource, /startContext\?\.label/);
  assert.match(routeMapSource, /maplibregl\.Map/);
  assert.match(routeMapSource, /OpenTopoMap/);
  assert.match(routeMapSource, /qaMarkers\.summit/);
  assert.match(routeMapSource, /fitBounds/);
});
