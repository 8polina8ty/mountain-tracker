import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditFirstWriteRecord } from "./phase8-prewrite.ts";
import {
  assignPointToAdminBoundary,
  assignRouteToAdminBoundary,
  parseAdminBoundaryDataset,
} from "./admin-boundary.ts";
import {
  OSM_ROUTE_IMPORT_CONTRACT_VERSION,
  applyStagingPlan,
  buildFirstBatchQa,
  buildFirstBatchSelection,
  buildImportPlan,
  createImportContract,
  createImportPlanRecord,
  createFirstWriteManifest,
  createLockedFirstWriteManifest,
  createRouteIdempotencyKey,
  matchPeakToMountain,
  parsePhase8CliOptions,
  selectReadyStagingRecords,
  serializeImportContract,
  summarizeImportPlan,
  validateFirstWriteManifest,
  validateStagingContract,
  type MountainCatalogRecord,
  type Phase7CanonicalRouteRecord,
  type Phase7EligibilityRecord,
  type StagingSourceRouteRecord,
  type StagingWriter,
} from "./phase8-staging.ts";

const ATTRIBUTION = "© OpenStreetMap contributors";
const PROVENANCE_ID = "openstreetmap-odbl-geofabrik-alps";

function mountain(
  id = 1,
  overrides: Partial<MountainCatalogRecord> = {},
): MountainCatalogRecord {
  return {
    id,
    osmId: "9001",
    name: "Example Peak",
    nameDe: null,
    heightMeters: 2_000,
    coordinates: [10, 47],
    countryCode: "AT",
    source: "openstreetmap",
    ...overrides,
  };
}

function eligibility(
  overrides: Partial<Phase7EligibilityRecord> = {},
): Phase7EligibilityRecord {
  return {
    canonicalRouteSourceId: "1001",
    routeName: "Example Route",
    eligibility: "AUTO_IMPORT_READY",
    reasons: ["Phase 7 eligible"],
    auditFlags: [],
    qualityScore: 95,
    confirmedPeakIds: ["9001"],
    sourceRouteIds: ["1001"],
    ...overrides,
  };
}

function canonical(
  overrides: Partial<Phase7CanonicalRouteRecord> = {},
): Phase7CanonicalRouteRecord {
  return {
    canonicalRouteSourceId: "1001",
    routeName: "Example Route",
    semanticType: "summit_route",
    qualityScore: 95,
    geometryType: "LineString",
    distanceMeters: 1_500,
    componentCount: 1,
    sourceRouteIds: ["1001"],
    removedDuplicateRepresentationIds: [],
    confirmedSummits: [
      {
        peakSourceId: "9001",
        peakName: "Example Peak",
        peakElevationMeters: 2_000,
        peakCoordinates: [10, 47],
        minimumGeometryDistanceMeters: 1,
        endpointDistanceMeters: 2,
        finalConfidence: 1,
        reasons: ["Confirmed by Phase 3"],
        provenanceId: PROVENANCE_ID,
        sourceRouteIds: ["1001"],
        sourceAssociations: [
          {
            routeSourceId: "1001",
            routeSourceUrl: "https://www.openstreetmap.org/relation/1001",
            routeProvenanceId: PROVENANCE_ID,
            finalConfidence: 1,
            minimumGeometryDistanceMeters: 1,
            endpointDistanceMeters: 2,
            reasons: ["Confirmed by Phase 3"],
          },
        ],
      },
    ],
    auditFlags: [],
    sourceProvenance: [
      {
        routeSourceId: "1001",
        sourceUrl: "https://www.openstreetmap.org/relation/1001",
        provenanceId: PROVENANCE_ID,
        license: "ODbL-1.0",
        attribution: ATTRIBUTION,
      },
    ],
    duplicateGroupId: null,
    ...overrides,
  };
}

function sourceRoute(
  overrides: Partial<StagingSourceRouteRecord> = {},
): StagingSourceRouteRecord {
  return {
    source: "openstreetmap",
    sourceType: "relation",
    sourceId: "1001",
    sourceUrl: "https://www.openstreetmap.org/relation/1001",
    provenanceId: PROVENANCE_ID,
    license: "ODbL-1.0",
    attribution: ATTRIBUTION,
    name: "Example Route",
    geometry: { type: "LineString", coordinates: [[9.99, 46.99], [10, 47]] },
    stats: { distanceMeters: 1_500, coordinatePoints: 2, componentCount: 1 },
    ...overrides,
  };
}

function contract(overrides: {
  eligibility?: Partial<Phase7EligibilityRecord>;
  canonical?: Partial<Phase7CanonicalRouteRecord>;
  sourceRoute?: Partial<StagingSourceRouteRecord>;
  mountains?: MountainCatalogRecord[];
} = {}) {
  return createImportContract({
    eligibility: eligibility(overrides.eligibility),
    canonical: canonical(overrides.canonical),
    sourceRoute: sourceRoute(overrides.sourceRoute),
    mountains: overrides.mountains ?? [mountain()],
    datasetVersion: "phase7:test",
    phase7AuditHash: "a".repeat(64),
    adminBoundaries: null,
  });
}

test("import contract has an explicit stable version", () => {
  assert.equal(contract().contractVersion, OSM_ROUTE_IMPORT_CONTRACT_VERSION);
});

test("import contract serialization is deterministic", () => {
  const value = contract();
  assert.equal(serializeImportContract(value), serializeImportContract(value));
  assert.deepEqual(JSON.parse(serializeImportContract(value)), value);
});

test("Phase 8 normalizes the known OSM attribution mojibake", () => {
  const value = contract({ sourceRoute: { attribution: "Â© OpenStreetMap contributors" } });
  assert.equal(value.source.attribution, ATTRIBUTION);
});

test("OSM ID produces an exact mountain match", () => {
  assert.equal(
    matchPeakToMountain(
      {
        peakOsmId: "9001",
        peakName: "Different Name",
        peakElevationMeters: 3_000,
        peakCoordinates: [11, 48],
      },
      [mountain()],
    ).classification,
    "EXACT_MOUNTAIN_MATCH",
  );
});

test("coordinates plus elevation produce only a probable match", () => {
  const result = matchPeakToMountain(
    {
      peakOsmId: "other",
      peakName: "Example Peak",
      peakElevationMeters: 2_020,
      peakCoordinates: [10.0001, 47],
    },
    [mountain(1, { osmId: "different" })],
  );
  assert.equal(result.classification, "PROBABLE_MOUNTAIN_MATCH");
});

test("elevation safeguard rejects a nearby implausible mountain", () => {
  const result = matchPeakToMountain(
    {
      peakOsmId: "other",
      peakName: "Example Peak",
      peakElevationMeters: 3_000,
      peakCoordinates: [10.0001, 47],
    },
    [mountain(1, { osmId: "different", heightMeters: 2_000 })],
  );
  assert.equal(result.classification, "NO_MOUNTAIN_MATCH");
});

test("name alone is never sufficient", () => {
  const result = matchPeakToMountain(
    {
      peakOsmId: "other",
      peakName: "Example Peak",
      peakElevationMeters: 2_000,
      peakCoordinates: null,
    },
    [mountain(1, { osmId: "different" })],
  );
  assert.equal(result.classification, "NO_MOUNTAIN_MATCH");
});

test("multiple plausible nearby mountains are ambiguous", () => {
  const peak = {
    peakOsmId: "other",
    peakName: "Example Peak",
    peakElevationMeters: 2_000,
    peakCoordinates: [10, 47] as [number, number],
  };
  const result = matchPeakToMountain(peak, [
    mountain(1, { osmId: "a" }),
    mountain(2, { osmId: "b", coordinates: [10.00001, 47] }),
  ]);
  assert.equal(result.classification, "AMBIGUOUS_MOUNTAIN_MATCH");
  assert.deepEqual(result.candidateMountainIds, [1, 2]);
});

test("no nearby mountain produces no match", () => {
  const result = matchPeakToMountain(
    {
      peakOsmId: "other",
      peakName: "Example Peak",
      peakElevationMeters: 2_000,
      peakCoordinates: [11, 48],
    },
    [mountain(1, { osmId: "different" })],
  );
  assert.equal(result.classification, "NO_MOUNTAIN_MATCH");
});

