import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M,
  PUBLIC_ROUTE_DIRECT_SUMMIT_RADIUS_M,
  PUBLIC_ROUTE_MIN_CONFIDENCE,
  PUBLIC_ROUTE_MIN_CONFIDENCE_MARGIN,
  classifyTrackForMountain,
  getDirectSummitAssociations,
} from "../Lib/tracks/validateTrackForMountain.ts";
import {
  COMMUNITY_ROUTE_DESCRIPTION_MAX,
  COMMUNITY_ROUTE_EDITABLE_FIELDS,
  COMMUNITY_ROUTE_TITLE_MAX,
  validateCommunityRouteContent,
} from "../Lib/tracks/communityRouteContent.ts";
import { evaluateMountainCandidatesForTrack } from "../Lib/tracks/detectMountainFromTrack.ts";
import {
  buildRouteSegmentSpatialIndex,
  getRouteSegmentCandidateIndexes,
} from "../Lib/tracks/routeSegmentSpatialIndex.ts";

const candidate = (overrides = {}) => ({
  mountainId: 123, mountainName: "Target", mountainHeight: 2000,
  distanceM: 40, confidence: 0.94, ...overrides,
});
const detection = (target, runnerUp = null, best = target) => ({
  ...best,
  runnerUp,
  candidates: [best, target, runnerUp].filter((item, index, items) =>
    item && items.findIndex((candidateItem) => candidateItem?.mountainId === item.mountainId) === index,
  ),
});

const mountainRow = (overrides) => ({
  id: 1,
  name: null,
  name_de: null,
  height: 2000,
  latitude: 0,
  longitude: 0,
  ...overrides,
});
const supabaseWithMountains = (mountains) => ({
  from(table) {
    assert.equal(table, "mountains");
    const query = {
      select() { return query; },
      not() { return query; },
      gte() { return query; },
      lte() { return query; },
      async limit() { return { data: mountains, error: null }; },
    };
    return query;
  },
});
const trackGeoJson = (geometry) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: {}, geometry }],
});

const twoSummitCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains([
    mountainRow({ id: 601, name: "Summit B", height: 2200, longitude: 0.001 }),
    mountainRow({ id: 602, name: "Summit A", height: 3200, longitude: 0.009 }),
  ]),
  geojson: trackGeoJson({
    type: "MultiLineString",
    coordinates: [
      [[0, 0, 2100], [0.002, 0, 2300]],
      [[0.008, 0, 3150], [0.01, 0, 3250]],
    ],
  }),
});
const lowerSummitCandidate = twoSummitCandidates.find(({ mountainId }) => mountainId === 601);
const higherSummitCandidate = twoSummitCandidates.find(({ mountainId }) => mountainId === 602);
assert.equal(lowerSummitCandidate?.confidence, 1, "2200m summit must use its matching local interpolated elevation");
assert.equal(higherSummitCandidate?.confidence, 1, "3200m summit must use its matching local interpolated elevation");
assert.equal(
  getDirectSummitAssociations(601, twoSummitCandidates, "matched").length,
  2,
  "both locally matching direct summits must qualify",
);
assert.equal(
  lowerSummitCandidate?.confidence,
  higherSummitCandidate?.confidence,
  "later 3200m route elevation must not penalize the earlier 2200m summit",
);

const incompatibleElevationCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains([
    mountainRow({ id: 603, name: "Incompatible summit", height: 2200, longitude: 0.001, latitude: 0.0008 }),
  ]),
  geojson: trackGeoJson({
    type: "LineString",
    coordinates: [[0, 0, 1000], [0.002, 0, 1000]],
  }),
});
assert.ok(incompatibleElevationCandidates[0].distanceM < 100, "incompatible summit must remain geographically close");
assert.ok(incompatibleElevationCandidates[0].confidence < PUBLIC_ROUTE_MIN_CONFIDENCE, "strong local elevation mismatch may fall below confidence threshold");

const noElevationCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains([
    mountainRow({ id: 604, name: "No elevation summit", height: 2200, longitude: 0.001 }),
  ]),
  geojson: trackGeoJson({
    type: "LineString",
    coordinates: [[0, 0], [0.002, 0]],
  }),
});
assert.equal(noElevationCandidates[0].confidence, 0.9, "missing local elevation must keep the neutral deterministic score");

const oneEndpointElevationCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains([
    mountainRow({ id: 605, name: "Partial elevation summit", height: 2200, longitude: 0.001 }),
  ]),
  geojson: trackGeoJson({
    type: "LineString",
    coordinates: [[0, 0, 2200], [0.002, 0]],
  }),
});
assert.equal(oneEndpointElevationCandidates[0].confidence, 1, "a single finite local endpoint elevation must be used");

const earthRadiusM = 6_371_000;
const metersToLatitudeDegrees = (meters) => (meters / earthRadiusM) * (180 / Math.PI);
const boundaryCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains([99, 100, 101].map((distanceM) => mountainRow({
    id: 700 + distanceM,
    name: `${distanceM}m summit`,
    height: 2200,
    latitude: metersToLatitudeDegrees(distanceM),
  }))),
  geojson: trackGeoJson({
    type: "LineString",
    coordinates: [[-0.01, 0, 2200], [0.01, 0, 2200]],
  }),
});
const boundaryByDistance = new Map(boundaryCandidates.map((item) => [item.mountainId - 700, item]));
assert.equal(boundaryByDistance.get(99)?.distanceM, 99, "99m spatial lookup must preserve exact rounded distance");
assert.equal(boundaryByDistance.get(100)?.distanceM, 100, "100m spatial lookup must preserve exact rounded distance");
assert.equal(boundaryByDistance.get(101)?.distanceM, 101, "101m spatial lookup must preserve exact rounded distance");
const thresholdCandidates = boundaryCandidates.map((item) => ({ ...item, confidence: PUBLIC_ROUTE_MIN_CONFIDENCE }));
const thresholdAssociations = getDirectSummitAssociations(799, thresholdCandidates, "matched");
assert.ok(thresholdAssociations.some(({ mountainId }) => mountainId === 799), "99m summit must remain direct-summit eligible");
assert.ok(thresholdAssociations.some(({ mountainId }) => mountainId === 800), "100m summit must remain direct-summit eligible");
assert.equal(thresholdAssociations.some(({ mountainId }) => mountainId === 801), false, "101m summit must not be an automatic direct summit");

