import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { buildOsmTrailGraph, type OsmTrailWayInput } from '../../Lib/gpxIngestion/osmTrailGraph.ts';
import { resolveRouteAccess } from '../../Lib/gpxIngestion/semanticRouteAccess.ts';
import { nodesReachingSummit } from '../../Lib/gpxIngestion/routableAnchorResolution.ts';
import { reconstructOsmRoute, toPhase11ComparableRoute, type GraphSearchDiagnostics } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import { compareRoutes, type ComparableRoute } from '../osm-import/route-similarity.ts';
import { classifyStartContextV2, type FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { analyzeRouteRoadSafety, type RoadSafetyWay } from '../osm-import/phase11c9-road-safety.ts';
import { acceptable, versions, type EResult } from './phase12e-run.ts';
import type { EMember } from './phase12e-evaluation-plan.ts';
import { CORRECTION, type CorrectiveRecord } from './phase12e-corrective-plan.ts';

export function evaluateCorrection(input: {
  member: EMember; record: CorrectiveRecord; ways: OsmTrailWayInput[]; datasetSha256: string;
  truth: DatabaseSync; features: FeatureIndex;
  sourceDatasetIdentity: Parameters<typeof analyzeRouteRoadSafety>[0]['sourceDatasetIdentity'];
}) {
  const { member, record, ways, truth, features } = input;
  const { start, summit, vias, evidence } = record;
  const started = performance.now();
  const result: EResult = { relationId: member.relationId, configuration: CORRECTION, signalCreated: !!evidence.signal,
    entityResolved: [start, ...vias, summit].every(r => r?.status === 'RESOLVED'), routableAnchorResolved: false,
    graphConnected: false, solved: false, failure: 'SEMANTIC_EVIDENCE_ABSENT', entityStatus: start?.status ?? 'NOT_FOUND',
    evidenceHash: evidence.hash, projections: [], graph: null, routeHash: null, manifestHash: null, visitedNodes: [], similarity: null,
    startContext: null, roadSafety: null, safetyReasons: [], autoCompatible: false, intrinsicAutoCompatible: false,
    frozenVetoes: member.negativeReasons, determinismVerified: true };
  if (evidence.signal && !result.entityResolved) {
    const failed = [{ role: 'START', r: start }, ...vias.map((r, i) => ({ role: `VIA_${i + 1}`, r })), { role: 'SUMMIT', r: summit }].find(a => a.r?.status !== 'RESOLVED')!;
    result.failure = `ENTITY_${failed.role}_${failed.r?.status ?? 'NOT_FOUND'}`;
    result.entityStatus = failed.r?.status ?? 'NOT_FOUND';
  }
  if (!evidence.signal || !result.entityResolved || !start?.anchor || !summit?.anchor) return { result, totalMs: performance.now() - started, graphBuilds: 0 };
  const dataset = { datasetKey: 'openstreetmap-odbl-geofabrik-alps', region: 'alps', snapshotTimestamp: '2026-08-24T21:21:08.000Z', pbfSha256: input.datasetSha256 };
  const baseGraph = buildOsmTrailGraph(dataset, ways);
  assert.equal(baseGraph.graphHash, buildOsmTrailGraph(dataset, [...ways].reverse()).graphHash);
  const accessInput = { start, summit, vias, graph: baseGraph, ways, connectors: false };
  const access = resolveRouteAccess(accessInput);
  const repeated = resolveRouteAccess({ ...accessInput, ways: [...ways].reverse() });
  assert.deepEqual(access.projections, repeated.projections); assert.equal(access.graph.graphHash, repeated.graph.graphHash);
  const graph = access.graph;
  result.projections = access.projections; result.routableAnchorResolved = access.ready;
  const snapped = [access.start, ...access.vias, summit].map((a, i, arr) => a.anchor && graph.findNearestNode(a.anchor.coordinate, i === arr.length - 1 ? 30 : 75));
  result.graphConnected = access.ready && snapped.slice(1).every((to, i) => to && snapped[i] && nodesReachingSummit(graph, to.node.nodeId).has(snapped[i]!.node.nodeId));
  result.graph = { hash: graph.graphHash, nodes: graph.nodes.size, edges: graph.edges.length };
  const peak = truth.prepare("SELECT json_extract(payload,'$.elevationMeters') AS elevation FROM peaks WHERE id=?").get(Number(member.facts.summits[0].id)) as { elevation: number | null } | undefined;
  const context = classifyStartContextV2([...start.anchor.coordinate] as [number, number], [...summit.anchor.coordinate] as [number, number], peak?.elevation ?? null, features);
  result.startContext = context.type;
  if (context.type === 'HIGH_MOUNTAIN_START') result.safetyReasons.push('START_HIGH_MOUNTAIN');
  if (context.type === 'AMBIGUOUS_START') result.safetyReasons.push('START_AMBIGUOUS');
  const diagnostics: GraphSearchDiagnostics[] = [];
  const solverInput = { signal: evidence.signal, graph, anchors: { start: access.start, summit, vias: access.vias }, startContext: context.type };
  const reconstruction = reconstructOsmRoute({ ...solverInput, diagnostics });
  assert.deepEqual(reconstructOsmRoute(solverInput), reconstruction, 'CORRECTIVE_SOLVER_DETERMINISM');
  result.visitedNodes = diagnostics.map(d => d.visitedNodes);
  if (!reconstruction.route) {
    result.failure = !access.ready ? 'ROUTABLE_ANCHOR_FAILED' : !result.graphConnected ? 'GRAPH_DISCONNECTED' : 'NO_ROUTE';
    return { result, totalMs: performance.now() - started, graphBuilds: 1 };
  }
  const route = reconstruction.route;
  result.solved = true; result.routeHash = route.geometryHash;
  result.manifestHash = sha256Stable({ baselineManifest: route.reconstructionManifestHash, evidence: evidence.hash,
    projections: result.projections, versions, configuration: CORRECTION });
  // First reference geometry read, after independent reconstruction is complete.
  const row = truth.prepare('SELECT payload FROM routes WHERE id=?').get(member.relationId) as { payload: string } | undefined;
  assert(row, 'MISSING_FROZEN_REFERENCE');
  const reference = JSON.parse(row.payload) as { name: string | null; geometry: ComparableRoute['geometry'] };
  result.similarity = compareRoutes(toPhase11ComparableRoute(route, member.facts.summits[0].id), {
    sourceId: member.relationId, name: reference.name || member.relationId, geometry: reference.geometry,
    summitEvidence: { confirmedPeakIds: member.facts.summits.map(s => s.id), associatedPeakIds: member.facts.summits.map(s => s.id) } });
  result.failure = result.similarity.classification;
  const routeWays: RoadSafetyWay[] = route.osmNodeIds.slice(1).map((to, i) => {
    const from = route.osmNodeIds[i], edge = graph.neighbors(from).find(e => e.toNodeId === to && route.osmWayIds.includes(e.wayId));
    assert(edge, 'MISSING_REAL_TRAVERSED_EDGE');
    const source = ways.find(w => w.id === edge.wayId)!;
    return { id: source.id, tags: { ...source.tags }, nodes: [from, to].map(nodeId => ({ nodeId, coordinate: [...graph.node(nodeId)!.coordinate] as [number, number] })) };
  });
  const nearbyMotorwayWays: RoadSafetyWay[] = ways.filter(w => ['motorway', 'motorway_link'].includes(w.tags.highway) && w.nodes.every(n => n.coordinate))
    .map(w => ({ id: w.id, tags: { ...w.tags }, nodes: w.nodes.map(n => ({ nodeId: n.nodeId, coordinate: [...n.coordinate!] as [number, number] })) }));
  const safety = analyzeRouteRoadSafety({ canonicalRelationId: member.relationId, stagingRouteId: 'offline-only', routeType: 'hiking', routeWays, nearbyMotorwayWays, sourceDatasetIdentity: input.sourceDatasetIdentity });
  result.roadSafety = safety.status; result.safetyReasons.push(...safety.reasonCodes);
  result.intrinsicAutoCompatible = ['BASE_START', 'HUT_START'].includes(context.type) && safety.status === 'SAFE' && !safety.reasonCodes.length && acceptable(result);
  result.autoCompatible = result.intrinsicAutoCompatible && !member.negativeReasons.length;
  return { result, totalMs: performance.now() - started, graphBuilds: 1 };
}
