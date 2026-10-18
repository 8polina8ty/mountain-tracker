#!/usr/bin/env node
// Phase 3 readiness audit: read-only, never generates SQL or writes production data.
import {readFileSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";
const base="data/border-peaks/phase3";
const paths={candidates:base+"/all-review.jsonl",decisions:base+"/decisions/verified-human-decisions.jsonl",existing:"data/border-peaks/existing-memberships-global.jsonl"};
const read=(p,optional=false)=>{if(!existsSync(p)){if(optional)return [];throw Error("Missing "+p)}const raw=readFileSync(p,"utf8").trim();return raw?raw.split(/\r?\n/).map(JSON.parse):[]};
const rows=read(paths.candidates),decisions=read(paths.decisions,true),existing=read(paths.existing,true);
if(rows.length!==2477)throw Error("Expected 2477 review candidates");
const byHash=new Map(rows.map(r=>[r.candidate_hash,r]));
if(byHash.size!==2477)throw Error("Duplicate candidate hash");
const seen=new Set();let approve=0,reject=0,defer=0,verified=0;
for(const d of decisions){
 const r=byHash.get(d.candidate_hash);
 if(!r||seen.has(d.candidate_hash)||r.mountain_id!==d.mountain_id||r.candidate_country_code!==d.candidate_country_code||r.primary_country_code!==d.primary_country_code)throw Error("Invalid decision identity");
 seen.add(d.candidate_hash);
 if(!["APPROVE","REJECT","DEFER"].includes(d.decision)||!d.reviewed_by||!Number.isFinite(Date.parse(d.reviewed_at)))throw Error("Invalid decision metadata");
 if(d.decision==="APPROVE"){approve++;if(d.independent_source_finding==="SUPPORTS"&&/^https:\/\//.test(d.independent_source_url||"")&&d.summit_boundary_checked===true&&d.source_reviewed_by&&Number.isFinite(Date.parse(d.source_reviewed_at)))verified++}
 else if(d.decision==="REJECT")reject++;else defer++;
}
const collisionSet=new Set(existing.map(r=>r.mountain_id+":"+r.country_code));
const collisions=decisions.filter(d=>d.decision==="APPROVE"&&collisionSet.has(d.mountain_id+":"+d.candidate_country_code)).length;
const ready=decisions.length===2477&&defer===0&&approve>0&&verified===approve&&existing.length>0&&collisions===0;
const report={stage:"PHASE3_EXPORT_PREFLIGHT",candidates:2477,decisions:decisions.length,approve,reject,defer,verified_approvals:verified,awaiting_decision:2477-decisions.length,existing_memberships_checked:existing.length,collisions,ready_for_sql_generation:ready,sql_generated:false,database_written:false,warning:"Existing membership baseline must be refreshed and official evidence independently reviewed before export."};
const out=base+"/export-preflight.json";mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