const syntheticSegments = Array.from({ length: 2000 }, (_, index) => ({
  startLongitude: -20 + index * 0.02,
  startLatitude: 0,
  endLongitude: -20 + (index + 1) * 0.02,
  endLatitude: 0,
}));
const syntheticIndex = buildRouteSegmentSpatialIndex(syntheticSegments, 2500);
const syntheticCandidateLocations = Array.from({ length: 200 }, (_, index) => ({
  longitude: -19.9 + index * 0.2,
  latitude: metersToLatitudeDegrees(50),
}));
const indexedEvaluationCount = syntheticCandidateLocations.reduce(
  (count, point) => count + getRouteSegmentCandidateIndexes(syntheticIndex, point.longitude, point.latitude).length,
  0,
);
const cartesianEvaluationCount = syntheticSegments.length * syntheticCandidateLocations.length;
assert.ok(
  indexedEvaluationCount < cartesianEvaluationCount / 10,
  "large-track spatial lookup must substantially prune the candidate x segment Cartesian product",
);

const longSegmentIndex = buildRouteSegmentSpatialIndex([{
  startLongitude: -40,
  startLatitude: 1,
  endLongitude: 40,
  endLatitude: 1,
}], 2500);
assert.deepEqual(
  getRouteSegmentCandidateIndexes(longSegmentIndex, 0, 1),
  [0],
  "pathological long segment must remain available through exact fallback",
);

function distanceMeters(firstLongitude, firstLatitude, secondLongitude, secondLatitude) {
  const firstLatitudeRadians = firstLatitude * Math.PI / 180;
  const secondLatitudeRadians = secondLatitude * Math.PI / 180;
  const latitudeDifference = (secondLatitude - firstLatitude) * Math.PI / 180;
  const longitudeDifference = (secondLongitude - firstLongitude) * Math.PI / 180;
  const haversine = Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitudeRadians) * Math.cos(secondLatitudeRadians) *
    Math.sin(longitudeDifference / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function bruteForceDistanceToSyntheticTrack(point) {
  let minimumDistanceM = Number.POSITIVE_INFINITY;
  for (const segment of syntheticSegments) {
    const averageLatitude = (point.latitude + segment.startLatitude + segment.endLatitude) / 3 * Math.PI / 180;
    const longitudeScale = Math.max(0.1, Math.cos(averageLatitude));
    const segmentX = (segment.endLongitude - segment.startLongitude) * Math.PI / 180 * longitudeScale;
    const segmentY = (segment.endLatitude - segment.startLatitude) * Math.PI / 180;
    const pointX = (point.longitude - segment.startLongitude) * Math.PI / 180 * longitudeScale;
    const pointY = (point.latitude - segment.startLatitude) * Math.PI / 180;
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const fraction = segmentLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (pointX * segmentX + pointY * segmentY) / segmentLengthSquared));
    const projectedLongitude = segment.startLongitude +
      (segment.endLongitude - segment.startLongitude) * fraction;
    const projectedLatitude = segment.startLatitude +
      (segment.endLatitude - segment.startLatitude) * fraction;
    minimumDistanceM = Math.min(
      minimumDistanceM,
      distanceMeters(point.longitude, point.latitude, projectedLongitude, projectedLatitude),
    );
  }
  return minimumDistanceM;
}

const parityLocations = syntheticCandidateLocations.filter((_, index) => index % 50 === 0);
const largeTrackCandidates = await evaluateMountainCandidatesForTrack({
  supabase: supabaseWithMountains(parityLocations.map((point, index) => mountainRow({
    id: 900 + index,
    name: `Parity summit ${index}`,
    height: 2200,
    longitude: point.longitude,
    latitude: point.latitude,
  }))),
  geojson: trackGeoJson({
    type: "LineString",
    coordinates: [
      ...syntheticSegments.map((segment) => [segment.startLongitude, segment.startLatitude, 2200]),
      [syntheticSegments.at(-1).endLongitude, syntheticSegments.at(-1).endLatitude, 2200],
    ],
  }),
});
for (const [index, point] of parityLocations.entries()) {
  const indexedCandidate = largeTrackCandidates.find(({ mountainId }) => mountainId === 900 + index);
  assert.equal(
    indexedCandidate?.distanceM,
    Math.round(bruteForceDistanceToSyntheticTrack(point)),
    `indexed distance must match brute force for parity candidate ${index}`,
  );
}

console.log(`Spatial index regression: ${indexedEvaluationCount}/${cartesianEvaluationCount} exact segment evaluations selected; brute-force parity passed for ${parityLocations.length} candidates.`);
console.log("Direct-summit boundary regression: 99m eligible, 100m eligible, 101m excluded.");

assert.equal(PUBLIC_ROUTE_MAX_SUMMIT_DISTANCE_M, 300);
assert.equal(PUBLIC_ROUTE_DIRECT_SUMMIT_RADIUS_M, 100);
assert.equal(PUBLIC_ROUTE_MIN_CONFIDENCE, 0.75);
assert.equal(PUBLIC_ROUTE_MIN_CONFIDENCE_MARGIN, 0.08);
const nearby = (distanceM, confidence) => candidate({ mountainId: 456, mountainName: "Nearby", distanceM, confidence });
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 30, confidence: 0.91 }), nearby(40, 0.90))).status, "matched", "30 m target must bypass nearby ambiguity");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 80, confidence: 0.90 }), nearby(85, 0.90))).status, "matched", "80 m target must bypass equal-confidence ambiguity");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 150, confidence: 0.91 }), nearby(140, 0.88))).status, "ambiguous", "150 m target must retain ambiguity rejection");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 180, confidence: 0.91 }), nearby(170, 0.80))).status, "matched", "180 m clearly strongest target must match");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 500, confidence: 0.2 }), null, nearby(20, 0.96))).status, "low_confidence", "malformed/low-confidence target must fail");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 500, confidence: 0.8 }), null, nearby(20, 0.96))).status, "wrong_mountain", "distant target with directly reached alternative must be wrong mountain");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 101, confidence: 0.90 }), nearby(90, 0.89))).status, "ambiguous", "101 m target must not use direct-summit bypass");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 100, confidence: 0.90 }), nearby(90, 0.90))).status, "matched", "exactly 100 m must use direct-summit rule");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ distanceM: 301, confidence: 0.9 }))).status, "too_far", "too-far route must fail");
assert.equal(classifyTrackForMountain(456, true, detection(candidate())).status, "wrong_mountain", "absent target candidate must fail");
assert.equal(classifyTrackForMountain(123, true, detection(candidate({ confidence: 0.74 }))).status, "low_confidence", "low-confidence route must fail");
assert.equal(classifyTrackForMountain(123, false, null).status, "mountain_coordinates_missing", "missing target coordinates must fail");

