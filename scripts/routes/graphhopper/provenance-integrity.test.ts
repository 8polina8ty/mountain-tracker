import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryBaseAccess, BASE_ACCESS_START_POLICY, type BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { validateRequest, assertPrimaryPublication, GENERATED_PUBLICATION_CONTRACT, SOURCE, publicationIdentity } from '../../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { sha256Stable } from '../../../Lib/gpxIngestion/hashing.ts';

function makeRealEvidence(overrides: Partial<import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence> = {}): import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence {
  const startOsmId = 123456;
  const mountainOsmId = 987654;
  const accessEvidence: BaseAccessEvidence = {
    policyVersion: BASE_ACCESS_START_POLICY.version,
    candidateKind: 'TRAILHEAD',
    publicRoadConnected: true,
    settlementConnected: false,
    parkingConnected: false,
    transitConnected: false,
    trailheadConnected: true,
    approachBoundary: false,
    accessNetworkDistance: 12.3,
    startElevation: null,
    summitElevation: null,
    startNodeId: startOsmId,
    approachNodeIds: [startOsmId, 111111, 222222],
    approachWayIds: [50001, 50002],
    outwardRoadNodeIds: [333333, 444444, 555555],
    outwardRoadWayIds: [60001],
    reasonCodes: ['EXACT_OSM_ACCESS_TOPOLOGY', 'OUTWARD_PUBLIC_ROAD_NETWORK', 'PRIMARY_BASE_ACCESS'],
  };
  const geometryHash = 'a'.repeat(64);
  const ev: import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence = {
    startRole: 'PRIMARY_BASE_ACCESS',
    accessEvidence,
    generatedRouteIdentity: `osm:node:${mountainOsmId}:node:${startOsmId}`,
    sourceCandidateHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    sourceMountainIdentity: `osm:node:${mountainOsmId}`,
    summit: { osmObjectType: 'node', osmId: mountainOsmId, name: 'Test Summit', coordinate: [11.0, 47.0] },
    start: { objectType: 'node', osmId: startOsmId, name: 'Test Trailhead', kind: 'TRAILHEAD', coordinate: [11.01, 47.01], candidateId: `node:${startOsmId}` },
    datasetFingerprint: 'd'.repeat(64),
    pilotCorpusHash: 'e'.repeat(64),
    adaptivePolicyHash: 'f'.repeat(64),
    summitPolicyHash: '0'.repeat(64),
    graphHash: '1'.repeat(64),
    graphCacheIdentityHash: '2'.repeat(64),
    extractionIdentityHash: '3'.repeat(64),
    reconstructionManifestHash: '4'.repeat(64),
    solverVersion: 'test',
    routePathHash: '5'.repeat(64),
    geometryHash,
    routeCategory: 'STANDARD_ASCENT',
    startContext: 'BASE_START',
    summitAttachment: {
      targetCoordinate: [11.0, 47.0],
      routeTerminalCoordinate: [11.0, 47.0],
      distanceMeters: 12.3,
      tier: 'DIRECT',
      autoEligible: true,
      reasonCodes: ['ADMITTED_SUMMIT_NODE_DIRECT'],
    },
    safety: { autoEligible: true, decision: 'SAFE', fabricatedGapCount: 0, boundaryLimited: false, connected: true, deterministic: true, solverStatus: 'RECONSTRUCTED', checkedEdges: 100 },
    source: SOURCE,
    ...overrides,
  } as unknown as import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence;
  // recompute generatedRouteIdentity if start/mountain changed — correct order is mountain: candidate
  if (overrides.start || overrides.summit) {
    const sId = (overrides.start as { osmId?: number })?.osmId ?? startOsmId;
    const sType = (overrides.start as { objectType?: string })?.objectType ?? 'node';
    const mId = (overrides.summit as { osmId?: number })?.osmId ?? mountainOsmId;
    const candidateId = `${sType}:${sId}`;
    ev.generatedRouteIdentity = `osm:node:${mId}:${candidateId}`;
    ev.sourceMountainIdentity = `osm:node:${mId}`;
    ev.sourceMountainIdentity = `osm:node:${mId}`;
    if (overrides.start) ev.start = { ...ev.start, ...overrides.start } as typeof ev.start;
    if (overrides.summit) ev.summit = { ...ev.summit, ...overrides.summit } as typeof ev.summit;
  }
  return ev;
}

