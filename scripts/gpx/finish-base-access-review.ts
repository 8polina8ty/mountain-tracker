/** Complete the checkpoint's review artifacts without regenerating a single route. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes, sha256Stable, stableJson } from '../../Lib/gpxIngestion/hashing.ts';
import { primaryBaseAccess, publicApproachRoad, BASE_ACCESS_START_POLICY } from '../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { calculateCoordinateDistanceMeters } from '../../Lib/gpxIngestion/gpxNormalization.ts';
import type { AdaptiveStartDiscoveryResult } from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import type { CanaryManifest, FrozenRow, Line } from '../../Lib/gpxIngestion/generatedRoutePublication.ts';
import type { OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { geometryReview, productReviewReasons, PRODUCT_REVIEW_RULES } from './base-access-product-review.ts';

assert.equal(process.argv.length, 2, 'REVIEW_ONLY_NO_EXECUTE');
const root = 'data/gpx/base-access-start-v2', pilot = 'data/gpx/adaptive-start-pilot';
const read = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const manifestPath = 'data/gpx/generated-route-publication/generated-route-canary-v1.json';
const manifest = await read<CanaryManifest>(manifestPath);
const oldRows = await read<FrozenRow[]>(`${pilot}/adaptive-start-component-v2-results.json`);
const checkpoint = await read<{ corpusHash: string; rows: { mountainId: number; resultHash: string; determinismVerified: boolean }[] }>(`${root}/comparison.json`);
assert.deepEqual(checkpoint.rows.map(r => r.mountainId), manifest.entries.map(e => e.request.mountainRoute.mountain_id));
const protectedPaths = [manifestPath, `${root}/comparison.json`, `${root}/comparison.sha256`, `${root}/REVIEW.md`,
  ...manifest.entries.flatMap(e => {
    const id = e.request.mountainRoute.mountain_id;
    return [`${root}/${id}-evaluation.json`, `${root}/${id}-comparison.geojson`, `${root}/${id}-comparison.png`, `${root}/${id}.gpx`,
      ...(['gpx', 'geojson'] as const).map(k => `data/gpx/generated-route-publication/${e.files[k].path}`)];
  })];
const protectedHashes = Object.fromEntries(await Promise.all(protectedPaths.map(async p => [p, sha256Bytes(await readFile(p))])));
const features = new AdaptiveStartFeatureIndex(await loadPhase11f2FeatureIndex('data/osm/alps/staging/phase11f2-features'));
const ReadOnly = DatabaseSync as unknown as { new(p: string, o: { readOnly: true }): DatabaseSync };
const db = new ReadOnly(`${pilot}/cache/${checkpoint.corpusHash}.sqlite`, { readOnly: true });
const query = db.prepare('SELECT payload FROM ways WHERE id=?');
const mainRoads = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary']);
const rows = [];
try {
  for (const entry of manifest.entries) {
    const id = entry.request.mountainRoute.mountain_id, provenance = entry.request.provenance;
    const result = await read<AdaptiveStartDiscoveryResult>(`${root}/${id}-evaluation.json`);
    const { resultHash, timings: _t, componentCacheHit: _c, ...hashContent } = result;
    void [_t, _c];
    assert.equal(sha256Stable(hashContent), resultHash, 'CHECKPOINT_RESULT_HASH_INVALID');
    assert.equal(checkpoint.rows.find(r => r.mountainId === id)!.resultHash, resultHash);
    assert(checkpoint.rows.find(r => r.mountainId === id)!.determinismVerified);
    const c = result.candidates[0]; assert(c?.route && c.accessEvidence);
    assert.equal(c.safety, 'SAFE'); assert.equal(c.autoEligible, true); assert.equal(result.fabricatedGapCount, 0);
    const old = oldRows.find(r => r.mountainId === provenance.sourceMountainIdentity)!.candidates.find(c => c.id === provenance.start.candidateId)!;
    const comparison = await read<{ features: { geometry: Line }[] }>(`${root}/${id}-comparison.geojson`);
    const oldGeometry = comparison.features[0].geometry, newGeometry = comparison.features[1].geometry;
    const geometry = geometryReview({ nodes: old.route!.osmNodeIds, coordinates: oldGeometry.coordinates },
      { nodes: c.route.osmNodeIds, coordinates: newGeometry.coordinates });
    const e = c.accessEvidence;
    const roads = new Map<number, OsmTrailWayInput>();
    for (const wayId of [...new Set(e.outwardRoadWayIds)]) {
      const record = query.get(wayId); assert(record, 'MISSING_WITNESS_WAY');
      const w = JSON.parse(String(record.payload)) as OsmTrailWayInput;
      assert(publicApproachRoad(w), 'PUBLIC_ROAD_WITNESS_REJECTED'); roads.set(wayId, w);
    }
    let distanceToMainRoad = 0, outwardDistance = 0, mainReached = false;
    for (let i = 0; i < e.outwardRoadWayIds.length; i++) {
      const w = roads.get(e.outwardRoadWayIds[i])!;
      const from = e.outwardRoadNodeIds[i], to = e.outwardRoadNodeIds[i + 1];
      assert(w.nodes.some((n, j) => j > 0 && ((n.nodeId === to && w.nodes[j - 1].nodeId === from) || (n.nodeId === from && w.nodes[j - 1].nodeId === to))), 'WITNESS_GAP');
      const length = calculateCoordinateDistanceMeters(w.nodes.find(n => n.nodeId === from)!.coordinate!, w.nodes.find(n => n.nodeId === to)!.coordinate!);
      mainReached ||= mainRoads.has(w.tags.highway);
      if (!mainReached) distanceToMainRoad += length;
      outwardDistance += length;
    }
    assert(mainReached && outwardDistance >= BASE_ACCESS_START_POLICY.minimumOutwardRoadMeters);
    const roadFacts = [...roads.values()].map(w => ({ osmWayId: w.id, tags: w.tags }));
    const nearby = features.queryStarts(c.anchor!.coordinate!, 250).map(f => ({ osmIdentity: f.identity, name: f.name,
      kind: f.kind, distanceMeters: Math.round(calculateCoordinateDistanceMeters(c.anchor!.coordinate!, f.coordinate)), tags: f.tags }));
    const reviewReasons = productReviewReasons({ oldDistance: old.route!.distanceM, newDistance: c.route.distanceM,
      serviceDistanceToMainRoad: distanceToMainRoad, differentApproachSide: geometry.differentApproachSide,
      oldSharedFraction: geometry.oldCoverage.sharedFraction, publicAccessVerified: primaryBaseAccess(e) });
    const oldIsHut = /HUT|REFUGE/.test(provenance.start.kind);
    const visitsOldHut = oldIsHut ? c.route.osmNodeIds.includes(provenance.start.osmId) : null;
    const contextNames = [...new Set(c.networkAccess?.approachWays.map(w => w.accessTags.name).filter(Boolean) ?? [])].sort();
    const displayName = contextNames.length ? `${contextNames.join(' / ')} public-road boundary` :
      c.name.startsWith('Network access') || c.name.startsWith('TRAILHEAD_INFO ') ? `Public-road boundary at OSM node ${e.startNodeId}` : c.name;
    const row = {
      mountainId: id, summitName: result.request.summit.name, summitCoordinate: result.request.summit.coordinate,
      old: { startName: provenance.start.name, osmIdentity: provenance.start.candidateId, kind: provenance.start.kind,
        startContext: old.startContext?.type, startElevation: old.startContext?.startElevationMeters ?? null,
        routeCategory: provenance.routeCategory, distanceMeters: old.route!.distanceM, startCoordinate: old.route!.startCoordinate },
      new: { startName: displayName, generatedName: c.name, osmIdentity: `${c.osmIdentity.objectType}:${c.osmIdentity.osmId}`,
        candidateId: c.id, actualStartOsmNodeId: e.startNodeId, actualStartCoordinate: c.anchor!.coordinate,
        candidateKind: c.kind, startElevation: e.startElevation, summitElevation: result.request.summit.elevationMeters,
        distanceMeters: c.route.distanceM, routeCategory: c.category, startRole: c.startRole, accessEvidence: e,
        generatorAutoEligible: c.autoEligible, safety: c.safety, summitAttachment: result.summitAttachment },
      productStatus: reviewReasons.length ? 'NEEDS_REVIEW' : 'AUTO_ELIGIBLE', reviewReasons,
      assessment: reviewReasons.length ? 'Access passes the V2 topology gate; normal usability/ascent choice requires human review.' :
        'Plausible public-road origin with no detected detour/remote-service/variant concern; human approval and replacement remain pending.',
      geometry, passesOldStart: geometry.exactOldStartVisited, passesOldHut: visitsOldHut,
      publicApproachContext: { distanceToMainRoadMeters: Math.round(distanceToMainRoad), outwardWitnessDistanceMeters: Math.round(outwardDistance),
        roads: roadFacts, nearbyFeaturesWithin250Meters: nearby, currentLegalAccessIndependentlyVerified: false,
        note: 'OSM public-road semantics and topology are source evidence, not a current road opening or customary-ascent certification.' },
      resultHash, deterministicReplayVerified: true, fabricatedGapCount: 0,
      artifacts: { evaluation: `${id}-evaluation.json`, gpx: `${id}.gpx`, originalComparison: `${id}-comparison.geojson`,
        markerComparison: `${id}-review.geojson`, plot: `${id}-comparison.png` },
    };
    rows.push(row);
    await writeFile(`${root}/${id}-review.geojson`, stableJson({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { role: 'OLD_ROUTE', name: provenance.start.name }, geometry: oldGeometry },
      { type: 'Feature', properties: { role: 'V2_ROUTE', name: displayName, productStatus: row.productStatus }, geometry: newGeometry },
      { type: 'Feature', properties: { role: 'OLD_START', name: provenance.start.name }, geometry: { type: 'Point', coordinates: oldGeometry.coordinates[0] } },
      { type: 'Feature', properties: { role: 'V2_START', name: displayName, osmNodeId: e.startNodeId }, geometry: { type: 'Point', coordinates: newGeometry.coordinates[0] } },
      { type: 'Feature', properties: { role: 'TARGET_SUMMIT', name: result.request.summit.name }, geometry: { type: 'Point', coordinates: result.request.summit.coordinate } },
      { type: 'Feature', properties: { role: 'ROUTE_TERMINAL', summitAttachmentTier: result.summitAttachment!.tier }, geometry: { type: 'Point', coordinates: newGeometry.coordinates.at(-1) } },
    ] }) + '\n');
    console.log(JSON.stringify({ id, status: row.productStatus, reasons: reviewReasons, sideDegrees: geometry.sideDifferenceDegrees,
      oldOverlap: geometry.oldCoverage.sharedFraction, serviceDistance: Math.round(distanceToMainRoad) }));
  }
} finally { db.close(); }
for (const [p, hash] of Object.entries(protectedHashes)) assert.equal(sha256Bytes(await readFile(p)), hash, `CHECKPOINT_MODIFIED:${p}`);
const final = { version: PRODUCT_REVIEW_RULES.version, policy: BASE_ACCESS_START_POLICY, reviewRules: PRODUCT_REVIEW_RULES,
  sourceCheckpointSha256: protectedHashes[`${root}/comparison.json`], protectedArtifactHashes: protectedHashes,
  regeneratedInThisCompletion: 0, ready: rows.filter(r => r.productStatus === 'AUTO_ELIGIBLE').length,
  needsReview: rows.filter(r => r.productStatus === 'NEEDS_REVIEW').length,
  writes: { database: 0, storage: 0, publication: 0 }, rows };
await writeFile(`${root}/final-review.json`, JSON.stringify(final, null, 2) + '\n');
console.log(JSON.stringify({ ready: final.ready, needsReview: final.needsReview, regenerated: 0, writes: final.writes }));
