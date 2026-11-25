import { readFile } from 'node:fs/promises';
import { calculateCoordinateDistanceMeters } from '../../../Lib/gpxIngestion/gpxNormalization.ts';
import { blockFor, loadBlockWays } from './pbf-block-loader.ts';
import { buildReconstructionPbfBlockGraph } from '../../../Lib/gpxIngestion/pbfBlockGraph.ts';
import { readJson } from './bulk700-contract.ts';
import type { StratifiedResult } from './bulk700-stratified-run.ts';

const BULK_DIR='data/routes/graphhopper-bulk/700m';
async function main(){
  const strat=await readJson<{targets: {id:number; name:string; height:number; latitude:number; longitude:number}[]}>(`${BULK_DIR}/canary-stratified/targets.json`);
  const map=new Map(strat.targets.map(m=>[m.id,m]));
  const holdouts: StratifiedResult[]=[];
  for(const m of strat.targets){
    try{ const r=await readJson<StratifiedResult>(`${BULK_DIR}/canary-stratified/run/holdout/${m.id}.json`); if(r.state==='SUMMIT_ATTACHMENT_REVIEW_REQUIRED') holdouts.push(r);}catch{}
  }
  holdouts.sort((a,b)=>(a.bestSummitSnapM??1e9)-(b.bestSummitSnapM??1e9));
  // pick 10 spread: indices 0,1,3,6,9,12,16,19,22,28  (across buckets)
  const picks=[0,1,3,6,9,12,15,18,22,28].map(i=>holdouts[i]).filter(Boolean);
  console.log(`Total summit holdouts ${holdouts.length}, picking ${picks.length}`);
  for(const r of picks){
    const m=map.get(r.mountainId)!;
    const ways=await loadBlockWays(blockFor(m.longitude,m.latitude),'15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5');
    // build graph to find nearest node to summit
    const graph=buildReconstructionPbfBlockGraph({datasetKey:'local-osm-pbf',region:'alps',snapshotTimestamp:new Date().toISOString(),pbfSha256:'15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5'}, ways);
    const nearest=graph.findNearestNode([m.longitude,m.latitude], 2000);
    const nearestDist=nearest? calculateCoordinateDistanceMeters(nearest.node.coordinate as [number,number],[m.longitude,m.latitude]): null;
    const nearestKind=nearest? (ways.flatMap(w=>w.nodes).find(n=>n.nodeId===nearest.node.nodeId)? 'found':''): null;
    // check candidate peak proximity via index? approximate by scanning ways for peak nodes?
    // check if any OSM way node is trail/path
    const trailWays=ways.filter(w=> w.tags && (w.tags.highway==='path' || w.tags.highway==='footway' || w.tags.highway==='track' || w.tags.route==='hiking'));
    const hasTrailNear=ways.some(w=> w.nodes.some(n=> n.coordinate && calculateCoordinateDistanceMeters(n.coordinate,[m.longitude,m.latitude])<500) && (w.tags.highway||w.tags.route));
    const classification=(()=> {
      if(nearestDist===null) return 'OFF_NETWORK_SUMMIT';
      if(nearestDist>1000) return 'OFF_NETWORK_SUMMIT';
      if(nearestDist>250) return 'GRAPH_COVERAGE_GAP';
      if(nearestDist>100 && r.reason==='NO_SUMMIT_CONNECTION') return 'TRAIL_PRESENT_BUT_NOT_ROUTED';
      if(r.reason==='SUMMIT_SNAP_EXCEEDS_50M' && nearestDist!==null && nearestDist<60) return 'DB_OSM_COORDINATE_MISMATCH';
      return 'OTHER';
    })();
    console.log(JSON.stringify({
      mountainId:m.id, name:m.name, height:m.height, requested:[m.longitude,m.latitude],
      snapSummit: r.bestSummitSnapM, snapStart: r.bestStartSnapM, reason:r.reason, terminal: r.terminalCoord,
      nearestOSMNodeDist: nearestDist, nearestNodeId: nearest?.node.nodeId ?? null,
      trailWaysInBlock: trailWays.length, hasTrailNear,
      classification,
    },null,2));
  }
}
main().catch(e=>{console.error(e);process.exit(1)});