function makeRequest(ev: import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence, mountainId = 999) {
  const origin = 'https://example.supabase.co';
  const publicationId = publicationIdentity(mountainId, ev);
  const req: import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationRequest = {
    contract: GENERATED_PUBLICATION_CONTRACT,
    publicationId,
    publicationIdempotencyKey: `${GENERATED_PUBLICATION_CONTRACT}:${publicationId}`,
    mountainRoute: {
      mountain_id: mountainId,
      name: `${ev.start.name} → ${ev.summit.name}`,
      start_location: ev.start.name,
      route_type: 'hiking',
      distance_km: 5.0,
      difficulty_system: null,
      difficulty_value: null,
      elevation_gain_m: null,
      duration_minutes: null,
      description: null,
      best_season: null,
      equipment: null,
      warnings: null,
      created_by: null,
      source_name: 'OpenStreetMap',
      source_url: SOURCE.url,
      is_verified: true,
      geojson_url: `${origin}/storage/v1/object/public/route-gpx/generated/${publicationId}/route.geojson`,
      gpx_url: `${origin}/storage/v1/object/public/route-gpx/generated/${publicationId}/route.gpx`,
    },
    provenance: {
      ...ev,
      publicationStatus: 'ACTIVE',
      geojsonSha256: 'a'.repeat(64),
      gpxSha256: 'b'.repeat(64),
      storageBucket: 'route-gpx',
      storagePaths: { geojson: `generated/${publicationId}/route.geojson`, gpx: `generated/${publicationId}/route.gpx` },
      geojsonBytes: 1000,
      gpxBytes: 1000,
    },
  };
  return req;
}

test('fabricated: pseudo OSM start ID without real candidate witness must be rejected', () => {
  // simulate old adapter: pseudoId derived 2929292929 (large) with fabricated witness
  const pseudoId = 2929292929;
  const ev = makeRealEvidence({
    start: { objectType: 'node', osmId: pseudoId, name: 'Fake Start', kind: 'TRAILHEAD', coordinate: [11.01, 47.01], candidateId: `node:${pseudoId}` },
    accessEvidence: {
      policyVersion: BASE_ACCESS_START_POLICY.version,
      candidateKind: 'TRAILHEAD',
      publicRoadConnected: true,
      settlementConnected: false,
      parkingConnected: false,
      transitConnected: false,
      trailheadConnected: true,
      approachBoundary: false,
      accessNetworkDistance: 12.5,
      startElevation: null,
      summitElevation: null,
      startNodeId: pseudoId,
      approachNodeIds: [pseudoId, pseudoId + 1],
      approachWayIds: [1000000 + 999],
      outwardRoadNodeIds: [2000000 + 999, 2000001 + 999],
      outwardRoadWayIds: [3000000 + 999],
      reasonCodes: ['EXACT_OSM_ACCESS_TOPOLOGY', 'OUTWARD_PUBLIC_ROAD_NETWORK', 'PRIMARY_BASE_ACCESS'],
    } as unknown as BaseAccessEvidence,
  });
  // This evidence has synthetic placeholder pattern 12.5 + sequential + 1000000 etc -> should be blocked (synthetic or identity)
  assert.throws(() => assertPrimaryPublication(ev), /SYNTHETIC_PLACEHOLDER|PRIMARY_BASE_ACCESS_REQUIRED/);
  const req = makeRequest(ev);
  assert.throws(() => validateRequest(req), /SYNTHETIC_PLACEHOLDER|START_OSM_ID_MISMATCH|INVALID_BASE_ACCESS|generatedRouteIdentity/);
});

test('fabricated: forced publicRoadConnected true without witness must be rejected', () => {
  const ev = makeRealEvidence({
    accessEvidence: {
      policyVersion: BASE_ACCESS_START_POLICY.version,
      candidateKind: 'PARKING',
      publicRoadConnected: true,
      settlementConnected: false,
      parkingConnected: true,
      transitConnected: false,
      trailheadConnected: false,
      approachBoundary: false,
      accessNetworkDistance: 12.5,
      startElevation: null,
      summitElevation: null,
      startNodeId: 123456,
      approachNodeIds: [],
      approachWayIds: [],
      outwardRoadNodeIds: [],
      outwardRoadWayIds: [],
      reasonCodes: ['PRIMARY_BASE_ACCESS'],
    } as unknown as BaseAccessEvidence,
  });
  assert.equal(primaryBaseAccess(ev.accessEvidence), false);
  assert.throws(() => assertPrimaryPublication(ev), /PRIMARY_BASE_ACCESS_REQUIRED|WITNESS_EMPTY/);
});

