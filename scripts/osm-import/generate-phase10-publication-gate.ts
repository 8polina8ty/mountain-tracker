import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildPublicationCandidateArtifact,
  buildPublicationCandidateManifest,
  renderPublicationReadinessReport,
} from "./phase10-publication-gate.ts";
import { loadPublicationGateInput } from "./phase10-live-data.ts";

const STAGING_DIRECTORY = resolve("data/osm/alps/staging");
const CANDIDATE_PATH = resolve(STAGING_DIRECTORY, "publication-candidates.json");
const CANDIDATE_MANIFEST_PATH = resolve(
  STAGING_DIRECTORY,
  "publication-candidate-manifest.json",
);
const REPORT_PATH = resolve("scripts/osm-import/PHASE10_PUBLICATION_GATE.md");

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const input = await loadPublicationGateInput();
  const computationStartedAt = performance.now();
  const artifact = buildPublicationCandidateArtifact(input);
  const candidateManifest = buildPublicationCandidateManifest(artifact);
  const candidateComputationMilliseconds = performance.now() - computationStartedAt;
  const artifactJson = `${JSON.stringify(artifact, null, 2)}\n`;
  const candidateManifestJson = `${JSON.stringify(candidateManifest, null, 2)}\n`;
  const report = renderPublicationReadinessReport(artifact);
  const artifactStartedAt = performance.now();
  await Promise.all([
    writeAtomically(CANDIDATE_PATH, artifactJson),
    writeAtomically(CANDIDATE_MANIFEST_PATH, candidateManifestJson),
    writeAtomically(REPORT_PATH, report),
  ]);
  const artifactGenerationMilliseconds = performance.now() - artifactStartedAt;

  process.stdout.write(`${JSON.stringify({
    artifactPath: CANDIDATE_PATH,
    candidateManifestPath: CANDIDATE_MANIFEST_PATH,
    reportPath: REPORT_PATH,
    totalStagingRoutes: artifact.totalReviewedRoutes,
    qaProgress: artifact.qaProgress,
    candidateCount: artifact.candidateCount,
    blockedCandidateCount: artifact.blockedCandidateCount,
    integrity: artifact.integrity,
    qaHistoryIntegrity: artifact.qaHistoryIntegrity,
    deterministicContentHash: artifact.deterministicContentHash,
    candidateManifestHash: candidateManifest.overallDeterministicManifestHash,
    performance: {
      candidateComputationMilliseconds: Math.round(candidateComputationMilliseconds * 10) / 10,
      artifactGenerationMilliseconds: Math.round(artifactGenerationMilliseconds * 10) / 10,
      candidatePayloadBytes: Buffer.byteLength(artifactJson, "utf8"),
      candidateManifestBytes: Buffer.byteLength(candidateManifestJson, "utf8"),
    },
    databaseWrites: 0,
    publicationWrites: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
