/** Synthetic topology only, for publication orchestration tests; never production evidence. */
import { BaseAccessNetwork } from './baseAccessStartPolicy.ts';
import { buildOsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';

export function fixtureBaseEvidence() {
  const road: OsmTrailWayInput = { id: 700, tags: { highway: 'residential', foot: 'yes' },
    nodes: [{ nodeId: 701, coordinate: [11, 47] }, { nodeId: 702, coordinate: [11.01, 47] }] };
  const graph = buildOsmTrailGraph({ datasetKey: 'test-only', region: 'synthetic',
    snapshotTimestamp: '2026-09-09T00:00:00.000Z', pbfSha256: 'a'.repeat(64) }, [road], { connectorHighways: ['residential'] });
  return new BaseAccessNetwork([road]).evaluate({ kind: 'PARKING', tags: {}, nodeId: 701, graph });
}
