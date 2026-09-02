import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  calculateRouteDiagnostics,
  validatePhase9Manifest,
  type PreviewCoordinate,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewMetadataRecord,
  type PreviewRouteGeometry,
} from "../../Lib/osmStagingPreview/core.ts";
import { writeJsonAtomically } from "./jsonl.ts";
import type { ImportPlanRecord } from "./phase8-staging.ts";

const DIRECTORY = resolve("data/osm/alps/staging");
const OUTPUT_PATH = resolve(DIRECTORY, "phase9-preview-metadata.json");

interface PlanDocument {
  records: ImportPlanRecord[];
}

interface PrewriteReviewDocument {
  records: Array<{
    sourceRelationId: string;
    payloadHash: string;
    approvedForFirstWrite: boolean;
    warnings: string[];
  }>;
}

function adminFields(resolution: ImportPlanRecord["contract"]["routeAdministration"]) {
  return resolution.status === "ASSIGNED"
    ? {
        countryCode: resolution.countryCode,
        countryName: resolution.countryName,
        admin1Code: resolution.admin1Code,
        admin1Name: resolution.admin1Name,
        administrationStatus: resolution.status,
      }
    : {
        countryCode: null,
        countryName: null,
        admin1Code: null,
        admin1Name: null,
        administrationStatus: resolution.status,
      };
}

async function main(): Promise<void> {
  const [manifestContent, planContent, reviewContent] = await Promise.all([
    readFile(resolve(DIRECTORY, "first-write-manifest.json"), "utf8"),
    readFile(resolve(DIRECTORY, "import-plan.json"), "utf8"),
    readFile(resolve(DIRECTORY, "first-50-prewrite-review.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestContent) as PreviewManifest;
  const plan = JSON.parse(planContent) as PlanDocument;
  const review = JSON.parse(reviewContent) as PrewriteReviewDocument;
  validatePhase9Manifest(manifest);
  const planByKey = new Map(plan.records.map((record) => [record.idempotencyKey, record]));
  const reviewBySource = new Map(
    review.records.map((record) => [record.sourceRelationId, record]),
  );
  const records = manifest.records.map((manifestRecord): PreviewMetadataRecord => {
    const planRecord = planByKey.get(manifestRecord.idempotencyKey);
    const reviewRecord = reviewBySource.get(manifestRecord.sourceRelationId);
    if (!planRecord || !reviewRecord || !reviewRecord.approvedForFirstWrite) {
      throw new Error(`Approved Phase 9 metadata source is missing: ${manifestRecord.idempotencyKey}`);
    }
    if (
      planRecord.payloadHash !== manifestRecord.payloadHash ||
      reviewRecord.payloadHash !== manifestRecord.payloadHash ||
      planRecord.operation !== "READY_FOR_STAGING"
    ) {
      throw new Error(`Approved Phase 9 metadata changed: ${manifestRecord.idempotencyKey}`);
    }
    if (planRecord.contract.confirmedSummits.length !== 1) {
      throw new Error(`Phase 9 currently requires one reviewed summit: ${manifestRecord.idempotencyKey}`);
    }
    const summit = planRecord.contract.confirmedSummits[0];
    if (
      summit.peakCoordinates === null ||
      summit.mountainMatch.mountainId === null ||
      summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
      summit.finalAssociation !== "CONFIRMED"
    ) {
      throw new Error(`Phase 9 summit evidence is not exact/confirmed: ${manifestRecord.idempotencyKey}`);
    }
    return {
      sourceRelationId: planRecord.sourceRelationId,
      canonicalRouteSourceId: planRecord.canonicalRouteSourceId,
      idempotencyKey: planRecord.idempotencyKey,
      payloadHash: planRecord.payloadHash,
      routeName: planRecord.routeName,
      semanticType: planRecord.contract.route.semanticType,
      qualityScore: planRecord.contract.route.qualityScore,
      distanceMeters: planRecord.contract.route.distanceMeters,
      componentCount: planRecord.contract.route.componentCount,
      auditFlags: [...planRecord.contract.auditFlags],
      warnings: [...reviewRecord.warnings],
      ...adminFields(planRecord.contract.routeAdministration),
      summit: {
        peakOsmId: summit.peakOsmId,
        peakName: summit.peakName,
        peakElevationMeters: summit.peakElevationMeters,
        peakCoordinates: summit.peakCoordinates as PreviewCoordinate,
        mountainId: summit.mountainMatch.mountainId,
        mountainName: summit.mountainMatch.mountainName,
        mountainElevationMeters: summit.mountainMatch.mountainElevationMeters,
        matchClassification: summit.mountainMatch.classification,
        finalAssociation: summit.finalAssociation,
        finalConfidence: summit.finalConfidence,
        minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
        endpointDistanceMeters: summit.endpointDistanceMeters,
      },
      diagnostics: calculateRouteDiagnostics({
        geometry: planRecord.contract.route.geometry as PreviewRouteGeometry,
        summitCoordinate: summit.peakCoordinates as PreviewCoordinate,
        totalDistanceMeters: planRecord.contract.route.distanceMeters,
        endpointDistanceMeters: summit.endpointDistanceMeters,
      }),
    };
  });
  const document: PreviewMetadataDocument = {
    schemaVersion: 1,
    contractVersion: manifest.contractVersion,
    datasetFingerprint: manifest.datasetFingerprint,
    manifestHash: manifest.manifestHash,
    recordCount: records.length,
    records,
  };
  await writeJsonAtomically(OUTPUT_PATH, document);
  process.stdout.write(
    `${JSON.stringify({
      outputPath: OUTPUT_PATH,
      recordCount: records.length,
      fullGeometriesIncluded: 0,
      databaseWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
