import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ClassifiableRoute } from "./route-classifier.ts";
import {
  buildCombinedScaleReadiness,
  createPhase11C3LockedBatchManifest,
  PHASE11C3_COMBINED_READINESS_PATH,
  PHASE11C3_V2_MANIFEST_PATH,
  PHASE11C3_TARGET_BATCH_SIZE,
} from "./phase11c3-combined-readiness.ts";
import { loadPhase11c4PublicationGateInput } from "./phase11c4-live-data.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
} from "./phase10-publication-gate.ts";

async function loadEnvironment(content: string): Promise<void> {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function loadRoutes(): Promise<Map<string, ClassifiableRoute>> {
  const routeText = await readFile("data/osm/alps/routes.jsonl", "utf8");
  const routes = new Map(routeText.trim().split(/\r?\n/).map((line) => {
    const route = JSON.parse(line) as ClassifiableRoute;
    return [route.sourceId, route] as const;
  }));
  return routes;
}

async function loadActiveRows(): Promise<Array<{ canonical_relation_id: string; publication_contract_version: string; publication_idempotency_key: string }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase credentials");
  const response = await fetch(`${url}/rest/v1/osm_route_publication_provenance?select=canonical_relation_id,publication_contract_version,publication_idempotency_key&publication_status=eq.ACTIVE&order=mountain_route_id.asc`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Active rows query failed: ${response.status}`);
  return response.json() as Promise<Array<{ canonical_relation_id: string; publication_contract_version: string; publication_idempotency_key: string }>>;
}

async function main(): Promise<void> {
  await loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Read-only combined scale readiness requires Supabase credentials.");

  const readiness = await buildCombinedScaleReadiness();

  await writeFile(PHASE11C3_COMBINED_READINESS_PATH, JSON.stringify(readiness, null, 2), "utf8");

  console.log(JSON.stringify({
    readinessPath: PHASE11C3_COMBINED_READINESS_PATH,
    deterministicReadinessHash: readiness.deterministicReadinessHash,
    historicalReviewed: readiness.historicalReviewed,
    phase11c4: readiness.phase11c4,
    combinedReviewed: readiness.combinedReviewed,
    combinedVisuallyApproved: readiness.combinedVisuallyApproved,
    candidatePool: readiness.candidatePool,
    qaExpansionQueueSize: readiness.qaExpansionQueue.length,
    databaseWrites: 0,
  }, null, 2));

  if (readiness.candidatePool.eligibleNonActive >= PHASE11C3_TARGET_BATCH_SIZE) {
    console.log("\n=== Generating 100-route manifest ===");
    const [historicalInput, phase11c4Input, routes, activeRows] = await Promise.all([
      loadPublicationGateInput(),
      loadPhase11c4PublicationGateInput(),
      loadRoutes(),
      loadActiveRows(),
    ]);

    const historicalArtifact = buildPublicationCandidateArtifact(historicalInput, { expectedRecordCount: 46 });
    const phase11c4Artifact = buildPublicationCandidateArtifact(phase11c4Input, { expectedRecordCount: 150 });

    const combinedArtifact = {
      ...historicalArtifact,
      candidates: [...historicalArtifact.candidates, ...phase11c4Artifact.candidates],
      candidateCount: historicalArtifact.candidateCount + phase11c4Artifact.candidateCount,
      totalReviewedRoutes: historicalArtifact.totalReviewedRoutes + phase11c4Artifact.totalReviewedRoutes,
      qaProgress: {
        total: historicalArtifact.qaProgress.total + phase11c4Artifact.qaProgress.total,
        decided: historicalArtifact.qaProgress.decided + phase11c4Artifact.qaProgress.decided,
        pending: historicalArtifact.qaProgress.pending + phase11c4Artifact.qaProgress.pending,
        visuallyApproved: historicalArtifact.qaProgress.visuallyApproved + phase11c4Artifact.qaProgress.visuallyApproved,
        needsReview: historicalArtifact.qaProgress.needsReview + phase11c4Artifact.qaProgress.needsReview,
        rejected: historicalArtifact.qaProgress.rejected + phase11c4Artifact.qaProgress.rejected,
        warnings: historicalArtifact.qaProgress.warnings + phase11c4Artifact.qaProgress.warnings,
        warningsPending: historicalArtifact.qaProgress.warningsPending + phase11c4Artifact.qaProgress.warningsPending,
      },
      blockedCandidateCount: historicalArtifact.blockedCandidateCount + phase11c4Artifact.blockedCandidateCount,
      blockedCountsByReason: {
        PENDING: historicalArtifact.blockedCountsByReason.PENDING + phase11c4Artifact.blockedCountsByReason.PENDING,
        NEEDS_REVIEW: historicalArtifact.blockedCountsByReason.NEEDS_REVIEW + phase11c4Artifact.blockedCountsByReason.NEEDS_REVIEW,
        REJECTED: historicalArtifact.blockedCountsByReason.REJECTED + phase11c4Artifact.blockedCountsByReason.REJECTED,
      },
    };

    const combinedManifest = buildPublicationCandidateManifest(combinedArtifact);

    const activeRelationIds = new Set(activeRows.map(r => r.canonical_relation_id));
    const { manifest, poolSize } = createPhase11C3LockedBatchManifest({
      artifact: combinedArtifact,
      candidateManifest: combinedManifest,
      qaHistory: [...historicalInput.qaHistory, ...phase11c4Input.qaHistory],
      routes,
      activeRelationIds,
      targetBatchSize: PHASE11C3_TARGET_BATCH_SIZE,
      baselineSnapshot: readiness.baselineSnapshot,
    });

    await writeFile(PHASE11C3_V2_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

    console.log(JSON.stringify({
      manifestPath: PHASE11C3_V2_MANIFEST_PATH,
      manifestHash: manifest.deterministicV2ManifestHash,
      poolSize,
      baselineActive: readiness.baselineSnapshot.baselineActiveCount,
      selectedCount: manifest.records.length,
      relationIds: manifest.records.map(r => r.canonicalRouteSourceId),
      routeTypeDistribution: manifest.records.reduce((acc, r) => {
        acc[r.routeType] = (acc[r.routeType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    }, null, 2));

    console.log("\n=== DRY-RUN PREFLIGHT ===");
    console.log("Would run publisher in read-only mode to verify:");
    console.log("- baseline ACTIVE = 18");
    console.log("- attempted = 100");
    console.log("- WOULD_CREATE = 100");
    console.log("- RESUME_MATCH = 0");
    console.log("- BLOCKED = 0");
    console.log("- RPC calls = 0");
    console.log("- DB writes = 0");
    console.log("- publication writes = 0");
  } else {
    console.log(`\n=== INSUFFICIENT ELIGIBLE CANDIDATES ===`);
    console.log(`Eligible non-active: ${readiness.candidatePool.eligibleNonActive}`);
    console.log(`Target: ${PHASE11C3_TARGET_BATCH_SIZE}`);
    console.log(`Additional approvals needed: ${readiness.candidatePool.additionalApprovalsNeededForTarget}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});