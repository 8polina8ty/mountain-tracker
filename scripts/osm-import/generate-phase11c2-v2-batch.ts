import { readFile, writeFile } from "node:fs/promises";

import type {
  PublicationCandidateArtifact,
  PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import {
  PHASE11C2_BASELINE_ACTIVE_RELATION_IDS,
  PHASE11C2_V2_MANIFEST_PATH,
  createPhase11C2V2BatchManifest,
} from "./phase11c2-v2-batch.ts";
import type { ClassifiableRoute } from "./route-classifier.ts";

if (process.argv.length !== 2) throw new Error("THIS_GENERATOR_ACCEPTS_NO_ARGUMENTS");

const [artifact, candidateManifest, routeText, qaHistorySource] = await Promise.all([
  readFile("data/osm/alps/staging/publication-candidates.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile("data/osm/alps/staging/publication-candidate-manifest.json", "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile("data/osm/alps/routes.jsonl", "utf8"),
  readFile("data/osm/alps/publication/phase11-dry-run.json", "utf8").then(
    (value) => JSON.parse(value) as { records: Array<{ provenancePayload: { qa_history_snapshot: unknown[] } }> },
  ),
]);
const routes = new Map(routeText.trim().split(/\r?\n/).map((line) => {
  const route = JSON.parse(line) as ClassifiableRoute;
  return [route.sourceId, route] as const;
}));
const qaHistory = qaHistorySource.records.flatMap(
  (record) => record.provenancePayload.qa_history_snapshot,
) as Parameters<typeof createPhase11C2V2BatchManifest>[0]["qaHistory"];
const uniqueQaHistory = [...new Map(qaHistory.map((event) => [event.id, event])).values()];
const manifest = createPhase11C2V2BatchManifest({
  artifact,
  candidateManifest,
  qaHistory: uniqueQaHistory,
  routes,
  activeRelationIds: new Set(PHASE11C2_BASELINE_ACTIVE_RELATION_IDS),
});
await writeFile(PHASE11C2_V2_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  path: PHASE11C2_V2_MANIFEST_PATH,
  relations: manifest.records.map((record) => record.canonicalRouteSourceId),
  deterministicV2ManifestHash: manifest.deterministicV2ManifestHash,
}, null, 2));