test("idempotency key is stable and provider scoped", () => {
  assert.equal(createRouteIdempotencyKey("123"), createRouteIdempotencyKey("123"));
  assert.match(createRouteIdempotencyKey("123"), /^openstreetmap:relation:123:/);
});

test("a complete exact-match contract is ready for staging", () => {
  const plan = createImportPlanRecord(contract());
  assert.equal(plan.operation, "READY_FOR_STAGING");
  assert.deepEqual(plan.validationErrors, []);
});

test("missing provenance blocks staging", () => {
  const value = contract();
  value.source.provenanceId = "";
  assert.ok(validateStagingContract(value).includes("INCOMPLETE_PROVENANCE"));
  assert.equal(createImportPlanRecord(value).operation, "BLOCKED_VALIDATION");
});

test("invalid geometry blocks staging", () => {
  const value = contract();
  value.route.geometry = { type: "LineString", coordinates: [[10, 47]] };
  assert.ok(validateStagingContract(value).includes("INVALID_GEOMETRY"));
});

test("a noncanonical duplicate representation blocks staging", () => {
  const value = contract();
  value.source.sourceRelationId = "1002";
  assert.ok(validateStagingContract(value).includes("NONCANONICAL_SOURCE_ROUTE"));
});

test("an unresolved duplicate provenance reference blocks staging", () => {
  const value = contract();
  value.mergedDuplicateProvenance.sourceRouteIds.push("1002");
  assert.ok(
    validateStagingContract(value).includes("UNRESOLVED_DUPLICATE_PROVENANCE:1002"),
  );
});

test("MANUAL_REVIEW_REQUIRED cannot enter the staging plan", () => {
  const result = buildImportPlan({
    eligibilityRecords: [eligibility({ eligibility: "MANUAL_REVIEW_REQUIRED" })],
    canonicalRoutes: [canonical()],
    sourceRoutes: [sourceRoute()],
    mountains: [mountain()],
    datasetVersion: "test",
    phase7AuditHash: "hash",
    adminBoundaries: null,
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.excludedEligibilityCounts.manualReviewRequired, 1);
});

test("unsupported REVIEW eligibility cannot enter staging", () => {
  const review = {
    ...eligibility(),
    eligibility: "REVIEW",
  } as unknown as Phase7EligibilityRecord;
  const result = buildImportPlan({
    eligibilityRecords: [review],
    canonicalRoutes: [canonical()],
    sourceRoutes: [sourceRoute()],
    mountains: [mountain()],
    datasetVersion: "test",
    phase7AuditHash: "hash",
    adminBoundaries: null,
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.excludedEligibilityCounts.unsupported, 1);
});

test("default CLI mode is dry-run", () => {
  assert.deepEqual(parsePhase8CliOptions([]), {
    mode: "dry-run",
    limit: null,
    confirmAll: false,
    adminBoundariesPath: null,
    mountainCatalogPath: null,
    manifestPath: null,
  });
});

test("--apply-staging is required for writes", async () => {
  let calls = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      calls += 1;
      return null;
    },
    async upsertRouteWithSummits() {
      calls += 1;
      return { id: "staged" };
    },
  };
  const result = await applyStagingPlan([createImportPlanRecord(contract())], {
    mode: "dry-run",
    limit: null,
    confirmAll: false,
  }, writer);
  assert.equal(calls, 0);
  assert.equal(result.databaseWrites, 0);
});

test("unlimited staging requires --confirm-all", () => {
  assert.throws(() => parsePhase8CliOptions(["--apply-staging"]), /--confirm-all/);
  assert.equal(
    parsePhase8CliOptions(["--apply-staging", "--confirm-all"]).confirmAll,
    true,
  );
});

test("bounded staging accepts a positive --limit", () => {
  const options = parsePhase8CliOptions(["--apply-staging", "--limit", "50"]);
  assert.equal(options.mode, "apply-staging");
  assert.equal(options.limit, 50);
});