const candidatesThreeSummits = [
  candidate({ mountainId: 100, mountainName: "Peak A", distanceM: 12, confidence: 0.96 }),
  candidate({ mountainId: 101, mountainName: "Peak B", distanceM: 46, confidence: 0.92 }),
  candidate({ mountainId: 102, mountainName: "Peak C", distanceM: 87, confidence: 0.89 }),
  candidate({ mountainId: 103, mountainName: "Peak D", distanceM: 180, confidence: 0.80 }),
];
const associationsThree = getDirectSummitAssociations(100, candidatesThreeSummits, "matched");
assert.equal(associationsThree.length, 3, "three summits <=100m must all be associated");
assert.equal(associationsThree.filter((a) => a.isPrimary).length, 1, "exactly one primary association");
assert.ok(associationsThree.find((a) => a.mountainId === 100 && a.isPrimary), "target mountain 100 is primary");
assert.ok(associationsThree.find((a) => a.mountainId === 101 && !a.isPrimary), "peak B is secondary");
assert.ok(associationsThree.find((a) => a.mountainId === 102 && !a.isPrimary), "peak C is secondary");
assert.equal(associationsThree.find((a) => a.mountainId === 103), undefined, "peak D at 180m not auto-associated");

const candidatesTwoClose = [
  candidate({ mountainId: 200, mountainName: "Peak A", distanceM: 30, confidence: 0.94 }),
  candidate({ mountainId: 201, mountainName: "Peak B", distanceM: 40, confidence: 0.93 }),
];
const associationsTwoClose = getDirectSummitAssociations(200, candidatesTwoClose, "matched");
assert.equal(associationsTwoClose.length, 2, "two summits both <=100m must both be accepted");
assert.ok(associationsTwoClose.find((a) => a.mountainId === 200 && a.isPrimary), "peak A is primary");
assert.ok(associationsTwoClose.find((a) => a.mountainId === 201 && !a.isPrimary), "peak B is secondary");

const candidatesOneAt101m = [
  candidate({ mountainId: 300, mountainName: "Peak A", distanceM: 30, confidence: 0.94 }),
  candidate({ mountainId: 301, mountainName: "Peak B", distanceM: 101, confidence: 0.92 }),
];
const associationsOneAt101m = getDirectSummitAssociations(300, candidatesOneAt101m, "matched");
assert.equal(associationsOneAt101m.length, 1, "summit at 101m must not be auto-associated");
assert.ok(associationsOneAt101m.find((a) => a.mountainId === 300 && a.isPrimary), "only peak A is associated");

const candidatesLowConfidence = [
  candidate({ mountainId: 400, mountainName: "Peak A", distanceM: 30, confidence: 0.94 }),
  candidate({ mountainId: 401, mountainName: "Peak B", distanceM: 50, confidence: 0.74 }),
];
const associationsLowConfidence = getDirectSummitAssociations(400, candidatesLowConfidence, "matched");
assert.equal(associationsLowConfidence.length, 1, "low-confidence <=100m candidate must be rejected");

const candidatesPrimary150m = [
  candidate({ mountainId: 500, mountainName: "Target", distanceM: 150, confidence: 0.91 }),
  candidate({ mountainId: 501, mountainName: "Peak B", distanceM: 46, confidence: 0.92 }),
  candidate({ mountainId: 502, mountainName: "Peak C", distanceM: 87, confidence: 0.89 }),
];
const associationsPrimary150m = getDirectSummitAssociations(500, candidatesPrimary150m, "matched");
assert.equal(associationsPrimary150m.length, 3, "primary 150m (strong-best) retained; unrelated <=100m also associated");
assert.ok(associationsPrimary150m.find((a) => a.mountainId === 500 && a.isPrimary), "target 500 is primary despite 150m");
assert.ok(associationsPrimary150m.find((a) => a.mountainId === 501 && !a.isPrimary), "peak B <=100m associated");
assert.ok(associationsPrimary150m.find((a) => a.mountainId === 502 && !a.isPrimary), "peak C <=100m associated");

const validContent = Object.fromEntries(COMMUNITY_ROUTE_EDITABLE_FIELDS.map((field) => [field, field === "title" ? "  Ridge route  " : null]));
const normalized = validateCommunityRouteContent(validContent);
assert.equal(normalized.ok, true, "valid owner content must be accepted");
assert.equal(normalized.ok && normalized.value.title, "Ridge route", "content must be trimmed");
assert.equal(validateCommunityRouteContent({ ...validContent, title: "x".repeat(COMMUNITY_ROUTE_TITLE_MAX + 1) }).ok, false, "overlong title must fail");
assert.equal(validateCommunityRouteContent({ ...validContent, description: "x".repeat(COMMUNITY_ROUTE_DESCRIPTION_MAX + 1) }).ok, false, "overlong body must fail");
assert.deepEqual(validateCommunityRouteContent({ ...validContent, route_type: "flying" }), { ok: false, error: "invalid_route_type", field: "route_type" }, "invalid route type must fail");
assert.deepEqual(validateCommunityRouteContent({ ...validContent, mountain_id: 999 }), { ok: false, error: "unknown_field", field: "mountain_id" }, "unknown/mass-assignment fields must fail");

