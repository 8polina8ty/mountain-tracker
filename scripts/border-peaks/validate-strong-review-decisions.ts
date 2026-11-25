#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";
type Status="TIER1_VERIFIED"|"GEOMETRIC_SUPPORT";
type QueueRow={candidate_hash:string;mountain_id:number;primary_country_code:string|null;candidate_country_code:string;pair:string;final_machine_status:Status;distance_to_boundary_meters:number|null;tier1_status:string|null;best_probe_status:string|null;latest_probe_status:string|null;latest_probe_source:string|null;boundary_source:string;boundary_source_id:string|null;boundary_dataset_version:string|null;};
type DecisionRow=QueueRow&{decision:"APPROVE"|"REJECT"|null;reviewed_by:string|null;reviewed_at:string|null;review_notes:string|null;decision_batch_id:string|null;approval_basis?:"EXPLICIT_HUMAN_OVERRIDE"|null;};
function arg(n:string,f:string){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const r=readFileSync(p,"utf8").trim();return r?r.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function main(){
 const q=read<QueueRow>(arg("--queue","data/border-peaks/global-review/strong-human-review.jsonl"));
 const d=read<DecisionRow>(arg("--decisions","data/border-peaks/global-review/strong-review-decisions.jsonl"));
 if(q.length!==1372||d.length!==1372||q.length!==d.length) throw new Error(`Expected matching 1372-row queue/decision files, found ${q.length}/${d.length}`);
 const by=new Map(q.map(r=>[r.candidate_hash,r])); const seen=new Set<string>(); let pending=0,approve=0,reject=0;
 for(const r of d){
  if(seen.has(r.candidate_hash)) throw new Error(`Duplicate decision hash ${r.candidate_hash.slice(0,12)}…`); seen.add(r.candidate_hash);
  const e=by.get(r.candidate_hash); if(!e) throw new Error("Decision hash missing from strong queue");
  for(const f of ["mountain_id","primary_country_code","candidate_country_code","pair","final_machine_status","distance_to_boundary_meters","tier1_status","best_probe_status","latest_probe_status","latest_probe_source","boundary_source","boundary_source_id","boundary_dataset_version"] as const){if(r[f]!==e[f])throw new Error(`Strong decision field ${f} drifted for ${r.candidate_hash.slice(0,12)}…`);}
  if(r.decision===null){if(r.reviewed_by!==null||r.reviewed_at!==null||r.review_notes!==null||r.decision_batch_id!==null||r.approval_basis!=null)throw new Error("Pending row has reviewer metadata");pending++;continue;}
  if(r.decision!=="APPROVE"&&r.decision!=="REJECT")throw new Error("Invalid decision");
  if(!r.reviewed_by||!r.reviewed_at||!Number.isFinite(Date.parse(r.reviewed_at))||!r.review_notes||r.review_notes.length<10||!r.decision_batch_id)throw new Error(`Incomplete reviewer metadata for ${r.candidate_hash.slice(0,12)}…`);
  if(r.approval_basis!=null){
   if(r.decision!=="APPROVE"||r.approval_basis!=="EXPLICIT_HUMAN_OVERRIDE")throw new Error(`Invalid approval_basis for ${r.candidate_hash.slice(0,12)}…`);
   if(!/(unresolved|insufficient|ambiguous|not independently)/i.test(r.review_notes))throw new Error(`Override notes must acknowledge unresolved/insufficient evidence for ${r.candidate_hash.slice(0,12)}…`);
  }
  if(r.decision==="APPROVE")approve++;else reject++;
 }
 process.stdout.write(JSON.stringify({total_rows:d.length,completed_rows:d.length-pending,pending_rows:pending,approve_rows:approve,reject_rows:reject,template_valid:true,export_ready:pending===0,safety:pending===0?"Strong human decision layer is structurally complete; SQL export still requires separate hardened preflight.":"Strong decision layer remains incomplete; do not export SQL."},null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
