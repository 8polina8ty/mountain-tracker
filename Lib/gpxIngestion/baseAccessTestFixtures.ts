/** Synthetic topology only, for publication orchestration tests; never production evidence. */
import { BaseAccessNetwork } from './baseAccessStartPolicy.ts';
import { buildOsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';
import type { Coordinate } from './types.ts';

export function fixtureBaseEvidence(startNodeId = 701, coordinate: Coordinate = [11, 47]) {
  const [longitude, latitude] = coordinate;
  const junction = { nodeId: startNodeId + 1, coordinate: [longitude, latitude + 0.0001] as [number, number] };
  const approach: OsmTrailWayInput = { id: 699, tags: { highway: 'footway', foot: 'yes' },
    nodes: [{ nodeId: startNodeId, coordinate: [longitude, latitude] }, junction] };
  const road: OsmTrailWayInput = { id: 700, tags: { highway: 'residential', foot: 'yes' },
    nodes: [junction, { nodeId: startNodeId + 2, coordinate: [longitude + 0.01, latitude + 0.0001] }] };
  const graph = buildOsmTrailGraph({ datasetKey: 'test-only', region: 'synthetic',
    snapshotTimestamp: '2026-09-09T00:00:00.000Z', pbfSha256: 'a'.repeat(64) }, [approach, road], { connectorHighways: ['residential'] });
  return new BaseAccessNetwork([road]).evaluate({ kind: 'PARKING', tags: {}, nodeId: startNodeId, graph });
}
