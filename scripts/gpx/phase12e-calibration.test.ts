import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateSemanticNames,
  normalizeSemanticName,
  withoutWhitelistedTrailingQualifier,
  featureNameVariants,
  semanticNameParts,
} from '../../Lib/gpxIngestion/nameNormalization.ts';
import {
  buildSemanticFeatureIndex,
  type SemanticFeatureIndex,
  type SemanticFeatureLayer,
  type SemanticFeatureRecordSource,
} from '../../Lib/gpxIngestion/semanticFeatureIndex.ts';
import { semanticEntityCandidates, resolveSemanticEntity } from '../../Lib/gpxIngestion/semanticEntityResolution.ts';
import {
  resolveRoutableAnchor,
  connectorEligible,
  projectRoutableAnchor,
  nodesReachingSummit,
} from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { extractSemanticEvidence } from '../../Lib/gpxIngestion/semanticEvidence.ts';
import { resolveRouteAccess } from '../../Lib/gpxIngestion/semanticRouteAccess.ts';
import { resolveOsmAnchor } from '../../Lib/gpxIngestion/osmAnchorResolution.ts';
import { reconstructOsmRoute } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import { elevationQualifierMeters } from '../../Lib/gpxIngestion/nameNormalization.ts';
import {
  buildOsmTrailGraph,
  evaluateConnectorCost,
  INCLUDED_TRAIL_HIGHWAYS,
  type OsmTrailWayInput,
} from '../../Lib/gpxIngestion/osmTrailGraph.ts';

const dataset = {
  datasetKey: 'openstreetmap-odbl-geofabrik-alps',
  region: 'alps',
  snapshotTimestamp: '2026-08-24T21:21:08.000Z',
  pbfSha256: '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5',
};

test('name normalization: whitelisted structural qualifiers are stripped', () => {
  assert.equal(candidateSemanticNames('Rossa, Palazzo Comunale').map(v => `${v.kind}:${v.name}`).join('|'),
    'EXACT_OSM_NAME:rossa, palazzo comunale|QUALIFIER_STRIPPED:rossa');
  assert.equal(candidateSemanticNames('Scopa, centro paese').map(v => v.name).includes('scopa'), true);
  assert.equal(candidateSemanticNames('Passo Monte Croce (quota 1360 m)').map(v => v.name)[1], 'passo monte croce');
  assert.equal(candidateSemanticNames('Collio (Trampolino)').map(v => v.name)[1], 'collio');
});

test('name normalization: non-whitelisted and non-trailing qualifiers are preserved', () => {
  assert.equal(withoutWhitelistedTrailingQualifier('Edolo (Pozzuolo)').reason, 'NOT_WHITELISTED');
  assert.deepEqual(candidateSemanticNames('Edolo (Pozzuolo)'), [{ kind: 'EXACT_OSM_NAME', name: 'edolo (pozzuolo)' }]);
  assert.equal(withoutWhitelistedTrailingQualifier('Bivio sopra Malga Moren').reason, 'NOT_TRAILING');
  assert.deepEqual(candidateSemanticNames('Strada per Veulla'), [{ kind: 'EXACT_OSM_NAME', name: 'strada per veulla' }]);
  assert.deepEqual(candidateSemanticNames('Lämmernhütte'), [{ kind: 'EXACT_OSM_NAME', name: 'lämmernhütte' }]);
  assert.deepEqual(candidateSemanticNames('Buvette de Hauta Chia'), [{ kind: 'EXACT_OSM_NAME', name: 'buvette de hauta chia' }]);
});

test('name normalization: empty residue after stripping is rejected', () => {
  assert.equal(withoutWhitelistedTrailingQualifier('(quota 100 m)').reason, 'EMPTY_AFTER_STRIP');
});

test('name normalization: multilingual and alt-name variants are collected', () => {
  const variants = featureNameVariants({ name: 'Meranerhütte - Rifugio Merano', 'name:de': 'Meranerhütte', 'name:it': 'Rifugio Merano', alt_name: 'Meraner Hütte;Rifugio Merano' });
  assert.equal(variants.includes('meranerhütte'), true);
  assert.equal(variants.includes('rifugio merano'), true);
  assert.equal(variants.includes('meraner hütte'), true);
  assert.equal(normalizeSemanticName('  Lämmernhütte '), 'lämmernhütte');
});

