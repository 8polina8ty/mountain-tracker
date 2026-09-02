import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManualAuditSample,
  buildPhase7Audit,
  classifyImportEligibility,
  inferExplicitCountryCode,
  percentile,
  qualityBucket,
  validatePeakCoordinate,
  validateRouteGeometry,
  type AssociationAuditSampleRecord,
  type AuditAnalysisInput,
  type AuditAssociationInput,
  type AuditPeakInput,
  type AuditRouteInput,
  type Phase7AuditInput,
} from "./alps-audit.ts";
import type { DuplicateGroup } from "./route-groups.ts";

const PROVENANCE_ID = "openstreetmap-odbl-geofabrik-alps";
const ATTRIBUTION = "© OpenStreetMap contributors";

function route(
  sourceId: string,
  overrides: Partial<AuditRouteInput> = {},
): AuditRouteInput {
  return {
    sourceId,
    sourceUrl: `https://www.openstreetmap.org/relation/${sourceId}`,
    name: `Route ${sourceId}`,
    geometryType: "LineString",
    distanceMeters: 5_000,
    componentCount: 1,
    heavilyFragmented: false,
    geometryValid: true,
    coordinatesFinite: true,
    provenanceId: PROVENANCE_ID,
    license: "ODbL-1.0",
    attribution: ATTRIBUTION,
    explicitCountryCode: null,
    ...overrides,
  };
}

function peak(
  sourceId: string,
  overrides: Partial<AuditPeakInput> = {},
): AuditPeakInput {
  const index = Number(sourceId.replace(/\D/g, "")) || 1;
  return {
    sourceId,
    sourceUrl: `https://www.openstreetmap.org/node/${sourceId}`,
    name: `Peak ${sourceId}`,
    elevationMeters: 2_000 + index,
    coordinates: [10 + index / 100, 46 + index / 100],
    coordinatesValid: true,
    provenanceId: PROVENANCE_ID,
    license: "ODbL-1.0",
    attribution: ATTRIBUTION,
    explicitCountryCode: null,
    ...overrides,
  };
}

function association(
  peakSourceId: string,
  finalAssociation: "CONFIRMED" | "REVIEW" | "REJECTED" = "CONFIRMED",
  overrides: Partial<AuditAssociationInput> = {},
): AuditAssociationInput {
  return {
    peakSourceId,
    peakSourceUrl: `https://www.openstreetmap.org/node/${peakSourceId}`,
    peakName: `Peak ${peakSourceId}`,
    peakElevation: 2_000,
    geometricClassification: "MATCHED",
    geometricConfidence: 1,
    minDistanceMeters: 1,
    endpointDistanceMeters: 5,
    nearEndpoint: true,
    routeSemanticType: "summit_route",
    finalAssociation,
    finalConfidence: finalAssociation === "REVIEW" ? 0.97 : 1,
    reasons: [`Fixture ${finalAssociation}`],
    ...overrides,
  };
}

function analysis(
  routeSourceId: string,
  qualityScore: number,
  summitAssociations: AuditAssociationInput[],
  overrides: Partial<AuditAnalysisInput> = {},
): AuditAnalysisInput {
  return {
    routeSourceId,
    routeName: `Route ${routeSourceId}`,
    semanticType: "summit_route",
    qualityScore,
    summitAssociations,
    ...overrides,
  };
}

function duplicateGroup(): DuplicateGroup {
  return {
    groupId: "duplicate-r1",
    canonicalSourceId: "r1",
    canonicalName: "Route r1",
    memberSourceIds: ["r1", "r2"],
    members: [
      {
        sourceId: "r1",
        name: "Route r1",
        qualityScore: 90,
        metadataRichness: 4,
        relationshipToCanonical: "CANONICAL",
      },
      {
        sourceId: "r2",
        name: "Route r2",
        qualityScore: 80,
        metadataRichness: 3,
        relationshipToCanonical: "EXACT_DUPLICATE",
      },
    ],
    duplicateRelationships: [
      {
        sourceIdA: "r1",
        sourceIdB: "r2",
        classification: "EXACT_DUPLICATE",
      },
    ],
    canonicalSelectionReasons: ["Highest Phase 3 quality score: 90."],
  };
}

