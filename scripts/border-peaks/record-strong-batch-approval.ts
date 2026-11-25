#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
type Status="TIER1_VERIFIED"|"GEOMETRIC_SUPPORT";
type BatchRow={candidate_hash:string;mountain_id:number;primary_country_code:string|null;candidate_country_code:string;pair:string;final_machine_status:Status;machine_evidence_tier:"EXACT_SUMMIT_CONTAINMENT"|"PROBE_GEOMETRIC_SUPPORT";batch_id:string;};
type DecisionRow={candidate_hash:string;mountain_id:number;primary_country_code:string|null;candidate_country_code:string;pair:string;final_machine_status:Status;decision:"APPROVE"|"REJECT"|null;reviewed_by:string|null;reviewed_at:string|null;review_notes:string|null;decision_batch_id:string|null;};
function arg(n:string,f:string){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const r=readFileSync(p,"utf8").trim();return r?r.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function main(){
 const batchNum=Number(arg("--batch","1")); if(!Number.isInteger(batchNum)||batchNum<=0)throw new Error("--batch must be a positive integer");
 const batchId=`strong-${String(batchNum).padStart(3,"0")}`;
 const batch=read<BatchRow>(join(arg("--dir","data/border-peaks/global-review/strong-batches"),batchId+".jsonl"));
 const decisionsPath=arg("--decisions","data/border-peaks/global-review/strong-review-decisions.jsonl");
 const decisions=read<DecisionRow>(decisionsPath);
 if(decisions.length!==1372)throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);
 if(batch.length===0)throw new Error("Refusing to approve empty batch");
 const batchHashes=new Set<string>(); const by=new Map(decisions.map(r=>[r.candidate_hash,r]));
 for(const b of batch){
  if(b.batch_id!==batchId)throw new Error(`Batch id mismatch for ${b.candidate_hash.slice(0,12)}…`);
  if(batchHashes.has(b.candidate_hash))throw new Error("Duplicate hash in batch"); batchHashes.add(b.candidate_hash);
  if(b.final_machine_status!=="TIER1_VERIFIED"||b.machine_evidence_tier!=="EXACT_SUMMIT_CONTAINMENT")throw new Error(`Batch ${batchId} contains non-TIER1 candidate ${b.candidate_hash.slice(0,12)}…; bulk approval is not allowed`);
  const d=by.get(b.candidate_hash); if(!d)throw new Error("Batch hash missing from decision template");
  if(d.mountain_id!==b.mountain_id||d.primary_country_code!==b.primary_country_code||d.candidate_country_code!==b.candidate_country_code||d.pair!==b.pair||d.final_machine_status!==b.final_machine_status)throw new Error("Batch/decision identity mismatch");
  if(d.decision!==null||d.reviewed_by!==null||d.reviewed_at!==null||d.review_notes!==null||d.decision_batch_id!==null)throw new Error(`Refusing to overwrite existing decision for ${b.candidate_hash.slice(0,12)}…`);
 }
 const now=new Date().toISOString();
 for(const h of batchHashes){const d=by.get(h)!;d.decision="APPROVE";d.reviewed_by="Human reviewer (explicit ChatGPT batch approval)";d.reviewed_at=now;d.review_notes=`Human reviewer explicitly approved ${batchId}. Candidate has TIER1_VERIFIED exact-summit dual-country containment machine evidence.`;d.decision_batch_id=batchId;}
 writeFileSync(decisionsPath,decisions.map(r=>JSON.stringify(r)).join("\n")+"\n");
 process.stdout.write(JSON.stringify({batch_id:batchId,approved_rows_written:batch.length,remaining_pending_rows:decisions.filter(r=>r.decision===null).length,decision_file:decisionsPath,safety:"Only the explicitly authorized TIER1 exact-summit batch is approved. No SQL or database write is performed."},null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