const FEATURE_LAYERS: SemanticFeatureLayer[] = ['alpine-huts', 'parking', 'stations', 'villages', 'hamlets', 'trailhead-info', 'peaks', 'saddles', 'mountain-passes', 'farms', 'isolated-dwellings', 'trailheads', 'bus-stops', 'halts', 'ridges', 'wilderness-huts'];

function record(layer: SemanticFeatureLayer, source: Partial<SemanticFeatureRecordSource> & { osmid: string; tags: Record<string, string> }): SemanticFeatureRecordSource {
  return {
    layer,
    objectType: 'node',
    osmid: source.osmid,
    coordinate: source.coordinate ?? [11, 46],
    tags: source.tags,
  };
}

function indexOf(records: SemanticFeatureRecordSource[], wantedNames: string[]): SemanticFeatureIndex {
  return buildSemanticFeatureIndex({
    sourceHashes: FEATURE_LAYERS.reduce((acc, layer) => ({ ...acc, [layer]: 'a'.repeat(64) }), {}),
    wantedNames: new Set(wantedNames.map(normalizeSemanticName)),
    collect: FEATURE_LAYERS.map(layer => ({ layer, records: records.filter(r => r.layer === layer) })),
  });
}

test('semantic feature index: filters to wanted names and dedupes deterministically', () => {
  const index = indexOf([
    record('peaks', { osmid: '1', tags: { name: 'Rossa', natural: 'peak' } }),
    record('peaks', { osmid: '1', tags: { name: 'Rossa', natural: 'peak' } }),
    record('villages', { osmid: '2', tags: { name: 'Scopa', place: 'village' } }),
    record('parking', { osmid: '3', tags: { name: 'Unrelated', amenity: 'parking' } }),
  ], ['Rossa']);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].osmId, 1);
  const again = indexOf([
    record('peaks', { osmid: '1', tags: { name: 'Rossa', natural: 'peak' } }),
    record('peaks', { osmid: '1', tags: { name: 'Rossa', natural: 'peak' } }),
    record('villages', { osmid: '2', tags: { name: 'Scopa', place: 'village' } }),
    record('parking', { osmid: '3', tags: { name: 'Unrelated', amenity: 'parking' } }),
  ], ['Rossa']);
  assert.equal(index.indexHash, again.indexHash);
});

test('semantic entity resolution: exact name with expected type resolves', () => {
  const index = indexOf([
    record('peaks', { osmid: '10', coordinate: [11.1, 46.1], tags: { name: 'Hexenkopf', natural: 'peak' } }),
  ], ['Hexenkopf']);
  const resolution = resolveSemanticEntity({ name: 'Hexenkopf', expectedTypes: ['SUMMIT'], regionName: null }, index);
  assert.equal(resolution.status, 'RESOLVED');
  if (resolution.status === 'RESOLVED') {
    assert.equal(resolution.anchor.osmObjectType, 'node');
    assert.equal(resolution.anchor.osmId, 10);
    assert.equal(resolution.anchor.resolutionEvidence.includes('EXACT_OSM_NAME'), true);
    assert.equal(resolution.anchor.resolutionEvidence.includes('EXPECTED_FEATURE_TYPE'), true);
  }
});

test('semantic entity resolution: localized name variant matches', () => {
  const index = indexOf([
    record('villages', { osmid: '20', coordinate: [11.2, 46.2], tags: { name: 'Sarnthein', 'name:it': 'Sarentino', place: 'village' } }),
  ], ['Sarentino']);
  const resolution = resolveSemanticEntity({ name: 'Sarentino', expectedTypes: ['SETTLEMENT'], regionName: null }, index);
  assert.equal(resolution.status, 'RESOLVED');
  if (resolution.status === 'RESOLVED') assert.equal(resolution.anchor.osmId, 20);
});

