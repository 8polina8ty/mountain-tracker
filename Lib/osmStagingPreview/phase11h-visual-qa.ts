import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  calculateRouteDiagnostics,
  PHASE9_CONTRACT_VERSION,
  validatePreviewManifest,
  type PreviewCoordinate,
  type PreviewManifest,
  type PreviewMetadataDocument,
  type PreviewMetadataRecord,
  type PreviewRouteGeometry,
} from "./core.ts";
import {
  loadPhase11hCalibrationPreview,
  type Phase11hCalibrationPreviewResult,
} from "./phase11h-calibration.ts";

const PAYLOADS_PATH = resolve(
  "data/osm/alps/staging/phase11i-b2-human-calibration-staging-payloads.json",
);
const EXECUTION_RECEIPT_PATH = resolve(
  "data/osm/alps/staging/phase11i-b2-controlled-staging-execution.json",
);
const NAME_AUDIT_PATH = resolve(
  "data/osm/alps/staging/phase11h-name-resolution-audit.json",
);

interface Phase11hRoutePayload {
  contract_version: string;
  idempotency_key: string;
  provider: string;
  source_relation_id: string;
  canonical_source_id: string;
  dataset_version: string;
  payload_hash: string;
  route_name: string | null;
  semantic_type: string;
  quality_score: number;
  geometry_geojson: unknown;
  distance_meters: number;
  matched_primary_mountain_id: number;
  audit_flags: string[];
  import_eligibility: string;
  payload: Record<string, unknown>;
}

interface Phase11hSummitPayload {
  peak_osm_id: string;
  mountain_id: number;
  mountain_match_classification: string;
  final_association: string;
  final_confidence: number;
  minimum_geometry_distance_meters: number;
  endpoint_distance_meters: number;
  evidence: string[];
  payload: {
    peak_name?: string | null;
    peak_elevation_meters?: number | null;
    peak_coordinates?: unknown;
  };
}

interface Phase11hPayloadRecord {
  canonicalRelationId: string;
  mainPayload: Phase11hRoutePayload;
  mainPayloadHash: string;
  summitPayloads: Phase11hSummitPayload[];
  summitPayloadHash: string;
}

interface Phase11hPayloadArtifact {
  artifactType: string;
  readOnly: boolean;
  publishable: boolean;
  qaDecisionWrites: number;
  autoApprovalEnabled: boolean;
  mainPayloadCount: number;
  summitPayloadCount: number;
  records: Phase11hPayloadRecord[];
  integrity: {
    uniqueRelationIds: boolean;
    allMountainIdsPresent: boolean;
    allPayloadHashesValid: boolean;
    allIdempotencyKeysUnique: boolean;
  };
}

interface Phase11hExecutionReceipt {
  artifactType: string;
  authorizedCount: number;
  blockedCount: number;
  blockedRelation: string;
  relationIds: string[];
  execution: { stagedResults: string[] };
  qaWrites: number;
  publicationWrites: number;
  activeChanges: number;
}

interface Phase11hNameAuditRecord {
  canonicalRelationId: string;
  startContext: string | null;
  startEntity: {
    featureType: string;
    objectType: string;
    osmid: string;
    name: string;
    distanceMeters: number;
  } | null;
  nameEvidence: string[];
}

interface Phase11hNameAuditArtifact {
  artifactType: string;
  readOnly: boolean;
  publishable: boolean;
  records: Phase11hNameAuditRecord[];
}

export interface Phase11hVisualQaRouteContext {
  canonicalRelationId: string;
  stagingRouteId: string;
  displayName: string;
  geometry: PreviewRouteGeometry;
  geometryHash: string;
  expectedStoredPayload: Record<string, unknown>;
  sourceUrl: string;
  datasetFingerprint: string;
  startContext: string | null;
  startEntity: Phase11hNameAuditRecord["startEntity"];
  startEvidence: string[];
  summitEvidence: string[];
  questions: Phase11hCalibrationPreviewResult["questions"];
  metadata: PreviewMetadataRecord;
}

export interface Phase11hVisualQaContract {
  calibration: Phase11hCalibrationPreviewResult;
  manifest: PreviewManifest;
  metadata: PreviewMetadataDocument;
  contexts: Phase11hVisualQaRouteContext[];
}