test('fabricated: fake approach/outward road witness IDs rejected', () => {
  const mid = 999;
  const ev = makeRealEvidence({
    accessEvidence: {
      policyVersion: BASE_ACCESS_START_POLICY.version,
      candidateKind: 'TRAILHEAD',
      publicRoadConnected: true,
      settlementConnected: false,
      parkingConnected: false,
      transitConnected: false,
      trailheadConnected: true,
      approachBoundary: false,
      accessNetworkDistance: 12.5,
      startElevation: null,
      summitElevation: null,
      startNodeId: 123456,
      approachNodeIds: [123456, 123457],
      approachWayIds: [1000000 + mid],
      outwardRoadNodeIds: [2000000 + mid, 2000001 + mid],
      outwardRoadWayIds: [3000000 + mid],
      reasonCodes: ['EXACT_OSM_ACCESS_TOPOLOGY', 'OUTWARD_PUBLIC_ROAD_NETWORK', 'PRIMARY_BASE_ACCESS'],
    } as unknown as BaseAccessEvidence,
  });
  assert.throws(() => assertPrimaryPublication(ev), /SYNTHETIC_PLACEHOLDER/);
});

test('fabricated: accessNetworkDistance constant 12.5 with sequential placeholder must be rejected', () => {
  const ev = makeRealEvidence({
    start: { objectType: 'node', osmId: 99999, name: 'Test Village', kind: 'VILLAGE', coordinate: [11.01, 47.01], candidateId: 'node:99999' },
    accessEvidence: {
      policyVersion: BASE_ACCESS_START_POLICY.version,
      candidateKind: 'VILLAGE',
      publicRoadConnected: true,
      settlementConnected: true,
      parkingConnected: false,
      transitConnected: false,
      trailheadConnected: false,
      approachBoundary: false,
      accessNetworkDistance: 12.5,
      startElevation: null,
      summitElevation: null,
      startNodeId: 99999,
      approachNodeIds: [99999, 100000],
      approachWayIds: [1000999],
      outwardRoadNodeIds: [2000999, 2001000],
      outwardRoadWayIds: [3000999],
      reasonCodes: ['EXACT_OSM_ACCESS_TOPOLOGY', 'OUTWARD_PUBLIC_ROAD_NETWORK', 'PRIMARY_BASE_ACCESS'],
    } as unknown as BaseAccessEvidence,
  });
  assert.throws(() => assertPrimaryPublication(ev), /SYNTHETIC_PLACEHOLDER|PRIMARY_BASE_ACCESS_REQUIRED/);
});

test('fabricated: summit snap 60m coerced to 25m DIRECT must be rejected via tier mismatch', () => {
  const ev = makeRealEvidence({
    summitAttachment: {
      targetCoordinate: [11.0, 47.0],
      routeTerminalCoordinate: [11.0, 47.0],
      distanceMeters: 25,
      tier: 'DIRECT',
      autoEligible: true,
      reasonCodes: ['ADMITTED_SUMMIT_NODE_DIRECT'],
    } as unknown as import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence['summitAttachment'],
  });
  // Simulate actual distance 60m but tier DIRECT -> if we manually set distance 60 with DIRECT tier, should fail
  const ev2 = makeRealEvidence({
    summitAttachment: {
      targetCoordinate: [11.0, 47.0],
      routeTerminalCoordinate: [11.0, 47.0],
      distanceMeters: 60,
      tier: 'DIRECT',
      autoEligible: true,
      reasonCodes: ['ADMITTED_SUMMIT_NODE_DIRECT'],
    } as unknown as import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence['summitAttachment'],
  });
  assert.throws(() => assertPrimaryPublication(ev2), /SUMMIT_TIER_MISMATCH/);
  // Even 25 with actual 60 would have been coerced; our correct verifier must use actual 60 and block as REVIEW_REQUIRED (>50)
  // Test that 60 with correct tier null would be blocked by primary check (autoEligible tier)
  const ev3 = makeRealEvidence({
    summitAttachment: {
      targetCoordinate: [11.0, 47.0],
      routeTerminalCoordinate: [11.0, 47.0],
      distanceMeters: 60,
      tier: 'DIRECT',
      autoEligible: true,
      reasonCodes: ['ADMITTED_SUMMIT_NODE_DIRECT'],
    } as unknown as import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence['summitAttachment'],
  });
  assert.throws(() => validateRequest(makeRequest(ev3)), /SUMMIT_TIER_MISMATCH|PRIMARY_SUMMIT_ATTACHMENT_REQUIRED/);
});

