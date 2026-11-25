#!/usr/bin/env node
// Read-only Phase 3 independent-source research queue.
// Does not claim verification or modify owner decisions / production.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname} from "node:path";
const base="data/border-peaks/phase3";
const input=base+"/all-review.jsonl";
const owner=base+"/decisions/verified-human-decisions.jsonl";
const output=base+"/independent-source-research-queue.jsonl";
const summaryPath=base+"/independent-source-research-summary.json";
function read(path){if(!existsSync(path))throw Error("Missing "+path);const s=readFileSync(path,"utf8").trim();return s?s.split(/\r?\n/).map(JSON.parse):[]}
const rows=read(input),decisions=read(owner);
if(rows.length!==2477||decisions.length!==2477)throw Error("Expected 2477 candidates and owner decisions");
const map=new Map(rows.map(r=>[r.candidate_hash,r]));
if(map.size!==2477)throw Error("Duplicate candidate hash");
const decided=new Set();
for(const d of decisions){
 const r=map.get(d.candidate_hash);
 if(!r||decided.has(d.candidate_hash)||d.mountain_id!==r.mountain_id||d.primary_country_code!==r.primary_country_code||d.candidate_country_code!==r.candidate_country_code||d.decision!=="APPROVE"||!d.reviewed_by||!Number.isFinite(Date.parse(d.reviewed_at)))throw Error("Owner decision mismatch");
 decided.add(d.candidate_hash);
}
const countryPair=r=>[r.primary_country_code,r.candidate_country_code].sort().join("-");
const priority=r=>r.latest_status==="INSUFFICIENT"||r.latest_status==="CONFLICT"?0:1;
const ordered=[...rows].sort((a,b)=>priority(a)-priority(b)||
(a.distance_to_boundary_meters??Infinity)-(b.distance_to_boundary_meters??Infinity)||
countryPair(a).localeCompare(countryPair(b))||a.mountain_id-b.mountain_id);
const tasks=ordered.map((r,i)=>({
 candidate_hash:r.candidate_hash,mountain_id:r.mountain_id,mountain_name:r.mountain_name,
 latitude:r.latitude,longitude:r.longitude,height:r.height,
 primary_country_code:r.primary_country_code,candidate_country_code:r.candidate_country_code,
 country_pair:countryPair(r),latest_status:r.latest_status,phase2_batch_id:r.phase2_batch_id,
 owner_decision:"APPROVE",research_state:"AWAITING_INDEPENDENT_SOURCE",
 source_url:null,source_authority:null,source_title:null,source_type:null,
 source_dataset_version:null,source_license:null,source_accessed_at:null,
 independent_finding:null,summit_boundary_checked:false,coordinate_match_checked:false,
 reviewer:null,reviewed_at:null,evidence_notes:null,
 research_order:i+1
}));
const digest=s=>createHash("sha256").update(s).digest("hex");
const serialized=tasks.map(JSON.stringify).join("\n")+"\n";
mkdirSync(dirname(output),{recursive:true});
if(existsSync(output))throw Error("Research output already exists; preserve prior work: "+output);
writeFileSync(output,serialized);
const summary={stage:"PHASE3_INDEPENDENT_RESEARCH_QUEUE",candidate_count:2477,owner_approved:2477,
 insufficient_first:tasks.filter(r=>r.latest_status==="INSUFFICIENT"||r.latest_status==="CONFLICT").length,
 geometric_followup:tasks.filter(r=>r.latest_status==="GEOMETRIC_SUPPORT"||r.latest_status==="VERIFIED").length,
 distinct_country_pairs:new Set(tasks.map(r=>r.country_pair)).size,
 independently_verified:0,ready_for_sql_generation:false,
 candidates_sha256:digest(readFileSync(input)),owner_decisions_sha256:digest(readFileSync(owner)),
 research_queue_sha256:digest(serialized),output,
 safety:"Research tasks only. Official evidence must be independently collected and reviewed; no decision status changed, no SQL, no production writes."};
writeFileSync(summaryPath,JSON.stringify(summary,null,2)+"\n");
console.log(JSON.stringify(summary,null,2));