export interface Phase11hMapViewModel {
  geometry: PreviewRouteGeometry;
  routeName: string;
  start: {
    coordinates: PreviewCoordinate;
    context: string;
    label: string;
    evidence: string[];
  };
  summit: {
    coordinates: PreviewCoordinate;
    name: string;
    osmId: string;
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseGeometry(value: unknown): PreviewRouteGeometry {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    !("coordinates" in value) ||
    (value.type !== "LineString" && value.type !== "MultiLineString") ||
    !Array.isArray(value.coordinates)
  ) {
    throw new Error("Phase 11H visual QA geometry is invalid.");
  }
  return value as PreviewRouteGeometry;
}

function parseCoordinate(value: unknown): PreviewCoordinate {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw new Error("Phase 11H visual QA summit coordinate is invalid.");
  }
  return [Number(value[0]), Number(value[1])];
}

function parseStagedRouteIds(receipt: Phase11hExecutionReceipt): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of receipt.execution.stagedResults) {
    const separator = value.indexOf(":");
    const relationId = value.slice(0, separator);
    const stagingRouteId = value.slice(separator + 1);
    if (
      separator < 1 ||
      !/^\d+$/.test(relationId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        stagingRouteId,
      ) ||
      result.has(relationId)
    ) {
      throw new Error("Phase 11I-B2 execution receipt contains an invalid staging identity.");
    }
    result.set(relationId, stagingRouteId);
  }
  return result;
}

