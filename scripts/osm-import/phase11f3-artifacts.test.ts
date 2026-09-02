import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyDeterministicArtifactHash } from "./phase11f-controlled-staging.ts";

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

interface Hashable {
  deterministicArtifactHash: string;
  [key: string]: unknown;
}

interface ClassificationArtifact extends Hashable {
  typeCounts: { BASE_START: number; HUT_START: number; HIGH_MOUNTAIN_START: number; AMBIGUOUS_START: number };
  transitions: Record<string, Record<string, number>>;
  routes: Array<{
    sourceRelationId: string;
    summitElevationMeters: number | null;
    startContext: { type: string; startElevationSource?: string | null; verticalGainMeters?: number | null };
  }>;
}

interface EvidenceArtifact extends Hashable {
  auditedCount: number;
  recoveryBySource: Record<string, number>;
  recoveredToBase: number;
  recoveredToHut: number;
  recoveredTotal: number;
  remainingUnproven: number;
  rows: Array<{
    canonicalRelationId: string;
    selectedElevationSource: string | null;
    verticalGainMeters: number | null;
  }>;
}

interface ReadinessArtifact extends Hashable {
  machineQualifiedSafe500: number;
  machineQualifiedSafe600: number;
  highMountainStart: number;
  ambiguousStart: number;
  tothornRemainsNotGreen: boolean;
  recoveredBaseFromAmbiguous: number;
}

interface F2Classification {
  routes: Array<{ sourceRelationId: string; startContext: { type: string } }>;
}

test("Phase 11F.3 classification artifact is deterministic and correct", async () => {
  const classification = await json<ClassificationArtifact>(
    "data/osm/alps/staging/phase11f3-start-context-classification.json",
  );
  verifyDeterministicArtifactHash(classification);
  assert.equal(classification.routes.length, 641);
  assert.deepEqual(
    {
      BASE_START: classification.typeCounts.BASE_START,
      HUT_START: classification.typeCounts.HUT_START,
      HIGH_MOUNTAIN_START: classification.typeCounts.HIGH_MOUNTAIN_START,
      AMBIGUOUS_START: classification.typeCounts.AMBIGUOUS_START,
    },
    { BASE_START: 75, HUT_START: 49, HIGH_MOUNTAIN_START: 263, AMBIGUOUS_START: 254 },
  );
  assert.deepEqual(classification.transitions["BASE_START"], { BASE_START: 74 });
  assert.deepEqual(classification.transitions["HUT_START"], { HUT_START: 49 });
  assert.deepEqual(classification.transitions["HIGH_MOUNTAIN_START"], { HIGH_MOUNTAIN_START: 263 });
  assert.deepEqual(classification.transitions["AMBIGUOUS_START"], { AMBIGUOUS_START: 254, BASE_START: 1 });
});

test("Phase 11F.3 evidence audit covers exactly the 174 missing-elevation routes", async () => {
  const evidence = await json<EvidenceArtifact>(
    "data/osm/alps/staging/phase11f3-start-elevation-evidence.json",
  );
  verifyDeterministicArtifactHash(evidence as Hashable);
  assert.equal(evidence.auditedCount, 174);
  assert.equal(evidence.rows.length, 174);
  assert.deepEqual(evidence.recoveryBySource, {
    EXACT_ENDPOINT_OSM_ELE: 0,
    EXACT_START_FEATURE_ELE: 1,
    CONTAINING_START_FEATURE_ELE: 0,
    CONNECTED_NETWORK_ELEVATION: 0,
    FROZEN_TERRAIN_DATA: 0,
    NONE: 173,
  });
  assert.equal(evidence.recoveredToBase, 1);
  assert.equal(evidence.recoveredToHut, 0);
  assert.equal(evidence.recoveredTotal, 1);
  assert.equal(evidence.remainingUnproven, 173);
});

test("the single recovered route is deterministic and green-compatible", async () => {
  const evidence = await json<EvidenceArtifact>(
    "data/osm/alps/staging/phase11f3-start-elevation-evidence.json",
  );
  const recovered = evidence.rows.filter((r) => r.selectedElevationSource !== null);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].canonicalRelationId, "2946431");
  assert.equal(recovered[0].selectedElevationSource, "EXACT_START_FEATURE_ELE");
  assert.ok((recovered[0].verticalGainMeters as number) >= 500);

  const classification = await json<ClassificationArtifact>(
    "data/osm/alps/staging/phase11f3-start-context-classification.json",
  );
  const rec = classification.routes.find((r) => r.sourceRelationId === "2946431");
  assert.equal(rec?.startContext.type, "BASE_START");
  assert.equal(rec?.startContext.startElevationSource, "EXACT_START_FEATURE_ELE");
});

test("readiness is truthful and never forced to 500", async () => {
  const readiness = await json<ReadinessArtifact>(
    "data/osm/alps/publication/phase11f3-start-context-readiness.json",
  );
  verifyDeterministicArtifactHash(readiness as Hashable);
  assert.equal(readiness.machineQualifiedSafe500, 75);
  assert.equal(readiness.machineQualifiedSafe600, 124);
  assert.equal(readiness.highMountainStart, 263);
  assert.equal(readiness.ambiguousStart, 254);
  assert.equal(readiness.tothornRemainsNotGreen, true);
  assert.equal(readiness.recoveredBaseFromAmbiguous, 1);
});

test("mandatory regression routes keep their Phase 11F.2 outcome", async () => {
  const classification = await json<ClassificationArtifact>(
    "data/osm/alps/staging/phase11f3-start-context-classification.json",
  );
  const type = (id: string) => classification.routes.find((r) => r.sourceRelationId === id)?.startContext.type;
  assert.equal(type("274491"), "HIGH_MOUNTAIN_START");
  assert.equal(type("6779777"), "AMBIGUOUS_START");
  assert.equal(type("15830354"), "AMBIGUOUS_START");
});

test("no F2 HIGH over-qualification correction becomes GREEN", () => {
  const f2 = JSON.parse(
    testRead("data/osm/alps/staging/phase11f2-start-context-classification.json"),
  ) as F2Classification;
  const classification = JSON.parse(
    testRead("data/osm/alps/staging/phase11f3-start-context-classification.json"),
  ) as ClassificationArtifact;
  const f3type = new Map(classification.routes.map((r) => [r.sourceRelationId, r.startContext.type]));
  const f2high = f2.routes.filter((r) => r.startContext.type === "HIGH_MOUNTAIN_START");
  assert.equal(f2high.length, 263);
  const flippedFromHigh = f2high.filter((r) => f3type.get(r.sourceRelationId) !== "HIGH_MOUNTAIN_START");
  assert.equal(flippedFromHigh.length, 0);
});

function testRead(path: string): string {
  return readFileSync(path, "utf8");
}