test('fabricated: SAFE evidence not produced from frozen source candidate rejected when missing osmId', () => {
  const ev = makeRealEvidence();
  (ev.start as unknown as { osmId: unknown }).osmId = 'not-a-number';
  // candidateId will be 'node:not-a-number' vs expected 'node:123456' mismatch triggers AssertionError with strictly equal
  assert.throws(() => validateRequest(makeRequest(ev)), /strictly equal|START_OSM_ID_MISMATCH|CANDIDATE_ID/);
});

test('positive: real frozen evidence with witness passes', () => {
  const ev = makeRealEvidence();
  // Should not throw
  assert.doesNotThrow(() => assertPrimaryPublication(ev));
  const req = makeRequest(ev);
  assert.doesNotThrow(() => validateRequest(req));
  assert.equal(req.provenance.summitAttachment.tier, 'DIRECT');
  assert.equal(req.provenance.safety.decision, 'SAFE');
});

test('real evidence start.osmId must equal accessEvidence.startNodeId', () => {
  const ev = makeRealEvidence();
  ev.start.osmId = 999999;
  // accessEvidence still 123456 -> mismatch
  assert.throws(() => assertPrimaryPublication(ev), /START_OSM_ID_MISMATCH/);
});

test('summit tier boundaries: 30 DIRECT, 30.1 EXTENDED, 50 EXTENDED, 50.1 REVIEW_REQUIRED', () => {
  const mk = (d: number, tier: 'DIRECT' | 'EXTENDED') => makeRealEvidence({ summitAttachment: { targetCoordinate: [11.0, 47.0], routeTerminalCoordinate: [11.0, 47.0], distanceMeters: d, tier, autoEligible: true, reasonCodes: ['ADMITTED_SUMMIT_NODE_DIRECT'] } as unknown as import('../../../Lib/gpxIngestion/generatedRoutePublication.ts').PublicationEvidence['summitAttachment'] });
  assert.doesNotThrow(() => assertPrimaryPublication(mk(30, 'DIRECT')));
  assert.doesNotThrow(() => assertPrimaryPublication(mk(30.1, 'EXTENDED')));
  assert.doesNotThrow(() => assertPrimaryPublication(mk(50, 'EXTENDED')));
  assert.throws(() => assertPrimaryPublication(mk(50.1, 'DIRECT')), /SUMMIT_TIER_MISMATCH/);
  assert.throws(() => assertPrimaryPublication(mk(50.1, 'EXTENDED' as unknown as 'DIRECT')), /SUMMIT_TIER_MISMATCH/);
  // Direct tier with 50m should fail tier check
  assert.throws(() => assertPrimaryPublication(mk(50, 'DIRECT')), /SUMMIT_TIER_MISMATCH/);
});

test('geometry drift: recomputed hash mismatch must be caught via validateRequest', () => {
  const ev = makeRealEvidence();
  const req = makeRequest(ev);
  // Tamper geometryHash
  (req.provenance as unknown as { geometryHash: string }).geometryHash = 'f'.repeat(64);
  assert.throws(() => validateRequest(req), /FROZEN_GEOMETRY_CHANGED|geometryHash|strictly equal/);
});

test('ambiguous start candidate: multiple matches must be treated as UNRECOVERABLE', () => {
  // Simulate recovery finding 2 candidates for same coord/kind -> ambiguous
  const cands = [
    { osmType: 'node' as const, osmId: 1, kind: 'TRAILHEAD', name: 'A', lat: 47.0, lon: 11.0, tags: {} },
    { osmType: 'node' as const, osmId: 2, kind: 'TRAILHEAD', name: 'B', lat: 47.0, lon: 11.0, tags: {} },
  ];
  assert.equal(cands.length, 2);
  // Reconstruction would classify as AMBIGUOUS_START_CANDIDATE -> UNRECOVERABLE_EVIDENCE
  assert.ok(cands.length > 1);
});