export function buildPhase11hVisualQaContract(input: {
  calibration: Phase11hCalibrationPreviewResult;
  payloads: Phase11hPayloadArtifact;
  receipt: Phase11hExecutionReceipt;
  nameAudit: Phase11hNameAuditArtifact;
}): Phase11hVisualQaContract {
  const { calibration, payloads, receipt, nameAudit } = input;
  const stagedMembers = calibration.members.filter(
    (member) => member.stagingStatus === "STAGED",
  );
  const stagedRouteIds = parseStagedRouteIds(receipt);
  const payloadByRelation = new Map(
    payloads.records.map((record) => [record.canonicalRelationId, record]),
  );
  const nameByRelation = new Map(
    nameAudit.records.map((record) => [record.canonicalRelationId, record]),
  );
  if (
    payloads.artifactType !== "PHASE11I_B2_STAGING_PAYLOADS" ||
    payloads.readOnly !== true ||
    payloads.publishable !== false ||
    payloads.qaDecisionWrites !== 0 ||
    payloads.autoApprovalEnabled !== false ||
    payloads.mainPayloadCount !== 44 ||
    payloads.summitPayloadCount !== 44 ||
    payloads.records.length !== 44 ||
    !payloads.integrity.uniqueRelationIds ||
    !payloads.integrity.allMountainIdsPresent ||
    !payloads.integrity.allPayloadHashesValid ||
    !payloads.integrity.allIdempotencyKeysUnique ||
    receipt.artifactType !== "PHASE11I_B2_CONTROLLED_STAGING_EXECUTION_RECEIPT" ||
    receipt.authorizedCount !== 44 ||
    receipt.blockedCount !== 1 ||
    receipt.blockedRelation !== "19752996" ||
    receipt.relationIds.length !== 44 ||
    stagedRouteIds.size !== 44 ||
    receipt.qaWrites !== 0 ||
    receipt.publicationWrites !== 0 ||
    receipt.activeChanges !== 0 ||
    nameAudit.artifactType !== "PHASE11H_NAME_RESOLUTION_AUDIT" ||
    nameAudit.readOnly !== true ||
    nameAudit.publishable !== false ||
    stagedMembers.length !== 44
  ) {
    throw new Error("Phase 11H visual QA source contract is invalid.");
  }

  const contexts = stagedMembers.map((member): Phase11hVisualQaRouteContext => {
    const record = payloadByRelation.get(member.canonicalRelationId);
    const name = nameByRelation.get(member.canonicalRelationId);
    const stagingRouteId = stagedRouteIds.get(member.canonicalRelationId);
    if (!record || !name || !stagingRouteId || record.summitPayloads.length !== 1) {
      throw new Error(`Phase 11H visual QA evidence is missing for ${member.canonicalRelationId}.`);
    }
    const route = record.mainPayload;
    const summit = record.summitPayloads[0];
    const geometry = parseGeometry(route.geometry_geojson);
    const peakCoordinates = parseCoordinate(summit.payload.peak_coordinates);
    const geometryHash = sha256(geometry);
    if (
      route.contract_version !== PHASE9_CONTRACT_VERSION ||
      route.provider !== "openstreetmap" ||
      route.source_relation_id !== member.canonicalRelationId ||
      route.canonical_source_id !== member.canonicalRelationId ||
      route.import_eligibility !== "AUTO_IMPORT_READY" ||
      route.matched_primary_mountain_id !== member.resolvedMountainId ||
      route.payload.qualification_hash !== member.qualificationHash ||
      route.payload.candidate_hash !== member.candidateHash ||
      route.payload.geometry_hash !== geometryHash ||
      record.mainPayloadHash !== sha256(route) ||
      record.summitPayloadHash !== sha256(summit) ||
      summit.peak_osm_id !== member.summitOsmId ||
      summit.mountain_id !== member.resolvedMountainId ||
      summit.mountain_match_classification !== "EXACT_MOUNTAIN_MATCH" ||
      summit.final_association !== "CONFIRMED" ||
      name.startContext !== member.startContext
    ) {
      throw new Error(`Phase 11H visual QA identity drift for ${member.canonicalRelationId}.`);
    }
    const diagnostics = calculateRouteDiagnostics({
      geometry,
      summitCoordinate: peakCoordinates,
      totalDistanceMeters: route.distance_meters,
      endpointDistanceMeters: summit.endpoint_distance_meters,
    });
    if (diagnostics.startCoordinate === null) {
      throw new Error(`Phase 11H visual QA start endpoint is unavailable for ${member.canonicalRelationId}.`);
    }
    const metadata: PreviewMetadataRecord = {
      sourceRelationId: route.source_relation_id,
      canonicalRouteSourceId: route.canonical_source_id,
      idempotencyKey: route.idempotency_key,
      payloadHash: route.payload_hash,
      routeName: route.route_name,
      semanticType: route.semantic_type,
      qualityScore: route.quality_score,
      distanceMeters: route.distance_meters,
      componentCount:
        typeof route.payload.component_count === "number"
          ? route.payload.component_count
          : geometry.type === "LineString"
            ? 1
            : geometry.coordinates.length,
      auditFlags: route.audit_flags,
      warnings: [],
      qualificationStatus: "GREEN",
      qualificationScore: route.quality_score,
      qualificationHash: member.qualificationHash,
      countryCode: null,
      countryName: null,
      admin1Code: null,
      admin1Name: null,
      administrationStatus: "UNASSIGNED",
      summit: {
        peakOsmId: summit.peak_osm_id,
        peakName:
          typeof summit.payload.peak_name === "string"
            ? summit.payload.peak_name
            : null,
        peakElevationMeters:
          typeof summit.payload.peak_elevation_meters === "number"
            ? summit.payload.peak_elevation_meters
            : null,
        peakCoordinates,
        mountainId: summit.mountain_id,
        mountainName: null,
        mountainElevationMeters: null,
        matchClassification: "EXACT_MOUNTAIN_MATCH",
        finalAssociation: "CONFIRMED",
        finalConfidence: summit.final_confidence,
        minimumGeometryDistanceMeters: summit.minimum_geometry_distance_meters,
        endpointDistanceMeters: summit.endpoint_distance_meters,
      },
      diagnostics,
    };
    return {
      canonicalRelationId: member.canonicalRelationId,
      stagingRouteId,
      displayName:
        member.resolvedDisplayName ?? `OSM relation ${member.canonicalRelationId}`,
      geometry,
      geometryHash,
      expectedStoredPayload: route.payload,
      sourceUrl: `https://www.openstreetmap.org/relation/${member.canonicalRelationId}`,
      datasetFingerprint:
        typeof route.payload.dataset_fingerprint === "string"
          ? route.payload.dataset_fingerprint
          : "",
      startContext: member.startContext,
      startEntity: name.startEntity,
      startEvidence: name.nameEvidence,
      summitEvidence: summit.evidence,
      questions: calibration.questions,
      metadata,
    };
  });

  if (
    payloadByRelation.size !== contexts.length ||
    receipt.relationIds.some((id) => !payloadByRelation.has(id)) ||
    contexts.some((context) => context.datasetFingerprint.length === 0)
  ) {
    throw new Error("Phase 11H visual QA relation scope is invalid.");
  }
  const datasetFingerprints = new Set(
    contexts.map((context) => context.datasetFingerprint),
  );
  if (datasetFingerprints.size !== 1) {
    throw new Error("Phase 11H visual QA dataset fingerprint drifted.");
  }
  const manifestContent: Omit<PreviewManifest, "manifestHash"> = {
    schemaVersion: 1,
    contractVersion: PHASE9_CONTRACT_VERSION,
    datasetFingerprint: contexts[0].datasetFingerprint,
    recordCount: contexts.length,
    expectedSummitAssociationCount: contexts.length,
    records: contexts.map((context) => ({
      idempotencyKey: context.metadata.idempotencyKey,
      payloadHash: context.metadata.payloadHash,
      sourceRelationId: context.canonicalRelationId,
      canonicalRouteSourceId: context.canonicalRelationId,
      expectedSummitAssociationCount: 1,
      mountainMatches: [
        {
          peakOsmId: context.metadata.summit.peakOsmId,
          mountainId: context.metadata.summit.mountainId,
          classification: "EXACT_MOUNTAIN_MATCH",
        },
      ],
    })),
  };
  const manifest: PreviewManifest = {
    ...manifestContent,
    manifestHash: sha256(manifestContent),
  };
  validatePreviewManifest(manifest, 44);
  return {
    calibration,
    manifest,
    metadata: {
      schemaVersion: 1,
      contractVersion: manifest.contractVersion,
      datasetFingerprint: manifest.datasetFingerprint,
      manifestHash: manifest.manifestHash,
      recordCount: contexts.length,
      records: contexts.map((context) => context.metadata),
    },
    contexts,
  };
}

