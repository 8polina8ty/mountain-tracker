/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { iterateJsonLines, readJsonLines } from "./jsonl.ts";

async function main() {
  // Load the 150-route queue
  const queueData = JSON.parse(await readFile(resolve("data/osm/alps/publication/phase11c4-new-qa-queue.json"), "utf8"));
  const queue = queueData.queue;
  
  console.log("Loading Phase 10 reviewed routes to exclude...");
  const phase10CandidatesPath = resolve("data/osm/alps/staging/publication-candidates.json");
  const phase10Candidates = JSON.parse(await readFile(phase10CandidatesPath, "utf8"));
  const reviewedCanonicalIds = new Set(phase10Candidates.candidates.map((c: any) => c.canonicalRouteSourceId));

  console.log("Loading existing ACTIVE production relations...");
  const activeRelations = new Set([
    "196164", "20916", "33528", "199145", "207900", "207913",
    "361148", "140270",
    "1877850", "2210870", "915266", "3973107", "2202791",
    "1796122", "2135331", "1165714", "961283", "2050305"
  ]);

  // Combine ACTIVE + reviewed for exclusion
  const excludedRelations = new Set([...activeRelations, ...reviewedCanonicalIds]);

  console.log("Loading route analyses for activity classification...");
  const routeBySourceId = new Map<string, any>();
  for await (const analysis of (await import("./jsonl.ts")).iterateJsonLines<any>(resolve("data/osm/alps/route-analysis.jsonl"))) {
    routeBySourceId.set(analysis.routeSourceId, analysis);
  }

  let green = 0, yellow = 0, red = 0;
  const recByRoute: Record<string, { recommendation: string; score: number; reasonCodes: string[] }> = {};

  const { computeAutoQaRecommendation } = await import("../../Lib/osmStagingPreview/auto-qa.ts");

  for (const record of queue) {
    const canonical = record.canonicalRouteSourceId;
    if (excludedRelations.has(canonical)) {
      continue;
    }

    // Build the full route object that computeAutoQaRecommendation expects
    const route = {
      idempotencyKey: record.stagingRouteId,
      sourceRelationId: record.sourceRelationId,
      canonicalRouteSourceId: record.canonicalRouteSourceId,
      routeName: record.routeName,
      semanticType: record.semanticType,
      qualityScore: record.quality,
      distanceMeters: 5000,
      componentCount: 1,
      auditFlags: record.auditFlags || [],
      warnings: record.warnings || [],
      countryCode: "UNKNOWN",
      countryName: "Unknown",
      admin1Code: null,
      admin1Name: null,
      administrationStatus: record.adminBoundaryStatus === "ASSIGNED" ? "ASSIGNED" : "UNASSIGNED",
      summit: {
        peakOsmId: record.summitPeakOsmId,
        peakName: record.summitName,
        peakElevationMeters: record.summitElevationMeters,
        peakCoordinates: [0, 0] as const,
        mountainId: record.mountainId,
        mountainName: record.summitName,
        mountainElevationMeters: record.summitElevationMeters,
        matchClassification: "EXACT_MOUNTAIN_MATCH" as const,
        finalAssociation: "CONFIRMED" as const,
        finalConfidence: 1,
        minimumGeometryDistanceMeters: 0,
        endpointDistanceMeters: 0,
      },
      diagnostics: {
        totalDistanceMeters: 5000,
        componentLengthsMeters: [5000],
        boundingBox: { minimumLongitude: 0, minimumLatitude: 0, maximumLongitude: 0, maximumLatitude: 0 },
        startCoordinate: [0, 0] as const,
        endCoordinate: [0, 0] as const,
        summitCoordinate: [0, 0] as const,
        endpointDistanceMeters: 0,
        startToSummitDistanceMeters: 0,
        straightLineDistanceMeters: 0,
        routeToStraightLineRatio: 1,
        routeToStraightLineStatus: "AVAILABLE" as const,
        topologyClassification: record.topology as any,
        connectedGroupCount: 1,
        physicalEndpointCount: 2,
        endpointOrientationReason: "CONFIRMED_SUMMIT_ENDPOINT" as const,
        endpointSelectionAmbiguous: false,
        endpointSelectionWarning: record.warnings && record.warnings.length > 0 ? record.warnings[0] : null,
        summitEndpointDistanceMeters: 0,
        geometryPointCount: 100,
      },
      qaStatus: "PENDING" as const,
      qaDecision: null,
      stagingRouteId: record.stagingRouteId,
      qaProgress: {
        total: 1,
        decided: 0,
        pending: 1,
        visuallyApproved: 0,
        needsReview: 0,
        rejected: 0,
        warnings: 0,
        warningsPending: 0,
      },
    } as const;

    // Create activity object from queue data
    const activity: {
      routeType: "hiking" | "via_ferrata" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other";
      confidence: number;
      manualReviewRequired: boolean;
      evidence: string[];
      conflictingTypes: ("via_ferrata" | "hiking" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other")[];
    } = {
      routeType: record.activityRouteType as "hiking" | "via_ferrata" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other",
      confidence: record.activityRouteType === "hiking" ? 0.95 : 0.9,
      manualReviewRequired: record.activityRouteType !== "hiking",
      evidence: [record.activityRouteType === "hiking" ? "Walking/hiking route or network evidence is present and no technical activity evidence conflicts with it." : `Explicit ${record.activityRouteType} evidence.`],
      conflictingTypes: [] as ("via_ferrata" | "hiking" | "mountaineering" | "climbing" | "ski_touring" | "mixed" | "other")[],
    };

    const { computeAutoQaRecommendation } = await import("../../Lib/osmStagingPreview/auto-qa.ts");
    const rec = computeAutoQaRecommendation(route as any, activity);
    recByRoute[record.canonicalRouteSourceId] = { recommendation: rec.recommendation, score: rec.score, reasonCodes: rec.reasonCodes };

    if (rec.recommendation === "GREEN") green++;
    else if (rec.recommendation === "YELLOW") yellow++;
    else red++;
  }

  console.log("\n=== GREEN/YELLOW/RED COUNTS FOR 150-ROUTE QUEUE ===");
  console.log(`GREEN: ${green}`);
  console.log(`YELLOW: ${yellow}`);
  console.log(`RED: ${red}`);
  console.log(`Total: ${green + yellow + red}`);

  // Show top GREEN routes
  const greenRoutes = Object.entries(recByRoute).filter(([, v]) => v.recommendation === "GREEN").sort((a, b) => b[1].score - a[1].score);
  console.log(`\nTop 10 GREEN routes (score):`);
  for (const [canonical, rec] of greenRoutes.slice(0, 10)) {
    console.log(`  ${canonical}: score=${rec.score} reasons=${rec.reasonCodes.join(", ")}`);
  }

  // Show YELLOW routes
  const yellowRoutes = Object.entries(recByRoute).filter(([, v]) => v.recommendation === "YELLOW").sort((a, b) => b[1].score - a[1].score);
  console.log(`\nYELLOW routes (${yellowRoutes.length}):`);
  for (const [canonical, rec] of yellowRoutes) {
    console.log(`  ${canonical}: score=${rec.score} reasons=${rec.reasonCodes.join(", ")}`);
  }

  // Show RED routes
  const redRoutes = Object.entries(recByRoute).filter(([, v]) => v.recommendation === "RED").sort((a, b) => b[1].score - a[1].score);
  console.log(`\nRED routes (${redRoutes.length}):`);
  for (const [canonical, rec] of redRoutes) {
    console.log(`  ${canonical}: score=${rec.score} reasons=${rec.reasonCodes.join(", ")}`);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