test('semantic entity resolution: whitelisted-qualifier start resolves to canonical feature', () => {
  const index = indexOf([
    record('villages', { osmid: '30', coordinate: [11.3, 46.3], tags: { name: 'Scopa', place: 'village' } }),
    record('peaks', { osmid: '31', coordinate: [11.31, 46.31], tags: { name: 'Something', natural: 'peak' } }),
  ], ['Scopa, centro paese', 'Scopa']);
  const resolution = resolveSemanticEntity({ name: 'Scopa, centro paese', expectedTypes: [], regionName: null }, index);
  assert.equal(resolution.status, 'RESOLVED');
  if (resolution.status === 'RESOLVED') {
    assert.equal(resolution.anchor.osmId, 30);
    assert.equal(resolution.anchor.resolutionEvidence.includes('QUALIFIER_STRIPPED'), true);
  }
});

test('semantic entity resolution: exact ties fail closed as ambiguous', () => {
  const index = indexOf([
    record('peaks', { osmid: '40', coordinate: [11.4, 46.4], tags: { name: 'Ganne', natural: 'peak' } }),
    record('peaks', { osmid: '41', coordinate: [11.4, 46.4], tags: { name: 'Ganne', natural: 'peak' } }),
  ], ['Ganne']);
  const resolution = resolveSemanticEntity({ name: 'Ganne', expectedTypes: ['SUMMIT'], regionName: null }, index);
  assert.equal(resolution.status, 'AMBIGUOUS');
  if (resolution.status === 'AMBIGUOUS') assert.equal(resolution.candidates.length, 2);
});

test('semantic entity resolution: no match reports not found', () => {
  const index = indexOf([
    record('peaks', { osmid: '50', coordinate: [11.5, 46.5], tags: { name: 'Other', natural: 'peak' } }),
  ], ['Lämmernhütte']);
  assert.equal(resolveSemanticEntity({ name: 'Lämmernhütte', expectedTypes: ['HUT'], regionName: null }, index).status, 'NOT_FOUND');
});

test('semantic entity resolution: expected-type mismatch excludes candidate', () => {
  const index = indexOf([
    record('peaks', { osmid: '60', coordinate: [11.6, 46.6], tags: { name: 'Zugspitze', natural: 'peak' } }),
  ], ['Zugspitze']);
  assert.equal(resolveSemanticEntity({ name: 'Zugspitze', expectedTypes: ['HUT'], regionName: null }, index).status, 'NOT_FOUND');
  assert.ok(semanticEntityCandidates({ name: 'Zugspitze', expectedTypes: ['HUT'], regionName: null }, index).length === 0);
});

function way(id: number, tags: Record<string, string>, nodes: Array<[number, number, number]>): OsmTrailWayInput {
  return {
    id,
    tags,
    nodes: nodes.map((coordinate, index) => ({ nodeId: id * 1000 + index, coordinate })),
  };
}

test('routable anchor: in-distance trail node becomes a SNAP', () => {
  const ways = [way(1, { highway: 'path' }, [[11.0, 46.0, 0], [11.001, 46.0, 0]])];
  const anchor = resolveRoutableAnchor([11.0005, 46.0], ways);
  assert.equal(anchor.kind, 'SNAP');
  if (anchor.kind === 'SNAP') assert.ok(anchor.distanceM < 75);
});

test('routable anchor: bounded connector admission for pedestrian-accessible roads', () => {
  const ways = [
    way(1, { highway: 'path' }, [[11.1, 46.1, 0], [11.1005, 46.1, 0]]),
    way(2, { highway: 'residential' }, [[11.0, 46.0, 0], [11.005, 46.0, 0]]),
  ];
  const anchor = resolveRoutableAnchor([11.002, 46.0005], ways, { startSnapMeters: 75, connectorSearchRadiusMeters: 400 });
  assert.equal(anchor.kind, 'UNROUTABLE');
  assert.equal(connectorEligible({ highway: 'residential' }), false);
  assert.equal(connectorEligible({ highway: 'residential', foot: 'yes' }), true);
});

test('routable anchor: motorways and private access are never connectors', () => {
  const ways = [
    way(1, { highway: 'motorway' }, [[10.0, 45.0, 0], [10.005, 45.0, 0]]),
    way(2, { highway: 'residential', access: 'private' }, [[10.1, 45.1, 0], [10.105, 45.1, 0]]),
  ];
  assert.equal(connectorEligible({ highway: 'motorway' }), false);
  assert.equal(connectorEligible({ highway: 'residential', access: 'private' }), false);
  assert.equal(resolveRoutableAnchor([10.002, 45.0], ways, { startSnapMeters: 400, connectorSearchRadiusMeters: 400 }).kind, 'UNROUTABLE');
});

