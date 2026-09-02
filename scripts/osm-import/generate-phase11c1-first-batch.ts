import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import {
  createPhase11C1BatchManifest,
  FIRST_PUBLISHED_RELATION_ID,
  PHASE11C1_BATCH_MANIFEST_NAME,
  PHASE11C1_SEMANTIC_RISK_RELATION_IDS,
} from "./phase11-batch.ts";
import { loadPhase11PublicationEnvironment } from "./phase11-live-data.ts";
import {
  createProvenancePayload,
  publicationIdentityMatches,
} from "./phase11-publication.ts";

const stagingDirectory = resolve("data/osm/alps/staging");
const publicationDirectory = resolve("data/osm/alps/publication");
const [storedArtifact, storedManifest, liveInput] = await Promise.all([
  readFile(resolve(stagingDirectory, "publication-candidates.json"), "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile(resolve(stagingDirectory, "publication-candidate-manifest.json"), "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  loadPublicationGateInput(),
]);
const liveArtifact = buildPublicationCandidateArtifact(liveInput);
const liveManifest = buildPublicationCandidateManifest(liveArtifact);
verifyPublicationCandidateDocuments({
  expectedArtifact: storedArtifact,
  expectedManifest: storedManifest,
  liveArtifact,
  liveManifest,
});
const environment = await loadPhase11PublicationEnvironment({
  mountainIds: liveArtifact.candidates.map((candidate) => candidate.summit.mountainId),
});
if (!environment.provenanceSchemaAvailable) {
  throw new Error("PHASE11C1_PROVENANCE_SCHEMA_UNAVAILABLE");
}
const firstPublished = liveArtifact.candidates.find(
  (candidate) => candidate.canonicalRouteSourceId === FIRST_PUBLISHED_RELATION_ID,
);
if (!firstPublished) throw new Error("PHASE11C1_ACTIVE_RELATION_196164_NOT_IN_CANDIDATES");
const firstPublishedProvenance = createProvenancePayload({
  artifact: liveArtifact,
  manifest: liveManifest,
  candidate: firstPublished,
  qaHistory: liveInput.qaHistory,
});
const firstPublishedIdentity = environment.existingPublications.get(
  firstPublishedProvenance.publication_idempotency_key,
);
if (
  !firstPublishedIdentity ||
  !publicationIdentityMatches(firstPublishedIdentity, firstPublishedProvenance)
) {
  throw new Error("PHASE11C1_RELATION_196164_NOT_ACTIVE_AND_UNCHANGED");
}
const batchManifest = createPhase11C1BatchManifest({
  artifact: liveArtifact,
  manifest: liveManifest,
  qaHistory: liveInput.qaHistory,
  existingPublications: environment.existingPublications,
});
await mkdir(publicationDirectory, { recursive: true });
const outputPath = resolve(publicationDirectory, PHASE11C1_BATCH_MANIFEST_NAME);
await writeFile(outputPath, `${JSON.stringify(batchManifest, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: "PASS",
      outputPath,
      excludedActiveRelationId: FIRST_PUBLISHED_RELATION_ID,
      excludedSemanticRiskRelationIds: PHASE11C1_SEMANTIC_RISK_RELATION_IDS,
      selectedRelationIds: batchManifest.records.map((record) => record.sourceRelationId),
      deterministicBatchManifestHash: batchManifest.deterministicBatchManifestHash,
      rpcCalls: 0,
      databaseWrites: 0,
      publicationWrites: 0,
    },
    null,
    2,
  ),
);
