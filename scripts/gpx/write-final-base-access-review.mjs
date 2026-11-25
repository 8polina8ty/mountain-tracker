import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

assert.equal(process.argv.length, 2, 'REPORT_ONLY_NO_EXECUTE');
const root = 'data/gpx/base-access-start-v2';
const report = JSON.parse(await readFile(`${root}/final-review.json`, 'utf8'));
const esc = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const ele = n => n == null ? 'unknown' : `${n} m`;
const km = n => (n / 1000).toFixed(2);
const yes = b => b == null ? 'N/A' : b ? 'yes' : 'no';
const rows = report.rows;
const lines = [
  '# Final base access V2 review — current local checkpoint', '',
  `**${report.ready}/10 AUTO_ELIGIBLE after the recorded product review; ${report.needsReview}/10 NEEDS_REVIEW. No publication is approved.**`, '',
  'Recovered: narrow Wikimedia image fix, V2 discovery/publication guards, ten completed deterministic GPX replays, ten old/new GeoJSON overlays, and ten PNG plots. No route was regenerated in this completion. Every prior replay, GPX, comparison, plot and original report was hash-checked before and after the review and preserved byte-for-byte.', '',
  'The earlier REVIEW.md describes the generator checkpoint (10/10 graph-eligible). This report and final-review.json add the product assessment and supersede that earlier acceptance summary. Graph eligibility alone does not establish a customary, usable mountain approach.', '',
  '## Mountain 150 image fix', '',
  'Lib/wikimedia.ts returns Wikimedia imageinfo.thumburl; the mountain page passes it to next/image. thumb.wikimedia.org was absent from the allowlist. next.config.ts now permits exactly protocol=https, hostname=thumb.wikimedia.org, pathname=/wikipedia/commons/**. Runtime validation requires the exact pattern and rejects wildcard Wikimedia hosts. No change to image fetching or the mountain page was needed.', '',
  '## Exact policy and publication gate', '',
  '`mountain-tracker/base-access-start-policy/v2` requires useful start semantics and external/public approach evidence. The old BASE_START/HUT_START classification alone was insufficient: it allowed huts and intermediate alpine points to be promoted to full ascents.', '',
  'V2 proves a connected OSM road witness extending at least 250 m and including residential, living_street, unclassified, tertiary or secondary road context. Service/track roads require explicit vehicle/general public permission. Restricted/private/customer/conditional access, foot=no, motorway and impassable ways cannot supply public-access evidence. Bounded approach paths use real admitted edges: at most 150 m, 30 m for trailheads, and 0 m for guideposts/network boundaries. Searches stop after 5,000 visited nodes. No straight connectors are added; detached POIs need topology proof.', '',
  'Preference order: road-connected trailhead → parking → village/hamlet → transit → legal public road end → verified road/trail transition. Ranking uses actual routed distance plus a 750 m preference step per kind and the existing quality terms. Public boundaries always compete, even when named candidates exist. This preserves the correction that removed the 46.8 km bus-stop choice for mountain 138. Road ends are represented by the verified transition category when no independent start feature is available.', '',
  'Primary publication requires PRIMARY_BASE_ACCESS, SAFE, connected/deterministic reconstruction, fabricatedGapCount=0 and DIRECT/EXTENDED automatic-compatible summit attachment. Huts/refuges and unproven high/internal graph starts fail. Huts may occur inside a complete route. V1 structural receipt validation remains available for historical auditing; new preparation and execute-side IO require V2 evidence. The old locked canary cannot be republished after the policy/source change. No replacement publication manifest or approval was issued.', '',
  'Evidence contains candidate kind, start role, publicRoadConnected, settlementConnected, parkingConnected, transitConnected, trailheadConnected, approachBoundary, network distance, start/summit elevations, reason codes, and exact OSM node/way witnesses. False context flags mean unproven rather than absent. Null elevations remain unknown.', '',
  '## Product review method', '',
  'Normal-start plausibility is assessed separately from graph connectivity. General review flags apply when a route more than doubles the old distance and adds over 5 km, when service/track access extends over 1 km before the first main road, or when the upper approach changes by at least 60° with less than 50% old-route edge overlap. These flags request human investigation; they do not prove the route is unusable. No mountain names are special-cased.', '',
  'Approach-side angles compare points 1 km back along the completed old/new routes from their terminals. Interpolation is used only for measurement, never exported as route geometry. Overlap is measured by shared OSM edge length, independent of sample density. Geometry is flagged substantially changed if either path has less than 75% overlap. Public-road tags and nearby OSM features support plausibility, but current opening/legal vehicle access and customary ascent choice are not independently certified.', '',
  '## Complete ten-mountain comparison', '',
  'Distances are complete generated one-way routes, not round trips. New kinds: NETWORK_ACCESS means a verified public-road boundary here; the one TRAILHEAD_INFO candidate is a guidepost at such a boundary, not a free-standing alpine junction.', '',
  '| ID / summit | Old start · kind · category | Old → new elevation | Old → new km | New public start · candidate kind | Product status |',
  '|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.mountainId} ${esc(r.summitName)} | ${esc(r.old.startName)} · ${r.old.kind} · ${r.old.routeCategory} | ${ele(r.old.startElevation)} → ${ele(r.new.startElevation)} | ${km(r.old.distanceMeters)} → ${km(r.new.distanceMeters)} | ${esc(r.new.startName)} · ${r.new.candidateKind} | ${r.productStatus} |`), '',
  '## Geometry, side change and old-start/hut traversal', '',
  '| ID | Substantial geometry change | Different upper approach side | Angle | Old edge coverage | Exact old start visited | Old hut visited |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.mountainId} | ${yes(r.geometry.substantiallyChanged)} | ${yes(r.geometry.differentApproachSide)} | ${r.geometry.sideDifferenceDegrees.toFixed(1)}° | ${(r.geometry.oldCoverage.sharedFraction * 100).toFixed(1)}% | ${yes(r.passesOldStart)} | ${yes(r.passesOldHut)} |`), '',
  'Old-start and hut traversal use exact OSM node identity. A nearby pass is not silently counted as a visit. In particular, 138 and 150 do not traverse Brunnsteinhütte; their new routes use different ascent lines.', '',
  '## Candidates requiring human review', '',
  ...rows.filter(r => r.reviewReasons.length).map(r => `- **${r.mountainId} ${r.summitName}:** ${r.reviewReasons.join(', ')}. New route ${km(r.new.distanceMeters)} km; public service/track distance before the main road ${r.publicApproachContext.distanceToMainRoadMeters} m.`), '',
  'Mountain 69594 additionally has unknown start elevation. Its 1,508 m service/track approach needs verification of actual public usability; road topology alone is insufficient. The other three candidates have no flagged detour, remote-service or substantial side-change concern in this assessment. All ten remain unpublished and require the separate review/replacement process.', '',
  '## Files and exact artifact paths', '',
  '- Final JSON: `data/gpx/base-access-start-v2/final-review.json`.',
  '- Final report: `data/gpx/base-access-start-v2/FINAL_REVIEW.md`.',
  '- Preserved checkpoint: `data/gpx/base-access-start-v2/comparison.json` and `comparison.sha256`.',
  '- New deterministic overlays with old/new route, old/new start, target summit and route-terminal markers: `data/gpx/base-access-start-v2/<ID>-review.geojson`.',
  '- Preserved original overlays: `data/gpx/base-access-start-v2/<ID>-comparison.geojson`.',
  '- Preserved plots: `data/gpx/base-access-start-v2/<ID>-comparison.png`.',
  '- Preserved GPX: `data/gpx/base-access-start-v2/<ID>.gpx`.',
  '- Full replay evidence: `data/gpx/base-access-start-v2/<ID>-evaluation.json`.',
  '- IDs: `138, 150, 796, 12895, 49632, 50473, 51088, 55190, 69594, 73101`.', '',
  'Earlier task changes: next.config.ts, scripts/validate-runtime-contract.mjs, package.json test scripts, Lib/gpxIngestion/baseAccessStartPolicy.ts and its tests/fixtures, adaptiveStartDiscovery.ts/tests, generatedRoutePublication.ts/tests, generated-publication-execute.ts/tests, generated-publication-frozen.ts, and the local regeneration/report/plot scripts. Completion changes: base-access-product-review.ts/tests, finish-base-access-review.ts, this final report writer, and inclusion of the review tests in test:gpx-base-access-canary. Pre-existing package-lock and Phase11 road-safety work were preserved.', '',
  '## Validation and production attestation', '',
  'See validation-results.json for command exit codes. Required bounded checks cover publication, adaptive/base access, semantic, reconstruction, canary/product review, runtime, TypeScript (--noEmit --incremental false), targeted ESLint, and git diff --check. The previously completed summit-graph suite also passed. Regression fixtures cover 138, 150, 12895 and 55190. Tests reject huts/refuges/high nodes, detached or restricted approaches, preserve parking/village → hut/trails → summit paths, verify zero connectors, and check deterministic geometry and the image remote pattern.', '',
  '**Database writes = 0; Storage writes = 0; publication writes = 0.** No route, provenance or Storage object was changed. No SQL, --execute, publication RPC, commit, push, checkout/reset/clean or branch switch was performed. No dev/start server was launched. Previously completed artifacts are protected by hashes in final-review.json.', '',
  'Manual runtime verification required. Terminal 1, repository root: `npm run dev`. Open `/de/mountain/150`; expect the Wikimedia image without an unconfigured-host error. If it fails, return the browser/server error text. The agent has not verified the running application. Review all ten marker GeoJSON files and the preserved geometry plots before replacement.', '',
  '## Per-mountain evidence', '',
];
for (const r of rows) {
  const e = r.new.accessEvidence;
  lines.push(`### ${r.mountainId} — ${r.summitName}`, '',
    `**${r.productStatus}**. ${r.assessment}`, '',
    `New semantic identity: **${r.new.osmIdentity}**; candidate ID: ${r.new.candidateId}; actual route start: **OSM node ${r.new.actualStartOsmNodeId}**, coordinate ${JSON.stringify(r.new.actualStartCoordinate)}. ` +
    `Kind ${r.new.candidateKind}; category ${r.new.routeCategory}; role ${r.new.startRole}. Start elevation ${ele(r.new.startElevation)}; summit ${ele(r.new.summitElevation)}.`, '',
    `Access flags: publicRoadConnected=${e.publicRoadConnected}; parkingConnected=${e.parkingConnected}; settlementConnected=${e.settlementConnected}; transitConnected=${e.transitConnected}; trailheadConnected=${e.trailheadConnected}; approachBoundary=${e.approachBoundary}. ` +
    `Local network/access distance=${e.accessNetworkDistance} m; outward witness=${r.publicApproachContext.outwardWitnessDistanceMeters} m; service/track distance to main road=${r.publicApproachContext.distanceToMainRoadMeters} m.`, '',
    `Reason codes: ${e.reasonCodes.join(', ')}. Review flags: ${r.reviewReasons.join(', ') || 'none'}.`, '',
    `Safety ${r.new.safety}; summit attachment ${r.new.summitAttachment.tier}, ${r.new.summitAttachment.distanceMeters} m. Deterministic replay verified; fabricated gaps 0.`, '',
    `Nearby OSM context within 250 m (context only, not connector proof): ${r.publicApproachContext.nearbyFeaturesWithin250Meters.slice(0, 12).map(f => `${f.name || f.osmIdentity} [${f.kind}, ${f.distanceMeters} m]`).join('; ') || 'no indexed features'}.`, '',
    `[Marker GeoJSON](${r.artifacts.markerComparison}) · [Original overlay](${r.artifacts.originalComparison}) · [GPX](${r.artifacts.gpx}) · [Full evaluation](${r.artifacts.evaluation})`, '',
    `![Old/new route geometry](${r.artifacts.plot})`, '');
}
lines.push(`BASE ACCESS START POLICY V2 PARTIAL —\n${report.ready}/10 READY, ${report.needsReview}/10 REQUIRE VISUAL REVIEW BEFORE REPLACEMENT.`, '');
await writeFile(`${root}/FINAL_REVIEW.md`, lines.join('\n'));
console.log(`${root}/FINAL_REVIEW.md`);
