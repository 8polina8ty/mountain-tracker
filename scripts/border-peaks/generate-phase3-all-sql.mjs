#!/usr/bin/env node
/**
 * Offline Phase 3 review SQL generator.
 * Produces TEMP staging-table SQL only. No production membership writes.
 * Usage: node scripts/border-peaks/generate-phase3-all-sql.mjs [input.jsonl] [output.sql]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";

const input = resolve(process.argv[2] ?? "data/border-peaks/phase3/all-review.jsonl");
const output = resolve(process.argv[3] ?? "data/border-peaks/phase3/phase3_all_2477_review.sql");
const raw = readFileSync(input, "utf8");
const records = raw.trim().split(/\r?\n/).filter(Boolean);
const rows = records.map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`Invalid JSON on line ${index + 1}`); }
});
if (rows.length !== 2477) throw new Error(`Expected 2477 candidates, found ${rows.length}`);

const hashes = new Set();
const pairs = new Set();
let geometric = 0;
let thirdSource = 0;
const sqlQuote = (value) => value == null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
for (const [i, row] of rows.entries()) {
  if (!/^[a-f0-9]{64}$/.test(row.candidate_hash ?? "") || hashes.has(row.candidate_hash)) {
    throw new Error(`Invalid/duplicate candidate hash at row ${i + 1}`);
  }
  hashes.add(row.candidate_hash);
  if (!Number.isSafeInteger(row.mountain_id) || row.mountain_id <= 0 ||
    !/^[A-Z]{2}$/.test(row.primary_country_code ?? "") ||
    !/^[A-Z]{2}$/.test(row.candidate_country_code ?? "") ||
    row.primary_country_code === row.candidate_country_code) {
    throw new Error(`Invalid mountain/country identity at row ${i + 1}`);
  }
  const key = `${row.mountain_id}:${row.candidate_country_code}`;
  if (pairs.has(key)) throw new Error(`Duplicate membership candidate ${key}`);
  pairs.add(key);
  if (!Number.isFinite(row.latitude) || Math.abs(row.latitude) > 90 ||
      !Number.isFinite(row.longitude) || Math.abs(row.longitude) > 180 ||
      (row.height != null && !Number.isFinite(row.height))) {
    throw new Error(`Invalid coordinates/elevation at row ${i + 1}`);
  }
  if (row.decision !== null || row.reviewed_by !== null || row.reviewed_at !== null) {
    throw new Error(`Expected undecided review input at row ${i + 1}`);
  }
  if (row.phase3_action === "INDEPENDENT_SOURCE_AND_HUMAN_REVIEW" &&
      ["VERIFIED", "GEOMETRIC_SUPPORT"].includes(row.latest_status)) geometric++;
  else if (row.phase3_action === "THIRD_SOURCE_INVESTIGATION" &&
      ["INSUFFICIENT", "CONFLICT"].includes(row.latest_status)) thirdSource++;
  else throw new Error(`Invalid status/action at row ${i + 1}`);
}
if (geometric !== 1812 || thirdSource !== 665) {
  throw new Error(`Unexpected status counts: ${geometric} / ${thirdSource}`);
}

const values = rows.map(row =>
  `(${row.mountain_id}, ${sqlQuote(row.mountain_name)}, ${row.latitude}, ${row.longitude}, ${row.height ?? "NULL"}, ${sqlQuote(row.primary_country_code)}, ${sqlQuote(row.candidate_country_code)}, ${sqlQuote(row.candidate_hash)}, ${sqlQuote(row.latest_status)}, ${sqlQuote(row.phase3_action)}, ${sqlQuote(row.phase2_batch_id)})`
).join(",\n");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sql = `-- REVIEW DATA ONLY: 2477 Phase 3 border candidates, not approved memberships.
-- Input SHA-256: ${digest(raw)}
-- No production table INSERT/UPDATE/DELETE. Run only in a review session.
BEGIN;
CREATE TEMP TABLE phase3_border_peak_review (
  mountain_id bigint NOT NULL, mountain_name text,
  latitude double precision NOT NULL, longitude double precision NOT NULL,
  height numeric, primary_country_code text NOT NULL,
  candidate_country_code text NOT NULL, candidate_hash text PRIMARY KEY,
  latest_status text NOT NULL, phase3_action text NOT NULL,
  phase2_batch_id text NOT NULL,
  UNIQUE (mountain_id, candidate_country_code)
) ON COMMIT PRESERVE ROWS;
INSERT INTO phase3_border_peak_review
(mountain_id, mountain_name, latitude, longitude, height, primary_country_code,
 candidate_country_code, candidate_hash, latest_status, phase3_action, phase2_batch_id)
VALUES
${values};
DO $guard$ BEGIN
  IF (SELECT count(*) FROM phase3_border_peak_review) <> 2477
    OR (SELECT count(*) FROM phase3_border_peak_review WHERE latest_status IN ('VERIFIED','GEOMETRIC_SUPPORT')) <> 1812
    OR (SELECT count(*) FROM phase3_border_peak_review WHERE latest_status IN ('INSUFFICIENT','CONFLICT')) <> 665
  THEN RAISE EXCEPTION 'Phase 3 review staging count mismatch'; END IF;
END $guard$;
COMMIT;
SELECT latest_status, count(*) FROM phase3_border_peak_review GROUP BY latest_status ORDER BY latest_status;
-- TEMP table is session-local. No public.mountain_countries changes.
`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, sql, "utf8");
process.stdout.write(JSON.stringify({
  output, candidates: rows.length, geometric, needs_third_source: thirdSource,
  input_sha256: digest(raw), sql_sha256: digest(sql),
  production_written: false
}, null, 2) + "\n");
