/** Synthetic fixtures for Route Factory unit tests — minimal fully eligible candidates and rows. */
import type { FactorySourceMeta } from './route-factory.ts';

export const AUTO_ELIGIBLE_CANDIDATE = {
  id: 'way:1',
  name: 'Parkplatz Test',
  kind: 'TRAILHEAD',
  osmIdentity: { objectType: 'way', osmId: 1 },
  coordinate: [12.0, 47.0],
  tags: { name: 'Parkplatz Test' },
  radiusTier: 10_000,
  airDistanceMeters: 1000,
  anchor: { status: 'RESOLVED' },
  networkDistanceMeters: 1200,
  routeDistanceMeters: 4200,
  elevationGainMeters: 1200,
  elevationGainSource: 'COMPLETE_ROUTE_OSM_ELEVATIONS',
  verticalGainMeters: 1200,
  solverStatus: 'RECONSTRUCTED',
  startContext: { type: 'BASE_START' },
  safety: 'SAFE',
  safetyReasons: [],
  autoEligible: true,
  category: 'STANDARD_ASCENT',
  reasons: [],
  duplicateOf: null,
  networkAccess: null,
  accessEvidence: {
    policyVersion: 'mountain-tracker/base-access-start-policy/v2',
    candidateKind: 'TRAILHEAD',
    publicRoadConnected: true,
    settlementConnected: false,
    parkingConnected: false,
    transitConnected: false,
    trailheadConnected: true,
    approachBoundary: false,
    accessNetworkDistance: 10,
    startElevation: 800,
    summitElevation: 2000,
    startNodeId: 1,
    approachNodeIds: [1],
    approachWayIds: [1],
    outwardRoadNodeIds: [1, 2, 3],
    outwardRoadWayIds: [1],
    reasonCodes: ['PRIMARY_BASE_ACCESS'],
  },
  startRole: 'PRIMARY_BASE_ACCESS',
  route: {
    geometryHash: '0'.repeat(64),
    reconstructionManifestHash: '1'.repeat(64),
    solverVersion: 'mountain-tracker/osm-a-star-route-solver/v1',
    graphHash: '2'.repeat(64),
    distanceM: 4200,
    osmNodeIds: [1, 2, 3, 4],
    osmWayIds: [1],
    startCoordinate: [12.0, 47.0],
    terminalCoordinate: [12.01, 47.01],
    geometrySource: 'OPENSTREETMAP',
  },
};

export function buildFixtureRow(candidates: readonly (typeof AUTO_ELIGIBLE_CANDIDATE)[] = [AUTO_ELIGIBLE_CANDIDATE]) {
  return {
    mountainId: 'osm:node:50473',
    name: 'Test Peak',
    blockId: 'test',
    stratum: 'NORMAL',
    status: 'STARTS_FOUND',
    graphStatus: 'READY',
    reasons: [],
    summitAttachment: { autoEligible: true, tier: 'DIRECT' },
    candidates,
    resultHash: '3'.repeat(64),
    determinismVerified: true,
  } as const;
}

export function makeFixtureSource(): FactorySourceMeta {
  return {
    datasetKey: 'openstreetmap-odbl-geofabrik-alps',
    region: 'alps',
    snapshotTimestamp: '2026-08-24T21:21:08.000Z',
    pbfSha256: '4'.repeat(64),
    policyHash: '5'.repeat(64),
    mountains: ['osm:node:50473', 'osm:node:138'],
  };
}

export { mkdtemp as fixtureSandbox } from 'node:fs/promises';
export { tmpdir } from 'node:os';