test('routable anchor: resent path beats farther connector', () => {
  const ways = [
    way(1, { highway: 'residential' }, [[11.0, 46.0, 0], [11.003, 46.0, 0]]),
    way(2, { highway: 'path' }, [[11.0015, 46.0005, 0], [11.0025, 46.0005, 0]]),
  ];
  const anchor = resolveRoutableAnchor([11.0018, 46.0008], ways, { startSnapMeters: 75, connectorSearchRadiusMeters: 400 });
  assert.equal(anchor.kind, 'SNAP');
});

test('osm trail graph: baseline hash is stable and connector-free', () => {
  const ways = [
    way(1, { highway: 'path' }, [[11.0, 46.0, 0], [11.001, 46.0, 0]]),
    way(2, { highway: 'residential', foot: 'yes' }, [[11.1, 46.1, 0], [11.101, 46.1, 0]]),
    way(3, { highway: 'motorway' }, [[11.2, 46.2, 0], [11.201, 46.2, 0]]),
  ];
  const a = buildOsmTrailGraph(dataset, ways);
  const b = buildOsmTrailGraph(dataset, [...ways].reverse());
  const c = buildOsmTrailGraph(dataset, ways, { connectorHighways: undefined });
  assert.equal(a.graphHash, b.graphHash);
  assert.equal(a.graphHash, c.graphHash);
  assert.equal(a.edges.some(e => e.connector === true), false);
  assert.ok(a.exclusions.some(e => e.reason === 'UNSUPPORTED_HIGHWAY'));
  assert.ok(a.exclusions.some(e => e.reason === 'MOTORWAY'));
});

test('osm trail graph: connector admission only when requested, flagged and surcharged', () => {
  const ways = [
    way(1, { highway: 'path' }, [[11.0, 46.0, 0], [11.001, 46.0, 0]]),
    way(2, { highway: 'residential', foot: 'yes' }, [[11.1, 46.1, 0], [11.101, 46.1, 0]]),
    way(4, { highway: 'residential', access: 'private' }, [[11.3, 46.3, 0], [11.301, 46.3, 0]]),
  ];
  const base = buildOsmTrailGraph(dataset, ways);
  const withConnectors = buildOsmTrailGraph(dataset, ways, { connectorHighways: ['residential'] });
  assert.notEqual(withConnectors.graphHash, base.graphHash);
  const connectorEdges = withConnectors.edges.filter(e => e.connector === true);
  assert.ok(connectorEdges.length > 0);
  assert.equal(connectorEdges.every(e => e.costMultiplier === 1.15), true);
  assert.equal(connectorEdges.every(e => e.warnings.includes('ACCESS_CONNECTOR')), true);
  const baseResidentialExcluded = base.exclusions.filter(e => e.wayId === 2).map(e => e.reason);
  assert.deepEqual(baseResidentialExcluded, ['UNSUPPORTED_HIGHWAY']);
  assert.equal(withConnectors.exclusions.some(e => e.wayId === 2), false);
  assert.ok(withConnectors.exclusions.some(e => e.wayId === 4 && e.reason === 'ACCESS_FORBIDDEN'));
  const again = buildOsmTrailGraph(dataset, ways, { connectorHighways: ['residential'] });
  assert.equal(again.graphHash, withConnectors.graphHash);
});

test('osm trail graph rejects connectors not admitted by the contract', () => {
  assert.throws(() => buildOsmTrailGraph(dataset, [way(1, { highway: 'primary' }, [[1, 1, 0], [1.001, 1, 0]])], { connectorHighways: ['primary'] }),
    /Connector highway is not admitted/);
});

test('connector cost and included highways match the contract', () => {
  assert.equal(INCLUDED_TRAIL_HIGHWAYS.has('path'), true);
  assert.deepEqual(evaluateConnectorCost({ highway: 'residential' }).multiplier, 1.15);
  assert.ok(evaluateConnectorCost({ highway: 'residential' }).warnings.includes('ACCESS_CONNECTOR'));
  assert.throws(() => evaluateConnectorCost({ highway: 'path' }));
});

