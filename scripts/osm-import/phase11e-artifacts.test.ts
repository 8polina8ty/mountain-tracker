import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePreviewManifest, type PreviewManifest, type PreviewMetadataDocument } from "../../Lib/osmStagingPreview/core.ts";
import {
  getPreviewQueueDefinition,
  validatePreviewQueueContract,
  type PreviewQueueArtifact,
} from "../../Lib/osmStagingPreview/queue-core.ts";
import { sha256Stable } from "./phase11-publication.ts";
import type { Phase11eQualificationResult } from "./phase11e-recovery.ts";

async function json<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((value) => JSON.parse(value) as T);
}

function verifyHash<T extends { deterministicArtifactHash: string }>(value: T): void {
  const { deterministicArtifactHash, ...content } = value;
  assert.equal(sha256Stable(content), deterministicArtifactHash);
}

interface QualificationArtifact {
  readOnly: boolean;
  publishable: boolean;
  autoApprovalEnabled: boolean;
  recordCount: number;
  records: Phase11eQualificationResult[];
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
  deterministicArtifactHash: string;
}

test("Phase 11E qualification partitions 947 non-active routes without auto-approval", async () => {
  const [green, yellow, red] = await Promise.all([
    json<QualificationArtifact>("data/osm/alps/publication/phase11e-qualified-safe-candidates.json"),
    json<QualificationArtifact>("data/osm/alps/publication/phase11e-yellow-review-candidates.json"),
    json<QualificationArtifact>("data/osm/alps/publication/phase11e-red-blocked-candidates.json"),
  ]);
  for (const artifact of [green, yellow, red]) {
    verifyHash(artifact);
    assert.equal(artifact.readOnly, true);
    assert.equal(artifact.publishable, false);
    assert.equal(artifact.autoApprovalEnabled, false);
    assert.equal(artifact.recordCount, artifact.records.length);
    assert.deepEqual(artifact.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
  }
  assert.equal(green.recordCount, 641);
  assert.equal(yellow.recordCount, 63);
  assert.equal(red.recordCount, 243);
  assert.equal(green.recordCount + yellow.recordCount + red.recordCount, 947);
  assert.ok(green.records.every((record) => record.status === "GREEN"));
  assert.ok(yellow.records.every((record) => record.status === "YELLOW"));
  assert.ok(red.records.every((record) => record.status === "RED"));
  assert.ok(green.records.filter((record) => record.recoveredByPhase11e).every((record) =>
    record.reasonCodes.includes("TOPOLOGY_RECOVERED_PRIMARY_PATH") &&
    record.topologyClassification === "SIMPLE" &&
    record.qualityScore >= 90 &&
    record.roadSafetyStatus === "SAFE"));
});

test("Phase 11E exclusion ledger assigns one primary reason to every excluded summit route", async () => {
  const ledger = await json<{
    summitRouteCount: number;
    candidatePopulation: number;
    excludedCount: number;
    includedRelationIds: string[];
    excludedRelationIdsByPrimaryReason: Record<string, string[]>;
    exclusionDistribution: Record<string, number>;
    deterministicArtifactHash: string;
  }>("data/osm/alps/audit/phase11e-summit-route-exclusion-ledger.json");
  verifyHash(ledger);
  const excludedIds = Object.values(ledger.excludedRelationIdsByPrimaryReason).flat();
  assert.equal(ledger.summitRouteCount, 2_780);
  assert.equal(ledger.candidatePopulation, 1_065);
  assert.equal(ledger.excludedCount, 1_715);
  assert.equal(ledger.includedRelationIds.length, 1_065);
  assert.equal(excludedIds.length, 1_715);
  assert.equal(new Set(excludedIds).size, excludedIds.length);
  assert.equal(new Set([...ledger.includedRelationIds, ...excludedIds]).size, 2_780);
  assert.equal(
    Object.values(ledger.exclusionDistribution).reduce((sum, count) => sum + count, 0),
    1_715,
  );
});

test("Phase 11E queue is fixed-path, deterministic, recovered-first, and excludes RED", async () => {
  const definition = getPreviewQueueDefinition("phase11e");
  type QueueRecord = PreviewQueueArtifact["queue"][number] & {
    qualificationStatus: "GREEN" | "YELLOW" | "RED";
    recoveredByPhase11e: boolean;
  };
  const [queue, manifest, metadata] = await Promise.all([
    json<Omit<PreviewQueueArtifact, "queue"> & {
      deterministicQueueHash: string;
      deterministicArtifactHash: string;
      queue: QueueRecord[];
    }>(definition.artifactPath),
    json<PreviewManifest>(definition.stagingManifestPath),
    json<PreviewMetadataDocument>(definition.previewMetadataPath),
  ]);
  verifyHash(queue);
  assert.equal(queue.queue.length, 704);
  assert.equal(sha256Stable(queue.queue), queue.deterministicQueueHash);
  assert.ok(queue.queue.every((record) => record.qualificationStatus !== "RED"));
  const firstExistingGreen = queue.queue.findIndex((record) =>
    record.qualificationStatus === "GREEN" && !record.recoveredByPhase11e);
  const lastRecoveredGreen = queue.queue.findLastIndex((record) =>
    record.qualificationStatus === "GREEN" && record.recoveredByPhase11e);
  const firstYellow = queue.queue.findIndex((record) => record.qualificationStatus === "YELLOW");
  assert.ok(lastRecoveredGreen < firstExistingGreen);
  assert.ok(firstExistingGreen < firstYellow);
  validatePreviewManifest(manifest, definition.expectedTotal);
  assert.doesNotThrow(() => validatePreviewQueueContract({ definition, artifact: queue, manifest, metadata }));
});

test("Phase 11E staging preflight and readiness remain zero-write and non-publishable", async () => {
  const [preflight, readiness, conflicts, executableManifest] = await Promise.all([
    json<{
      totalPlanned: number;
      wouldCreate: number;
      unchanged: number;
      blocked: number;
      conflicts: number;
      executable: { totalPlanned: number; wouldCreate: number; unchanged: number; blocked: number; conflicts: number };
      writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
      deterministicArtifactHash: string;
    }>("data/osm/alps/staging/phase11e-staging-preflight.json"),
    json<{
      readiness: {
        machineQualifiedSafe500: boolean;
        machineQualifiedSafe600: boolean;
        humanQaPublicationReady500: boolean;
        humanQaPublicationReadyCount: number;
        humanQaCountsAmongGreen: { visuallyApproved: number; needsReview: number; rejected: number; pending: number };
      };
      calibration: { falseGreenCount: number; falseGreenRelationIds: string[] };
      writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
      deterministicArtifactHash: string;
    }>("data/osm/alps/publication/phase11e-scale-readiness.json"),
    json<{
      conflictCount: number;
      excludedFromExecutableManifest: boolean;
      records: Array<{
        canonicalRelationId: string;
        classification: string;
        exactResumeMatch: boolean;
        existingStagingIdentity: { geometryType: string; componentCount: number };
        plannedStagingIdentity: { geometryType: string; componentCount: number };
      }>;
      deterministicArtifactHash: string;
    }>("data/osm/alps/staging/phase11e-staging-conflicts.json"),
    json<PreviewManifest>("data/osm/alps/staging/phase11e-staging-manifest.json"),
  ]);
  verifyHash(preflight);
  verifyHash(readiness);
  verifyHash(conflicts);
  assert.equal(preflight.totalPlanned, preflight.wouldCreate + preflight.unchanged + preflight.blocked);
  assert.equal(preflight.conflicts, preflight.blocked);
  assert.deepEqual(preflight.executable, {
    totalPlanned: 702,
    wouldCreate: 636,
    unchanged: 66,
    blocked: 0,
    conflicts: 0,
    manifestPath: "data/osm/alps/staging/phase11e-staging-manifest.json",
    manifestHash: executableManifest.manifestHash,
  });
  assert.equal(executableManifest.recordCount, 702);
  assert.equal(conflicts.conflictCount, 2);
  assert.equal(conflicts.excludedFromExecutableManifest, true);
  assert.deepEqual(conflicts.records.map((record) => record.canonicalRelationId), ["1144001", "2210868"]);
  assert.ok(conflicts.records.every((record) => record.classification === "F_ACTUAL_DATA_DRIFT" && !record.exactResumeMatch));
  assert.ok(conflicts.records.every((record) =>
    record.existingStagingIdentity.geometryType === "MultiLineString" &&
    record.existingStagingIdentity.componentCount === 2 &&
    record.plannedStagingIdentity.geometryType === "LineString" &&
    record.plannedStagingIdentity.componentCount === 1));
  assert.deepEqual(preflight.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
  assert.equal(readiness.readiness.machineQualifiedSafe500, true);
  assert.equal(readiness.readiness.machineQualifiedSafe600, true);
  assert.equal(readiness.readiness.humanQaPublicationReady500, false);
  assert.equal(readiness.readiness.humanQaPublicationReadyCount, 13);
  assert.deepEqual(readiness.readiness.humanQaCountsAmongGreen, {
    visuallyApproved: 13,
    needsReview: 0,
    rejected: 0,
    pending: 628,
  });
  assert.equal(readiness.calibration.falseGreenCount, 0);
  assert.deepEqual(readiness.calibration.falseGreenRelationIds, []);
  assert.deepEqual(readiness.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});

test("warnings and multi-summit semantics are not cleared to inflate GREEN", async () => {
  const [warnings, multi, mountains] = await Promise.all([
    json<{ warningCount: number; recoveredWarningCount: number; deterministicArtifactHash: string }>("data/osm/alps/audit/phase11e-warning-evidence-audit.json"),
    json<{ routeCount: number; recoveredGreenCount: number; deterministicArtifactHash: string }>("data/osm/alps/audit/phase11e-multi-summit-audit.json"),
    json<{ method: string; currentCandidateRecoveredRouteCount: number; deterministicArtifactHash: string }>("data/osm/alps/audit/phase11e-mountain-identity-recovery.json"),
  ]);
  for (const value of [warnings, multi, mountains]) verifyHash(value);
  assert.equal(warnings.warningCount, 40);
  assert.equal(warnings.recoveredWarningCount, 0);
  assert.equal(multi.routeCount, 90);
  assert.equal(multi.recoveredGreenCount, 0);
  assert.equal(mountains.currentCandidateRecoveredRouteCount, 0);
  assert.match(mountains.method, /OSM node ID/);
  assert.match(mountains.method, /names and proximity never recover identity/);
});
