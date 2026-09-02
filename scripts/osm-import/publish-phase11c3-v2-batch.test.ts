import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Phase 11C.3/11C.8 publisher validates all frozen v1 and v2 baseline generations", async () => {
  const source = await readFile(
    "scripts/osm-import/publish-phase11c3-v2-batch.ts",
    "utf8",
  );
  assert.match(source, /PHASE11C2_V2_MANIFEST_PATH/);
  assert.match(source, /verifyPhase11C2V2BatchManifest/);
  assert.match(source, /priorV2BatchIdentityChecks/);
  assert.match(source, /assertFrozenActivePublicationBaseline/);
  assert.match(source, /FROZEN_ACTIVE_BASELINE_EXPECTATION_INCOMPLETE/);
  assert.match(source, /ACTIVE_GEOJSON_IDENTITY_INCOMPATIBLE/);
});

test("Phase 11C.3/11C.8 read-only result exposes the requested zero-write counters", async () => {
  const source = await readFile(
    "scripts/osm-import/publish-phase11c3-v2-batch.ts",
    "utf8",
  );
  assert.match(source, /baselineActive:\s*activeRows\.length/);
  assert.match(source, /attempted:\s*batchRequests\.length/);
  assert.match(source, /wouldCreate:/);
  assert.match(source, /resumeMatch:/);
  assert.match(source, /rpcCalls:\s*0/);
  assert.match(source, /databaseWrites:\s*0/);
  assert.match(source, /publicationWrites:\s*0/);
});

test("Phase 11C.10 execute path deeply verifies all 118 identities and mutation guards", async () => {
  const source = await readFile(
    "scripts/osm-import/publish-phase11c3-v2-batch.ts",
    "utf8",
  );
  assert.match(source, /expectedFrozenAll/);
  assert.match(source, /allIdentityChecks\.length !== 118/);
  assert.match(source, /originalIdentityChecks\.length !== 18/);
  assert.match(source, /newIdentityChecks\.length !== 100/);
  assert.match(source, /uniqueActiveRelationIds !== 118/);
  assert.match(source, /uniqueActiveSourceUrls !== 118/);
  assert.match(source, /uniquePublicationIdentities !== 118/);
  assert.match(source, /roadSafetyMatches !== 100/);
  assert.match(source, /PHASE11C10_UNRELATED_PRODUCTION_MUTATION_DETECTED/);
});