const accessEntity = { osmObjectType: 'node', osmId: 1, coordinate: [11, 46] as [number, number], tagsSubset: { amenity: 'parking' } };
const trail: OsmTrailWayInput = { id: 90, tags: { highway: 'path' }, nodes: [
  { nodeId: 3, coordinate: [11.002, 46] }, { nodeId: 4, coordinate: [11.003, 46] },
] };
const road: OsmTrailWayInput = { id: 91, tags: { highway: 'service', foot: 'yes' }, nodes: [
  { nodeId: 1, coordinate: [11, 46] }, { nodeId: 2, coordinate: [11.001, 46] }, { nodeId: 3, coordinate: [11.002, 46] },
] };
function access(ways: OsmTrailWayInput[], connectors = true) {
  const graph = buildOsmTrailGraph(dataset, ways);
  return projectRoutableAnchor({ entity: accessEntity, graph, ways, reachableNodes: nodesReachingSummit(graph, 4), connectors });
}
test('local access reaches a real shared trail node with bounded continuous OSM edges', () => {
  const result = access([trail, road]);
  assert.equal(result.method, 'LOCAL_ACCESS_CONNECTOR');
  assert.deepEqual(result.connectorNodeIds, [1, 2, 3]);
  assert.deepEqual(result.connectorWayIds, [91, 91]);
  assert(result.roadLengthM < 300 && result.pathLengthM > 100);
  assert.deepEqual(access([road, trail]), result);
  assert.equal(access([trail, road], false).status, 'UNROUTABLE');
});
test('near road without shared topology cannot bridge a gap', () => {
  const broken = { ...road, nodes: road.nodes.map(n => ({ ...n, nodeId: n.nodeId + 100 })) };
  assert.equal(access([trail, broken]).status, 'UNROUTABLE');
});
test('local access respects pedestrian direction and missing geometry', () => {
  assert.equal(access([trail, { ...road, tags: { ...road.tags, 'oneway:foot': '-1' } }]).status, 'UNROUTABLE');
  assert.equal(access([trail, { ...road, nodes: road.nodes.map(n => n.nodeId === 2 ? { ...n, coordinate: null } : n) }]).status, 'UNROUTABLE');
});
for (const tags of [ { highway: 'motorway', foot: 'yes' }, { highway: 'motorway_link', foot: 'yes' },
  { highway: 'primary', foot: 'yes' }, { highway: 'service', foot: 'no' }, { highway: 'service', access: 'private' },
  { highway: 'service' }, { highway: 'service', foot: 'yes', smoothness: 'impassable' },
  { highway: 'service', 'foot:conditional': 'yes @ (sunrise-sunset)' } ] as Record<string, string>[]) {
  test(`local connector fails closed: ${JSON.stringify(tags)}`, () => assert.equal(access([trail, { ...road, tags }]).status, 'UNROUTABLE'));
}
test('feature road-length bound rejects a connected detour', () => {
  const detour = { ...road, nodes: [road.nodes[0], { nodeId: 2, coordinate: [11.001, 46.002] as [number, number] }, road.nodes[2]] };
  assert.equal(access([trail, detour]).status, 'UNROUTABLE');
});
test('projection skips a closer disconnected trail without manufacturing geometry', () => {
  const graph = buildOsmTrailGraph(dataset, [trail, { id: 92, tags: { highway: 'path' }, nodes: [road.nodes[0], road.nodes[1]] }]);
  const entity = { ...accessEntity, coordinate: [11.001, 46] as [number, number] };
  const result = projectRoutableAnchor({ entity, graph, ways: [], reachableNodes: nodesReachingSummit(graph, 4), connectors: false });
  assert.equal(result.nodeId, 3);
  assert.equal(result.method, 'BOUNDED_PROJECTION');
  assert.deepEqual(result.connectorCoordinates, []);
});
test('elevation qualifier remains evidence and excludes a conflicting named entity', () => {
  assert.equal(elevationQualifierMeters('Ravascletto (quota 963 m)'), 963);
  const index = indexOf([record('villages', { osmid: '101', tags: { name: 'Ravascletto', place: 'village', ele: '1500' } })], ['Ravascletto']);
  assert.equal(resolveSemanticEntity({ name: 'Ravascletto (quota 963 m)', expectedTypes: [], regionName: null }, index).status, 'NOT_FOUND');
  const result = extractSemanticEvidence('10', { relationTags: { from: 'Ravascletto (quota 963 m)', to: 'Summit', via: 'Pass', route: 'hiking' }, summits: [{ id: '11', name: 'Summit' }] });
  assert.equal(result.signal?.viaHints[0].name, 'Pass');
  assert(result.evidence.some(e => e.kind === 'ELEVATION_QUALIFIER' && e.originalValue === 'Ravascletto (quota 963 m)'));
  assert(result.evidence.every(e => e.semanticOnly && !('coordinate' in e)));
});
test('missing start and unsafe evidence do not invent a signal', () => {
  for (const relationTags of [{ ref: '123', name: 'Summit' }, { from: '<script>', to: 'Summit' }] as Record<string, string>[]) {
    assert.equal(extractSemanticEvidence('10', { relationTags, summits: [{ id: '11', name: 'Summit' }] }).signal, null);
  }
});
test('candidate overflow fails closed instead of selecting a truncated winner', () => {
  const index = indexOf([record('villages', { osmid: '201', tags: { name: 'Same', place: 'village' } }),
    record('villages', { osmid: '202', tags: { name: 'Same', place: 'village' } })], ['Same']);
  assert.throws(() => resolveSemanticEntity({ name: 'Same', expectedTypes: [], regionName: null }, index, { maximumCandidateCount: 1 }), /CANDIDATE_LIMIT/);
});
test('feature index rejects absent coordinates', () => {
  const source = record('villages', { osmid: '301', tags: { name: 'Same', place: 'village' } });
  source.coordinate = null;
  assert.equal(indexOf([source], ['Same']).entries.length, 0);
});
test('access wrapper preserves semantic identity and reconstructs only the bounded connector plus trail', () => {
  const hint = (name: string) => ({ name, expectedTypes: [], regionName: null });
  const resolve = (name: string, id: number, coordinate: [number, number], tags: Record<string, string>) => resolveOsmAnchor(hint(name), [
    { sourceKey: 'openstreetmap', osmObjectType: 'node', osmId: id, coordinate, tags: { ...tags, name } },
  ]);
  const start = resolve('Parking', 1, [11, 46], { amenity: 'parking' });
  const summit = resolve('Summit', 4, [11.003, 46], { natural: 'peak' });
  const unrelatedRoad = { ...road, id: 92, nodes: [{ nodeId: 500, coordinate: [11.1, 46] as [number, number] }, { nodeId: 501, coordinate: [11.11, 46] as [number, number] }] };
  const ways = [trail, road, unrelatedRoad], graph = buildOsmTrailGraph(dataset, ways);
  const access = resolveRouteAccess({ graph, ways, start, summit, vias: [], connectors: true });
  assert(access.ready);
  assert.equal(access.projections[0].entityIdentity.osmId, 1);
  assert.equal(access.projections[0].nodeId, 3);
  assert.equal(access.graph.edges.some(e => e.wayId === 92), false);
  const evidence = extractSemanticEvidence('10', { relationTags: { from: 'Parking', to: 'Summit' }, summits: [{ id: '4', name: 'Summit' }] });
  assert(evidence.signal);
  // Validate the real baseline-v1 solver contract with independently supplied semantics.
  const result = reconstructOsmRoute({ signal: evidence.signal, graph: access.graph,
    anchors: { start: access.start, summit, vias: [] }, startContext: 'BASE_START' });
  assert(result.route);
  assert.deepEqual(result.route.osmNodeIds, [1, 2, 3, 4]);
  assert.equal(result.route.graphVersion, 'mountain-tracker/local-access-graph/v2');
});

