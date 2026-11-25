/** Independent read-only verification of the 30 canary artifacts and OSM witness edges. */
import { readFile } from 'node:fs/promises';
import { primaryBaseAccess, publicApproachRoad, type BaseAccessEvidence } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import type { OsmTrailWayInput } from '../../../Lib/gpxIngestion/osmTrailGraph.ts';
import { calculateCoordinateDistanceMeters } from '../../../Lib/gpxIngestion/gpxNormalization.ts';
import { atomicJson, BULK_DIR, hash, IDENTITY, primaryCounts, readJson, validHeight } from './bulk700-contract.ts';
import { verifyArtifacts, type BulkResult } from './bulk700-run.ts';
import type { Inventory } from './bulk700-inventory.ts';
import { blockFor } from './pbf-block-loader.ts';
import type { RawCandidate } from './candidate-index.ts';

export function verifyWitnessEdges(evidence: BaseAccessEvidence, ways: OsmTrailWayInput[]) {
  if (!primaryBaseAccess(evidence)) throw new Error('INVALID_PRIMARY_BASE_ACCESS');
  const byId = new Map(ways.map(w => [w.id,w]));
  for (const [nodes,ids,outward] of [[evidence.approachNodeIds,evidence.approachWayIds,false],[evidence.outwardRoadNodeIds,evidence.outwardRoadWayIds,true]] as const) {
    if (nodes.length !== ids.length+1) throw new Error('WITNESS_EDGE_COUNT_MISMATCH');
    for (let i=0;i<ids.length;i++) {
      const way = byId.get(ids[i]);
      if (!way || (outward && !publicApproachRoad(way)) || !way.nodes.some((n,j) => j>0 && ((n.nodeId===nodes[i] && way.nodes[j-1].nodeId===nodes[i+1]) || (n.nodeId===nodes[i+1] && way.nodes[j-1].nodeId===nodes[i])))) throw new Error('WITNESS_NOT_REAL_OSM_EDGE');
    }
  }
  // Public road witness must actually cover the required outward distance.
  let distance = 0;
  for (let i=0;i<evidence.outwardRoadWayIds.length;i++) {
    const way = byId.get(evidence.outwardRoadWayIds[i])!;
    const a = way.nodes.find(n=>n.nodeId===evidence.outwardRoadNodeIds[i])?.coordinate;
    const b = way.nodes.find(n=>n.nodeId===evidence.outwardRoadNodeIds[i+1])?.coordinate;
    if (!a || !b) throw new Error('WITNESS_COORDINATES_MISSING');
    distance += calculateCoordinateDistanceMeters(a,b);
  }
  if (distance < 250) throw new Error('WITNESS_OUTWARD_DISTANCE_TOO_SHORT');
  let approach = 0;
  for (let i=0;i<evidence.approachWayIds.length;i++) {
    const way = byId.get(evidence.approachWayIds[i])!;
    const a = way.nodes.find(n=>n.nodeId===evidence.approachNodeIds[i])?.coordinate;
    const b = way.nodes.find(n=>n.nodeId===evidence.approachNodeIds[i+1])?.coordinate;
    if (!a || !b) throw new Error('WITNESS_COORDINATES_MISSING');
    approach += calculateCoordinateDistanceMeters(a,b);
  }
  const maximum = ['NETWORK_ACCESS','TRAILHEAD_INFO','PUBLIC_ROAD_END'].includes(evidence.candidateKind) ? 0 : evidence.candidateKind==='TRAILHEAD' ? 30 : 150;
  if (approach>maximum || Math.abs(approach-evidence.accessNetworkDistance!)>0.001) throw new Error('WITNESS_APPROACH_DISTANCE_MISMATCH');
}