const sql = await readFile(new URL("../database/mountain_community_routes.sql", import.meta.url), "utf8");
const publish = await readFile(new URL("../app/api/mountain-community-routes/route.ts", import.meta.url), "utf8");
const download = await readFile(new URL("../app/[locale]/mountain/[id]/community-route/[routeId]/gpx/route.ts", import.meta.url), "utf8");
const update = await readFile(new URL("../app/api/mountain-community-routes/[routeId]/route.ts", import.meta.url), "utf8");
const detail = await readFile(new URL("../app/[locale]/mountain/[id]/community-route/[routeId]/page.tsx", import.meta.url), "utf8");
const listPage = await readFile(new URL("../app/[locale]/mountain/[id]/page.tsx", import.meta.url), "utf8");
const geojson = await readFile(new URL("../app/[locale]/mountain/[id]/community-route/[routeId]/geojson/route.ts", import.meta.url), "utf8");
const repairPhase1 = await readFile(new URL("../database/mountain_community_routes_repair_phase1.sql", import.meta.url), "utf8");
const repairMultimountain = await readFile(new URL("../database/mountain_community_routes_repair_multimountain.sql", import.meta.url), "utf8");
const publicationPhase2 = await readFile(new URL("../database/mountain_community_routes_publication_phase2.sql", import.meta.url), "utf8");
const recoverySql = await readFile(new URL("../database/mountain_community_routes_recovery.sql", import.meta.url), "utf8");
const repairFinalize = await readFile(new URL("../database/mountain_community_routes_repair_finalize.sql", import.meta.url), "utf8");
const repairBackfill = await readFile(new URL("./backfill-community-route-geojson.mjs", import.meta.url), "utf8");
const recoveryScript = await readFile(new URL("./repair-community-route-associations.mjs", import.meta.url), "utf8");
const listRpc = sql.slice(
  sql.indexOf("create or replace function public.list_published_mountain_community_routes"),
  sql.indexOf("create or replace function public.get_published_mountain_community_route"),
);
const detailRpc = sql.slice(
  sql.indexOf("create or replace function public.get_published_mountain_community_route"),
  sql.indexOf("revoke select, insert, update, delete on public.mountain_community_routes"),
);
const publicationRpc = sql.slice(
  sql.indexOf("create or replace function public.publish_mountain_community_route"),
  sql.indexOf("create or replace function public.finalize_mountain_community_route_backfill"),
);
const backfillFinalizeRpc = sql.slice(
  sql.indexOf("create or replace function public.finalize_mountain_community_route_backfill"),
  sql.indexOf("create or replace function public.list_published_mountain_community_routes"),
);
assert.match(sql, /unique \(gps_activity_id\)/i, "one canonical activity must have only one publication");
assert.match(sql, /status = 'published' or user_id = auth\.uid\(\)/, "public metadata policy must expose only published rows");
assert.match(sql, /no browser INSERT or UPDATE policy/i, "direct publication bypass protection missing");
assert.match(sql, /community-route-tracks[\s\S]*false/, "published snapshot bucket must remain private");
assert.match(sql, /application\/geo\+json/, "published snapshot bucket must allow GeoJSON uploads");
assert.match(sql, /revoke select, insert, update, delete on public\.mountain_community_routes from anon, authenticated/i, "browser roles must have no base-table SELECT or write privileges");
assert.equal(/grant select on public\.mountain_community_routes to anon|grant select on public\.mountain_community_routes to authenticated/i.test(sql), false, "browser roles must not receive base-table SELECT");
assert.equal(/grant delete on public\.mountain_community_routes/i.test(sql), false, "authenticated users must not receive direct base-table DELETE in this stage");
assert.equal(/create policy mountain_community_routes_owner_delete/i.test(sql), false, "SQL must not imply that an RLS policy grants the intentionally absent DELETE privilege");
assert.match(listRpc, /security definer[\s\S]*set search_path = ''/i, "public list RPC must use a hardened SECURITY DEFINER boundary");
assert.match(detailRpc, /security definer[\s\S]*set search_path = ''/i, "public detail RPC must use a hardened SECURITY DEFINER boundary");
assert.match(listRpc, /inner join public\.mountain_community_route_mountains as assoc[\s\S]*assoc\.route_id = route\.id/, "list RPC must use association table");
assert.match(listRpc, /assoc\.mountain_id = requested_mountain_id/, "list RPC must bind via association");
assert.match(listRpc, /least\(greatest\(requested_limit, 0\), 50\)/, "list RPC must cap its page size");
assert.match(detailRpc, /inner join public\.mountain_community_route_mountains as assoc[\s\S]*assoc\.route_id = route\.id/, "detail RPC must use association table");
assert.match(detailRpc, /assoc\.mountain_id = requested_mountain_id/, "detail RPC must bind via association");
assert.match(detailRpc, /associated_mountains jsonb/, "detail RPC must return associated mountains");
assert.match(sql, /revoke all on function public\.list_published_mountain_community_routes\(bigint, integer, integer\) from public/i, "list RPC must explicitly revoke default PUBLIC execution");
assert.match(sql, /revoke all on function public\.get_published_mountain_community_route\(uuid, bigint\) from public/i, "detail RPC must explicitly revoke default PUBLIC execution");
const executeGrants = sql.match(/grant execute on function[^;]+;/gi) ?? [];
const publicExecuteGrants = executeGrants.filter((grant) => /to anon, authenticated;/i.test(grant));
const serverExecuteGrants = executeGrants.filter((grant) => /to service_role;/i.test(grant));
assert.equal(publicExecuteGrants.length, 2, "only the two public read RPCs may be browser-callable");
for (const grant of publicExecuteGrants) {
  assert.match(grant, /to anon, authenticated;/i, "public read RPC execution must be granted only to anon and authenticated");
}
assert.equal(serverExecuteGrants.length, 2, "only atomic publication and backfill RPCs may receive service-role execution");
assert.ok(serverExecuteGrants.some((grant) => /publish_mountain_community_route/i.test(grant)), "service-role grant must include atomic publication RPC");
assert.ok(serverExecuteGrants.some((grant) => /finalize_mountain_community_route_backfill/i.test(grant)), "service-role grant must include atomic backfill RPC");
assert.equal(executeGrants.length, 4, "unexpected function EXECUTE grant in clean-install SQL");
for (const privateField of ["gps_activity_id", "user_id", "published_gpx_path", "published_geojson_path"]) {
  assert.equal(listRpc.includes(privateField), false, `list RPC must not expose ${privateField}`);
  assert.equal(detailRpc.includes(privateField), false, `detail RPC must not expose ${privateField}`);
}

