import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Stable } from "./phase11-publication.ts";

const REPORT_PATH = "data/osm/alps/publication/phase11-final-closure-report.json";

interface ClosureReport {
  schemaVersion: number;
  artifactType: string;
  contractVersion: string;
  readOnly: boolean;
  publishable: boolean;
  production: {
    totals: {
      activePublications: number;
      uniqueActiveMountainRoutes: number;
      uniqueActiveRelations: number;
    };
    phase11hControlledStaging: Record<string, number>;
    blockedRelation: Record<string, number | string>;
    machineGreenPublicationPartition: {
      total: number;
      activeOverlap: number;
      unpublished: number;
      unpublishedRelationIds: string[];
    };
  };
  machineScale: Record<string, number | boolean>;
  humanCalibration: {
    decisionDistribution: Record<string, number>;
    historyIntegrityPass: boolean;
    payloadCompatibilityPass: boolean;
    humanRejectedMachineGreen: number;
    humanNeedsReviewMachineGreen: number;
  };
  roadSafety: Record<string, string | boolean>;
  startContext: {
    counts: Record<string, number>;
    externalDemOrElevationApi: boolean;
    tothorn: { classification: string; green: boolean };
  };
  naming: {
    nameReady: number;
    nameUnresolved: number;
    derivedNamesArePresentationMetadataOnly: boolean;
    derivedNamesRewriteOsmSourceName: boolean;
  };
  databaseSafety: Record<string, string[] | number | boolean>;
  zeroUnapprovedPublicationAttestation: Record<string, number | boolean>;
  validation: { overall: string; commands: Array<{ command: string; status: string }> };
  readiness: Record<string, string | boolean>;
  deterministicArtifactHash: string;
}

async function loadReport(): Promise<ClosureReport> {
  return JSON.parse(await readFile(REPORT_PATH, "utf8")) as ClosureReport;
}

test("Phase 11 closure report preserves the versioned read-only boundary", async () => {
  const report = await loadReport();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.artifactType, "PHASE11_FINAL_CLOSURE_REPORT");
  assert.equal(report.contractVersion, "mountain-tracker-phase11-final-closure/v1");
  assert.equal(report.readOnly, true);
  assert.equal(report.publishable, false);

  const { deterministicArtifactHash, ...content } = report;
  assert.equal(deterministicArtifactHash, sha256Stable(content));
});

test("production reconciliation keeps ACTIVE, controlled staging, and blocked relation distinct", async () => {
  const report = await loadReport();
  assert.deepEqual(report.production.totals, {
    stagingRoutes: 876,
    summitStagingRows: 876,
    qaCurrentDecisions: 196,
    qaHistoryRows: 201,
    publicationProvenanceRows: 118,
    activePublications: 118,
    uniqueActiveMountainRoutes: 118,
    uniqueActiveRelations: 118,
  });
  assert.deepEqual(report.production.phase11hControlledStaging, {
    expectedRelations: 44,
    routeRows: 44,
    exactReceiptMatches: 44,
    summitRows: 44,
    singleConfirmedSummitRows: 44,
    qaCurrentRows: 44,
    visuallyApprovedRows: 44,
    needsReviewRows: 0,
    rejectedRows: 0,
    qaHistoryRows: 45,
    publicationProvenanceRows: 0,
    activePublicationRows: 0,
  });
  assert.deepEqual(report.production.blockedRelation, {
    canonicalRelationId: "19752996",
    peakOsmId: "14110138897",
    stagingRows: 0,
    qaCurrentRows: 0,
    qaHistoryRows: 0,
    publicationProvenanceRows: 0,
    exactMountainIdentityRows: 0,
  });
});

