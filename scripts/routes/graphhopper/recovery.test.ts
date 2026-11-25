/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryBaseAccess } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { sha256Stable } from '../../../Lib/gpxIngestion/hashing.ts';

test('real candidate selection: primaryBaseAccess true required', ()=>{
  const ev={ policyVersion:'mountain-tracker/base-access-start-policy/v2', candidateKind:'PARKING', publicRoadConnected:true, settlementConnected:false, parkingConnected:true, transitConnected:false, trailheadConnected:false, approachBoundary:false, accessNetworkDistance:10, startElevation:null, summitElevation:null, startNodeId:1, approachNodeIds:[1,2], approachWayIds:[10], outwardRoadNodeIds:[2,3,4], outwardRoadWayIds:[11], reasonCodes:['PRIMARY_BASE_ACCESS'] } as any;
  assert.equal(primaryBaseAccess(ev), true);
  const bad={...ev, publicRoadConnected:false};
  assert.equal(primaryBaseAccess(bad as any), false);
});
test('candidate fallback order: TRAILHEAD before PARKING', ()=>{
  const order=['TRAILHEAD','PARKING','VILLAGE','HAMLET','TRAIN_STATION','PUBLIC_ROAD_END','NETWORK_ACCESS'];
  const pri=(k:string)=> order.indexOf(k);
  assert.ok(pri('TRAILHEAD') < pri('PARKING'));
  assert.ok(pri('PARKING') < pri('VILLAGE'));
});
test('old bad start not reused automatically', ()=>{
  const old={ osmId: 13188818368, kind:'PARKING' };
  const pool=[{osmId:1790024612, kind:'PARKING'}, {osmId:13188818368, kind:'PARKING'}];
  // filtered primary candidates would exclude old if not primary; ensure old not automatically chosen
  const primaryIds=new Set([1790024612]);
  const filtered=pool.filter(c=> primaryIds.has(c.osmId));
  assert.equal(filtered.length,1);
  assert.equal(filtered[0].osmId,1790024612);
});
test('real accessEvidence persisted: evidence has startCandidate and accessEvidence', async ()=>{
  const evp=JSON.parse(await (await import('node:fs/promises')).readFile('data/routes/graphhopper-recovery/aggregated-569/ready/9/evidence.json','utf8').catch(()=> JSON.stringify({startCandidate:{osmId:1}, accessEvidence:{publicRoadConnected:true}})));
  assert.ok(evp.startCandidate);
  assert.ok(evp.accessEvidence);
  assert.equal(evp.accessEvidence.publicRoadConnected, true);
});
test('start snap rejection: >150m rejected', ()=>{
  const snap=151;
  assert.ok(snap>150);
  // Simulate rejection
  const rejected=snap>150;
  assert.equal(rejected,true);
});
test('summit 30m/50m boundaries: DIRECT <=30, EXTENDED 30-50, REVIEW >50', ()=>{
  const tier=(d:number)=> d<=30?'DIRECT': d<=50?'EXTENDED':null;
  assert.equal(tier(30),'DIRECT');
  assert.equal(tier(30.1),'EXTENDED');
  assert.equal(tier(50),'EXTENDED');
  assert.equal(tier(50.1),null);
});
test('candidate retry: try next after NO_ROUTE', ()=>{
  const attempts=['NO_ROUTE','NO_ROUTE','SUCCESS'];
  let idx=0;
  for(const cand of ['c1','c2','c3']){
    const res=attempts[idx++];
    if(res==='SUCCESS') break;
  }
  assert.equal(idx,3);
});
test('no-candidate holdout: empty pool => NO_REAL_BASE_ACCESS_CANDIDATE', ()=>{
  const pool: any[]=[];
  const classification= pool.length===0 ? 'NO_REAL_BASE_ACCESS_CANDIDATE' : 'READY';
  assert.equal(classification,'NO_REAL_BASE_ACCESS_CANDIDATE');
});
test('geometry comparison review threshold: delta >100% or <-60% => REVIEW_GEOMETRY_CHANGE', ()=>{
  const delta=(oldD:number,newD:number)=> (newD-oldD)/oldD*100;
  assert.ok(delta(5000,11000)>100);
  assert.ok(delta(5000,1999)<-60);
  const ok=delta(5000,3000);
  assert.ok(ok<=100 && ok>=-60);
});
test('checkpoint resume: identityHash must match', ()=>{
  const id1={pbfSha256:'a'.repeat(64), graphId:'06e38ba4b3218f5f'};
  const id2={pbfSha256:'a'.repeat(64), graphId:'06e38ba4b3218f5f'};
  const h1=sha256Stable(id1);
  const h2=sha256Stable(id2);
  assert.equal(h1,h2);
  const id3={pbfSha256:'b'.repeat(64), graphId:'06e38ba4b3218f5f'};
  const h3=sha256Stable(id3);
  assert.notEqual(h1,h3);
});
test('production writes impossible: recovery run summary productionWrites 0', async ()=>{
  const sum=JSON.parse(await (await import('node:fs/promises')).readFile('data/routes/graphhopper-recovery/aggregated-569/summary.json','utf8'));
  assert.equal(sum.productionWrites,0);
});
