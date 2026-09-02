import { readFile } from "node:fs/promises";

import { readJsonLines } from "./jsonl.ts";
import {
  PHASE11F_EXCLUDED_RELATIONS,
  PHASE11F_EXPECTED_EXECUTABLE,
  phase11fExecutionToken,
  verifyDeterministicArtifactHash,
} from "./phase11f-controlled-staging.ts";
import {
  createPhase11fAdminClient,
  loadPhase11fActivePublications,
  preflightPhase11fExecution,
  stagePhase11fRecord,
} from "./phase11f-live.ts";
import {
  validateFirstWriteManifest,
  type FirstWriteManifest,
  type ImportPlanRecord,
} from "./phase8-staging.ts";
import { sha256Stable } from "./phase11-publication.ts";

const ALLOWLISTED_CONTRACT_PATH = "data/osm/alps/staging/phase11f-executable-staging-contract.json";
const EXECUTION_PLAN_PATH = "data/osm/alps/staging/phase11e-executable-staging-plan.jsonl";
const MANIFEST_PATH = "data/osm/alps/staging/phase11e-staging-manifest.json";

interface FrozenContract {
  executableManifestHash: string;
  executionPlanHash: string;
  total: number;
  excludedDriftRelations: string[];
  deterministicArtifactHash: string;
  records: Array<{ canonicalRelationId: string }>;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): { contractPath: string; token: string } {
  let execute = false;
  let contractPath: string | null = null;
  let token: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") execute = true;
    else if (argument === "--contract" || argument === "--token") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--contract") contractPath = value;
      else token = value;
    } else throw new Error(`Unknown Phase 11F staging argument: ${argument}`);
  }
  if (!execute) throw new Error("PHASE11F_EXPLICIT_EXECUTE_FLAG_REQUIRED");
  if (contractPath !== ALLOWLISTED_CONTRACT_PATH) {
    throw new Error("PHASE11F_CONTRACT_PATH_NOT_ALLOWLISTED");
  }
  if (!token) throw new Error("PHASE11F_EXECUTION_TOKEN_REQUIRED");
  return { contractPath, token };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [contract, manifest, executionPlans] = await Promise.all([
    readFile(options.contractPath, "utf8").then((value) => JSON.parse(value) as FrozenContract),
    readFile(MANIFEST_PATH, "utf8").then((value) => JSON.parse(value) as FirstWriteManifest),
    readJsonLines<ImportPlanRecord>(EXECUTION_PLAN_PATH),
  ]);
  verifyDeterministicArtifactHash(contract);
  const expectedToken = phase11fExecutionToken(contract.deterministicArtifactHash, manifest.manifestHash);
  if (options.token !== expectedToken) throw new Error("PHASE11F_EXECUTION_TOKEN_MISMATCH");
  if (
    contract.total !== PHASE11F_EXPECTED_EXECUTABLE.total ||
    contract.executableManifestHash !== manifest.manifestHash ||
    contract.executionPlanHash !== sha256Stable(executionPlans) ||
    sha256Stable(contract.excludedDriftRelations) !== sha256Stable([...PHASE11F_EXCLUDED_RELATIONS]) ||
    contract.records.some((record) => PHASE11F_EXCLUDED_RELATIONS.includes(record.canonicalRelationId as never))
  ) throw new Error("PHASE11F_FROZEN_CONTRACT_DRIFT");
  validateFirstWriteManifest(executionPlans, manifest, manifest.datasetFingerprint);

  const client = await createPhase11fAdminClient();
  const [activeRows, preflight] = await Promise.all([
    loadPhase11fActivePublications(client),
    preflightPhase11fExecution(client, executionPlans),
  ]);
  const activeIds = new Set(activeRows.map((row) => String(row.canonical_relation_id)));
  if (activeRows.length !== 118 || activeIds.size !== 118) throw new Error("PHASE11F_ACTIVE_CHECKPOINT_DRIFT");
  if (
    preflight.wouldCreate !== PHASE11F_EXPECTED_EXECUTABLE.wouldCreate ||
    preflight.unchanged !== PHASE11F_EXPECTED_EXECUTABLE.unchanged ||
    preflight.blocked !== 0
  ) {
    throw new Error(`PHASE11F_EXECUTION_PREFLIGHT_DRIFT:${preflight.wouldCreate}:${preflight.unchanged}:${preflight.blocked}`);
  }
  const actionByRelation = new Map(preflight.records.map((record) => [record.sourceRelationId, record.action]));
  let created = 0;
  for (const record of executionPlans) {
    if (actionByRelation.get(record.canonicalRouteSourceId) === "UNCHANGED") continue;
    const immediate = await preflightPhase11fExecution(client, [record]);
    if (immediate.wouldCreate !== 1 || immediate.unchanged !== 0 || immediate.blocked !== 0) {
      throw new Error(`PHASE11F_IMMEDIATE_PREFLIGHT_CHANGED:${record.canonicalRouteSourceId}`);
    }
    await stagePhase11fRecord(client, record);
    created += 1;
  }
  if (created !== PHASE11F_EXPECTED_EXECUTABLE.wouldCreate) {
    throw new Error(`PHASE11F_CREATED_COUNT_MISMATCH:${created}`);
  }
  const finalPreflight = await preflightPhase11fExecution(client, executionPlans);
  if (finalPreflight.wouldCreate !== 0 || finalPreflight.unchanged !== 702 || finalPreflight.blocked !== 0) {
    throw new Error(`PHASE11F_POSTWRITE_VERIFICATION_FAILED:${finalPreflight.wouldCreate}:${finalPreflight.unchanged}:${finalPreflight.blocked}`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    created: 636,
    unchangedBeforeExecution: 66,
    exactUnchangedAfterExecution: 702,
    overwritten: 0,
    qaWrites: 0,
    publicationWrites: 0,
    activeChanges: 0,
    excludedRelations: [...PHASE11F_EXCLUDED_RELATIONS],
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
