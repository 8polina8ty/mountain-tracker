import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { GPX_IMPORT_MAX_FILE_BYTES, validateGpxImportFile } from "../Lib/tracks/importGpxActivity.ts";
import { GPX_MAX_TRACK_POINTS, isValidGpxCoordinate } from "../Lib/tracks/parseGpxFile.ts";

const importerSource = await readFile(new URL("../Lib/tracks/importGpxActivity.ts", import.meta.url), "utf8");
const parserSource = await readFile(new URL("../Lib/tracks/parseGpxFile.ts", import.meta.url), "utf8");
const evidenceUi = await readFile(new URL("../components/projects/ProjectDayTrackEvidence.tsx", import.meta.url), "utf8");
const projectPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");
const mutationSource = await readFile(new URL("../Lib/projects/mutations.ts", import.meta.url), "utf8");

assert.equal(GPX_IMPORT_MAX_FILE_BYTES, 25 * 1024 * 1024, "GPS A: GPX import file ceiling changed unexpectedly.");
assert.equal(validateGpxImportFile({ name: "track.gpx", size: 1024 }), true, "GPS B: valid GPX rejected.");
assert.equal(validateGpxImportFile({ name: "TRACK.GPX", size: 1024 }), true, "GPS B: case-insensitive GPX extension rejected.");
assert.equal(validateGpxImportFile({ name: "track.gpx", size: 0 }), false, "GPS C: empty GPX accepted.");
assert.equal(validateGpxImportFile({ name: "track.gpx", size: GPX_IMPORT_MAX_FILE_BYTES + 1 }), false, "GPS C: oversized GPX accepted.");
assert.equal(validateGpxImportFile({ name: "track.xml", size: 1024 }), false, "GPS C: non-GPX extension accepted.");
assert.equal(validateGpxImportFile({ name: `${"x".repeat(252)}.gpx`, size: 1024 }), false, "GPS C: oversized filename accepted.");

assert.equal(GPX_MAX_TRACK_POINTS, 250_000, "GPS D: point ceiling changed unexpectedly.");
for (const [latitude, longitude] of [[0, 0], [90, 180], [-90, -180], [47.4, 10.9]]) {
  assert.equal(isValidGpxCoordinate(latitude, longitude), true, `GPS E: valid coordinate rejected: ${latitude},${longitude}`);
}
for (const [latitude, longitude] of [[90.0001, 0], [-90.0001, 0], [0, 180.0001], [0, -180.0001], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY]]) {
  assert.equal(isValidGpxCoordinate(latitude, longitude), false, `GPS F: invalid coordinate accepted: ${latitude},${longitude}`);
}

assert.ok(importerSource.indexOf("if (!validateGpxImportFile(file))") < importerSource.indexOf('.from("gps_activities").insert'), "GPS G: validation must happen before persistent activity creation.");
assert.ok(parserSource.includes("trackPointElements.length > GPX_MAX_TRACK_POINTS"), "GPS H: parser point ceiling is not enforced.");
assert.ok(parserSource.includes("latitudeAttribute === null || longitudeAttribute === null"), "GPS I: missing coordinates are not rejected.");
assert.ok(parserSource.includes("!isValidGpxCoordinate(latitude, longitude)"), "GPS I: coordinate ranges are not validated.");
assert.equal(parserSource.includes("Math.min(...elevations)"), false, "GPS J: parser retains unbounded elevation spread.");
assert.equal(parserSource.includes("Math.max(...elevations)"), false, "GPS J: parser retains unbounded elevation spread.");

const storageFailureGuard = importerSource.indexOf("if (error && !isStorageMissingError(error)) return false;");
const activityCleanup = importerSource.indexOf('.from("gps_activities").delete()');
assert.ok(storageFailureGuard >= 0 && storageFailureGuard < activityCleanup, "GPS K: failed Storage cleanup must preserve the activity row for recovery.");
assert.ok(importerSource.includes("isStorageMissingError"), "GPS L: already-missing Storage objects must be cleanup-safe.");
assert.ok(importerSource.includes('reason: "cleanup-required"'), "GPS M: incomplete compensation must remain explicit.");

assert.ok(evidenceUi.includes("setImportedActivityId(result.gpsActivityId)"), "GPS N: successful import must retain the canonical activity before linking.");
assert.ok(evidenceUi.includes("retryImportedLink") && evidenceUi.includes("linkImportedTrack(importedActivityId)"), "GPS O: failed project linking must be retryable without re-import.");
assert.equal((evidenceUi.match(/await importGpxActivity\(/g) ?? []).length, 1, "GPS O: retry path must not duplicate GPX import.");
assert.ok(projectPage.includes('.from("activity-tracks").createSignedUrls') && projectPage.includes("60 * 60"), "GPS P: linked GeoJSON must retain private one-hour signed delivery.");
assert.ok(mutationSource.includes('rpc("unlink_expedition_project_day_track"') && !mutationSource.includes('.from("gps_activities").delete()'), "GPS Q: project unlink must not delete the canonical account activity.");

console.log("GPS evidence hardening contracts passed.");
