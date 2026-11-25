import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMITTED_CONNECTOR_HIGHWAYS, buildOsmTrailGraph, type OsmTrailWayInput } from '../../../Lib/gpxIngestion/osmTrailGraph.ts';
import { AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS, RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS, buildAuthoritativePbfBlockGraph, buildReconstructionPbfBlockGraph } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { BaseAccessNetwork } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';

test('reconstruction block loader graph options match pbf.ts authoritative options', () => {
  // Authoritative set must be exactly ADMITTED_CONNECTOR_HIGHWAYS
  assert.deepEqual([...AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.connectorHighways].sort(), [...ADMITTED_CONNECTOR_HIGHWAYS].sort());
  assert.deepEqual([...RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.connectorHighways].sort(), [...ADMITTED_CONNECTOR_HIGHWAYS].sort());
  // Limits must be preserved (authoritative strict, reconstruction relaxed but same connectors)
  assert.equal(AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.maximumWays, 150000);
  assert.equal(AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.maximumNodes, 800000);
  assert.equal(RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.maximumWays, 500000);
  assert.equal(RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.maximumNodes, 2000000);
  // Build functions must use those options — smoke build
  const dataset = { datasetKey: 'local-osm-pbf', region: 'local', snapshotTimestamp: new Date(0).toISOString(), pbfSha256: 'a'.repeat(64) } as never;
  const dummyWays: OsmTrailWayInput[] = [
    { id: 1, tags: { highway: 'path' }, nodes: [{ nodeId: 1, coordinate: [11.0, 47.0] }, { nodeId: 2, coordinate: [11.001, 47.0] }] },
  ];
  const g1 = buildAuthoritativePbfBlockGraph(dataset, dummyWays);
  const g2 = buildReconstructionPbfBlockGraph(dataset, dummyWays);
  assert.ok(g1.nodes.size === 2);
  assert.ok(g2.nodes.size === 2);
  const gEmpty = buildOsmTrailGraph(dataset, dummyWays.concat({ id: 2, tags: { highway: 'residential' }, nodes: [{ nodeId: 3, coordinate: [11.002, 47.0] }, { nodeId: 4, coordinate: [11.003, 47.0] }] }), { connectorHighways: [], maximumWays: 500000, maximumNodes: 2000000 });
  const gConn = buildOsmTrailGraph(dataset, dummyWays.concat({ id: 2, tags: { highway: 'residential', foot: 'yes' }, nodes: [{ nodeId: 3, coordinate: [11.002, 47.0] }, { nodeId: 4, coordinate: [11.003, 47.0] }] }), { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS], maximumWays: 500000, maximumNodes: 2000000 });
  // residential without foot=yes is excluded even with connectors (access check), but with foot=yes it is included
  assert.ok(gEmpty.nodes.size < gConn.nodes.size || gEmpty.edges.length < gConn.edges.length);
});

test('fixture: without connector highways -> no witness, with ADMITTED -> real witness succeeds', () => {
  const dataset = { datasetKey: 'local-osm-pbf', region: 'local', snapshotTimestamp: new Date(0).toISOString(), pbfSha256: 'b'.repeat(64) } as never;
  // Minimal topology fixture not used directly; longWays is authoritative case below
  void ((): OsmTrailWayInput[] => [
    { id: 10, tags: { highway: 'path' }, nodes: [{ nodeId: 10, coordinate: [11.0, 47.0] }, { nodeId: 11, coordinate: [11.0001, 47.0] }] },
    { id: 20, tags: { highway: 'service', foot: 'yes' }, nodes: [{ nodeId: 100, coordinate: [11.0, 47.0] }, { nodeId: 10, coordinate: [11.0, 47.0] }] },
    { id: 30, tags: { highway: 'residential', foot: 'yes' }, nodes: [{ nodeId: 30, coordinate: [11.0002, 47.0] }, { nodeId: 11, coordinate: [11.0001, 47.0] }] },
  ]);
  // Need longer road: make distance between 30 and 31 ~300m (approx 0.004 deg ~ 300m at 47deg)
  // Use stub to ensure distance >250
  const longWays: OsmTrailWayInput[] = [
    { id: 10, tags: { highway: 'path' }, nodes: [{ nodeId: 10, coordinate: [11.0, 47.0] }, { nodeId: 11, coordinate: [11.0001, 47.0] }] },
    { id: 20, tags: { highway: 'service', foot: 'yes' }, nodes: [{ nodeId: 100, coordinate: [10.9999, 47.0] }, { nodeId: 10, coordinate: [11.0, 47.0] }] },
    { id: 30, tags: { highway: 'residential', foot: 'yes' }, nodes: [{ nodeId: 11, coordinate: [11.0001, 47.0] }, { nodeId: 30, coordinate: [11.0002, 47.0] }] },
    { id: 31, tags: { highway: 'residential', foot: 'yes' }, nodes: [{ nodeId: 30, coordinate: [11.0002, 47.0] }, { nodeId: 31, coordinate: [11.0025, 47.0] }] },
    { id: 32, tags: { highway: 'residential', foot: 'yes' }, nodes: [{ nodeId: 31, coordinate: [11.0025, 47.0] }, { nodeId: 32, coordinate: [11.005, 47.0] }] },
  ];
  const graphEmpty = buildOsmTrailGraph(dataset, longWays, { connectorHighways: [], maximumWays: 500000, maximumNodes: 2000000 });
  const networkEmpty = new BaseAccessNetwork(longWays);
  const evEmpty = networkEmpty.evaluate({ kind: 'PARKING', tags: {}, nodeId: 100, graph: graphEmpty });
  // Without connectors, service/residential edges are absent from graph, so approach cannot reach road via graph
  // Expect NO_EXTERNAL_PUBLIC_ACCESS (or possibly still outward if starting node is directly on road — but here parking node is not on residential, so fails)
  assert.equal(evEmpty.publicRoadConnected, false);
  assert.ok(evEmpty.reasonCodes.includes('NO_EXTERNAL_PUBLIC_ACCESS'));

  const graphConn = buildOsmTrailGraph(dataset, longWays, { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS], maximumWays: 500000, maximumNodes: 2000000 });
  const networkConn = new BaseAccessNetwork(longWays);
  const evConn = networkConn.evaluate({ kind: 'PARKING', tags: {}, nodeId: 100, graph: graphConn });
  // With connectors, graph includes service+residential edges, path to road exists
  // The outward road must be >=250m, which we constructed via 30-31-32 chain (≈380m)
  assert.equal(evConn.publicRoadConnected, true);
  assert.ok(evConn.reasonCodes.includes('PRIMARY_BASE_ACCESS'));
  // Sanity: ensure witness IDs are real and not synthetic
  assert.ok(evConn.approachNodeIds[0] === 100);
  assert.ok(evConn.outwardRoadWayIds.length > 0);
  assert.ok(evConn.accessNetworkDistance !== null && evConn.accessNetworkDistance <= 150);
});