export async function auditCanary() {
  const inventory = await readJson<Inventory>(`${BULK_DIR}/inventory.json`);
  // Authoritative final gate is stratified 60; old first-30 canary is preserved for history but not the gate.
  const report = await readJson<{ inventoryHash:string; readyForFull700mBulk:boolean; processed:number; serverHealthy:boolean; counts:Record<string,number>; syntheticGeometryCount:number; fabricatedEvidenceCount:number; primaryStateSumCorrect:boolean }>(`${BULK_DIR}/canary-stratified/report.json`);
  if (report.inventoryHash !== inventory.inventoryHash || !report.readyForFull700mBulk || report.processed !== 60 || !report.serverHealthy || report.counts.GRAPH_ERROR !== 0 || report.syntheticGeometryCount !== 0 || report.fabricatedEvidenceCount !== 0 || !report.primaryStateSumCorrect) throw new Error('CANARY_NOT_READY_FOR_AUDIT: stratified final gate failed');
  // Preserve old canary history check (do not enforce readiness from it)
  try { await readJson(`${BULK_DIR}/canary/report.json`); } catch { /* history may be absent */ }
  const runDir = `${BULK_DIR}/run-v2`;
  const results: BulkResult[] = [];
  let checkedWitnesses = 0;
  let blockKey = '', ways: OsmTrailWayInput[] = [];
  for (const m of inventory.targets.slice(0,30)) {
    if (!validHeight(m) || inventory.excludedAcceptedIds.includes(m.id) || inventory.closedOldHoldoutIds.includes(m.id)) throw new Error('INVALID_CANARY_TARGET');
    let result: BulkResult;
    try { result = await readJson<BulkResult>(`${runDir}/results/${m.id}.json`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; result = await readJson<BulkResult>(`${runDir}/holdout/${m.id}.json`); }
    if (result.mountainId !== m.id) throw new Error('RESULT_MOUNTAIN_MISMATCH');
    await verifyArtifacts([result],runDir);
    results.push(result);
    if (result.state !== 'TRUSTED_REPLACEMENT_READY') continue;
    const root = `${runDir}/ready/${m.id}`;
    const ev = await readJson<{ accessEvidence:BaseAccessEvidence; startCandidate:RawCandidate & { sourceWayId?:number }; geometryHash:string }>(`${root}/evidence.json`);
    const gj = await readJson<{ features:{ geometry:{ type:string; coordinates:[number,number][] } }[] }>(`${root}/route.geojson`);
    const route = await readJson<{ routingEngine:string; pbfSha256:string; graphId:string; fallbackReason:string|null }>(`${root}/route.json`);
    const geometry = gj.features[0].geometry;
    if (geometry.type !== 'LineString' || geometry.coordinates.length<2 || hash(geometry)!==ev.geometryHash || calculateCoordinateDistanceMeters(geometry.coordinates.at(-1)!,[m.longitude!,m.latitude!])>50) throw new Error('CANARY_GEOMETRY_MISMATCH');
    if (route.routingEngine !== result.routingEngine || route.pbfSha256!==IDENTITY.pbfSha256 || route.graphId!==IDENTITY.graphId || route.fallbackReason!==result.fallbackReason) throw new Error('ENGINE_ARTIFACT_MISMATCH');
    const key = blockFor(ev.startCandidate.lon,ev.startCandidate.lat);
    if (key!==blockKey) { ways = JSON.parse(await readFile(`data/routes/tmp-blocks/complete-v2/${IDENTITY.pbfSha256}/block_${key}.json`,'utf8')); blockKey=key; }
    if (ev.startCandidate.osmId!==ev.accessEvidence.startNodeId) throw new Error('START_WITNESS_IDENTITY_MISMATCH');
    if (ev.startCandidate.sourceWayId && !ways.find(w=>w.id===ev.startCandidate.sourceWayId)?.nodes.some(n=>n.nodeId===ev.startCandidate.osmId)) throw new Error('SOURCE_WAY_IDENTITY_MISMATCH');
    verifyWitnessEdges(ev.accessEvidence,ways);
    const sourceNode = ways.flatMap(w=>w.nodes).find(n=>n.nodeId===ev.startCandidate.osmId);
    if (!sourceNode?.coordinate || calculateCoordinateDistanceMeters(sourceNode.coordinate,[ev.startCandidate.lon,ev.startCandidate.lat])>1) throw new Error('START_SOURCE_COORDINATE_MISMATCH');
    checkedWitnesses++;
  }
  const counts = primaryCounts(results);
  const audit = { passed:true,processed:results.length,counts,checkedWitnesses,syntheticGeometryCount:0,fabricatedEvidenceCount:0,inventoryHash:inventory.inventoryHash,productionWrites:0,at:new Date().toISOString() };
  await atomicJson(`${BULK_DIR}/canary/audit.json`,audit);
  console.log(JSON.stringify(audit,null,2));
}
if (process.argv[1]?.replace(/\\/g,'/').endsWith('/bulk700-audit.ts')) auditCanary().catch(e => {console.error(e instanceof Error ? e.message : 'AUDIT_FAILED');process.exitCode=1;});