test("duplicate rerun protection skips an unchanged payload", async () => {
  const record = createImportPlanRecord(contract());
  let writes = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      return { id: "existing", payloadHash: record.payloadHash };
    },
    async upsertRouteWithSummits() {
      writes += 1;
      return { id: "existing" };
    },
  };
  const result = await applyStagingPlan([record], {
    mode: "apply-staging",
    limit: 1,
    confirmAll: false,
  }, writer);
  assert.equal(writes, 0);
  assert.equal(result.unchanged, 1);
});

test("changed payload is upserted under the same idempotency key", async () => {
  const record = createImportPlanRecord(contract());
  let atomicWrites = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      return { id: "existing", payloadHash: "old" };
    },
    async upsertRouteWithSummits() {
      atomicWrites += 1;
      return { id: "existing" };
    },
  };
  const result = await applyStagingPlan([record], {
    mode: "apply-staging",
    limit: 1,
    confirmAll: false,
  }, writer);
  assert.equal(atomicWrites, 1);
  assert.equal(result.createdOrUpdated, 1);
});

test("first-50 selection is deterministic across input order", () => {
  const records = ["3", "1", "2"].map((sourceId) => {
    const value = contract({
      eligibility: { canonicalRouteSourceId: sourceId, sourceRouteIds: [sourceId] },
      canonical: {
        canonicalRouteSourceId: sourceId,
        sourceRouteIds: [sourceId],
        sourceProvenance: [
          {
            routeSourceId: sourceId,
            sourceUrl: `https://www.openstreetmap.org/relation/${sourceId}`,
            provenanceId: PROVENANCE_ID,
            license: "ODbL-1.0",
            attribution: ATTRIBUTION,
          },
        ],
      },
      sourceRoute: {
        sourceId,
        sourceUrl: `https://www.openstreetmap.org/relation/${sourceId}`,
      },
    });
    return createImportPlanRecord(value);
  });
  const first = buildFirstBatchSelection(records, 3);
  const second = buildFirstBatchSelection([...records].reverse(), 3);
  assert.deepEqual(first, second);
});

test("first-batch QA contains inspection evidence and links", () => {
  const qa = buildFirstBatchQa([createImportPlanRecord(contract())], 1)[0];
  assert.equal(qa.summits[0].associationConfidence, 1);
  assert.equal(qa.inspection.localMountainPaths[0], "/mountain/1");
  assert.match(qa.inspection.osmRouteUrl, /openstreetmap/);
});

test("admin boundary join assigns a point and complete route", () => {
  const dataset = parseAdminBoundaryDataset({
    type: "FeatureCollection",
    metadata: {
      provider: "Test provider",
      dataset: "Test ADM1",
      source: "Natural Earth",
      license: "Public domain",
      version: "test",
      sourceUrl: "https://example.test/boundaries",
      attribution: "Test boundary data",
    },
    features: [
      {
        type: "Feature",
        id: "AT:AT-7",
        bbox: [9, 46, 11, 48],
        properties: {
          countryCode: "AT",
          countryName: "Austria",
          admin1Code: "AT-7",
          admin1Name: "Tyrol",
          source: "Test provider",
          sourceUrl: "https://example.test/source",
          license: "Public domain",
          licenseUrl: "https://example.test/license",
          attribution: "Test boundary data",
          version: "test",
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[9, 46], [11, 46], [11, 48], [9, 48], [9, 46]]],
        },
      },
    ],
  });
  assert.equal(assignPointToAdminBoundary([10, 47], dataset)?.countryCode, "AT");
  assert.equal(
    assignRouteToAdminBoundary(
      { type: "LineString", coordinates: [[9.5, 46.5], [10.5, 47.5]] },
      dataset,
    )?.admin1Name,
    "Tyrol",
  );
});

test("country is not guessed when boundary data is absent", () => {
  assert.equal(assignPointToAdminBoundary([10, 47], null), null);
  assert.equal(
    assignRouteToAdminBoundary(
      { type: "LineString", coordinates: [[9.5, 46.5], [10.5, 47.5]] },
      null,
    ),
    null,
  );
});

test("probable match is blocked and never attached automatically", () => {
  const plan = createImportPlanRecord(
    contract({ mountains: [mountain(1, { osmId: "different", coordinates: [10.0001, 47] })] }),
  );
  assert.equal(plan.summits[0].mountainMatch.classification, "PROBABLE_MOUNTAIN_MATCH");
  assert.equal(plan.operation, "BLOCKED_NO_MOUNTAIN");
});

