import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface QueueRecord {
  sourceRelationId: string;
  canonicalRouteSourceId: string;
  routeName: string;
  mountainId: number | null;
  quality: number;
  topology: string;
  semanticType: string;
  activityRouteType: string;
  auditFlags: string[];
  warnings: string[];
  summitPeakOsmId: string;
  summitName: string;
  summitElevationMeters: number;
  adminBoundaryStatus: string;
  priorityScore: number;
}

async function main() {
  const queueData = JSON.parse(await readFile(resolve("data/osm/alps/publication/phase11c4-new-qa-queue.json"), "utf8"));
  const queue = queueData.queue as QueueRecord[];
  
  console.log("Queue length:", queue.length);
  console.log("First record keys:", Object.keys(queue[0]));
  console.log("First record:", JSON.stringify(queue[0], null, 2));
  console.log("\n--- Checking for non-empty warnings ---");
  const withWarnings = queue.filter(r => r.warnings && r.warnings.length > 0);
  console.log(`Routes with warnings: ${withWarnings.length}`);
  if (withWarnings.length > 0) {
    console.log("First with warnings:", JSON.stringify(withWarnings[0], null, 2));
  }
  
  console.log("\n--- Checking adminBoundaryStatus ---");
  const adminStatuses = new Map<string, number>();
  for (const r of queue) {
    const s = r.adminBoundaryStatus || "UNKNOWN";
    adminStatuses.set(s, (adminStatuses.get(s) || 0) + 1);
  }
  console.log("Admin boundary status distribution:", Object.fromEntries(adminStatuses));
  
  console.log("\n--- Checking auditFlags ---");
  const withAuditFlags = queue.filter(r => r.auditFlags && r.auditFlags.length > 0);
  console.log(`Routes with auditFlags: ${withAuditFlags.length}`);
  if (withAuditFlags.length > 0) {
    console.log("First with auditFlags:", JSON.stringify(withAuditFlags[0], null, 2));
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });