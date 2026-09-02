import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyStagingPlan,
  createLockedFirstWriteManifest,
  type ImportPlanRecord,
  type StagingWriter,
} from "./phase8-staging.ts";
import { buildPhase11c4StagingPreflight } from "./phase11c4-staging-preflight.ts";

async function readyRecords(count: number): Promise<{ records: ImportPlanRecord[]; datasetFingerprint: string }> {
  const document = JSON.parse(
    await readFile("data/osm/alps/staging/import-plan.json", "utf8"),
  ) as { datasetFingerprint: string; records: ImportPlanRecord[] };
  return {
    records: document.records.filter((record) => record.operation === "READY_FOR_STAGING").slice(0, count),
    datasetFingerprint: document.datasetFingerprint,
  };
}

function mountainRows(records: ImportPlanRecord[]) {
  return records.flatMap((record) =>
    record.contract.confirmedSummits.map((summit) => ({
      id: summit.mountainMatch.mountainId as number,
      osm_id: summit.peakOsmId,
    })),
  );
}

test("read-only staging preflight reports would-create and detects mountain drift", async () => {
  const { records } = await readyRecords(1);
  const clear = buildPhase11c4StagingPreflight({
    records,
    stagingRoutes: [],
    stagingSummits: [],
    mountains: mountainRows(records),
    productionRoutes: [],
  });
  assert.deepEqual(
    { wouldCreate: clear.wouldCreate, unchanged: clear.unchanged, blocked: clear.blocked, writes: clear.databaseWrites },
    { wouldCreate: 1, unchanged: 0, blocked: 0, writes: 0 },
  );
  const drift = buildPhase11c4StagingPreflight({
    records,
    stagingRoutes: [],
    stagingSummits: [],
    mountains: mountainRows(records).map((row) => ({ ...row, osm_id: "different" })),
    productionRoutes: [],
  });
  assert.equal(drift.blocked, 1);
  assert.match(drift.records[0].reason ?? "", /MOUNTAIN_IDENTITY_DRIFT/);
  assert.equal(drift.databaseWrites, 0);
});

test("read-only staging preflight classifies an exact resume match as unchanged", async () => {
  const { records } = await readyRecords(1);
  const record = records[0];
  const mountainId = record.contract.confirmedSummits[0].mountainMatch.mountainId as number;
  const stagingRouteId = "existing-route";
  const result = buildPhase11c4StagingPreflight({
    records,
    stagingRoutes: [{
      id: stagingRouteId,
      idempotency_key: record.idempotencyKey,
      payload_hash: record.payloadHash,
      source_relation_id: record.sourceRelationId,
      canonical_source_id: record.canonicalRouteSourceId,
      contract_version: record.contract.contractVersion,
      import_eligibility: "AUTO_IMPORT_READY",
      matched_primary_mountain_id: mountainId,
      geometry_geojson: record.contract.route.geometry,
    }],
    stagingSummits: record.contract.confirmedSummits.map((summit) => ({
      staging_route_id: stagingRouteId,
      peak_osm_id: summit.peakOsmId,
      mountain_id: summit.mountainMatch.mountainId as number,
      mountain_match_classification: "EXACT_MOUNTAIN_MATCH",
      final_association: "CONFIRMED",
    })),
    mountains: mountainRows(records),
    productionRoutes: [],
  });
  assert.equal(result.unchanged, 1);
  assert.equal(result.blocked, 0);
  assert.equal(result.records[0].action, "UNCHANGED");
  assert.deepEqual(result.records[0].mismatchFields, []);
  assert.equal(result.records[0].conflictCategory, null);
});

test("read-only staging preflight fails closed on payload and geometry drift", async () => {
  const { records } = await readyRecords(1);
  const record = records[0];
  const mountainId = record.contract.confirmedSummits[0].mountainMatch.mountainId as number;
  const stagingRouteId = "stale-route";
  const result = buildPhase11c4StagingPreflight({
    records,
    stagingRoutes: [{
      id: stagingRouteId,
      idempotency_key: record.idempotencyKey,
      payload_hash: "stale-payload",
      source_relation_id: record.sourceRelationId,
      canonical_source_id: record.canonicalRouteSourceId,
      contract_version: record.contract.contractVersion,
      import_eligibility: "AUTO_IMPORT_READY",
      matched_primary_mountain_id: mountainId,
      geometry_geojson: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    }],
    stagingSummits: record.contract.confirmedSummits.map((summit) => ({
      staging_route_id: stagingRouteId,
      peak_osm_id: summit.peakOsmId,
      mountain_id: summit.mountainMatch.mountainId as number,
      mountain_match_classification: "EXACT_MOUNTAIN_MATCH",
      final_association: "CONFIRMED",
    })),
    mountains: mountainRows(records),
    productionRoutes: [],
  });
  assert.equal(result.blocked, 1);
  assert.equal(result.records[0].conflictCategory, "F_ACTUAL_DATA_DRIFT");
  assert.deepEqual(result.records[0].mismatchFields, ["payloadHash", "geometryHash"]);
});

test("manifest apply preflights every row before the first write", async () => {
  const { records, datasetFingerprint } = await readyRecords(2);
  const manifest = createLockedFirstWriteManifest(records, datasetFingerprint);
  let writes = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      throw new Error("inspectRecord should own manifest preflight");
    },
    async inspectRecord(record) {
      return record.sourceRelationId === records[1].sourceRelationId
        ? { status: "CONFLICT", reason: "test identity conflict" }
        : { status: "MISSING" };
    },
    async upsertRouteWithSummits() {
      writes += 1;
      return { id: "never" };
    },
  };
  await assert.rejects(
    applyStagingPlan(
      records,
      { mode: "apply-staging", limit: null, confirmAll: false },
      writer,
      { manifest, datasetFingerprint },
    ),
    /Staging preflight blocked/,
  );
  assert.equal(writes, 0);
});

test("manifest apply resumes by skipping unchanged rows and creating only missing rows", async () => {
  const { records, datasetFingerprint } = await readyRecords(2);
  const manifest = createLockedFirstWriteManifest(records, datasetFingerprint);
  const written: string[] = [];
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      throw new Error("inspectRecord should own manifest preflight");
    },
    async inspectRecord(record) {
      return record.sourceRelationId === records[0].sourceRelationId
        ? { status: "UNCHANGED", id: "existing" }
        : { status: "MISSING" };
    },
    async upsertRouteWithSummits(record) {
      written.push(record.sourceRelationId);
      return { id: "created" };
    },
  };
  const result = await applyStagingPlan(
    records,
    { mode: "apply-staging", limit: null, confirmAll: false },
    writer,
    { manifest, datasetFingerprint },
  );
  assert.deepEqual(written, [records[1].sourceRelationId]);
  assert.equal(result.unchanged, 1);
  assert.equal(result.databaseWrites, 1);
});
