import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";
import {
  buildPhase11C3ScaleReadiness,
  PHASE11C3_SCALE_READINESS_PATH,
  PHASE11C3_QA_EXPANSION_QUEUE_PATH,
} from "./phase11c3-scale-readiness.ts";

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

async function restGet(path: string): Promise<unknown> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing Supabase service key");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: { Accept: "application/json", apikey: key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`READ_ONLY_QUERY_FAILED:${response.status}:${path}`);
  return response.json();
}

async function main(): Promise<void> {
  loadEnvironment(await readFile(resolve(".env.local"), "utf8"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Read-only Phase 11 scale readiness requires Supabase credentials.");

  const [storedArtifact, storedCandidateManifest, routeText, liveInput, activeRows] = await Promise.all([
    readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
      (value) => JSON.parse(value) as PublicationCandidateArtifact,
    ),
    readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
      (value) => JSON.parse(value) as PublicationCandidateManifest,
    ),
    readFile("data/osm/alps/routes.jsonl", "utf8"),
    loadPublicationGateInput(),
    restGet(
      "osm_route_publication_provenance?select=canonical_relation_id,publication_contract_version,publication_status,publication_idempotency_key&publication_status=eq.ACTIVE&order=mountain_route_id.asc"
    ),
  ]);

  const liveArtifact = buildPublicationCandidateArtifact(liveInput);
  const liveCandidateManifest = buildPublicationCandidateManifest(liveArtifact);

  const routes = new Map(routeText.trim().split(/\r?\n/).map((line) => {
    const route = JSON.parse(line) as ClassifiableRoute;
    return [route.sourceId, route] as const;
  }));

  const activeRowsTyped = activeRows as Array<{ canonical_relation_id: string; publication_contract_version: string; publication_idempotency_key: string }>;

  const readiness = await buildPhase11C3ScaleReadiness({
    artifact: liveArtifact,
    candidateManifest: liveCandidateManifest,
    qaHistory: liveInput.qaHistory,
    routes,
    activeRows: activeRowsTyped,
  });

  const readinessOutput = `${JSON.stringify(readiness, null, 2)}\n`;
  await writeFile(PHASE11C3_SCALE_READINESS_PATH, readinessOutput, "utf8");

  const queueOutput = `${JSON.stringify(readiness.qaExpansionQueue, null, 2)}\n`;
  await writeFile(PHASE11C3_QA_EXPANSION_QUEUE_PATH, queueOutput, "utf8");

  console.log(JSON.stringify({
    readinessPath: PHASE11C3_SCALE_READINESS_PATH,
    queuePath: PHASE11C3_QA_EXPANSION_QUEUE_PATH,
    deterministicReadinessHash: readiness.deterministicReadinessHash,
    totalStagingRoutes: readiness.candidatePool.totalStagingRoutes,
    totalReviewedRoutes: readiness.candidatePool.totalReviewedRoutes,
    totalVisuallyApproved: readiness.candidatePool.totalVisuallyApproved,
    totalCandidates: readiness.candidatePool.totalCandidates,
    currentActive: readiness.candidatePool.currentActive,
    eligibleNonActive: readiness.candidatePool.eligibleNonActive,
    blockedCandidates: readiness.candidatePool.blockedCandidates,
    warningCandidates: readiness.candidatePool.warningCandidates,
    manualReviewRequired: readiness.candidatePool.manualReviewRequired,
    additionalApprovalsNeededForTarget: readiness.candidatePool.additionalApprovalsNeededForTarget,
    status: readiness.candidatePool.status,
    topologyDistribution: readiness.candidatePool.topologyDistribution,
    routeTypeDistribution: readiness.candidatePool.routeTypeDistribution,
    qaExpansionQueueSize: readiness.qaExpansionQueue.length,
    databaseWrites: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});