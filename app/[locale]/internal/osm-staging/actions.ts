"use server";

import { revalidatePath } from "next/cache";

import { requireOsmStagingPreviewAccess } from "@/Lib/osmStagingPreview/access";
import {
  executeQaDecisionMutation,
  type QaMutationResult,
  type QaMutationTarget,
  type QaMutationWriteInput,
} from "@/Lib/osmStagingPreview/mutation-core";
import { parsePreviewQueueId } from "@/Lib/osmStagingPreview/queue-core";
import {
  loadApprovedStagingRouteDetail,
  loadValidatedQaMutationTarget,
} from "@/Lib/osmStagingPreview/server";
import { createAdminClient } from "@/Lib/supabase/admin";
import { computeAutoQaRecommendation } from "@/Lib/osmStagingPreview/auto-qa";
import { classifyRouteActivity } from "@/scripts/osm-import/route-activity-classifier.ts";
import type { ClassifiableRoute } from "@/scripts/osm-import/route-classifier.ts";
import type { PreviewQaDecisionInput } from "@/Lib/osmStagingPreview/core";

interface QaRpcRow {
  status: string;
  reviewer_note: string | null;
  reviewed_at: string | null;
  version: number | null;
  changed: boolean;
}

export type SaveQaDecisionResult =
  | ({ ok: true } & QaMutationResult)
  | { ok: false; code: "CONFLICT" | "VALIDATION_FAILED"; message: string };

export type AutoQaRecommendationResult = {
  recommendation: "GREEN" | "YELLOW" | "RED";
  score: number;
  reasonCodes: string[];
  explanation: string;
};

async function validateTarget(input: PreviewQaDecisionInput): Promise<QaMutationTarget> {
  const { listItem, manifestRecord } = await loadValidatedQaMutationTarget(
    input.stagingRouteId,
    parsePreviewQueueId(input.queueId ?? undefined),
  );
  return {
    stagingRouteId: listItem.stagingRouteId,
    contractVersion: "mountain-tracker-osm-route/v1",
    importEligibility: "AUTO_IMPORT_READY",
    metadata: listItem,
    manifest: manifestRecord,
  };
}

async function writeDecision(input: QaMutationWriteInput): Promise<QaMutationResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("record_osm_staging_visual_qa_decision", {
    p_staging_route_id: input.stagingRouteId,
    p_status: input.status,
    p_reviewer_note: input.reviewerNote,
    p_reviewer_user_id: input.reviewerUserId,
    p_expected_version: input.expectedVersion,
    p_expected_contract_version: input.target.contractVersion,
    p_expected_idempotency_key: input.target.manifest.idempotencyKey,
    p_expected_payload_hash: input.target.manifest.payloadHash,
    p_expected_source_relation_id: input.target.manifest.sourceRelationId,
    p_expected_canonical_source_id: input.target.manifest.canonicalRouteSourceId,
    p_expected_peak_osm_id: input.target.metadata.summit.peakOsmId,
    p_expected_mountain_id: input.target.metadata.summit.mountainId,
    p_expected_summit_count: input.target.manifest.expectedSummitAssociationCount,
  });
  if (error) {
    if (error.code === "40001" || /QA_DECISION_CONFLICT/.test(error.message)) {
      throw new Error("QA_DECISION_CONFLICT");
    }
    throw new Error(`QA decision write failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as QaRpcRow | null;
  if (!row) throw new Error("QA decision write returned no result.");
  const status = String(row.status);
  if (!["PENDING", "VISUALLY_APPROVED", "NEEDS_REVIEW", "REJECTED"].includes(status)) {
    throw new Error("QA decision write returned an invalid status.");
  }
  return {
    status: status as QaMutationResult["status"],
    reviewerNote: row.reviewer_note,
    reviewedAt: row.reviewed_at,
    version: row.version === null ? null : Number(row.version),
    changed: Boolean(row.changed),
  };
}

export async function saveOsmStagingQaDecision(rawInput: unknown): Promise<SaveQaDecisionResult> {
  const access = await requireOsmStagingPreviewAccess();
  try {
    const result = await executeQaDecisionMutation(rawInput, {
      authorize: async () => access,
      validateTarget,
      writeDecision,
    });
    revalidatePath("/[locale]/internal/osm-staging", "page");
    revalidatePath("/[locale]/internal/osm-staging/[stagingRouteId]", "page");
    return { ok: true, ...result };
  } catch (error) {
    const conflict = error instanceof Error && error.message.includes("QA_DECISION_CONFLICT");
    return {
      ok: false,
      code: conflict ? "CONFLICT" : "VALIDATION_FAILED",
      message: conflict
        ? "This decision changed in another review session. Reload before saving again."
        : "The QA decision failed closed because its input or reviewed staging evidence was invalid.",
    };
  }
}

export async function getAutoQaRecommendation(
  stagingRouteId: string,
  rawQueueId: string | null = null,
): Promise<AutoQaRecommendationResult> {
  await requireOsmStagingPreviewAccess();
  const queueId = parsePreviewQueueId(rawQueueId ?? undefined);
  const { detail } = await loadApprovedStagingRouteDetail(stagingRouteId, queueId);
  const activityInput: ClassifiableRoute = {
    sourceId: detail.sourceRelationId,
    sourceUrl: `https://www.openstreetmap.org/relation/${detail.sourceRelationId}`,
    name: detail.routeName,
    ref: null,
    network: null,
    operator: null,
    geometry: detail.geometry,
    stats: {
      distanceMeters: detail.distanceMeters,
      coordinatePoints: detail.diagnostics.geometryPointCount,
      componentCount: detail.componentCount,
    },
    metadata: {
      route: detail.semanticType === "summit_route" ? "hiking" : "",
      from: null,
      to: null,
      roundtrip: null,
      osmcSymbol: null,
      tags: {},
    },
  };
  return computeAutoQaRecommendation(detail, classifyRouteActivity(activityInput));
}
