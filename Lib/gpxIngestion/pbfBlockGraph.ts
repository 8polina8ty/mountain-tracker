/** Authoritative PBF block graph factory — single source of truth for scripts/routes/pbf.ts and graphhopper reconstruction.
 * Prevents connectorHighways drift (historical bug: [] vs ADMITTED_CONNECTOR_HIGHWAYS).
 */
import { ADMITTED_CONNECTOR_HIGHWAYS, buildOsmTrailGraph, type OsmTrailWayInput } from './osmTrailGraph.ts';

export const AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS = {
  connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS],
  maximumWays: 150000,
  maximumNodes: 800000,
} as const;

// Reconstruction uses coarse 0.25deg+hallo blocks without adaptive subdivision;
// they can exceed 800k nodes (e.g. 40_189 ~ 900k nodes). Keep connectors authoritative,
// use relaxed node/way bounds only to allow faithful coarse rebuild without changing semantics.
export const RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS = {
  connectorHighways: [...ADMITTED_CONNECTOR_HIGHWAYS],
  maximumWays: 500000,
  maximumNodes: 2000000,
} as const;

export function buildAuthoritativePbfBlockGraph(
  dataset: { datasetKey: string; region: string; snapshotTimestamp: string; pbfSha256: string },
  ways: readonly OsmTrailWayInput[],
) {
  return buildOsmTrailGraph(dataset as never, ways, {
    connectorHighways: [...AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.connectorHighways],
    maximumWays: AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.maximumWays,
    maximumNodes: AUTHORITATIVE_PBF_BLOCK_GRAPH_OPTIONS.maximumNodes,
  });
}

export function buildReconstructionPbfBlockGraph(
  dataset: { datasetKey: string; region: string; snapshotTimestamp: string; pbfSha256: string },
  ways: readonly OsmTrailWayInput[],
) {
  return buildOsmTrailGraph(dataset as never, ways, {
    connectorHighways: [...RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.connectorHighways],
    maximumWays: RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.maximumWays,
    maximumNodes: RECONSTRUCTION_PBF_BLOCK_GRAPH_OPTIONS.maximumNodes,
  });
}
