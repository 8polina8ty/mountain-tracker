import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SQL_FILES = [
  "gpx_source_registry.sql",
  "gpx_import_runs.sql",
  "gpx_source_tracks.sql",
  "gpx_track_mountain_associations.sql",
  "gpx_route_clusters.sql",
  "gpx_import_qa.sql",
] as const;

async function readSql(name: (typeof SQL_FILES)[number]): Promise<string> {
  return readFile(new URL(`../../database/${name}`, import.meta.url), "utf8");
}

function executableSql(source: string): string {
  return source.replace(/--.*$/gm, "");
}

test("all Phase 12 SQL files are explicit manual-deployment artifacts", async () => {
  for (const name of SQL_FILES) {
    const source = await readSql(name);
    assert.match(source, /REVIEWED MANUAL-DEPLOYMENT ARTIFACT/);
    assert.match(source, /enable row level security/);
    assert.match(source, /revoke all/);
  }
});

test("Phase 12A SQL contains no data or publication writes", async () => {
  const source = executableSql(
    (await Promise.all(SQL_FILES.map(readSql))).join("\n"),
  );
  assert.doesNotMatch(source, /\binsert\s+into\b/i);
  assert.doesNotMatch(source, /\b(update|delete)\s+(public\.)?mountain_routes\b/i);
  assert.doesNotMatch(source, /\bmountain_community_routes\b/i);
  assert.doesNotMatch(source, /\bgps_activities\b/i);
});

test("source registry includes every fail-closed rights dimension", async () => {
  const source = await readSql("gpx_source_registry.sql");
  for (const field of [
    "source_key",
    "source_name",
    "homepage_url",
    "geographic_scope",
    "access_method",
    "license_status",
    "redistribution_permission_status",
    "attribution_required",
    "source_url_retention_permission",
    "raw_gpx_retention_permission",
    "normalized_geometry_publication_permission",
    "last_verified_at",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /'ALLOWED','REVIEW_REQUIRED','BLOCKED'/);
});

test("source tracks retain independent exact and reversed identities", async () => {
  const source = await readSql("gpx_source_tracks.sql");
  assert.match(source, /raw_content_hash/);
  assert.match(source, /normalized_geometry_hash/);
  assert.match(source, /direction_neutral_geometry_hash/);
  assert.match(source, /source_native_id/);
  assert.match(source, /publication_status/);
  assert.doesNotMatch(executableSql(source), /\buser_id\b/);
});

test("Phase 12 plan contains 12A through 12N and stops before unauthorized 12F", async () => {
  const plan = await readFile(new URL("../../PHASE_12_PLAN.md", import.meta.url), "utf8");
  for (const suffix of "ABCDEFGHIJKLMN") {
    assert.match(plan, new RegExp(`\\*\\*12${suffix} `));
  }
  assert.match(plan, /Phase 12F must not begin automatically/);
  assert.match(plan, /Discovery signals and independent OSM reconstruction/);
  assert.match(plan, /proprietary route geometry is not an authorized geometry/i);
  assert.match(plan, /COMPLETE LOCALLY; FINITE VALIDATION PASSED/);
});