assert.match(sql, /create table if not exists public\.mountain_community_route_mountains/, "clean install must create relation table");
assert.match(sql, /primary key \(route_id, mountain_id\)/, "relation table must have composite primary key");
assert.match(sql, /mountain_community_route_mountains_primary_unique/, "relation table must have unique partial index for primary");
assert.match(sql, /revoke all privileges on table public\.mountain_community_route_mountains\s+from anon, authenticated;/i, "relation table must revoke browser privileges");
assert.equal(/create policy mountain_community_route_mountains_/i.test(sql), false, "relation table must have no browser policies");
assert.match(publicationRpc, /language plpgsql volatile security invoker set search_path = ''/i, "publication RPC must use invoker rights with an empty search path");
assert.match(publicationRpc, /insert into public\.mountain_community_routes[\s\S]*insert into public\.mountain_community_route_mountains/i, "publication RPC must insert route and associations in one statement transaction");
assert.match(publicationRpc, /inserted_route\.id[\s\S]*from inserted_route[\s\S]*cross join pg_catalog\.jsonb_to_recordset/i, "association insert must depend on the newly inserted route CTE");
assert.match(publicationRpc, /public\.gps_activities[\s\S]*activity\.user_id = requested_user_id[\s\S]*processing_status = 'ready'/i, "publication RPC must independently verify ready activity ownership");
assert.match(publicationRpc, /jsonb_typeof\(requested_associations\)/i, "publication RPC must validate association JSON shape");
assert.match(publicationRpc, /association_count <> distinct_mountain_count or primary_count <> 1/i, "publication RPC must validate association uniqueness and primary cardinality");
assert.match(publicationRpc, /primary_distance_m <> requested_validation_distance_m[\s\S]*primary_confidence <> requested_validation_confidence/i, "publication RPC must bind primary association metrics to validation");
assert.match(publicationRpc, /requested_published_gpx_path is distinct from \(requested_route_id::text \|\| '\/route\.gpx'\)[\s\S]*requested_published_geojson_path is distinct from \(requested_route_id::text \|\| '\/route\.geojson'\)/i, "publication RPC must enforce opaque immutable snapshot paths");
assert.match(publicationRpc, /from public, anon, authenticated/i, "publication RPC must revoke default and browser execution");
assert.match(publicationRpc, /to service_role/i, "publication RPC must be explicitly service-role only");
assert.equal(/publish_mountain_community_route[\s\S]*to anon|publish_mountain_community_route[\s\S]*to authenticated/i.test(publicationRpc), false, "publication RPC must never be browser-callable");
assert.match(backfillFinalizeRpc, /returns void[\s\S]*language plpgsql volatile security invoker set search_path = ''/i, "backfill finalization RPC must return no internal data and use invoker rights with an empty search path");
assert.match(backfillFinalizeRpc, /requested_published_geojson_path is distinct from \([\s\S]*requested_route_id::text \|\| '\/route\.geojson'[\s\S]*\)/i, "backfill finalization RPC must enforce the immutable route-bound GeoJSON path");
assert.match(backfillFinalizeRpc, /from public\.mountain_community_routes as route[\s\S]*route\.status = 'published'[\s\S]*route\.published_geojson_path is null[\s\S]*for update/i, "backfill finalization RPC must lock only an existing eligible route");
assert.match(backfillFinalizeRpc, /association_count <> distinct_mountain_count[\s\S]*primary_count <> 1[\s\S]*primary_mountain_id <> route_mountain_id/i, "backfill finalization RPC must reject duplicates and require exactly one matching primary");
assert.match(backfillFinalizeRpc, /association\.distance_m is null or association\.distance_m < 0[\s\S]*association\.confidence is null or association\.confidence < 0 or association\.confidence > 1/i, "backfill finalization RPC must validate distance and confidence ranges before mutation");
const backfillAssociationValidation = backfillFinalizeRpc.indexOf("if association_count <> distinct_mountain_count");
const backfillPathUpdate = backfillFinalizeRpc.indexOf("update public.mountain_community_routes as route");
const backfillAssociationUpsert = backfillFinalizeRpc.indexOf("insert into public.mountain_community_route_mountains");
assert.ok(backfillAssociationValidation >= 0 && backfillAssociationValidation < backfillPathUpdate, "association validation failure must occur before the path update can commit");
assert.ok(backfillPathUpdate >= 0 && backfillPathUpdate < backfillAssociationUpsert, "path update failure must occur before association persistence starts");
assert.match(backfillFinalizeRpc, /update public\.mountain_community_routes[\s\S]*insert into public\.mountain_community_route_mountains[\s\S]*on conflict \(route_id, mountain_id\) do update/i, "successful backfill must atomically update the path and upsert every association");
assert.match(backfillFinalizeRpc, /from public, anon, authenticated/i, "backfill finalization RPC must revoke PUBLIC and browser execution");
assert.match(backfillFinalizeRpc, /to service_role/i, "backfill finalization RPC must grant execution only to service_role");
assert.equal(/finalize_mountain_community_route_backfill[\s\S]*to anon|finalize_mountain_community_route_backfill[\s\S]*to authenticated/i.test(backfillFinalizeRpc), false, "backfill finalization RPC must never be browser-callable");

assert.equal(/^\s*drop\s+table\b/im.test(repairPhase1), false, "phase 1 must not drop the deployed table");
assert.equal(/^\s*delete\s+from\b/im.test(repairPhase1), false, "phase 1 must not delete deployed rows");
assert.equal(/^\s*truncate\b/im.test(repairPhase1), false, "phase 1 must not truncate deployed rows");
assert.match(repairPhase1, /add column if not exists published_geojson_path text;/i, "phase 1 GeoJSON path must initially remain nullable");
assert.equal(/add column if not exists published_geojson_path text not null/i.test(repairPhase1), false, "phase 1 must not require a missing GeoJSON snapshot");
for (const field of ["summary", "description", "start_location", "route_type", "difficulty_system", "difficulty_value", "best_season", "equipment", "warnings", "conditions_notes"]) {
  assert.match(repairPhase1, new RegExp(`add column if not exists ${field} text`, "i"), `phase 1 must add ${field}`);
}
assert.match(repairPhase1, /revoke all privileges on table public\.mountain_community_routes\s+from anon, authenticated;/i, "phase 1 must revoke every browser table privilege");
assert.match(repairPhase1, /drop policy if exists mountain_community_routes_public_select/i, "phase 1 must remove the obsolete SELECT policy");
assert.match(repairPhase1, /drop policy if exists mountain_community_routes_owner_delete/i, "phase 1 must remove the obsolete DELETE policy");
assert.equal(/create policy mountain_community_routes_(?:public_select|owner_delete)/i.test(repairPhase1), false, "phase 1 must not recreate obsolete browser policies");
assert.equal(/grant\s+[^;]*\s+on\s+(?:table\s+)?public\.mountain_community_routes/i.test(repairPhase1), false, "phase 1 must not grant browser table privileges");
assert.match(repairPhase1, /update storage\.buckets[\s\S]*set public = false[\s\S]*application\/geo\+json[\s\S]*where id = 'community-route-tracks'/i, "phase 1 must repair the existing private bucket MIME contract");
const repairListRpc = repairPhase1.slice(
  repairPhase1.indexOf("create or replace function public.list_published_mountain_community_routes"),
  repairPhase1.indexOf("create or replace function public.get_published_mountain_community_route"),
);
const repairDetailRpc = repairPhase1.slice(
  repairPhase1.indexOf("create or replace function public.get_published_mountain_community_route"),
  repairPhase1.indexOf("revoke all on function public.list_published_mountain_community_routes"),
);
for (const privateField of ["gps_activity_id", "user_id", "published_gpx_path", "published_geojson_path"]) {
  assert.equal(repairListRpc.includes(privateField), false, `repair list RPC must not expose ${privateField}`);
  assert.equal(repairDetailRpc.includes(privateField), false, `repair detail RPC must not expose ${privateField}`);
}
assert.match(repairPhase1, /revoke all on function public\.list_published_mountain_community_routes\(bigint, integer, integer\) from public/i, "repair list RPC must revoke PUBLIC execution");
assert.match(repairPhase1, /revoke all on function public\.get_published_mountain_community_route\(uuid, bigint\) from public/i, "repair detail RPC must revoke PUBLIC execution");

const multimountainListRpc = repairMultimountain.slice(
  repairMultimountain.indexOf("create or replace function public.list_published_mountain_community_routes"),
  repairMultimountain.indexOf("drop function if exists public.get_published_mountain_community_route"),
);
const multimountainDetailRpc = repairMultimountain.slice(
  repairMultimountain.indexOf("create function public.get_published_mountain_community_route"),
  repairMultimountain.indexOf("-- 7. Revoke/grant execute on updated RPCs"),
);
const returnsTableShape = (source) => source.slice(
  source.indexOf("returns table ("),
  source.indexOf(")\nlanguage", source.indexOf("returns table (")) + 1,
).replace(/\s+/g, " ").trim();
assert.equal(returnsTableShape(multimountainListRpc), returnsTableShape(repairListRpc), "unchanged list RPC return shape must remain replaceable without a drop");
assert.notEqual(returnsTableShape(multimountainDetailRpc), returnsTableShape(repairDetailRpc), "multi-mountain detail RPC return shape must differ from deployed Phase 1");
assert.match(multimountainDetailRpc, /associated_mountains jsonb/i, "changed detail return shape must include associated mountains");

