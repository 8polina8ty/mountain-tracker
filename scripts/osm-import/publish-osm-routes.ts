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
import { loadPhase11PublicationEnvironment } from "./phase11-live-data.ts";
import {
  createFirstRouteManifest,
  dryRunCandidate,
  sha256Stable,
  type Phase11FirstRouteManifest,
} from "./phase11-publication.ts";

function parseArguments(argv: string[]): { manifestPath: string } {
  if (!argv.includes("--dry-run")) {
    throw new Error("Phase 11 publisher requires --dry-run; write mode is not implemented.");
  }
  const manifestIndex = argv.indexOf("--manifest");
  if (manifestIndex < 0 || !argv[manifestIndex + 1]) {
    throw new Error("--manifest <path> is required.");
  }
  const forbidden = ["--write", "--publish", "--apply", "--execute"];
  if (forbidden.some((flag) => argv.includes(flag))) {
    throw new Error("Publication writes are not available in Phase 11 dry-run tooling.");
  }
  return { manifestPath: resolve(argv[manifestIndex + 1]) };
}

function verifyFirstManifest(
  provided: Phase11FirstRouteManifest,
  expected: Phase11FirstRouteManifest,
): void {
  const { deterministicManifestHash, ...content } = provided;
  if (sha256Stable(content) !== deterministicManifestHash) {
    throw new Error("FIRST_ROUTE_MANIFEST_HASH_DRIFT");
  }
  if (stableJson(provided) !== stableJson(expected)) {
    throw new Error("FIRST_ROUTE_MANIFEST_CONTENT_DRIFT");
  }
}

const { manifestPath } = parseArguments(process.argv.slice(2));
const publicationDirectory = resolve("data/osm/alps/publication");
const stagingDirectory = resolve("data/osm/alps/staging");
const [storedArtifact, storedManifest, requestedManifest, liveInput] = await Promise.all([
  readFile(resolve(stagingDirectory, "publication-candidates.json"), "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateArtifact,
  ),
  readFile(resolve(stagingDirectory, "publication-candidate-manifest.json"), "utf8").then(
    (value) => JSON.parse(value) as PublicationCandidateManifest,
  ),
  readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as
    | PublicationCandidateManifest
    | Phase11FirstRouteManifest),
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

let candidates = liveArtifact.candidates;
let reportName = "phase11-dry-run";
if (requestedManifest.artifactType === "PHASE11_FIRST_PUBLICATION_MANIFEST") {
  const expected = createFirstRouteManifest({
    artifact: liveArtifact,
    manifest: liveManifest,
    qaHistory: liveInput.qaHistory,
  });
  verifyFirstManifest(requestedManifest, expected);
  candidates = candidates.filter(
    (candidate) => candidate.stagingRouteId === requestedManifest.stagingRouteId,
  );
  reportName = "phase11-first-route-dry-run";
} else if (stableJson(requestedManifest) !== stableJson(liveManifest)) {
  throw new Error("CANDIDATE_MANIFEST_DRIFT");
}

const environment = await loadPhase11PublicationEnvironment({
  mountainIds: candidates.map((candidate) => candidate.summit.mountainId),
});
const records = candidates.map((candidate) =>
  dryRunCandidate({
    artifact: liveArtifact,
    manifest: liveManifest,
    candidate,
    qaHistory: liveInput.qaHistory,
    environment,
  }),
);
const topologyCounts = Object.fromEntries(
  [...new Set(candidates.map((candidate) => candidate.topology.classification))]
    .sort()
    .map((classification) => [
      classification,
      candidates.filter((candidate) => candidate.topology.classification === classification).length,
    ]),
);
const summary = {
  attempted: records.length,
  wouldCreate: records.filter((record) => record.action === "WOULD_CREATE").length,
  wouldSkipUnchanged: records.filter((record) => record.action === "WOULD_SKIP_UNCHANGED").length,
  blocked: records.filter((record) => record.action === "BLOCKED").length,
  warningCandidates: records.filter((record) =>
    record.warnings.some((warning) => warning !== "REVIEW_ONLY_PROVENANCE_SCHEMA_NOT_DEPLOYED"),
  ).length,
  topologyCounts,
  missingTargetFields: {
    start_location: records.length,
    difficulty_system: records.length,
    difficulty_value: records.length,
    elevation_gain_m: records.length,
    duration_minutes: records.length,
    description: records.length,
    best_season: records.length,
    equipment: records.length,
    gpx_url: records.length,
    created_by: records.length,
  },
  unsupportedMappings: 0,
  geometryBlockers: records.filter((record) =>
    record.blockers.some((blocker) => blocker.includes("GEOMETRY")),
  ).length,
  provenanceBlockers: records.filter((record) =>
    record.blockers.some((blocker) => blocker.includes("PUBLICATION")),
  ).length,
  provenanceSchemaAvailable: environment.provenanceSchemaAvailable,
  databaseWrites: 0,
  publicationWrites: 0,
};
const report = {
  schemaVersion: 1,
  artifactType: "PHASE11_PUBLICATION_DRY_RUN",
  publicationContractVersion: "mountain-tracker-osm-publication/v1",
  candidateSetContentHash: liveArtifact.deterministicContentHash,
  candidateManifestHash: liveManifest.overallDeterministicManifestHash,
  summary,
  records,
};
await mkdir(publicationDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(publicationDirectory, `${reportName}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(resolve(publicationDirectory, `${reportName}.jsonl`), `${records.map((record) => stableJson(record)).join("\n")}\n`, "utf8"),
]);
console.log(JSON.stringify(summary, null, 2));
if (summary.blocked > 0) process.exitCode = 2;
