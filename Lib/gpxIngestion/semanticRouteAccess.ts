import assert from 'node:assert/strict';
import type { OsmAnchorResolution } from './osmAnchorResolution.ts';
import { ADMITTED_CONNECTOR_HIGHWAYS, INCLUDED_TRAIL_HIGHWAYS, buildOsmTrailGraph, type OsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';
import { nodesReachingSummit, projectRoutableAnchor, type ResolvedRoutableAnchor } from './routableAnchorResolution.ts';

export const SEMANTIC_ROUTE_ACCESS_VERSION = 'mountain-tracker/semantic-route-access/v1';
export function resolveRouteAccess(input: {
  start: OsmAnchorResolution; summit: OsmAnchorResolution; vias: OsmAnchorResolution[];
  graph: OsmTrailGraph; ways: OsmTrailWayInput[]; connectors: boolean;
}): { graph: OsmTrailGraph; start: OsmAnchorResolution; vias: OsmAnchorResolution[]; projections: ResolvedRoutableAnchor[]; ready: boolean } {
  let graph = input.graph;
  const projections: ResolvedRoutableAnchor[] = [];
  const summit = input.summit.anchor && graph.findNearestNode(input.summit.anchor.coordinate, 30);
  if (!summit) return { graph, start: input.start, vias: input.vias, projections, ready: false };
  const reachableNodes = nodesReachingSummit(graph, summit.node.nodeId);
  const selectedRoads: OsmTrailWayInput[] = [];
  const project = (resolution: OsmAnchorResolution, allowConnector: boolean): OsmAnchorResolution => {
    if (!resolution.anchor) return resolution;
    const projection = projectRoutableAnchor({ entity: resolution.anchor, graph: input.graph, ways: input.ways,
      reachableNodes, connectors: allowConnector });
    projections.push(projection);
    if (projection.status !== 'RESOLVED') return { status: 'NOT_FOUND', anchor: null, candidates: [] };
    let nodeId = projection.nodeId!, coordinate = projection.coordinate!;
    if (projection.method === 'LOCAL_ACCESS_CONNECTOR') {
      nodeId = projection.connectorNodeIds[0]; coordinate = projection.connectorCoordinates[0];
      // Admit only the actual bounded access path. No general road network enters the mountain graph.
      for (let i = 0; i < projection.connectorWayIds.length; i++) {
        const wayId = projection.connectorWayIds[i];
        const source = input.ways.find(w => w.id === wayId)!;
        const from = projection.connectorNodeIds[i], to = projection.connectorNodeIds[i + 1];
        const index = source.nodes.findIndex((n, j) => j > 0 &&
          ((source.nodes[j - 1].nodeId === from && n.nodeId === to) || (source.nodes[j - 1].nodeId === to && n.nodeId === from)));
        assert(index > 0, 'CONNECTOR_MUST_BE_REAL_CONTIGUOUS_OSM_EDGE');
        selectedRoads.push({ ...source, nodes: source.nodes.slice(index - 1, index + 1) });
      }
    }
    // This is a routing adapter; the original semantic entity remains in the plan and projection record.
    return { status: 'RESOLVED', candidates: resolution.candidates,
      anchor: { ...resolution.anchor, osmObjectType: 'node', osmId: nodeId, coordinate,
        resolutionEvidence: [...resolution.anchor.resolutionEvidence, projection.method!] } };
  };
  const start = project(input.start, input.connectors);
  // Vias use independent evidence and bounded trail projection; connector detours at vias are not inferred.
  const vias = input.vias.map(v => project(v, false));
  if (selectedRoads.length) graph = buildOsmTrailGraph(graph.dataset,
    [...input.ways.filter(w => INCLUDED_TRAIL_HIGHWAYS.has(w.tags.highway)), ...selectedRoads],
    { connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS] });
  return { graph, start, vias, projections, ready: start.status === 'RESOLVED' && vias.every(v => v.status === 'RESOLVED') };
}