assert.match(repairMultimountain, /create table if not exists public\.mountain_community_route_mountains/, "multimountain repair must create relation table");
assert.match(repairMultimountain, /create unique index if not exists mountain_community_route_mountains_primary_unique/, "multimountain relation index must be rerun-safe");
assert.match(repairMultimountain, /revoke all privileges on table public\.mountain_community_route_mountains\s+from anon, authenticated;/i, "multimountain repair must revoke relation table privileges");
assert.match(repairMultimountain, /inner join public\.mountain_community_route_mountains as assoc/, "multimountain repair list RPC must use association table");
assert.match(repairMultimountain, /associated_mountains jsonb/, "multimountain repair detail RPC must return associated mountains");
const multimountainBegin = repairMultimountain.indexOf("begin;");
const multimountainRelationCreate = repairMultimountain.indexOf("create table if not exists public.mountain_community_route_mountains");
const multimountainDetailDrop = repairMultimountain.indexOf("drop function if exists public.get_published_mountain_community_route(uuid, bigint);");
const multimountainDetailCreate = repairMultimountain.indexOf("create function public.get_published_mountain_community_route(");
const multimountainDetailRevoke = repairMultimountain.indexOf("revoke all on function public.get_published_mountain_community_route(uuid, bigint) from public;");
const multimountainDetailGrant = repairMultimountain.indexOf("grant execute on function public.get_published_mountain_community_route(uuid, bigint) to anon, authenticated;");
const multimountainCommit = repairMultimountain.lastIndexOf("commit;");
assert.ok(multimountainBegin >= 0 && multimountainBegin < multimountainRelationCreate && multimountainDetailGrant < multimountainCommit, "multi-mountain repair must transaction-wrap every DDL and privilege statement");
assert.equal(repairMultimountain.trim().endsWith("commit;"), true, "multi-mountain repair transaction must commit only after privilege restoration");
assert.ok(multimountainDetailDrop >= 0 && multimountainDetailDrop < multimountainDetailCreate, "changed-return detail RPC must be dropped before recreation");
assert.match(repairMultimountain, /drop function if exists public\.get_published_mountain_community_route\(uuid, bigint\);[\s\S]*create function public\.get_published_mountain_community_route\(\s*requested_route_id uuid,\s*requested_mountain_id bigint\s*\)/i, "detail RPC drop and recreation must use the exact deployed signature");
assert.ok(multimountainDetailCreate < multimountainDetailRevoke && multimountainDetailRevoke < multimountainDetailGrant, "detail RPC privileges must be restored after recreation");
assert.equal(/drop function if exists public\.list_published_mountain_community_routes/i.test(repairMultimountain), false, "unchanged-return list RPC must not be dropped");
assert.equal(/^\s*(?:delete\s+from|truncate|drop\s+table)\b/im.test(repairMultimountain), false, "multimountain repair must not delete existing route data");
assert.equal(/delete\s+from\s+public\.mountain_community_routes/i.test(repairMultimountain), false, "multi-mountain repair must preserve every existing route row");

assert.match(publicationPhase2, /reviewed manual repair artifact/i, "phase 2 publication SQL must remain manual-review only");
assert.match(publicationPhase2, /create or replace function public\.publish_mountain_community_route/i, "phase 2 repair must install atomic publication RPC");
assert.match(publicationPhase2, /language plpgsql volatile security invoker set search_path = ''/i, "phase 2 publication repair must use invoker rights with an empty search path");
assert.match(publicationPhase2, /insert into public\.mountain_community_routes[\s\S]*insert into public\.mountain_community_route_mountains/i, "phase 2 repair must atomically insert route and associations");
assert.match(publicationPhase2, /from public, anon, authenticated[\s\S]*to service_role/i, "phase 2 publication repair must remain server-only");
assert.match(publicationPhase2, /create or replace function public\.finalize_mountain_community_route_backfill/i, "undeployed phase 2 artifact must install atomic backfill finalization");
assert.match(publicationPhase2, /update public\.mountain_community_routes[\s\S]*insert into public\.mountain_community_route_mountains[\s\S]*on conflict \(route_id, mountain_id\) do update/i, "phase 2 repair must atomically finalize existing route path and associations");
assert.equal(/^\s*(?:delete\s+from|truncate|drop\s+table)\b/im.test(publicationPhase2), false, "phase 2 publication repair must not mutate existing route data");

const finalizeGuard = repairFinalize.indexOf("published_geojson_path is null");
const finalizeNotNull = repairFinalize.indexOf("alter column published_geojson_path set not null");
assert.ok(finalizeGuard >= 0 && finalizeGuard < finalizeNotNull, "finalize must guard against missing snapshots before setting NOT NULL");
assert.match(repairFinalize, /raise exception 'cannot finalize: community routes still lack GeoJSON snapshots'/i, "finalize null guard must fail fast");
assert.match(repairFinalize, /unique \(published_geojson_path\)/i, "finalize must preserve unique immutable GeoJSON paths");
assert.match(repairFinalize, /cannot finalize: published community routes missing mountain associations/i, "finalize must guard missing associations");
assert.match(repairFinalize, /cannot finalize: published community routes must have exactly one primary mountain association/i, "finalize must guard exactly one primary");
assert.match(repairFinalize, /cannot finalize: primary association mountain_id does not match route\.mountain_id/i, "finalize must guard primary matches route.mountain_id");
assert.equal(/^\s*(?:delete\s+from|truncate|drop\s+table)\b/im.test(repairFinalize), false, "finalize must not delete existing route data");

