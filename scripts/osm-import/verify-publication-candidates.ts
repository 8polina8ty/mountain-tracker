import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  verifyPublicationCandidateDocuments,
  type PublicationCandidateArtifact,
  type PublicationCandidateManifest,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");

async function main(): Promise<void> {
  const [expectedArtifact, expectedManifest, liveInput] = await Promise.all([
    readFile(resolve(STAGING_DIRECTORY, "publication-candidates.json"), "utf8").then(
      (value) => JSON.parse(value) as PublicationCandidateArtifact,
    ),
    readFile(
      resolve(STAGING_DIRECTORY, "publication-candidate-manifest.json"),
      "utf8",
    ).then((value) => JSON.parse(value) as PublicationCandidateManifest),
    loadPublicationGateInput(),
  ]);
  const liveArtifact = buildPublicationCandidateArtifact(liveInput);
  const liveManifest = buildPublicationCandidateManifest(liveArtifact);
  process.stdout.write(
    `${JSON.stringify(
      verifyPublicationCandidateDocuments({
        expectedArtifact,
        expectedManifest,
        liveArtifact,
        liveManifest,
      }),
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