test("ambiguous match is blocked separately", () => {
  const plan = createImportPlanRecord(
    contract({
      mountains: [
        mountain(1, { osmId: "different-1" }),
        mountain(2, { osmId: "different-2", coordinates: [10.00001, 47] }),
      ],
    }),
  );
  assert.equal(plan.operation, "BLOCKED_AMBIGUOUS");
});

test("summary generation is deterministic and counts match classes", () => {
  const exact = createImportPlanRecord(contract());
  const noMatch = createImportPlanRecord(contract({ mountains: [] }));
  noMatch.summits[0].peakOsmId = "9002";
  const first = summarizeImportPlan([exact, noMatch]);
  const second = summarizeImportPlan([exact, noMatch]);
  assert.deepEqual(first, second);
  assert.equal(first.mountainMatches.uniquePeaks.EXACT_MOUNTAIN_MATCH, 1);
  assert.equal(first.mountainMatches.uniquePeaks.NO_MOUNTAIN_MATCH, 1);
  assert.equal(first.operations.READY_FOR_STAGING, 1);
  assert.equal(first.operations.BLOCKED_NO_MOUNTAIN, 1);
});

test("only READY_FOR_STAGING records can be selected for writes", () => {
  const ready = createImportPlanRecord(contract());
  const blocked = createImportPlanRecord(contract({ mountains: [] }));
  assert.deepEqual(selectReadyStagingRecords([blocked, ready], null), [ready]);
});

test("missing canonical inputs are retained as validation blockers", () => {
  const result = buildImportPlan({
    eligibilityRecords: [eligibility()],
    canonicalRoutes: [],
    sourceRoutes: [],
    mountains: [],
    datasetVersion: "test",
    phase7AuditHash: "hash",
    adminBoundaries: null,
  });
  assert.equal(result.records[0].operation, "BLOCKED_VALIDATION");
  assert.match(result.records[0].reasons.at(-1) ?? "", /Missing canonical audit record/);
});

function planRecordForSource(sourceId: string) {
  return createImportPlanRecord(
    contract({
      eligibility: { canonicalRouteSourceId: sourceId, sourceRouteIds: [sourceId] },
      canonical: {
        canonicalRouteSourceId: sourceId,
        sourceRouteIds: [sourceId],
        sourceProvenance: [
          {
            routeSourceId: sourceId,
            sourceUrl: `https://www.openstreetmap.org/relation/${sourceId}`,
            provenanceId: PROVENANCE_ID,
            license: "ODbL-1.0",
            attribution: ATTRIBUTION,
          },
        ],
      },
      sourceRoute: {
        sourceId,
        sourceUrl: `https://www.openstreetmap.org/relation/${sourceId}`,
      },
    }),
  );
}

test("first-write manifest generation is deterministic", () => {
  const records = [planRecordForSource("2"), planRecordForSource("1")];
  const first = createFirstWriteManifest(records, "dataset-fingerprint");
  const second = createFirstWriteManifest([...records].reverse(), "dataset-fingerprint");
  assert.deepEqual(first, second);
  assert.deepEqual(first.records.map((record) => record.sourceRelationId), ["1", "2"]);
});

test("locked staging manifest deterministically includes geometry, route, and summit evidence", () => {
  const records = [planRecordForSource("2"), planRecordForSource("1")];
  const first = createLockedFirstWriteManifest(records, "dataset-fingerprint");
  const second = createLockedFirstWriteManifest([...records].reverse(), "dataset-fingerprint");
  assert.deepEqual(first, second);
  assert.equal(first.records[0].lockedEvidence?.datasetFingerprint, "dataset-fingerprint");
  assert.match(first.records[0].lockedEvidence?.geometryHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(first.records[0].lockedEvidence?.importEligibility, "AUTO_IMPORT_READY");
  assert.equal(first.records[0].lockedEvidence?.summitAssociations[0].mountainId, 1);
});

test("manifest guard rejects changed locked evidence even if the payload hash was not refreshed", () => {
  const record = planRecordForSource("1");
  const manifest = createLockedFirstWriteManifest([record], "dataset");
  record.contract.route.distanceMeters += 1;
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /Locked staging evidence changed/,
  );
});