export function createPhase11hMapViewModel(
  context: Phase11hVisualQaRouteContext,
): Phase11hMapViewModel {
  const startCoordinates = context.metadata.diagnostics.startCoordinate;
  if (startCoordinates === null) {
    throw new Error("Phase 11H map view requires a start endpoint.");
  }
  const startContext = context.startContext ?? "START CONTEXT UNAVAILABLE";
  const startLabel = context.startEntity
    ? `${startContext.replace(/_/g, " ")}: ${context.startEntity.name} (${context.startEntity.featureType}, OSM ${context.startEntity.osmid}, ${Math.round(context.startEntity.distanceMeters)} m from route start)`
    : `${startContext.replace(/_/g, " ")}: inferred route start; no exact named start feature`;
  return {
    geometry: context.geometry,
    routeName: context.displayName,
    start: {
      coordinates: startCoordinates,
      context: startContext,
      label: startLabel,
      evidence: context.startEvidence,
    },
    summit: {
      coordinates: context.metadata.summit.peakCoordinates,
      name:
        context.metadata.summit.peakName ?? context.metadata.summit.peakOsmId,
      osmId: context.metadata.summit.peakOsmId,
    },
  };
}

export async function loadPhase11hVisualQaContract(): Promise<Phase11hVisualQaContract> {
  const [calibration, payloadsRaw, receiptRaw, nameAuditRaw] = await Promise.all([
    loadPhase11hCalibrationPreview("phase11h"),
    readFile(PAYLOADS_PATH, "utf8"),
    readFile(EXECUTION_RECEIPT_PATH, "utf8"),
    readFile(NAME_AUDIT_PATH, "utf8"),
  ]);
  return buildPhase11hVisualQaContract({
    calibration,
    payloads: JSON.parse(payloadsRaw) as Phase11hPayloadArtifact,
    receipt: JSON.parse(receiptRaw) as Phase11hExecutionReceipt,
    nameAudit: JSON.parse(nameAuditRaw) as Phase11hNameAuditArtifact,
  });
}
