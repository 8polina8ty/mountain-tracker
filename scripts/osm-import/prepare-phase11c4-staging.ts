import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  calculateRouteDiagnostics,
  type PreviewMetadataDocument,
  type PreviewMetadataRecord,
  type PreviewRouteGeometry,
} from "../../Lib/osmStagingPreview/core.ts";
import {
  getPreviewQueueDefinition,
  type PreviewQueueArtifact,
} from "../../Lib/osmStagingPreview/queue-core.ts";
import { writeJsonAtomically } from "./jsonl.ts";
import {
  createLockedFirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";

interface ImportPlanDocument {
  datasetFingerprint: string;
  records: ImportPlanRecord[];
}

function metadataRecord(record: ImportPlanRecord): PreviewMetadataRecord {
  if (record.operation !== "READY_FOR_STAGING") {
    throw new Error(`Queue relation ${record.sourceRelationId} is ${record.operation}.`);
  }
  if (record.contract.confirmedSummits.length !== 1) {
    throw new Error(`Queue relation ${record.sourceRelationId} does not have exactly one summit.`);
  }
  const summit = record.contract.confirmedSummits[0];
  if (
    summit.peakCoordinates === null ||
    summit.mountainMatch.classification !== "EXACT_MOUNTAIN_MATCH" ||
    summit.mountainMatch.mountainId === null
  ) {
    throw new Error(`Queue relation ${record.sourceRelationId} lacks an exact mountain match.`);
  }
  const administration = record.contract.routeAdministration;
  const geometry = record.contract.route.geometry as PreviewRouteGeometry;
  return {
    sourceRelationId: record.sourceRelationId,
    canonicalRouteSourceId: record.canonicalRouteSourceId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    routeName: record.routeName,
    semanticType: record.contract.route.semanticType,
    qualityScore: record.contract.route.qualityScore,
    distanceMeters: record.contract.route.distanceMeters,
    componentCount: record.contract.route.componentCount,
    auditFlags: [...record.contract.auditFlags],
    warnings: [...record.warnings],
    countryCode: administration.status === "ASSIGNED" ? administration.countryCode : null,
    countryName: administration.status === "ASSIGNED" ? administration.countryName : null,
    admin1Code: administration.status === "ASSIGNED" ? administration.admin1Code : null,
    admin1Name: administration.status === "ASSIGNED" ? administration.admin1Name : null,
    administrationStatus: administration.status,
    summit: {
      peakOsmId: summit.peakOsmId,
      peakName: summit.peakName,
      peakElevationMeters: summit.peakElevationMeters,
      peakCoordinates: summit.peakCoordinates,
      mountainId: summit.mountainMatch.mountainId,
      mountainName: summit.mountainMatch.mountainName,
      mountainElevationMeters: summit.mountainMatch.mountainElevationMeters,
      matchClassification: "EXACT_MOUNTAIN_MATCH",
      finalAssociation: "CONFIRMED",
      finalConfidence: summit.finalConfidence,
      minimumGeometryDistanceMeters: summit.minimumGeometryDistanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
    },
    diagnostics: calculateRouteDiagnostics({
      geometry,
      summitCoordinate: summit.peakCoordinates,
      totalDistanceMeters: record.contract.route.distanceMeters,
      endpointDistanceMeters: summit.endpointDistanceMeters,
    }),
  };
}

async function main(): Promise<void> {
  const definition = getPreviewQueueDefinition("phase11c4");
  const [artifact, plan] = await Promise.all([
    readFile(resolve(definition.artifactPath), "utf8").then(
      (value) => JSON.parse(value) as PreviewQueueArtifact,
    ),
    readFile(resolve("data/osm/alps/staging/import-plan.json"), "utf8").then(
      (value) => JSON.parse(value) as ImportPlanDocument,
    ),
  ]);
  const planByRelation = new Map(
    plan.records.map((record) => [record.sourceRelationId, record]),
  );
  const seen = new Set<string>();
  const seenCanonicals = new Set<string>();
  const seenSourceUrls = new Set<string>();
  const blockers: Array<{ sourceRelationId: string; reason: string }> = [];
  const selected: ImportPlanRecord[] = [];

  if (
    artifact.artifactType !== "PHASE11C4_NEW_QA_QUEUE" ||
    artifact.newRoutesQueued !== definition.expectedTotal ||
    artifact.queue.length !== definition.expectedTotal
  ) {
    throw new Error("Phase 11C.4 queue artifact count or type is invalid.");
  }
  for (const queueRecord of artifact.queue) {
    if (seen.has(queueRecord.sourceRelationId)) {
      blockers.push({
        sourceRelationId: queueRecord.sourceRelationId,
        reason: "DUPLICATE_QUEUE_RELATION",
      });
      continue;
    }
    seen.add(queueRecord.sourceRelationId);
    if (seenCanonicals.has(queueRecord.canonicalRouteSourceId)) {
      blockers.push({
        sourceRelationId: queueRecord.sourceRelationId,
        reason: "DUPLICATE_QUEUE_CANONICAL_SOURCE",
      });
      continue;
    }
    seenCanonicals.add(queueRecord.canonicalRouteSourceId);
    const record = planByRelation.get(queueRecord.sourceRelationId);
    if (!record) {
      blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reason: "MISSING_PHASE8_PLAN" });
      continue;
    }
    if (seenSourceUrls.has(record.contract.source.sourceUrl)) {
      blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reason: "DUPLICATE_SOURCE_URL" });
      continue;
    }
    seenSourceUrls.add(record.contract.source.sourceUrl);
    if (
      record.canonicalRouteSourceId !== queueRecord.canonicalRouteSourceId ||
      record.sourceRelationId !== queueRecord.sourceRelationId
    ) {
      blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reason: "SOURCE_IDENTITY_DRIFT" });
      continue;
    }
    if (record.operation !== "READY_FOR_STAGING") {
      blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reason: record.operation });
      continue;
    }
    if (
      record.contract.confirmedSummits.length !== 1 ||
      record.contract.confirmedSummits[0].mountainMatch.classification !==
        "EXACT_MOUNTAIN_MATCH" ||
      record.contract.confirmedSummits[0].mountainMatch.mountainId === null
    ) {
      blockers.push({ sourceRelationId: queueRecord.sourceRelationId, reason: "INVALID_SUMMIT_MATCH" });
      continue;
    }
    selected.push(record);
  }

  const readiness = {
    schemaVersion: 1,
    artifactType: "PHASE11C4_STAGING_READINESS",
    queueId: definition.id,
    queueTotal: artifact.queue.length,
    readyForStaging: selected.length,
    blocked: blockers.length,
    stagingWriteEnabled: false,
    runtimeContractGenerated: blockers.length === 0,
    blockers,
    records: artifact.queue.map((queueRecord) => {
      const record = planByRelation.get(queueRecord.sourceRelationId);
      return {
        sourceRelationId: queueRecord.sourceRelationId,
        canonicalRouteSourceId: queueRecord.canonicalRouteSourceId,
        operation: record?.operation ?? "MISSING_PHASE8_PLAN",
        idempotencyKey: record?.idempotencyKey ?? null,
        payloadHash: record?.payloadHash ?? null,
        expectedSummitAssociationCount: record?.contract.confirmedSummits.length ?? 0,
      };
    }),
  };
  await writeJsonAtomically(
    resolve("data/osm/alps/staging/phase11c4-staging-readiness.json"),
    readiness,
  );

  if (blockers.length === 0) {
    const manifest = createLockedFirstWriteManifest(selected, plan.datasetFingerprint);
    const metadata: PreviewMetadataDocument = {
      schemaVersion: 1,
      contractVersion: manifest.contractVersion,
      datasetFingerprint: manifest.datasetFingerprint,
      manifestHash: manifest.manifestHash,
      recordCount: selected.length,
      records: selected.map(metadataRecord),
    };
    await Promise.all([
      writeJsonAtomically(resolve(definition.stagingManifestPath), manifest),
      writeJsonAtomically(resolve(definition.previewMetadataPath), metadata),
    ]);
  }

  process.stdout.write(
    `${JSON.stringify({
      queueTotal: artifact.queue.length,
      readyForStaging: selected.length,
      blocked: blockers.length,
      runtimeContractGenerated: blockers.length === 0,
      databaseWrites: 0,
    }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