assert.match(repairBackfill, /const apply = args\.includes\("--apply"\)/, "backfill mutations must require --apply");
assert.match(repairBackfill, /DRY RUN: no Storage or database mutations will occur/, "backfill must default visibly to dry-run");
assert.match(repairBackfill, /activity\.user_id !== route\.user_id/, "backfill must independently verify activity ownership");
assert.match(repairBackfill, /validateTrackForMountain\([\s\S]*targetMountainId: route\.mountain_id/, "backfill must rerun strict target-mountain validation");
assert.match(repairBackfill, /getAllDirectSummitsForTrack/, "backfill must detect all direct summits");
assert.match(repairBackfill, /verifiedMountains/, "backfill dry-run must report all verified mountains");
assert.match(repairBackfill, /const destinationPath = `\$\{route\.id\}\/route\.geojson`/, "backfill must use the immutable route GeoJSON path");
assert.match(repairBackfill, /contentType: "application\/geo\+json"[\s\S]*upsert: false/, "backfill snapshot upload must be immutable");
assert.match(repairBackfill, /\.rpc\([\s\S]*"finalize_mountain_community_route_backfill"[\s\S]*requested_published_geojson_path: destinationPath[\s\S]*requested_associations: associationRows/, "backfill must atomically finalize path and associations through the server-only RPC");
assert.equal(repairBackfill.includes('.from("mountain_community_route_mountains")'), false, "backfill must not persist associations outside the finalization transaction");
assert.equal(repairBackfill.includes('.update({ published_geojson_path: destinationPath })'), false, "backfill must not update the route path outside the finalization transaction");
const backfillDryRunGuard = repairBackfill.indexOf('validation.status !== "matched" || !apply');
const backfillSnapshotUpload = repairBackfill.indexOf(".upload(destinationPath");
const backfillFinalizeCall = repairBackfill.indexOf('"finalize_mountain_community_route_backfill"');
assert.ok(backfillDryRunGuard >= 0 && backfillDryRunGuard < backfillSnapshotUpload && backfillSnapshotUpload < backfillFinalizeCall, "dry-run must exit before Storage upload or database finalization");
assert.match(repairBackfill.slice(backfillFinalizeCall), /finalizeError[\s\S]*\.remove\(\[destinationPath\]\)[\s\S]*finalize_failed_compensation_failed[\s\S]*finalize_failed_compensated/, "failed database finalization must compensate the new Storage snapshot");
assert.match(repairBackfill, /\.is\("published_geojson_path", null\)/, "failed routes must remain selectable for retry while the path is NULL");

assert.match(recoverySql, /reviewed manual operational repair artifact[\s\S]*do not execute automatically/i, "association recovery SQL must remain a manual operational artifact");
assert.match(recoverySql, /create or replace function public\.repair_mountain_community_route_associations\(\s*requested_route_id uuid,\s*requested_associations jsonb\s*\)/i, "association recovery RPC must use the reviewed narrow signature");
assert.match(recoverySql, /returns void[\s\S]*language plpgsql volatile security invoker set search_path = ''/i, "association recovery RPC must return no internal data and use invoker rights with an empty search path");
assert.match(recoverySql, /from public\.mountain_community_routes as route[\s\S]*where route\.id = requested_route_id[\s\S]*for update/i, "association recovery must lock the existing route");
assert.match(recoverySql, /route_status <> 'published'/i, "association recovery must require published status");
assert.match(recoverySql, /route_gpx_path is distinct from \(requested_route_id::text \|\| '\/route\.gpx'\)[\s\S]*route_geojson_path is distinct from \(requested_route_id::text \|\| '\/route\.geojson'\)/i, "association recovery must require both immutable route-bound snapshot paths");
assert.match(recoverySql, /from public\.mountain_community_route_mountains as existing_association[\s\S]*existing_association\.route_id = requested_route_id[\s\S]*associations already exist/i, "association recovery must refuse non-empty existing association state");
assert.match(recoverySql, /association_count <> distinct_mountain_count[\s\S]*primary_count <> 1[\s\S]*primary_mountain_id <> route_mountain_id/i, "association recovery must reject duplicate mountains and require exactly one matching primary");
assert.match(recoverySql, /association\.distance_m is null or association\.distance_m < 0[\s\S]*association\.confidence is null or association\.confidence < 0 or association\.confidence > 1/i, "association recovery must validate distance and confidence ranges");
assert.match(recoverySql, /insert into public\.mountain_community_route_mountains[\s\S]*jsonb_to_recordset\(requested_associations\)/i, "association recovery must atomically insert the verified association set");
assert.equal(/^\s*(?:update|delete from|insert into)\s+public\.mountain_community_routes(?:\s|\()/im.test(recoverySql), false, "association recovery SQL must not mutate the existing route row");
assert.equal(/^\s*(?:delete|truncate|drop\s+table)\b/im.test(recoverySql), false, "association recovery SQL must not delete route or relation data");
assert.ok(recoverySql.indexOf("begin;") < recoverySql.indexOf("create or replace function") && recoverySql.indexOf("grant execute") < recoverySql.lastIndexOf("commit;"), "association recovery helper installation must be transaction-wrapped");
assert.match(recoverySql, /from public, anon, authenticated/i, "association recovery RPC must revoke PUBLIC and browser execution");
assert.match(recoverySql, /to service_role/i, "association recovery RPC must grant execution only to service_role");
assert.equal(/repair_mountain_community_route_associations[\s\S]*to anon|repair_mountain_community_route_associations[\s\S]*to authenticated/i.test(recoverySql), false, "association recovery RPC must not be browser-callable");
assert.equal(sql.includes("repair_mountain_community_route_associations"), false, "operational recovery helper must not become part of clean installations");

assert.match(recoveryScript, /RECOVERY_ROUTE_ID = "e0edfa4b-390c-4831-a813-7bbf472540bf"/, "recovery script must be locked to the reviewed existing route");
assert.match(recoveryScript, /routeArguments\.length !== 1[\s\S]*routeId !== RECOVERY_ROUTE_ID/, "recovery must require the explicit reviewed route argument");
assert.match(recoveryScript, /route\.status !== "published"[\s\S]*route\.published_gpx_path !== expectedGpxPath[\s\S]*route\.published_geojson_path !== expectedGeoJsonPath/, "recovery script must require exact published immutable snapshot state");
assert.match(recoveryScript, /\.from\("mountain_community_route_mountains"\)[\s\S]*count: "exact", head: true[\s\S]*associationCount !== 0/, "recovery dry run must verify association state is still empty");
assert.match(recoveryScript, /activity\.id !== 22[\s\S]*activity\.user_id !== route\.user_id[\s\S]*activity\.processing_status !== "ready"/, "recovery must verify the reviewed activity, ownership, and readiness");
assert.match(recoveryScript, /downloadRequired\(PUBLISHED_BUCKET, expectedGpxPath[\s\S]*downloadRequired\([\s\S]*PUBLISHED_BUCKET,[\s\S]*expectedGeoJsonPath[\s\S]*downloadRequired\([\s\S]*ACTIVITY_BUCKET,[\s\S]*activity\.geojson_url/, "recovery must verify immutable GPX, immutable GeoJSON, and canonical GeoJSON objects");
assert.match(recoveryScript, /validTrackGeoJson[\s\S]*LineString[\s\S]*MultiLineString/, "recovery must validate safe non-empty route FeatureCollections");
const recoveryGeometryCheck = recoveryScript.indexOf("routeGeometryMatches(canonicalGeoJson, publishedGeoJson)");
const recoveryStrictValidation = recoveryScript.indexOf("const validation = await validateTrackForMountain");
const recoveryAllSummits = recoveryScript.indexOf("const directSummits = await getAllDirectSummitsForTrack");
assert.ok(recoveryGeometryCheck >= 0 && recoveryGeometryCheck < recoveryStrictValidation && recoveryStrictValidation < recoveryAllSummits, "snapshot geometry equivalence must precede strict target and all-summit revalidation");
assert.match(recoveryScript, /primaryAssociations\.length !== 1[\s\S]*primaryAssociations\[0\]\.mountainId !== route\.mountain_id[\s\S]*uniqueMountainIds\.size !== directSummits\.length/, "recovery must enforce one unique requested primary association");
assert.equal(/\.upload\(|\.remove\(|\.move\(/.test(recoveryScript), false, "recovery must never mutate immutable Storage objects");
assert.equal(/\.from\("mountain_community_routes"\)[\s\S]*\.(?:update|delete|insert|upsert)\(/.test(recoveryScript), false, "recovery script must never mutate or duplicate the existing route");
const recoveryApplyGuard = recoveryScript.indexOf("if (apply) {");
const recoveryRpcCall = recoveryScript.indexOf('"repair_mountain_community_route_associations"');
assert.ok(recoveryApplyGuard >= 0 && recoveryApplyGuard < recoveryRpcCall, "dry run must perform zero association mutations without --apply");
assert.match(recoveryScript, /const verifiedMountains = directSummits\.map[\s\S]*routeId: route\.id[\s\S]*primaryMountainId: route\.mountain_id[\s\S]*verifiedMountains[\s\S]*publishedGeojsonPath: route\.published_geojson_path[\s\S]*validated_dry_run/, "dry run must emit only reviewed recovery details without secrets or signed URLs");
assert.equal(/signedUrl|serviceKey\s*[,}]/.test(recoveryScript.slice(recoveryScript.indexOf("console.log(JSON.stringify"))), false, "recovery output must not expose secrets or signed URLs");
assert.ok(listPage.includes('.rpc(\n    "list_published_mountain_community_routes"') && !listPage.includes('.from("mountain_community_routes")'), "mountain page must read the safe public list RPC");
assert.ok(detail.includes('supabase.rpc("get_published_mountain_community_route"') && !detail.includes('supabase.from("mountain_community_routes")'), "detail metadata must read the safe public detail RPC");
assert.equal(detail.includes("published_geojson_path") || detail.includes("published_gpx_path") || detail.includes("gps_activity_id"), false, "detail HTML source must not consume private system fields");
assert.ok(detail.includes("createAdminClient") && detail.includes('.eq("user_id", auth.user.id)') && detail.includes("owner = Boolean(ownedRoute)"), "owner determination must be a separate trusted server check");
assert.ok(publish.indexOf('.eq("user_id", auth.user.id)') < publish.indexOf("const validation = await validateTrackForMountain"), "ownership must be checked before validation/publication");
assert.ok(publish.includes("validateTrackForMountain") && !publish.includes("detected_mountain_id"), "server must independently detect instead of trusting stored/browser detection");
assert.ok(publish.includes("publishedPath") && publish.includes("originalGpx"), "publication must create an immutable GPX snapshot");
assert.equal(publish.includes('.from("gps_activities").delete'), false, "publication failure must not delete the canonical activity");
assert.ok(publish.includes("getAllDirectSummitsForTrack"), "publication must detect all direct summits");
assert.ok(publish.includes('.rpc("publish_mountain_community_route"'), "publication must use the atomic server-only RPC");
assert.equal(publish.includes('.from("mountain_community_routes").insert'), false, "route row must not be inserted outside the publication transaction");
assert.equal(publish.includes('.from("mountain_community_route_mountains")'), false, "association rows must not be inserted outside the publication transaction");
assert.equal(publish.includes('.delete().eq("id", routeId)'), false, "publication must not depend on compensating route-row deletion");
const gpxSnapshotUpload = publish.indexOf(".upload(publishedPath");
const geoJsonSnapshotUpload = publish.indexOf(".upload(publishedGeoJsonPath");
const publicationTransaction = publish.indexOf('.rpc("publish_mountain_community_route"');
assert.ok(gpxSnapshotUpload >= 0 && gpxSnapshotUpload < geoJsonSnapshotUpload && geoJsonSnapshotUpload < publicationTransaction, "both immutable snapshots must upload before the atomic database transaction");
assert.match(publish.slice(publicationTransaction), /publishError[\s\S]*\.remove\(\[publishedPath, publishedGeoJsonPath\]\)/, "database publication failure must compensate both new snapshots");
assert.ok(download.includes('.eq("id", routeId)') && download.includes('.eq("mountain_id", mountainId)') && download.includes('.eq("status", "published")'), "download must bind route, mountain, and published state");
assert.ok(download.includes('route.published_gpx_path !== `${route.id}/route.gpx`'), "download must enforce the immutable path contract");
assert.ok(download.includes("createAdminClient") && download.includes("community-route-tracks"), "GPX delivery must remain server-bound");
assert.ok(download.includes("mountain_community_route_mountains"), "GPX endpoint must check association table");
assert.ok(geojson.includes("createAdminClient") && geojson.includes('.eq("id", routeId)') && geojson.includes('.eq("mountain_id", mountainId)') && geojson.includes('.eq("status", "published")'), "GeoJSON delivery must remain server-bound to route, mountain, and published state");
assert.ok(geojson.includes('route.published_geojson_path !== `${route.id}/route.geojson`'), "GeoJSON delivery must enforce the immutable path contract");
assert.ok(geojson.includes("mountain_community_route_mountains"), "GeoJSON endpoint must check association table");
assert.ok(update.includes('.eq("id", routeId).eq("user_id", auth.user.id)'), "owner identity must be enforced in the route lookup and update");
assert.ok(update.includes("validateCommunityRouteContent(body)"), "server content validation missing");
assert.equal(update.includes(".update(requestBody)"), false, "request body must never be mass-assigned");
const updateObject = update.slice(update.indexOf('.update({'), update.indexOf('}).eq("id", routeId)', update.indexOf('.update({')));
for (const immutable of ["mountain_id", "gps_activity_id", "user_id", "validation_distance_m", "validation_confidence", "distance_m", "elevation_gain_m", "duration_seconds", "published_gpx_path", "published_geojson_path", "status", "published_at"]) {
  assert.equal(updateObject.includes(`${immutable}:`), false, `${immutable} must remain immutable in PATCH`);
}
assert.ok(detail.includes("owner && <CommunityRouteEditor"), "edit UI must be owner-only");
assert.equal(detail.includes("dangerouslySetInnerHTML"), false, "public user content must not use raw HTML");
assert.ok(detail.includes("route.description &&") && detail.includes("route.equipment &&") && detail.includes("route.warnings &&"), "empty optional fields must be conditionally omitted");

function shape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
}
let expected;
for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
  const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}/mountain.json`, import.meta.url), "utf8"));
  assert.ok(catalog.Mountain?.CommunityRoutes, `${locale} CommunityRoutes namespace missing`);
  const current = shape(catalog.Mountain.CommunityRoutes);
  expected ??= current;
  assert.deepEqual(current, expected, `${locale} CommunityRoutes locale shape differs`);
}

console.log("Community mountain route contracts passed.");