function historicIndex(entries: Array<{ id: string; name: string; tags?: Record<string, string>; coordinate?: [number, number] }>) {
  return buildSemanticFeatureIndex({ sourceHashes: { fixture: 'semantic-only' }, wantedNames: new Set(entries.map(e => normalizeSemanticName(e.name))),
    collect: [{ layer: 'historic-status', records: entries.map(e => ({ layer: 'historic-status', objectType: 'node', osmid: e.id,
      coordinate: e.coordinate ?? [11, 46], tags: { name: e.name, historic: 'archaeological_site', archaeological_site: 'ruins', ...e.tags } })) }] });
}
test('documented status is separate evidence; canonical and qualified identities both resolve', () => {
  const index = historicIndex([{ id: '600', name: 'Alte Hütte' }]);
  for (const name of ['Alte Hütte', 'Alte Hütte (verf.)']) {
    assert.equal(resolveSemanticEntity({ name, expectedTypes: [], regionName: null }, index).status, 'RESOLVED');
  }
  const parts = semanticNameParts('Alte Hütte (verf.)');
  assert.equal(parts.rawValue, 'Alte Hütte (verf.)');
  assert.equal(parts.identityName, 'alte hütte');
  assert.equal(parts.qualifiers[0].kind, 'STATUS');
  assert.equal(parts.qualifiers[0].rawValue, 'verf.');
});
test('unknown parentheses and legitimate parenthesized identities are preserved', () => {
  for (const name of ['Maison (Nord)', 'Hütte (verf. Nord)', 'Alpe (Pozzuolo)']) {
    assert.equal(semanticNameParts(name).identityName, normalizeSemanticName(name));
    assert.deepEqual(semanticNameParts(name).qualifiers, []);
    const index = historicIndex([{ id: '601', name }]);
    assert.equal(resolveSemanticEntity({ name, expectedTypes: [], regionName: null }, index).status, 'RESOLVED');
  }
});
test('status fallback needs independently compatible OSM status, never just a same-named active hut', () => {
  const index = indexOf([record('alpine-huts', { osmid: '602', tags: { name: 'Alte Hütte', tourism: 'alpine_hut' } })], ['Alte Hütte']);
  assert.equal(resolveSemanticEntity({ name: 'Alte Hütte (verf.)', expectedTypes: [], regionName: null }, index).status, 'NOT_FOUND');
});
test('ruins cannot satisfy a live HUT type hint or a conflicting explicit region', () => {
  const index = historicIndex([{ id: '603', name: 'Alte Hütte', tags: { 'addr:country': 'AT' } }]);
  assert.equal(resolveSemanticEntity({ name: 'Alte Hütte (verf.)', expectedTypes: ['HUT'], regionName: null }, index).status, 'NOT_FOUND');
  assert.equal(resolveSemanticEntity({ name: 'Alte Hütte (verf.)', expectedTypes: [], regionName: 'IT' }, index).status, 'NOT_FOUND');
});
test('collisions after status normalization remain ambiguous and ordered deterministically', () => {
  const entries = [{ id: '605', name: 'Alte Hütte' }, { id: '604', name: 'Alte Hütte' }];
  const hint = { name: 'Alte Hütte (verf.)', expectedTypes: [], regionName: null };
  const a = resolveSemanticEntity(hint, historicIndex(entries));
  const b = resolveSemanticEntity(hint, historicIndex([...entries].reverse()));
  assert.equal(a.status, 'AMBIGUOUS'); assert.deepEqual(a, b);
  assert.deepEqual(a.candidates.map(c => c.osmId), [604, 605]);
});
test('status dictionary has explicit multilingual entries and Unicode normalization', () => {
  for (const [name, qualifier] of [['Alte Hütte', 'verfallen'], ['Old Hut', 'ruins'], ['Ancien refuge', 'ruine'], ['Vecchio rifugio', 'rudere']]) {
    const index = historicIndex([{ id: '606', name }]);
    const raw = `${name.normalize('NFD')} (${qualifier.toUpperCase()})`;
    assert.equal(resolveSemanticEntity({ name: raw, expectedTypes: [], regionName: null }, index).status, 'RESOLVED');
    assert(semanticNameParts(raw).qualifiers[0].languages.length > 0);
  }
});
test('semantic-only hut-via regression retains the raw name and resolves independent ruins', () => {
  const result = extractSemanticEvidence('fixture-via-regression', { relationTags: { from: 'Active Hut', via: 'Old Hut (ruins)', to: 'Summit' }, summits: [{ id: '999', name: 'Summit' }] });
  assert(result.signal);
  const via = result.evidence.find(e => e.kind === 'VIA_NAME')!;
  assert.equal(via.originalValue, 'Old Hut (ruins)');
  assert.equal(via.identityName, 'old hut');
  assert.equal(via.qualifiers?.[0].kind, 'STATUS');
  assert.equal(resolveSemanticEntity(result.signal.viaHints[0], historicIndex([{ id: '607', name: 'Old Hut' }])).status, 'RESOLVED');
});