function fixtureInput(): Phase7AuditInput {
  const routes = [route("r1"), route("r2"), route("r3"), route("r4"), route("r5"), route("r6")];
  const peaks = [peak("p1"), peak("p2"), peak("p3"), peak("p4")];
  const analyses = [
    analysis("r1", 90, [association("p1")]),
    analysis("r2", 80, [association("p1"), association("p2")]),
    analysis("r3", 75, [association("p3")]),
    analysis("r4", 60, [association("p1")]),
    analysis("r5", 80, [association("p4")]),
    analysis("r6", 85, [
      association("p1", "REVIEW", {
        minDistanceMeters: 2,
        endpointDistanceMeters: 50,
        finalConfidence: 0.97,
      }),
    ]),
  ];
  return {
    summary: {
      generatedAt: "2026-08-25T00:00:00.000Z",
      mode: "confirmed-full",
      provenance: {
        id: PROVENANCE_ID,
        source: "openstreetmap",
        extractProvider: "Geofabrik GmbH",
        license: "ODbL-1.0",
        attribution: ATTRIBUTION,
        sourcePage: "https://download.geofabrik.de/europe/alps.html",
      },
      counts: {
        hikingRelationsFound: 6,
        selectedRelations: 6,
        reconstructedRoutes: 6,
        rejectedRoutes: 0,
        peaks: 4,
        summitAssociations: { CONFIRMED: 6, REVIEW: 1, REJECTED: 0 },
        similarityClassifications: {
          EXACT_DUPLICATE: 1,
          NEAR_DUPLICATE: 0,
          SAME_VARIANT: 0,
          DIFFERENT_VARIANT: 0,
          UNRELATED: 0,
        },
        duplicateGroups: 1,
      },
    },
    routes,
    peaks,
    analyses,
    duplicateGroups: [duplicateGroup()],
  };
}

function summarySection(
  input: Phase7AuditInput,
  key: string,
): Record<string, unknown> {
  return buildPhase7Audit(input).artifacts.finalSummary[key] as Record<string, unknown>;
}

test("counts unique confirmed source routes", () => {
  const confirmed = summarySection(fixtureInput(), "confirmedRoutes");
  assert.equal(confirmed.totalConfirmedAssociations, 6);
  assert.equal(confirmed.uniqueRoutesWithConfirmedSummit, 5);
});

test("counts unique peaks covered by confirmed routes", () => {
  const coverage = summarySection(fixtureInput(), "peakCoverage");
  assert.equal(coverage.uniqueConfirmedPeaks, 4);
  assert.equal(coverage.exactly1ConfirmedRoute, 3);
  assert.equal(coverage.from2To5ConfirmedRoutes, 1);
});

test("reports multiple confirmed summits per route", () => {
  const confirmed = summarySection(fixtureInput(), "confirmedRoutes");
  assert.equal(confirmed.routesWithExactlyOneConfirmedSummit, 4);
  assert.equal(confirmed.routesWithMultipleConfirmedSummits, 1);
  assert.equal(confirmed.maximumConfirmedSummitsOnOneRoute, 2);
  assert.equal(confirmed.averageConfirmedSummitsPerConfirmedRoute, 1.2);
});

test("deduplication maps confirmed duplicate representations to the canonical route", () => {
  const result = buildPhase7Audit(fixtureInput()).artifacts;
  const duplicate = result.confirmedRoutes.find((record) => record.routeSourceId === "r2");
  assert.equal(duplicate?.duplicateStatus, "DUPLICATE_REPRESENTATION");
  assert.equal(duplicate?.canonicalRouteSourceId, "r1");
  assert.equal(result.canonicalConfirmedRoutes.length, 4);
});

