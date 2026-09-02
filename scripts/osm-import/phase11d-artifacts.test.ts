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
import type { Phase11dQualificationResult } from "./phase11d-qualification.ts";

interface QualificationArtifact {
  recordCount: number;
  records: Phase11dQualificationResult[];
  deterministicArtifactHash: string;
  writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
}

interface Phase11dQueueArtifact extends Omit<PreviewQueueArtifact, "queue"> {
  deterministicQueueHash: string;
  deterministicArtifactHash: string;
  queue: Array<PreviewQueueArtifact["queue"][number] & { qualificationStatus: string }>;
}

async function json<T>(path: string): Promise<T> {
  return readFile(path, "utf8").then((value) => JSON.parse(value) as T);
}

function verifyHash<T extends { deterministicArtifactHash: string }>(value: T): void {
  const { deterministicArtifactHash, ...content } = value;
  assert.equal(sha256Stable(content), deterministicArtifactHash);
}

test("Phase 11D qualification artifacts are partitioned and never auto-approve", async () => {
  const [green, yellow, red] = await Promise.all([
    json<QualificationArtifact>("data/osm/alps/publication/phase11d-qualified-safe-candidates.json"),
    json<QualificationArtifact>("data/osm/alps/publication/phase11d-yellow-review-candidates.json"),
    json<QualificationArtifact>("data/osm/alps/publication/phase11d-red-blocked-candidates.json"),
  ]);
  for (const artifact of [green, yellow, red]) {
    verifyHash(artifact);
    assert.equal(artifact.records.length, artifact.recordCount);
    assert.deepEqual(artifact.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
    assert.ok(artifact.records.every((record) => record.autoApprovalEnabled === false));
    assert.ok(artifact.records.every((record) => record.qaWrites === 0));
  }
  assert.ok(green.records.every((record) => record.status === "GREEN"));
  assert.ok(yellow.records.every((record) => record.status === "YELLOW"));
  assert.ok(red.records.every((record) => record.status === "RED"));
  const relations = [...green.records, ...yellow.records, ...red.records]
    .map((record) => record.sourceRelationId);
  assert.equal(new Set(relations).size, relations.length);
});

test("Phase 11D queue is deterministic, fixed-path, non-RED, and contract complete", async () => {
  const definition = getPreviewQueueDefinition("phase11d");
  const [queue, manifest, metadata] = await Promise.all([
    json<Phase11dQueueArtifact>(definition.artifactPath),
    json<PreviewManifest>(definition.stagingManifestPath),
    json<PreviewMetadataDocument>(definition.previewMetadataPath),
  ]);
  verifyHash(queue);
  assert.equal(sha256Stable(queue.queue), queue.deterministicQueueHash);
  assert.ok(queue.queue.every((record) => record.qualificationStatus !== "RED"));
  assert.deepEqual(
    [...new Set(metadata.records.map((record) => record.qualificationStatus))].sort(),
    ["GREEN", "YELLOW"],
  );
  validatePreviewManifest(manifest, definition.expectedTotal);
  assert.doesNotThrow(() => validatePreviewQueueContract({
    definition,
    artifact: queue,
    manifest,
    metadata,
  }));
});

test("Phase 11D staging preflight is read-only and conflict-free", async () => {
  const preflight = await json<{
    totalPlanned: number;
    wouldCreate: number;
    unchanged: number;
    blocked: number;
    conflicts: number;
    writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
    deterministicArtifactHash: string;
  }>("data/osm/alps/staging/phase11d-staging-preflight.json");
  verifyHash(preflight);
  assert.equal(preflight.totalPlanned, preflight.wouldCreate + preflight.unchanged + preflight.blocked);
  assert.equal(preflight.blocked, 0);
  assert.equal(preflight.conflicts, 0);
  assert.deepEqual(preflight.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});

test("Phase 11D readiness distinguishes machine and human publication readiness", async () => {
  const readiness = await json<{
    readiness: {
      machineQualifiedSafe500: boolean;
      humanQaPublicationReady500: boolean;
      humanQaPublicationReadyCount: number;
    };
    calibration: { falseGreenCount: number };
    writes: { databaseWrites: number; qaWrites: number; publicationWrites: number };
    deterministicArtifactHash: string;
  }>("data/osm/alps/publication/phase11d-scale-readiness.json");
  verifyHash(readiness);
  assert.equal(readiness.readiness.machineQualifiedSafe500, false);
  assert.equal(readiness.readiness.humanQaPublicationReady500, false);
  assert.ok(readiness.readiness.humanQaPublicationReadyCount < 500);
  assert.equal(readiness.calibration.falseGreenCount, 0);
  assert.deepEqual(readiness.writes, { databaseWrites: 0, qaWrites: 0, publicationWrites: 0 });
});