test("manifest guard rejects a payload mismatch", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  record.payloadHash = "changed";
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /Payload hash changed/,
  );
});

test("manifest guard rejects a contract mismatch", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  (manifest as unknown as { contractVersion: string }).contractVersion = "future-contract";
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /contract version mismatch/i,
  );
});

test("manifest guard rejects changed mountain resolution", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  record.contract.confirmedSummits[0].mountainMatch.mountainId = 2;
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /Mountain resolution changed/,
  );
});

test("manifest guard rejects a route that is no longer ready", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  record.operation = "BLOCKED_VALIDATION";
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /no longer READY_FOR_STAGING/,
  );
});

test("manifest guard rejects a missing reviewed key", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  assert.throws(
    () => validateFirstWriteManifest([], manifest, "dataset"),
    /missing from the current plan/,
  );
});

test("manifest guard rejects duplicate reviewed keys", () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  manifest.records.push({ ...manifest.records[0] });
  manifest.recordCount += 1;
  assert.throws(
    () => validateFirstWriteManifest([record], manifest, "dataset"),
    /duplicate idempotency key/,
  );
});

test("manifest apply selects only the reviewed records", async () => {
  const reviewed = planRecordForSource("1");
  const unreviewed = planRecordForSource("2");
  const manifest = createFirstWriteManifest([reviewed], "dataset");
  const written: string[] = [];
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      return null;
    },
    async upsertRouteWithSummits(record) {
      written.push(record.sourceRelationId);
      return { id: "staged" };
    },
  };
  const result = await applyStagingPlan(
    [unreviewed, reviewed],
    { mode: "apply-staging", limit: null, confirmAll: false },
    writer,
    { manifest, datasetFingerprint: "dataset" },
  );
  assert.deepEqual(written, ["1"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.databaseWrites, 1);
});

test("administrative ambiguity remains a review warning, not a blocker", () => {
  const record = planRecordForSource("1");
  record.contract.routeAdministration = {
    status: "AMBIGUOUS",
    candidates: [],
    reason: "Test border point",
    boundaryProvenance: {
      provider: "test",
      dataset: "test",
      source: "test",
      license: "test",
      version: "test",
      sourceUrl: "https://example.test",
      attribution: "test",
    },
  };
  record.warnings = ["Offline administrative-boundary enrichment is ambiguous"];
  const review = auditFirstWriteRecord(record, new Map([[1, mountain()]]));
  assert.equal(review.disposition, "WARNING");
  assert.equal(review.approvedForFirstWrite, true);
  assert.deepEqual(review.hardFailures, []);
});

test("manifest-guarded dry-run performs zero database writes", async () => {
  const record = planRecordForSource("1");
  const manifest = createFirstWriteManifest([record], "dataset");
  let calls = 0;
  const writer: StagingWriter = {
    async findByIdempotencyKey() {
      calls += 1;
      return null;
    },
    async upsertRouteWithSummits() {
      calls += 1;
      return { id: "never" };
    },
  };
  const result = await applyStagingPlan(
    [record],
    { mode: "dry-run", limit: null, confirmAll: false },
    writer,
    { manifest, datasetFingerprint: "dataset" },
  );
  assert.equal(calls, 0);
  assert.equal(result.databaseWrites, 0);
});

test("rollback is limited to the Phase 8 staging objects", async () => {
  const sql = await readFile("database/osm_route_import_staging_rollback.sql", "utf8");
  const executable = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.match(executable, /drop function if exists public\.stage_osm_route_import/);
  assert.match(executable, /drop table if exists public\.osm_route_import_summit_staging/);
  assert.match(executable, /drop table if exists public\.osm_route_import_staging/);
  assert.doesNotMatch(executable, /\b(delete|update|truncate)\b/i);
  assert.doesNotMatch(executable, /drop table(?! if exists public\.osm_route_import_(?:summit_)?staging)/i);
  assert.doesNotMatch(executable, /public\.mountains|public\.mountain_routes/i);
});