test("canonical merge preserves every contributing source provenance record", () => {
  const canonical = buildPhase7Audit(fixtureInput()).artifacts.canonicalConfirmedRoutes.find(
    (record) => record.canonicalRouteSourceId === "r1",
  );
  assert.deepEqual(
    canonical?.sourceProvenance.map((item) => item.routeSourceId),
    ["r1", "r2"],
  );
  assert.ok(canonical?.sourceProvenance.every((item) => item.attribution === ATTRIBUTION));
});

test("peak route-count ranking includes source routes and canonical variants", () => {
  const ranking = buildPhase7Audit(fixtureInput()).artifacts.peakCoverageRanking
    .top100ByConfirmedRouteCount as Array<Record<string, unknown>>;
  assert.equal(ranking[0].peakSourceId, "p1");
  assert.equal(ranking[0].confirmedSourceRouteCount, 3);
  assert.equal(ranking[0].canonicalRouteVariantCount, 2);
});

test("quality buckets use the documented closed ranges", () => {
  assert.equal(qualityBucket(95), "90-100");
  assert.equal(qualityBucket(89), "80-89");
  assert.equal(qualityBucket(70), "70-79");
  assert.equal(qualityBucket(60), "60-69");
  assert.equal(qualityBucket(50), "50-59");
  assert.equal(qualityBucket(49), "<50");
  const quality = summarySection(fixtureInput(), "qualityAudit");
  assert.deepEqual(quality.buckets, {
    "90-100": 1,
    "80-89": 2,
    "70-79": 1,
    "60-69": 1,
    "50-59": 0,
    "<50": 0,
  });
});

test("percentile calculation uses deterministic linear interpolation", () => {
  const values = [0, 10, 20, 30, 40];
  assert.equal(percentile(values, 0.1), 4);
  assert.equal(percentile(values, 0.25), 10);
  assert.equal(percentile(values, 0.5), 20);
  assert.equal(percentile(values, 0.9), 36);
});

test("manual audit sampling is deterministic and deduplicates shared entries", () => {
  const sample = buildPhase7Audit(fixtureInput()).artifacts.manualAuditSample;
  const rerun = buildPhase7Audit(fixtureInput()).artifacts.manualAuditSample;
  assert.deepEqual(sample, rerun);
  const entries = sample.entries as AssociationAuditSampleRecord[];
  assert.equal(new Set(entries.map((entry) => entry.sampleKey)).size, entries.length);
});

test("REVIEW associations remain REVIEW in opportunity output", () => {
  const opportunities = buildPhase7Audit(fixtureInput()).artifacts.reviewOpportunities;
  const sample = opportunities.highestConfidenceAllCriteriaSample as Array<
    Record<string, unknown>
  >;
  assert.equal(opportunities.allFourCriteriaCount, 1);
  assert.equal(sample[0].finalAssociation, "REVIEW");
});

test("orphan peak associations are reported as critical integrity failures", () => {
  const input = fixtureInput();
  input.analyses[0].summitAssociations[0] = association("missing");
  const integrity = summarySection(input, "integrity");
  const failures = integrity.failures as Array<Record<string, unknown>>;
  assert.ok(failures.some((item) => item.code === "ORPHAN_PEAK_ASSOCIATION"));
});

test("invalid route geometry is detected without accepting synthetic emptiness", () => {
  assert.deepEqual(
    validateRouteGeometry({ type: "LineString", coordinates: [] }),
    { geometryValid: false, coordinatesFinite: false },
  );
  assert.deepEqual(
    validateRouteGeometry({
      type: "MultiLineString",
      coordinates: [
        [
          [10, 46],
          [10.1, 46.1],
        ],
      ],
    }),
    { geometryValid: true, coordinatesFinite: true },
  );
});

