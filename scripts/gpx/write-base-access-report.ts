/** Assemble a local review packet from the completed, offline canary replay. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { sha256Bytes } from '../../Lib/gpxIngestion/hashing.ts';

const root = 'data/gpx/base-access-start-v2';
interface Row {
  mountainId: number; name: string; summitElevation: number; status: string; resultHash: string;
  old: { name: string; kind: string; category: string; elevation: number | null; distanceMeters: number };
  new: { name: string; kind: string; elevation: number | null; distanceMeters: number; passesOldStart: boolean;
    sharedOldNodeCount: number; oldNodeCount: number; accessEvidence: { accessNetworkDistance: number; startNodeId: number } } | null;
}
const report = JSON.parse(await readFile(`${root}/comparison.json`, 'utf8')) as { rows: Row[]; productionWrites: number };
assert.equal(report.rows.length, 10); assert.equal(report.productionWrites, 0);
const metres = (n: number | null | undefined) => n == null ? 'unknown' : `${n} m`;
const km = (n: number) => (n / 1000).toFixed(2);
const escape = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const table: string[] = [], details: string[] = [];
for (const row of report.rows) {
  const r = JSON.parse(await readFile(`${root}/${row.mountainId}-evaluation.json`, 'utf8')) as AdaptiveStartDiscoveryResult;
  const c = r.candidates[0];
  const roads = [...new Set(c?.networkAccess?.approachWays.map(w => w.accessTags.name).filter(Boolean) ?? [])].sort();
  const label = roads.length ? `${roads.join(' / ')} public road transition` : c?.name ?? 'No accepted primary route';
  table.push(`| ${row.mountainId} ${escape(row.name)} | ${escape(row.old.name)} (${row.old.kind}; ${metres(row.old.elevation)}) | ${escape(label)}${c ? ` (OSM node ${c.accessEvidence!.startNodeId})` : ''} | ${metres(row.new?.elevation)} / ${row.summitElevation} m | ${km(row.old.distanceMeters)} → ${row.new ? km(row.new.distanceMeters) : '—'} | ${row.new ? String(row.new.passesOldStart) : '—'} |`);
  details.push(`### ${row.mountainId} — ${row.name}\n\n` +
    `Status: **${row.status}**. Old category: ${row.old.category}.\n\n` +
    (c ? `Candidate kind: ${c.kind}; role: ${c.startRole}; safety: ${c.safety}; summit attachment: ${r.summitAttachment?.tier} (${r.summitAttachment?.distanceMeters} m). ` +
      `Public road access distance: ${c.accessEvidence!.accessNetworkDistance} m. ` +
      `The new route shares ${row.new!.sharedOldNodeCount}/${row.new!.oldNodeCount} old route nodes; exact old start visited: ${row.new!.passesOldStart}.\n\n` :
      'No GPX is approved by V2. Review the recorded rejection evidence; do not publish a fallback.\n\n') +
    `![Old/new geometry](${row.mountainId}-comparison.png)\n\n` +
    `[Complete evaluation and evidence](${row.mountainId}-evaluation.json) · [Old/new GeoJSON](${row.mountainId}-comparison.geojson)` +
    (c ? ` · [Proposed GPX](${row.mountainId}.gpx)` : '') + '\n');
}
const files = ['next.config.ts', 'scripts/validate-runtime-contract.mjs', 'Lib/gpxIngestion/baseAccessStartPolicy.ts',
  'Lib/gpxIngestion/adaptiveStartDiscovery.ts', 'Lib/gpxIngestion/generatedRoutePublication.ts',
  'scripts/gpx/regenerate-base-access-canary.ts', 'scripts/gpx/generated-publication-execute.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async p => [p, sha256Bytes(await readFile(p))])));
await writeFile(`${root}/source-hashes.json`, JSON.stringify(hashes, null, 2) + '\n');
const accepted = report.rows.filter(r => r.new).length;
const longerApproaches = report.rows.filter(r => r.new && r.new.distanceMeters > 2 * r.old.distanceMeters).map(r => r.mountainId);
const text = `# Base access start policy V2 — canary review\n\n` +
  `**${accepted}/10 mountains have an accepted regenerated primary candidate; ${10 - accepted} need further investigation. Production writes: 0. No replacements published.**\n\n` +
  `The exact live canary IDs are preserved. Source: the immutable local canary manifest and frozen OSM extraction/cache. No external requests, SQL, Storage writes, route updates, or provenance changes were made.\n\n` +
  `## Image error\n\nWikimedia's imageinfo response can supply a thumb.wikimedia.org thumburl. Lib/wikimedia.ts passes that URL to the mountain page's next/image component. The existing allowlist covered upload.wikimedia.org only. next.config.ts now also permits exactly HTTPS thumb.wikimedia.org /wikipedia/commons/**; runtime validation requires this entry and forbids wildcard Wikimedia hosts.\n\n` +
  `## Policy and limits\n\nThe old gate accepted BASE_START or HUT_START semantics without proving public approach access. V2 requires useful semantics plus exact OSM public-road connectivity. Huts/refuges remain diagnostic secondary candidates and cannot become primary. Guideposts and network nodes qualify only at a proven road/trail boundary. Detached POIs without topology proof are rejected; no straight connectors are added.\n\n` +
  `Preferred kinds: road-access trailhead, parking, village/hamlet, transit, legal road end, verified approach boundary. Ranking combines actual network route length with a 750 m preference step per kind, so a remote named stop does not outrank the normal nearby public boundary. Radius is a bounded discovery tool, never access proof.\n\n` +
  `The public road witness must extend at least 250 m through connected road geometry and include a residential/living-street/unclassified/tertiary/secondary road. Service/track access additionally needs explicit vehicle/general public permission. Private, customers-only, conditional, foot=no, motorway and impassable access cannot supply the witness. Local approach paths are limited to 150 m (trailheads: 30 m; guideposts/network boundaries: 0 m), without alpine-rated links. Search is bounded at 5,000 visited nodes. The existing route safety and summit attachment gates remain required.\n\n` +
  `Evidence records candidate kind, role, public-road/settlement/parking/transit/trailhead/boundary flags, approach distance, exact approach and outward OSM node/way IDs, available start/summit elevations and reason codes. False context flags mean unproven, not proof of absence. Elevations use existing deterministic OSM context; unknown values stay null and no GPX elevation samples are invented.\n\n` +
  `These are evidence-backed candidates for visual review, not a claim that OSM proves the customary ascent or current road conditions. Discovery has finite candidate/window limits. Parking polygons and detached transit/settlement centroids are often unavailable as connected topology in the frozen highway-only extraction, so a verified public boundary can be selected instead. The proposed paths may differ from the old ascent and need not pass the old hut.\n\n` +
  `**Visual review priorities:** mountains ${longerApproaches.join(', ')} have routes more than twice as long as the old routes and need scrutiny for approach choice and detours. Mountain 69594 has unknown start elevation. None of the ten new paths visits the exact old start node; 138 and 150 use a different ascent line and do not pass Brunnsteinhütte. All ten remain awaiting human review.\n\n` +
  `## Old versus new\n\nAll distances are the complete generated one-way ascent, not a return trip. Plots are north-up geometry comparisons with equal ground scale and no terrain basemap. Blue is old; orange is V2.\n\n` +
  `| Mountain | Old start / kind / elevation | Proposed public start | Start / summit elevation | Old → new km | Passes old start |\n|---|---|---|---|---|---|\n` + table.join('\n') + '\n\n' +
  `## Validation\n\nThe replay verifies deterministic result hashes, zero fabricated gaps, every traversed OSM edge, unchanged source manifest bytes and extraction-window containment. Test logs are in data/gpx/base-access-v2-*.log. The canary regression suite verifies IDs 138, 150, 12895 and 55190, immutable old GPX/GeoJSON bytes, V2 evidence, and full new GPX geometry. Publication tests include fail-before-IO checks for all ten legacy candidates and forbidden start kinds. V1 structural receipt validation remains available for auditing existing live routes; preparation and execution require V2 evidence.\n\n` +
  `Executed successfully: publication (67 tests), adaptive/base-access/summit-attachment (80), semantic (44), reconstruction (23), summit graphs (6), canary artifacts (6), TypeScript with --noEmit --incremental false, targeted ESLint, runtime/dependency contract, and git diff --check. Total: 226 tests.\n\n` +
  `Manual runtime verification required. In Terminal 1 at the repository root, run npm run dev, then open /de/mountain/150. Expected: the Wikimedia image renders without an unconfigured-host error. Return the browser/server error text if it fails. No server was started by the agent. Review the ten geometry plots and GPX/GeoJSON files before a separate controlled replacement task.\n\n` + details.join('\n');
await writeFile(`${root}/REVIEW.md`, text);
console.log(JSON.stringify({ accepted, needsReview: 10 - accepted, report: `${root}/REVIEW.md`, productionWrites: 0 }));
