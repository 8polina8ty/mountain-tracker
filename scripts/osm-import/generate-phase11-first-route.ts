import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  stableJson,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";
import { createFirstRouteManifest } from "./phase11-publication.ts";

const stagingDirectory = resolve("data/osm/alps/staging");
const publicationDirectory = resolve("data/osm/alps/publication");
const [storedArtifact, storedManifest, liveInput] = await Promise.all([
  readFile(resolve(stagingDirectory, "publication-candidates.json"), "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile(
    resolve(stagingDirectory, "publication-candidate-manifest.json"),
    "utf8",
  ).then((value) => JSON.parse(value) as PublicationCandidateManifest),
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
const first = createFirstRouteManifest({
  artifact: liveArtifact,
  manifest: liveManifest,
  qaHistory: liveInput.qaHistory,
});
await mkdir(publicationDirectory, { recursive: true });
await writeFile(
  resolve(publicationDirectory, "phase11-first-route.json"),
  `${JSON.stringify(first, null, 2)}\n`,
  "utf8",
);
console.log(stableJson({
  selectedRelationId: first.canonicalRelationId,
  mountainId: first.mountainId,
  deterministicManifestHash: first.deterministicManifestHash,
  databaseWrites: 0,
  publicationWrites: 0,
}));