test("invalid peak coordinates are rejected", () => {
  assert.equal(validatePeakCoordinate([10, 46]), true);
  assert.equal(validatePeakCoordinate([181, 46]), false);
  assert.equal(validatePeakCoordinate([10, Number.NaN]), false);
});

test("eligible canonical route becomes AUTO_IMPORT_READY", () => {
  const record = buildPhase7Audit(fixtureInput()).artifacts.importEligibility.find(
    (item) => item.canonicalRouteSourceId === "r3",
  );
  assert.equal(record?.eligibility, "AUTO_IMPORT_READY");
});

test("quality and non-critical flags produce MANUAL_REVIEW_REQUIRED", () => {
  const record = buildPhase7Audit(fixtureInput()).artifacts.importEligibility.find(
    (item) => item.canonicalRouteSourceId === "r4",
  );
  assert.equal(record?.eligibility, "MANUAL_REVIEW_REQUIRED");
});

test("invalid geometry produces EXCLUDE", () => {
  const input = fixtureInput();
  const invalidRoute = input.routes.find((item) => item.sourceId === "r5");
  assert.ok(invalidRoute);
  invalidRoute.geometryValid = false;
  const record = buildPhase7Audit(input).artifacts.importEligibility.find(
    (item) => item.canonicalRouteSourceId === "r5",
  );
  assert.equal(record?.eligibility, "EXCLUDE");
});

test("canonical route merges summit evidence absent from its own associations", () => {
  const canonical = buildPhase7Audit(fixtureInput()).artifacts.canonicalConfirmedRoutes.find(
    (record) => record.canonicalRouteSourceId === "r1",
  );
  assert.deepEqual(
    canonical?.confirmedSummits.map((summit) => summit.peakSourceId),
    ["p1", "p2"],
  );
  const p1 = canonical?.confirmedSummits.find((summit) => summit.peakSourceId === "p1");
  assert.deepEqual(p1?.sourceRouteIds, ["r1", "r2"]);
});

test("complete Phase 7 artifact content is deterministic across reruns", () => {
  const first = buildPhase7Audit(fixtureInput()).artifacts;
  const second = buildPhase7Audit(fixtureInput()).artifacts;
  assert.deepEqual(first, second);
  assert.equal(
    first.finalSummary.deterministicContentHash,
    second.finalSummary.deterministicContentHash,
  );
});

test("country assignment accepts explicit codes only", () => {
  assert.equal(inferExplicitCountryCode({ "addr:country": "at" }), "AT");
  assert.equal(inferExplicitCountryCode({ name: "Austrian trail" }), null);
  assert.equal(inferExplicitCountryCode({ "addr:country": "US" }), null);
});

test("eligibility helper excludes unresolved confirmed peaks", () => {
  const result = classifyImportEligibility({
    route: route("direct"),
    qualityScore: 95,
    flags: [],
    confirmedPeaks: [null],
  });
  assert.equal(result.eligibility, "EXCLUDE");
});

test("manual sampler preserves 25 entries per populated category", () => {
  const samples: AssociationAuditSampleRecord[] = Array.from(
    { length: 30 },
    (_, index) => ({
      sampleKey: `r${index}:p${index}`,
      sampleCategories: [],
      routeSourceId: `r${index}`,
      routeName: `Route ${index}`,
      semanticType: "summit_route",
      routeQualityScore: index,
      routeDistanceMeters: 1_000 + index,
      routeConfirmedSummitCount: 2,
      peakSourceId: `p${index}`,
      peakName: `Peak ${index}`,
      peakElevationMeters: 2_000 + index,
      peakCoordinates: [8 + index / 10, 45 + index / 10],
      minimumGeometryDistanceMeters: 0,
      endpointDistanceMeters: 0,
      finalConfidence: 1,
      finalAssociation: "CONFIRMED",
      reasons: [],
    }),
  );
  const result = buildManualAuditSample(samples);
  const categories = result.categoryKeys as Record<string, string[]>;
  assert.ok(Object.values(categories).every((keys) => keys.length === 25));
});