test("machine scale and human sample are reconciled without extrapolation", async () => {
  const report = await loadReport();
  assert.equal(report.machineScale.phase11f3ExistingGreen, 124);
  assert.equal(report.machineScale.phase11gNewGreen, 121);
  assert.equal(report.machineScale.overlap, 0);
  assert.equal(report.machineScale.combinedMachineGreen, 245);
  assert.equal(report.machineScale.humanReviewedSample, 44);
  assert.equal(report.machineScale.activePublications, 118);
  assert.equal(report.production.machineGreenPublicationPartition.total, 245);
  assert.equal(report.production.machineGreenPublicationPartition.activeOverlap, 0);
  assert.equal(report.production.machineGreenPublicationPartition.unpublished, 245);
  assert.equal(report.production.machineGreenPublicationPartition.unpublishedRelationIds.length, 245);

  assert.equal(report.humanCalibration.decisionDistribution.VISUALLY_APPROVED, 44);
  assert.equal(report.humanCalibration.decisionDistribution.NEEDS_REVIEW, 0);
  assert.equal(report.humanCalibration.decisionDistribution.REJECTED, 0);
  assert.equal(report.humanCalibration.decisionDistribution.PENDING, 0);
  assert.equal(report.humanCalibration.historyIntegrityPass, true);
  assert.equal(report.humanCalibration.payloadCompatibilityPass, true);
  assert.equal(report.humanCalibration.humanRejectedMachineGreen, 0);
  assert.equal(report.humanCalibration.humanNeedsReviewMachineGreen, 0);
});

test("safety, start-context, and naming remain fail-closed", async () => {
  const report = await loadReport();
  assert.equal(report.roadSafety.contractStatus, "UNCHANGED_AND_MANDATORY");
  assert.equal(report.roadSafety.ambiguousCrossing, "FAIL_CLOSED_TO_REVIEW");
  assert.equal(report.roadSafety.weakenedDuringFThroughI, false);
  assert.equal(report.startContext.counts.BASE_START, 75);
  assert.equal(report.startContext.counts.HUT_START, 49);
  assert.equal(report.startContext.counts.HIGH_MOUNTAIN_START, 263);
  assert.equal(report.startContext.counts.AMBIGUOUS_START, 254);
  assert.equal(report.startContext.externalDemOrElevationApi, false);
  assert.deepEqual(report.startContext.tothorn, {
    canonicalRelationId: "274491",
    routeName: "Tothorn route",
    classification: "HIGH_MOUNTAIN_START",
    green: false,
    startElevationSource: "EXACT_ENDPOINT_OSM_ELE",
    evidence: [
      'Route starts within 87 m of saddle "Rezlipass" (node).',
      "Start at pass/saddle/ridge/peak indicates high-mountain start, not a meaningful base ascent.",
      "Deterministic start elevation via EXACT_ENDPOINT_OSM_ELE (2837 m).",
      "START_ELEVATION_PROVEN",
    ],
  });
  assert.equal(report.naming.nameReady, 89);
  assert.equal(report.naming.nameUnresolved, 32);
  assert.equal(report.naming.derivedNamesArePresentationMetadataOnly, true);
  assert.equal(report.naming.derivedNamesRewriteOsmSourceName, false);
});

test("closure attests zero unapproved publication and generator contains no database mutation", async () => {
  const report = await loadReport();
  assert.equal(report.databaseSafety.closureDatabaseWrites, 0);
  assert.equal(report.databaseSafety.phase11hOrIPublishedControlledSample, false);
  assert.equal(report.databaseSafety.phase11hOrIModifiedActive, false);
  assert.equal(report.databaseSafety.createdBlockedMountainIdentity, false);
  assert.equal(report.zeroUnapprovedPublicationAttestation.attested, true);
  assert.equal(report.readiness.publicationAuthorizationGrantedByThisArtifact, false);

  const source = await readFile(
    "scripts/osm-import/generate-phase11-final-closure-report.ts",
    "utf8",
  );
  assert.doesNotMatch(source, /\.(?:insert|upsert|delete|rpc)\s*\(/);
  assert.doesNotMatch(source, /\.from\([^)]*\)\s*\.update\s*\(/);
});

test("all closure validation commands are recorded without failures", async () => {
  const report = await loadReport();
  assert.equal(report.validation.overall, "PASS_WITH_WARNINGS");
  assert.ok(report.validation.commands.length >= 12);
  assert.ok(
    report.validation.commands.every((entry) =>
      ["PASS", "PASS_WITH_WARNINGS"].includes(entry.status),
    ),
  );
});
